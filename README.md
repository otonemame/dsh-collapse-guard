# 塌缩止血 · dsh-collapse-guard

> 模型吐着吐着开始「好。写。发。好。写。发。」刷屏的时候，把这个流掐掉。

一个 DeepSeek Harness 插件。挂在 `llm/stream` 瀑布上包住上游 chunk 流，扫最近一百多行，发现退化成重复碎念就断流，补一个 terminal `finish(error)`，让这一步以「provider 报错」的样子收场。

**它管什么、不管什么**

- 管得住「一直吐到爆」：一次能救回二十几万字符的垃圾吞吐。
- 管不住「它压根不该塌」：那是模型和参数的事，把 `reasoning_effort` 降下来才是正解。

## 为什么要这么断

不是所有断法都一样：

| 断法 | 后果 |
|---|---|
| 补 `finish(stop)` | agent-loop 当正常结束，半截内容组装成 `assistant/message` 进历史 —— 下一轮模型照着垃圾往下写 |
| `agent.cancel()` | 走 `signal.aborted` 分支，写 `assistant/message` 且 `interrupted:true`，照样进历史 |
| **补 `finish(error)`** | 只写 `assistant/attempt`（没有 surfaceOp，模型看不见），本步不产生 `assistant/message` |

第三种是唯一一条路。本插件走的就是它，`failure.code = STREAM_COLLAPSE`。

这个码**刻意不在 `dsh-llm-retry` 的默认重试集里**（默认只有 `EMPTY_RESPONSE / RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT`）：塌缩是请求本身的属性，重试等于把整个 prompt 再烧一遍。

## 三种形态

| 规则码 | 抓的是什么 |
|---|---|
| `short-line-tight` | **最近** 48 行里不同短句 ≤ 2 种 —— 买的是提前量 |
| `short-line-dominant` | 整窗（128 行）里不同短句 ≤ 4 种 |
| `short-line-cycle` | 5–12 种短句按固定周期原样绕圈（Write / Execute / Run / Test / Done） |
| `short-line-spread` | 种数更多、但最多那种占一半以上（偏斜型轮转） |
| `paragraph-repeat` | 同一条长行**连着**复读 ≥ 3 次（累计不算，免得误杀时政稿里重复引用的同一句话） |
| `hard-cap` | 单个通道超过 `hardChars`（默认 200000）还在继续 |

不换行的复读（`switch switch switch` 这种中间没有 `\n` 的）会被按标点/空格切成短行，照样进短句判据。

围栏（` ``` `）内的内容不参与判定；超过 `skipLineChars`（默认 2000）的长行跳过且不清窗。

## 命中之后你会看到

界面上是一句出错提示，形如：

```
模型推理通道进入重复塌缩（尾窗只剩 3 种短句，「发。」出现了 42 次，已读到 4403 字符），守卫掐断了本次流。
```

这一轮结束，不会自动重试。再发一句就继续。

## 怎么关

三种，任选：

1. 建一个空文件：`~/.dsh/doudou-collapse-guard/off`（下一个请求就生效，不用重启）
2. 环境变量：`DOUDOU_COLLAPSE_GUARD_OFF=1`
3. 在 DSH 设置里把这个插件关掉

## 怎么改判据

配置优先级：默认值 → `cordis.patch.yml` 的 `config` → 环境变量 `DOUDOU_COLLAPSE_GUARD_CONFIG`（JSON）。

| 键 | 默认 | 说明 |
|---|---|---|
| `window` | 128 | 主判据窗口行数。**这是拐点**：64 行误报多，192 行召回掉到 53.7% |
| `distinctMax` | 4 | 主判据允许的不同短句种数 |
| `distinctSpreadMax` | 8 | 放宽档：种数到这么多也报（要配合周期或占比） |
| `distinctSpreadShare` | 0.5 | 放宽档要求「最多那种」占全部短句的比例 |
| `fenceMaxLines` | 200 | 围栏看门狗：开着这么多行还没闭合，就当它没打开 |
| `longTolerance` | 6 | 窗口内允许混几条长行 |
| `tightWindow` | 48 | 紧判据窗口 |
| `tightDistinctMax` | 2 | 紧判据允许的不同短句种数 |
| `tightLongTolerance` | 1 | 紧判据允许的长行数 |
| `maxLineChars` | 32 | 超过这个长度算「长行」，不计入短句统计 |
| `skipLineChars` | 2000 | 超过这个长度整行跳过（多半是工具输出） |
| `longLineRepeat` | 3 | 同一条长行重复几次算段落复读 |
| `minChars` | 400 | 总字符数不到这个数不判 |
| `hardChars` | 200000 | 单通道硬上限 |
| `watch` | `['reasoning-delta','text-delta']` | 盯哪几条通道；只想管推理就删掉后面那条 |
| `enabled` | `true` | 设 `false` 等于不挂 |
| `journal` | `true` | 设 `false` 不写交接记录 |

例：只想管推理通道，跑

```
DOUDOU_COLLAPSE_GUARD_CONFIG={"watch":["reasoning-delta"]}
```

## 交接记录

一次开火一行 JSONL，落在 `$DSH_HOME/doudou-collapse-guard/fires.jsonl`（`DSH_HOME` 没设就是 `~/.dsh`）。超过 512 KB 自动轮转成 `.1`。

每行带：时间、规则码、通道、行号、次数、种数、所在字符位置、sessionId、provider、model、首字延迟、耗时，以及**当时生效的全部阈值** —— 事后要回校判据，靠的就是这一份。

```json
{"at":"2026-11-10T12:56:40.826Z","rule":"paragraph-repeat","channel":"reasoning-delta","line":null,"count":3,"distinct":20,"atChars":4403,"sessionId":"…","model":"deepseek-flash","thresholds":{…}}
```

## 已知边界

- 段落复读的日志 `tail` 里长行会显示成 `<长行>` 占位符，看不出具体在复读哪一段。
- 只读流，不改判据之外的任何东西，不碰历史，不碰会话文件。

## 装法

```
plugin_manager install_bundle target="github:otonemame/dsh-collapse-guard"
```

或在 `cordis.patch.yml` 里手动插一条 `dsh-mcp-client` 那样的条目，`name` 写 `doudou-collapse-guard`。

## 许可

MIT
