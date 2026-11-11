/**
 * 塌缩止血 —— 流这一层的守卫（纯 JS，零依赖，可离线单测）。
 *
 * 这一段是整件事的核心，协议约束都在这儿：
 *
 *  1. `@deepseek-ai/dsh-llm` 有 `llm-invariant`：一条流**只能**以一个 terminal
 *     `finish` 收尾，没闭合的块**只有** `kind: "error"` / `kind: "aborted"` 才被容忍。
 *     所以命中之后我们只吐一个 finish，后面一个 chunk 都不能再有。
 *
 *  2. 命中就 `break`，不再往上游拉 —— `for await` 的 break 会调上游 generator 的
 *     `return()`，`adapterStream` 的 finally 再去 `iterator.return()`，HTTP 立刻断。
 *
 *  3. 触发的那一块**不往下游吐**（先判后 yield），少一点垃圾落进
 *     `assistant/attempt`。
 *
 *  4. 不补 finish 会怎样：`assembler.finish` 默认 `{kind:'stop'}`
 *     （dsh-llm/lib/types/assembler.js:171-173），agent-loop 当正常结束处理，
 *     `blocks()` 把半截内容组装成 `assistant/message` 并 `surfaceOp:'append'`
 *     （dsh-agent-loop/lib/index.js:949-955）—— 垃圾进历史，就是这个病自己续上自己。
 *
 *  5. `failure.code` 决定 `dsh-llm-retry` 重不重试。默认重试集只有
 *     EMPTY_RESPONSE / RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT
 *     （dsh-llm/lib/types/retry-policy.js:16-22），我们的码**刻意不在里面**：
 *     重发由本插件自己做，次数与姿势都可控，不交给上层。
 *
 *  6. 重发的前提是「下游还一个字都没收到」。为此 `holdChars` 那段尾巴先扣住不放：
 *     塌缩多半发生在开头几千字内，那时缓冲里全是垃圾，直接丢掉重来最干净。
 *     一旦放出去过任何东西，就不再重发（否则新旧两段会拼成一条）。
 */
import { createDetector } from './detect.js'

/** 触发时上报给 agent-loop 的失败码。刻意不进默认重试集。 */
export const FAILURE_CODE = 'STREAM_COLLAPSE'

/** 一句话交代，直接作为 LlmError 的 message 出现在界面上。 */
export function failureMessage(verdict, extra) {
  const where = verdict.channel === 'text-delta' ? '正文' : '推理'
  const at = verdict.atChars
  const line = verdict.line ?? ''
  const count = verdict.count ?? '?'
  const distinct = verdict.distinct ?? '?'
  const tail = extra?.attempt > 1 ? `，重发 ${extra.attempt - 1} 次仍塌` : ''
  switch (verdict.rule) {
    case 'short-line-dominant':
      return `模型${where}通道进入重复塌缩（尾窗只剩 ${distinct} 种短句，「${line}」出现了 ${count} 次，已读到 ${at} 字符${tail}），守卫掐断了本次流。`
    case 'short-line-tight':
      return `模型${where}通道进入重复塌缩（最近 ${distinct} 种短句反复循环，「${line}」出现了 ${count} 次，已读到 ${at} 字符${tail}），守卫掐断了本次流。`
    case 'short-line-cycle':
      return `模型${where}通道在循环复读（${distinct} 种短句按固定周期绕圈，「${line}」出现了 ${count} 次，已读到 ${at} 字符${tail}），守卫掐断了本次流。`
    case 'short-line-spread':
      return `模型${where}通道进入重复塌缩（尾窗 ${distinct} 种短句，「${line}」占了一半以上、出现 ${count} 次，已读到 ${at} 字符${tail}），守卫掐断了本次流。`
    case 'paragraph-repeat':
      return `模型${where}通道在整段复读（同一段 ${verdict.line?.length ?? '?'} 字的内容重复了 ${count} 次，已读到 ${at} 字符${tail}），守卫掐断了本次流。`
    case 'hard-cap':
      return `模型输出超过 ${at} 字符仍在继续（${where}通道${tail}），守卫按硬上限掐断了本次流。`
    default:
      return `模型输出进入重复塌缩（已读到 ${at} 字符${tail}），守卫掐断了本次流。`
  }
}

