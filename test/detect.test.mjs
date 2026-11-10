/**
 * 判据回归测试。跑：node --test test/
 *
 * 每个用例都是一段「模型真会吐出来的东西」，期望要么掐（hit），要么放行（none）。
 * 这份用例表就是 README 里那些数字的来源 —— 改动判据之后先跑它。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDetector } from '../lib/detect.js'

function feedAll(text, channel = 'reasoning-delta') {
  const d = createDetector()
  return d.feed(channel, text)
}

function repeat(list, times) {
  const out = []
  for (let i = 0; i < times; i++) out.push(list[i % list.length])
  return out.join('\n')
}

const NORMAL_PARAGRAPHS = Array.from(
  { length: 60 },
  (_, i) => `第${i}段讲了不同的事，句子有长有短，没有重复。`
).join('\n')

const QUOTE =
  '“我们注意到有关报道，正在核实相关情况。”外交部发言人在例行记者会上表示。'
const BODY = Array.from(
  { length: 40 },
  (_, i) => `第${i}段写的是别的内容，跟上面完全不同，讲的是另一件事的来龙去脉。`
).join('\n')

test('流式切片：同一段话不换行重复，5 字一喂也要掐', () => {
  const para =
    '这一段话有一百来个字符吧我们数一数究竟有多长其实也不用太精确反正就是一段挺长的推理内容啊确实挺长的一段话。'
  const d = createDetector()
  const full = para.repeat(12)   // 53 字 × 12 ≈ 636 字，越过 minChars 400
  let hit = null
  for (let i = 0; i < full.length; i += 5) {
    hit = d.feed('reasoning-delta', full.slice(i, i + 5))
    if (hit) break
  }
  assert.ok(hit, '流式切片下段落复读也要抓得住')
})

test('流式切片：正常长推理不能误杀', () => {
  const d = createDetector()
  const text = NORMAL_PARAGRAPHS + '\n' + BODY + '\n' + NORMAL_PARAGRAPHS.replace(/第/g, '另一')
  let hit = null
  for (let i = 0; i < text.length; i += 7) {
    hit = d.feed('reasoning-delta', text.slice(i, i + 7))
    if (hit) break
  }
  assert.equal(hit, null)
})

test('经典四拍：好/写/发/format：好', () => {
  const v = feedAll(repeat(['好。', '写。', '发。', 'format：好。'], 300))
  assert.ok(v, '应该掐')
  // 规则码可能是 short-line-* 也可能是 paragraph-repeat —— 整段四拍本来就是周期重复，都算抓对。
  assert.ok(
    ['short-line-tight', 'short-line-dominant', 'short-line-cycle', 'short-line-spread', 'paragraph-repeat'].includes(v.rule),
    `规则码是 ${v.rule}`
  )
})

test('三拍：好/写/发', () => {
  const v = feedAll(repeat(['好。', '写。', '发。'], 300))
  assert.ok(v, '应该掐')
})

test('五种轮转：Write/Execute/Run/Test/Done', () => {
  const v = feedAll(repeat(['Write.', 'Execute.', 'Run.', 'Test.', 'Done.'], 400))
  assert.ok(v, '应该掐')
})

test('七种轮转', () => {
  const v = feedAll(
    repeat(['Write.', 'Execute.', 'Run.', 'Test.', 'Done.', 'Check.', 'Verify.'], 400)
  )
  assert.ok(v, '应该掐')
})

test('正常中文段落：不能误杀', () => {
  assert.equal(feedAll(NORMAL_PARAGRAPHS), null)
})

test('时政稿里同一句引文出现三次：不能误杀', () => {
  const text = [QUOTE, BODY, QUOTE, BODY, QUOTE, BODY].join('\n')
  assert.equal(feedAll(text), null)
})

test('不换行的英文复读', () => {
  const v = feedAll('abc abc abc '.repeat(120))
  assert.ok(v, '应该掐')
})

test('不换行的中文复读', () => {
  const v = feedAll('好的 好的 好的 '.repeat(150))
  assert.ok(v, '应该掐')
})

test('不换行的正常叙述：不能误杀', () => {
  const text =
    '今天出门买了两斤橘子回来路上碰到老同学聊了十几分钟他说改天一起吃饭然后又去买了点别的 '.repeat(
      4
    )
  assert.equal(feedAll(text), null)
})

test('短正常对话：不能误杀', () => {
  const text = [
    '今天出门买了两斤橘子，回来路上碰到老同学。',
    '他问我最近在忙什么，我说在写东西。',
    '聊了十几分钟，他说改天一起吃饭。'
  ].join('\n')
  assert.equal(feedAll(text), null)
})

test('围栏闭合的代码块：不能误杀', () => {
  assert.equal(feedAll('```js\nconst a = 1;\nconst b = 2;\n```\n'), null)
})

test('围栏不闭合 + 后面开始复读：看门狗要能看见', () => {
  let text = '```js\n'
  for (let i = 0; i < 400; i++) text += ['好。', '写。', '发。'][i % 3] + '\n'
  assert.ok(feedAll(text), '围栏看门狗失效')
})

test('正文通道也会被抓', () => {
  const v = feedAll(repeat(['好。', '写。', '发。'], 300), 'text-delta')
  assert.ok(v, '正文通道应该也掐')
  assert.equal(v.channel, 'text-delta')
})

test('硬上限：超长不换行的正文', () => {
  const v = feedAll('这是一段很长的正常内容，'.repeat(20000))
  assert.ok(v, '应该触发 hard-cap')
  assert.equal(v.rule, 'hard-cap')
})
