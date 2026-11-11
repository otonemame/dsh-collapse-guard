/**
 * @local/doudou-collapse-guard —— 塌缩止血的 Cordis 宿主半边。
 *
 * 挂在 `llm/stream` 瀑布上（正是 dsh-llm 自己的 llm-invariant 用的同一个扩展点），
 * 包住上游 chunk 流；命中重复碎念就把流掐掉，补一个 terminal `finish(error)`，
 * 让这一步以「provider 报错」的样子收场。
 *
 * 为什么不是 `agent/assistant-stream`：
 *   那是 `this.dispatch.emit("agent/assistant-stream", {frame})`
 *   （dsh-agent-loop/lib/index.js:872-874）—— emit 是单向通知，拦不住流。
 *   在那条路上唯一能做的是 `agent.cancel()`，而 cancel 走的是
 *   `signal.aborted` 分支：`live.interruptedBlocks()` → append `assistant/message`
 *   带 `interrupted:true` 和 `surfaceOp:'append'`（同文件 :889-905）—— 那是
 *   **进模型可见面**的，下一轮模型照着垃圾往下写，正是要躲的坑。
 *
 * 零依赖：不引 schemastery，配置就是普通对象（patch 里写什么就是什么），
 * 另加环境变量与一个空文件开关，方便出事时立刻让路。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULTS } from './lib/detect.js'
import { FAILURE_CODE, guardStream } from './lib/guard.js'
export const name = 'doudou-collapse-guard'

/** 家里地址：显式 DSH_HOME 优先，其次 ~/.dsh（与 dsh-home-paths 的 resolveDshHome 同序）。 */
const DSH_HOME = process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh')
const HOME = path.join(DSH_HOME, 'doudou-collapse-guard')
/** 这个文件存在 = 全套让路（不用重启，下一个请求就生效）。 */
const OFF_FILE = path.join(HOME, 'off')
const JOURNAL_FILE = path.join(HOME, 'fires.jsonl')
const JOURNAL_MAX_BYTES = 512 * 1024
const ENV_OFF = 'DOUDOU_COLLAPSE_GUARD_OFF'
const ENV_CONFIG = 'DOUDOU_COLLAPSE_GUARD_CONFIG'

function ensureHome() {
  try {
    fs.mkdirSync(HOME, { recursive: true })
  } catch {
    // 建不了目录不算错，只是没有日志
  }
}

/** 运行时开关：环境变量，或 `~/.dsh/doudou-collapse-guard/off` 这个空文件。 */
function isOff() {
  const value = process.env[ENV_OFF]
  if (value !== undefined && /^(1|true|on|yes)$/i.test(value.trim())) return true
  try {
    return fs.existsSync(OFF_FILE)
  } catch {
    return false
  }
}

/** 合并参数：默认 → patch config → 环境变量里的 JSON（启动期一次）。 */
function resolveConfig(patchConfig) {
  let config = { ...DEFAULTS, failureCode: FAILURE_CODE, journal: true }
  if (patchConfig !== null && typeof patchConfig === 'object') config = { ...config, ...patchConfig }
  const raw = process.env[ENV_CONFIG]
  if (raw !== undefined && raw.trim() !== '') {
    try {
      const parsed = JSON.parse(raw)
      if (parsed !== null && typeof parsed === 'object') config = { ...config, ...parsed }
    } catch {
      // 坏 JSON 就忽略，别为了一个环境变量把插件拖死
    }
  }
  return config
}

/** 交接记录：一次开火一行，超了轮转成一个 `.1`。 */
function record(entry) {
  try {
    ensureHome()
    try {
      if (fs.statSync(JOURNAL_FILE).size > JOURNAL_MAX_BYTES) fs.renameSync(JOURNAL_FILE, `${JOURNAL_FILE}.1`)
    } catch {
      // 文件还不存在
    }
    fs.appendFileSync(JOURNAL_FILE, `${JSON.stringify(entry)}\n`, 'utf8')
  } catch {
    // 记录失败不许影响流
  }
}

function buildEntry(verdict, facts, config) {
  return {
    at: new Date().toISOString(),
    rule: verdict.rule,
    channel: verdict.channel,
    line: verdict.line ?? null,
    count: verdict.count ?? 0,
    distinct: verdict.distinct ?? 0,
    atChars: verdict.atChars,
    sessionId: facts.sessionId,
    provider: facts.provider,
    model: facts.model,
    ttftMs: facts.ttftMs,
    elapsedMs: facts.elapsedMs,
    chars: facts.chars,
    attempt: facts.attempt ?? null,
    released: facts.released ?? null,
    tail: String(facts.sample ?? '').slice(-240),
    thresholds: {
      minChars: config.minChars,
      window: config.window,
      maxLineChars: config.maxLineChars,
      distinctMax: config.distinctMax,
      longTolerance: config.longTolerance,
      tightWindow: config.tightWindow,
      tightDistinctMax: config.tightDistinctMax,
      tightLongTolerance: config.tightLongTolerance,
      longLineRepeat: config.longLineRepeat,
      skipLineChars: config.skipLineChars,
      hardChars: config.hardChars,
      holdChars: config.holdChars,
      maxAttempts: config.maxAttempts
    }
  }
}

/**
 * 挂上去。
 * @param ctx Cordis 上下文
 * @param patchConfig patch 里那段 config
 */
export function apply(ctx, patchConfig = {}) {
  const config = resolveConfig(patchConfig)
  if (config.enabled === false) return

  const warn = (message) => {
    try {
      if (ctx.logger?.warn !== undefined) ctx.logger.warn(message)
    } catch {}
  }
  const log = (message) => {
    try {
      if (ctx.logger?.info !== undefined) ctx.logger.info(message)
      else warn(message)
    } catch {}
  }

  ctx.on(
    'llm/stream',
    (options, next) => {
      // 运行时开关每请求读一次：出事当场建个空文件就能让路，不用重启
      if (isOff()) return next()
      return guardStream(
        next(),
        options,
        config,
        log,
        (verdict, facts) => {
          if (config.journal !== false) record(buildEntry(verdict, facts, config))
        },
        // 重发通道：再走一遍下游。守卫只在下游「一个字都还没收到」时才用它，
        // 所以这里不需要额外记账；attempt 次数由 guardStream 的 maxAttempts 兜住。
        () => next()
      )
    },
    { global: true }
  )
}