/** 一个 chunk 大约占多少字符（用来算尾巴要扣多久才放）。 */
function chunkChars(chunk) {
  if (typeof chunk?.text === 'string') return chunk.text.length
  return 0
}

/**
 * 包住一条模型流。
 *
 * @param source 上游 chunk 流（waterfall 里的 `next()` 第一次调用）
 * @param options 本次调用的 GenerateOptions（要 sessionId 和 signal）
 * @param config 判据参数（含 holdChars / maxAttempts）
 * @param log 可选，(message) => void
 * @param onFire 可选，(verdict, facts) => void，在 terminal chunk 之前调一次；抛错也吞掉
 * @param restart 可选，() => AsyncIterable，重发用；不传就退化成「只掐不重发」
 * @returns 守住的 chunk 流
 */
export async function* guardStream(source, options, config, log, onFire, restart) {
  const maxAttempts = Math.max(1, Number(config?.maxAttempts ?? 2) || 1)
  const holdChars = Math.max(0, Number(config?.holdChars ?? 4096) || 0)
  const startedAt = Date.now()

  let attempt = 0
  let verdict = null
  let released = false
  let firstDeltaAt = null
  let chars = 0
  let sample = ''

  while (attempt < maxAttempts) {
    attempt += 1
    const detector = createDetector(config)
    let stream
    try {
      stream = await (attempt === 1 ? source : restart?.())
    } catch (error) {
      // 第一次拿不到流 = 上游本身的问题，透出去；重发通道自己挂 = 算这次重发没成，
      // 保留上一次的 verdict 收尾，别把守卫自己的异常瞒上去。
      if (attempt === 1) throw error
      log?.('collapse-guard: restart failed, settling as failure')
      break
    }
    if (stream === undefined || stream === null) {
      // 没有重发通道，或上游给不出流：把第一次的原样收掉
      break
    }

    const pending = []
    let pendingChars = 0
    verdict = null

    for await (const chunk of stream) {
      const type = chunk?.type
      if (
        verdict === null &&
        typeof chunk?.text === 'string' &&
        (type === 'reasoning-delta' || type === 'text-delta')
      ) {
        if (firstDeltaAt === null) firstDeltaAt = Date.now()
        verdict = detector.feed(type, chunk.text)
        // 命中的这一块不往下游吐
        if (verdict !== null) break
      }
      pending.push(chunk)
      pendingChars += chunkChars(chunk)
      // 尾巴扣够长了才往外放
      while (pendingChars > holdChars && pending.length > 0) {
        const head = pending.shift()
        pendingChars -= chunkChars(head)
        released = true
        yield head
      }
    }
    chars = detector.chars

    if (verdict === null) {
      // 正常收尾：缓冲里的全部放出去
      for (const chunk of pending) {
        released = true
        yield chunk
      }
      return
    }

    // 命中了。缓冲里的东西全是垃圾，直接丢（不 yield），但留一份样本
    sample = pending
      .filter((chunk) => typeof chunk?.text === 'string')
      .map((chunk) => chunk.text)
      .join('')
      .slice(-4096)
    try {
      log?.(
        `collapse-guard: ${verdict.rule}/${verdict.channel} at ${verdict.atChars} chars ` +
          `(attempt ${attempt}/${maxAttempts}, released=${released}, session ${options?.sessionId ?? '?'})`
      )
    } catch {
      // 日志是诊断，不许弄坏流
    }

    if (!released && attempt < maxAttempts && typeof restart === 'function') {
      // 下游还没见过任何东西，这次重发完全透明
      continue
    }
    break
  }

  const firedAt = Date.now()
  const failure = {
    message: failureMessage(verdict, { attempt }),
    code: config?.failureCode ?? FAILURE_CODE
  }
  try {
    onFire?.(verdict, {
      startedAt,
      firstDeltaAt,
      firedAt,
      ttftMs: firstDeltaAt === null ? null : firstDeltaAt - startedAt,
      elapsedMs: firstDeltaAt === null ? null : firedAt - firstDeltaAt,
      chars,
      attempt,
      released,
      sample,
      aborted: options?.signal?.aborted === true,
      sessionId: options?.sessionId ?? null,
      provider: options?.provider ?? null,
      model: options?.model ?? null
    })
  } catch {
    // 交接记录同理
  }
  yield {
    type: 'finish',
    reason: options?.signal?.aborted === true ? { kind: 'aborted', failure } : { kind: 'error', failure }
  }
}
