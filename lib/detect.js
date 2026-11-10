/**
 * 塌缩判据（纯函数，零依赖）。
 *
 * 要抓三形态：
 *   A  短行碎念    `好。` / `写。` / `发。` / `format：好。`   ← V4.1 Flash 这次的病，主目标
 *   B  段落复读    整段推理原样重复三四遍                      ← 长推理模型那种病
 *   C  硬上限      单流累计字符爆掉                            ← 判据全瞎时的兜底
 *
 * 判据来源（拼了四家，全部对着本机 10 份真实会话量过）：
 *   · 天枢 #260   128 行窗口 / 每行 ≤32 字 / 不同短句 ≤4        ← 主判据
 *   · 本机紧判据   48 行窗口 / 不同短句 ≤2                      ← 提前量，早 2/3 开火
 *   · himi-li     次数 + 占比双条件，代码行/结构行不参与
 *   · degen-guard isStructuralLine（不含字的行不算）、长块兜底
 *
 * 为什么窗口要 128 行而不是 8 行：
 *   本机 8747 个正常块实测，48 行窗口最坏能到 72.9% 相似度，128 行窗口最坏只有 7.8%。
 *   窗口拉长是唯一能压住「正常碎念」的一维。窗口扫描：64 行 26 误报、128 行 7 误报（全是漏标真货）、192 行召回掉到 53.7%。
 *
 * 一条护栏，专防误伤：不含字（字母/数字/汉字）的行直接跳过、也不清窗 ——
 * `}`、```、`---`、表格分隔线这类结构性重复不会触发，空行夹在碎念中间也不会把窗口冲掉。
 */

export const DEFAULTS = Object.freeze({
  /** 主判据窗口（行）。 */
  window: 128,
  /** 主判据允许的不同短句种数。塌缩形态是 好/写/发/format：好 四种轮转。 */
  distinctMax: 4,
  /** 主判据窗口里最多夹几条长行（5%）。 */
  longTolerance: 6,

  /** 紧判据窗口（行）：只有一两种短句连打时提前开火。 */
  tightWindow: 48,
  tightDistinctMax: 2,
  tightLongTolerance: 1,

  /** 超过这个长度（字符）的行算「长行」，不进短句窗口。 */
  maxLineChars: 32,
  /** 单行超过这个长度直接跳过（巨型正文行），不参与判据也不清窗。 */
  skipLineChars: 2000,

  /** 段落复读：同一长行在整步里出现这么多次就断。 */
  longLineRepeat: 3,
  /** 长行计数表上限，超了清空重来（防一步几十万行顶爆内存）。 */
  longCountsMax: 4096,

  /** 本步累计这么多字符才开始下判决（太少会拿开场白误判）。窗口照填。 */
  minChars: 400,
  /** 单流累计字符硬上限。超了直接判 hard-cap 掐断 —— 正经的长分析不该一条流吐到二十万字符。 */
  hardChars: 200000,
  /** 围栏看门狗：围栏开着却这么多行都没闭合，就当它没打开（模型吐半个代码块再复读，否则整个守卫全瞎）。 */
  fenceMaxLines: 200,

  /** 盯哪些通道。reasoning 先塌，text 也会塌，两条都盯。 */
  watch: Object.freeze(['reasoning-delta', 'text-delta'])
})

const HAS_WORD = /[\p{L}\p{N}]/u

// 归一化的宽度映射：半角标点折成全角，免得「好。」和「好.」、「format：好」和「format:好」算成两种。
const WIDTH = new Map([
  [',', '，'], ['.', '。'], [':', '：'],
  [';', '；'], ['!', '！'], ['?', '？']
])

// 代码行 / 表格行 / 格式行：命中就不进窗口（himi-li CODE_LINE 的简化版）。
// 不检测这类行是故意的——代码块里重复的行太多，误杀代价比漏报高。
const CODEISH = new RegExp(
  [
    '^\\s*\\|', '^\\s*`{3,}', '^\\s*#{1,6}\\s', '^\\s*>\\s',
    '^\\s*[-*+]\\s', '^\\s*\\d+[.)]\\s', '^\\s*[{}\\[\\]();]+\\s*$',
    '[{};]\\s*$', '=>|->|<=|>=|::|//|/\\*|\\*/',
    '</?[A-Za-z][\\w-]*',
    '\\bdef\\b|\\bfunction\\b|\\bimport\\b|\\bclass\\b|\\breturn\\b|\\bconst\\b|\\blet\\b|\\bvar\\b'
  ].join('|'), 'u'
)

/**
 * 行归一化：折标点宽度、只留含字内核。
 * 「好。」「**好** ✓」「（好）」都归到同一个 key，形态 B 才抓得住。
 * 返回空串 = 不含字的行（结构行），不进窗口。
 */
function lineKey(raw) {
  const t = raw.trim()
  let out = ''
  for (const ch of t) {
    const fold = WIDTH.get(ch)
    const c = fold === undefined ? ch : fold
    if (HAS_WORD.test(c)) out += c
  }
  return out
}

function isCodeish(raw) {
  return CODEISH.test(raw)
}

/** 一个通道的判据状态。 */
function createChannelState() {
  return {
    window: [],          // [{ key, long }]
    counts: new Map(),   // key -> 窗口内次数（只算短行）
    longInWindow: 0,
    longCounts: new Map(), // 整步长行计数（段落复读）
    pending: '',
    chars: 0,
    inFence: false,
    fenceLines: 0,
    tripped: null
  }
}

