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
 *     塌缩是请求本身的属性，重试等于把整个 prompt 再烧一遍。
 */
import { createDetector } from './detect.js'

/** 触发时上报给 agent-loop 的失败码。刻意不进默认重试集。 */
export const FAILURE_CODE = 'STREAM_COLLAPSE'

/** 一句话交代，直接作为 LlmError 的 message 出现在界面上。 */
export function failureMessage(verdict) {
  const where = verdict.channel === 'text-delta' ? '正文' : '推理'
  const at = verdict.atChars
  const line = verdict.line ?? ''
  const count = verdict.count ?? '?'
  const distinct = verdict.distinct ?? '?'
  switch (verdict.rule) {
    case 'short-line-dominant':
      return `模型${where}通道进入重复塌缩（尾窗只剩 ${distinct} 种短句，「${line}」出现了 ${count} 次，已读到 ${at} 字符），守卫掐断了本次流。`
    case 'short-line-tight':
      return `模型${where}通道进入重复塌缩（最近 ${distinct} 种短句反复循环，「${line}」出现了 ${count} 次，已读到 ${at} 字符），守卫掐断了本次流。`
    case 'paragraph-repeat':
      return `模型${where}通道在整段复读（同一段 ${verdict.line?.length ?? '?'} 字的内容重复了 ${count} 次，已读到 ${at} 字符），守卫掐断了本次流。`
    case 'hard-cap':
      return `模型输出超过 ${at} 字符仍在继续（${where}通道），守卫按硬上限掐断了本次流。`
    default:
      return `模型输出进入重复塌缩（已读到 ${at} 字符），守卫掐断了本次流。`
  }
}

/**
 * 包住一条模型流。
 *
 * @param source 上游 chunk 流（waterfall 里的 `next()`）
 * @param options 本次调用的 GenerateOptions（要 sessionId 和 signal）
 * @param config 判据参数
 * @param log 可选，(message) => void
 * @param onFire 可选，(verdict, facts) => void，在 terminal chunk 之前调一次；抛错也吞掉
 * @returns 守住的 chunk 流
 */
export async function* guardStream(source, options, config, log, onFire) {
  const detector = createDetector(config)
  const startedAt = Date.now()
  let firstDeltaAt = null
  let verdict = null
  // `await` 兜一下：`next()` 正常是同步返回 async generator，
  // 但万一哪一版变成 Promise<AsyncIterable>，这里不用改。
  const upstream = await source
  for await (const chunk of upstream) {
    const type = chunk?.type
    if (verdict === null && typeof chunk?.text === 'string' && (type === 'reasoning-delta' || type === 'text-delta')) {
      if (firstDeltaAt === null) firstDeltaAt = Date.now()
      verdict = detector.feed(type, chunk.text)
      // 命中的这一块不往下游吐
      if (verdict !== null) break
    }
    yield chunk
  }
  if (verdict === null) return
  const firedAt = Date.now()
  const failure = { message: failureMessage(verdict), code: config?.failureCode ?? FAILURE_CODE }
  try {
    log?.(`collapse-guard: ${verdict.rule}/${verdict.channel} at ${verdict.atChars} chars (session ${options?.sessionId ?? '?'}) — aborting stream`)
  } catch {
    // 日志是诊断，不许弄坏流
  }
  try {
    onFire?.(verdict, {
      startedAt,
      firstDeltaAt,
      firedAt,
      ttftMs: firstDeltaAt === null ? null : firstDeltaAt - startedAt,
      elapsedMs: firstDeltaAt === null ? null : firedAt - firstDeltaAt,
      chars: detector.chars,
      sample: detector.buffer[verdict.channel] ?? '',
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
