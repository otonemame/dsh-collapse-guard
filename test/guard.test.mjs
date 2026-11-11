/**
 * guardStream 的行为测试：扣尾巴、重发、正常收尾。
 *
 * 用手搓的假流，不碰网络。每个用例都只看「下游收到什么」，
 * 因为下游收到什么，直接决定进不进历史。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { guardStream, FAILURE_CODE } from '../lib/guard.js'

/** 把一段文本按 n 字切成 delta，模拟流式吐字。 */
function deltas(text, n = 5, type = 'reasoning-delta') {
  const out = []
  for (let i = 0; i < text.length; i += n) {
    out.push({ type, text: text.slice(i, i + n) })
  }
  return out
}

/** 一段正常推理：不重复、每行都长。 */
const NORMAL = Array.from({ length: 20 }, (_, i) =>
  `第${i + 1}步，先看这一处代码到底在算什么，再把边界情况过一遍，最后决定怎么改才不伤到别的调用方。`
).join('\n')

/** 一段塌缩：四拍轮转，刷到两百行。 */
const COLLAPSED = Array.from({ length: 240 }, (_, i) => ['好。', '写。', '发。', 'format：好。'][i % 4]).join('\n')

function makeStream(chunks) {
  return (async function* () {
    for (const c of chunks) {
      yield { type: c.type ?? 'reasoning-delta', text: c.text }
    }
  })()
}

async function drain(iter) {
  const out = []
  for await (const chunk of iter) out.push(chunk)
  return out
}

function textOf(chunks) {
  return chunks.filter((c) => typeof c.text === 'string').map((c) => c.text).join('')
}

// holdChars 要比 COLLAPSED 整段还长（约 1200 字符），才能保证塌缩时下游一个字都没收到
const BASE = { minChars: 400, holdChars: 4096, maxAttempts: 2 }

test('正常流原样透传：扣住的尾巴最后也要放出来', async () => {
  const src = makeStream(deltas(NORMAL))
  const out = await drain(guardStream(src, {}, BASE, null, null, null))
  assert.equal(textOf(out), NORMAL)
  assert.equal(out.filter((c) => c.type === 'finish').length, 0)
})

test('塌缩：只吐一个 finish(error)，不吐半个 finish(stop)', async () => {
  const fired = []
  const src = makeStream(deltas(COLLAPSED))
  const out = await drain(
    guardStream(src, {}, BASE, null, (v, f) => fired.push({ v, f }), null)
  )
  const finishes = out.filter((c) => c.type === 'finish')
  assert.equal(finishes.length, 1)
  assert.equal(finishes[0].reason.kind, 'error')
  assert.equal(finishes[0].reason.failure.code, FAILURE_CODE)
  assert.equal(fired.length, 1)
  // 已经放出去过的，说明尾巴扣得不够；这条用例就是要它扣住
  assert.equal(fired[0].f.released, false)
})

test('扣着的时候塌了、且下游一个字没收 → 重发，下游只看见第二遍', async () => {
  let restarts = 0
  const good = NORMAL + '\n收尾：就这样，没别的了。'
  const out = await drain(
    guardStream(
      makeStream(deltas(COLLAPSED)),
      {},
      BASE,
      null,
      null,
      () => {
        restarts += 1
        return makeStream(deltas(good))
      }
    )
  )
  assert.equal(restarts, 1)
  assert.equal(textOf(out), good, '下游只能收到第二遍，不能两遍拼起来')
  assert.equal(out.filter((c) => c.type === 'finish').length, 0)
})

test('已经放出去过东西了 → 不再重发，直接按失败收尾', async () => {
  let restarts = 0
  // holdChars 极小，第一块就放出去了
  const out = await drain(
    guardStream(
      makeStream(deltas(COLLAPSED)),
      {},
      { ...BASE, holdChars: 0 },
      null,
      null,
      () => {
        restarts += 1
        return makeStream(deltas(NORMAL))
      }
    )
  )
  assert.equal(restarts, 0)
  const finishes = out.filter((c) => c.type === 'finish')
  assert.equal(finishes.length, 1)
  assert.equal(finishes[0].reason.kind, 'error')
})

test('重发之后还塌 → 收尾，且文案里写明重发几次', async () => {
  let restarts = 0
  const out = await drain(
    guardStream(
      makeStream(deltas(COLLAPSED)),
      {},
      BASE,
      null,
      null,
      () => {
        restarts += 1
        return makeStream(deltas(COLLAPSED))
      }
    )
  )
  assert.equal(restarts, 1, 'maxAttempts=2，只重发一次')
  const finishes = out.filter((c) => c.type === 'finish')
  assert.equal(finishes.length, 1)
  assert.match(finishes[0].reason.failure.message, /重发 1 次仍塌/)
})

test('maxAttempts=1 就是老行为：只掐不重发', async () => {
  let restarts = 0
  const out = await drain(
    guardStream(
      makeStream(deltas(COLLAPSED)),
      {},
      { ...BASE, maxAttempts: 1 },
      null,
      null,
      () => {
        restarts += 1
        return makeStream(deltas(NORMAL))
      }
    )
  )
  assert.equal(restarts, 0)
  assert.equal(out.filter((c) => c.type === 'finish').length, 1)
})

test('正文通道塌了也照样掐', async () => {
  const src = makeStream(deltas(COLLAPSED, 5, 'text-delta'))
  const out = await drain(guardStream(src, {}, BASE, null, null, null))
  const finishes = out.filter((c) => c.type === 'finish')
  assert.equal(finishes.length, 1)
  assert.match(finishes[0].reason.failure.message, /正文/)
})

test('上游没给 restart 也不崩，按失败收尾', async () => {
  const out = await drain(guardStream(makeStream(deltas(COLLAPSED)), {}, BASE, null, null, undefined))
  assert.equal(out.filter((c) => c.type === 'finish').length, 1)
})

test('重启通道自己抛错，不能把守卫带崩', async () => {
  const out = await drain(
    guardStream(makeStream(deltas(COLLAPSED)), {}, BASE, null, null, () => {
      throw new Error('upstream down')
    })
  )
  const finishes = out.filter((c) => c.type === 'finish')
  assert.equal(finishes.length, 1)
  assert.equal(finishes[0].reason.kind, 'error')
})