function pushLine(state, raw, config) {
  const s = raw.trim()
  if (s === '') return false
  if (s.startsWith('```')) {          // 围栏行本身切换状态
    state.inFence = !state.inFence
    state.fenceLines = 0
    return false
  }
  if (state.inFence) {                // 围栏里的内容一律不进窗口
    state.fenceLines += 1
    if (state.fenceLines > (config.fenceMaxLines ?? 200)) {
      // 开着几百行都没闭合：多半是吐了半个代码块就开始复读，当它没打开
      state.inFence = false
      state.fenceLines = 0
    }
    return false
  }
  const k = lineKey(s)
  if (k === '') return false                  // 结构行：不计数、不清窗
  if (isCodeish(s)) return false              // 代码/表格/列表行

  const isLong = s.length > config.maxLineChars
  if (isLong) {
    state.window.push({ key: null, long: true })
    state.longInWindow += 1
  } else {
    state.window.push({ key: k, long: false })
    state.counts.set(k, (state.counts.get(k) ?? 0) + 1)
  }
  while (state.window.length > config.window) {
    const old = state.window.shift()
    if (old.long) state.longInWindow -= 1
    else {
      const c = (state.counts.get(old.key) ?? 0) - 1
      if (c <= 0) state.counts.delete(old.key)
      else state.counts.set(old.key, c)
    }
  }
  return !isLong
}

function decide(state, config, channel) {
  const n = state.window.length

  // 紧判据：一两种短句连打
  if (n >= config.tightWindow && state.longInWindow <= config.tightLongTolerance) {
    if (state.counts.size <= config.tightDistinctMax && state.counts.size > 0) {
      return verdict('short-line-tight', channel, state, config)
    }
  }
  // 主判据：压倒性短句
  if (n >= config.window && state.longInWindow <= config.longTolerance) {
    if (state.counts.size <= config.distinctMax && state.counts.size > 0) {
      return verdict('short-line-dominant', channel, state, config)
    }
  }
  return null
}

function verdict(rule, channel, state, config) {
  let top = null
  let topCount = 0
  for (const [k, c] of state.counts) {
    if (c > topCount) { top = k; topCount = c }
  }
  return {
    rule,
    channel,
    line: top,
    count: topCount,
    distinct: state.counts.size,
    atChars: state.chars,
    longs: state.longInWindow,
    windowLines: state.window.length
  }
}

export function createDetector(overrides = {}) {
  const config = { ...DEFAULTS, ...overrides }
  const channels = new Map()
  const stateOf = (channel) => {
    let s = channels.get(channel)
    if (s === undefined) { s = createChannelState(); channels.set(channel, s) }
    return s
  }

  return {
    config,
    get buffer() {
      return Object.fromEntries(
        [...channels].map(([k, v]) => [k, v.window.map((x) => x.key ?? '<长行>').filter(Boolean).join('\n')])
      )
    },
    get chars() {
      let total = 0
      for (const s of channels.values()) total += s.chars
      return total
    },
    get tripped() {
      for (const s of channels.values()) if (s.tripped !== null) return true
      return false
    },

    /**
     * 喂一个 delta。
     * @param {string} channel 例如 `reasoning-delta`
     * @param {string} text
     * @returns {object|null} verdict
     */
    feed(channel, text) {
      if (!config.watch.includes(channel)) return null
      if (typeof text !== 'string' || text === '') return null
      const state = stateOf(channel)
      if (state.tripped !== null) return state.tripped
      state.chars += text.length

      if (state.chars >= config.hardChars) {
        state.tripped = { rule: 'hard-cap', channel, count: 0, distinct: 0, atChars: state.chars }
        return state.tripped
      }

      const parts = (state.pending + text).split('\n')
      state.pending = parts.pop() ?? ''
      if (state.pending.length > config.skipLineChars) {
        state.pending = state.pending.slice(-config.skipLineChars)
      }

      let dirty = false
      for (const part of parts) {
        if (part.length > config.skipLineChars) continue
        if (part.trim().length > config.maxLineChars) {
          // 长行：走整步计数（段落复读），不进短句窗口
          const key = lineKey(part)
          if (key !== '' && !isCodeish(part)) {
            const c = (state.longCounts.get(key) ?? 0) + 1
            if (c >= config.longLineRepeat && state.chars >= config.minChars) {
              state.tripped = { rule: 'paragraph-repeat', channel, line: key.slice(0, 40), count: c, distinct: state.longCounts.size, atChars: state.chars }
              return state.tripped
            }
            if (state.longCounts.size > config.longCountsMax) state.longCounts.clear()
            state.longCounts.set(key, c)
          }
          pushLine(state, part, config)   // 长行占窗口位（会被标成 long），但不计数
          continue
        }
        if (pushLine(state, part, config)) dirty = true
      }

      if (!dirty) return null
      const v = decide(state, config, channel)
      if (v !== null && state.chars >= config.minChars) {
        state.tripped = v
        return v
      }
      return null
    },

    /** 生成结束时调：把没换行的半行也判一次。 */
    flush() {
      for (const [channel, state] of channels) {
        if (state.tripped !== null) continue
        const line = state.pending
        state.pending = ''
        if (!line) continue
        if (!pushLine(state, line, config)) continue
        const v = decide(state, config, channel)
        if (v !== null && state.chars >= config.minChars) {
          state.tripped = v
          return v
        }
      }
      return null
    }
  }
}
