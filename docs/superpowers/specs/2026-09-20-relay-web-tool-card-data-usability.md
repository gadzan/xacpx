# Relay Web Tool Call 卡片数据可用性优化设计

日期：2026-09-20
状态：提案（已过一轮子代理事实核查与设计审查，审查发现已回写）

## 背景与目标

Relay Web 的 tool call 卡片在真实使用中「分辨不出 agent 在做什么」：

- 连续 Read / Edit / Bash 全部只显示一个工具名，展开后正文与标题重复；
- 进行中的工具永远转圈，没有任何耗时；
- 失败的步骤只剩一个红色三角，看不到失败原因；
- Kimi 会话的 Grep 显示成「查阅」并带错误的文件扩展名角标，TodoList 变成一条噪音卡；
- 输出的截断、命中数等结构化元数据全部丢弃。

本设计不改动卡片视觉语言（2026-09-08 去卡片化已定稿），只修**数据到 UI 之间丢失的信息**与**冗余帧的广播成本**。

### 非目标

- 不重做卡片视觉 / 不引入新的卡片形态。
- 不改 acpx 上游（ACP `tool_call_update` 的稀疏帧语义是既定事实，本设计在 xacpx 侧适配）。
- 不做相邻 read/search 工具聚合（「查阅 · 1 搜索」），已由 2026-09-07 trace 折叠设计列为后续项。
- 不改 Feishu / Discord / WeChat 频道的工具呈现（`channel-feishu` 的 `ToolUseStore` 有独立的 `startedAt`/`durationMs` 派生逻辑，不受影响）。

## 证据基础

以下数据全部来自本机真实 agent 会话日志 `~/.acpx/sessions/*.stream.ndjson`（OpenCode 1.18.10 与 Kimi Code CLI），以及 xacpx 仓库现有代码路径。所有统计量均由全量遍历得出，非抽样。

### 帧密度与到达时序（Kimi 会话 session_3c29b67e，307 次工具调用）

| 观测 | 数值 | 口径 |
|---|---|---|
| 工具帧总量 | 8745 = 307 `tool_call` + 8438 `tool_call_update` | 按 `params.update.sessionUpdate` 计数 |
| 每工具帧数 | 均值 28.5，p50 10，p90 32，最大 2468 | 含初始帧，即 (updates+1) |
| 富信息帧（同时带 kind + title 且带 rawInput/rawOutput 之一）的相对到达位置 | p10 = 0.67，p50 = 0.80，p90 = 0.95 | `index/(n-1)`；按 `index/n` 则为 0.57/0.70/0.92 |
| 初始 `tool_call` 帧的 rawInput | 307/307 为空 | pending 阶段标题只能是裸工具名 `Bash`/`Edit` |
| 每工具的 title 变体数 | 301/307 有 2 个（工具名 → 人话描述），6 个只有 1 个 | 非空 title 去重 |
| 中途帧内容形态 | `content[].content.text` = 逐渐变长的参数 JSON 串 | 例：`{"path":"packages` → `{"path":"packages/relay-web/src/components/NewSess` |

大会话（session_bb859b52，Kimi，仅统计当前活跃 segment）：33522 `tool_call_update` / 103 个 toolCallId（102 个初始 `tool_call` 帧），均值 325.5 帧/工具。

含义：一个 Bash 跑到 80% 时 UI 才拿到命令原文；中途帧携带的是**参数 JSON 的增量字符串**，被当作输出流式刷进卡片。

### Kimi 的 diff block 到达位置（关键，直接决定 P0-2 的写法）

对 30 个 Kimi Edit 逐一遍历：

| 观测 | 数值 |
|---|---|
| 最终出现 diff block 的 Edit 数 | 30/30 |
| **最后一个 diff block 所在帧** | **全部是倒数第二帧（`in_progress`），距终帧距离 = 1，30/30** |
| 终帧（`completed`）携带的内容 | `Replaced N occurrence(s) in <path>` 文本 + rawOutput，**无 diff block** |
| 首个 diff block 的相对位置 | min 0.78，p50 0.90，max 1.00（`index/n`） |
| 2468 帧的那个 Edit | 首个（也是唯一）diff block 出现在 index 2466，终帧 2467 |

OpenCode（ses_04759）的 `content` 中 **没有任何 diff block**（其 edit 走 `rawOutput.metadata.diff` / `rawOutput.metadata.files`，仅 1 例）。

**这条证据推翻了「终帧必定携带 diff」的假设**：diff 出现在 `in_progress` 的倒数第二帧，而非终帧。任何丢弃中间帧 `content` 的逻辑都必须按帧的 status/位置精细判断，不能按「只留终帧」一刀切。

### 驱动差异化

| 观测 | 数值 |
|---|---|
| Kimi 工具 → kind 映射（初始帧即带 kind） | Bash→execute（206/206）、Edit→edit（30/30）、Read→read（27/27）、**Grep→read（20/20，错误）**、TodoList（19）/FetchURL（2）/AskUserQuestion（2）/TaskStop（1）→other |
| Kimi Bash 终态帧 | 206/206 为 `content=[{type:"terminal",terminalId}]`，无 rawOutput |
| OpenCode 终态帧携带 `kind` | 1 / 94 |
| OpenCode `rawOutput.metadata` 可用字段频次 | `truncated:93, exit:40, matches:19, outputPath:11, todos:4, diff:1, files:1, diagnostics:1, count:3` |
| Kimi todo 项的 status 取值 | `done:53, pending:29, in_progress:16`（**ACP 没有 `done`，只有 `pending/in_progress/completed`**） |
| Kimi TodoList 的 rawInput | `{todos:[{title,status}]}`，19/19 各只有一帧携带完整列表 |
| `ToolUseEvent.durationMs` 的生产者 | `src/transport` 与 `src/bridge` 全路径 0 个 |

含义：Kimi 的 `rawInput.todos=[{title,status}]` 与 Cursor TodoWrite 结构同构（字段名与 status 词表不同），但被 `normalizeCursorPlanUpdate` 的 `state.driver !== "cursor"` 挡死，只能沦为 `other` 噪音卡。

### 代码侧确认

- `durationMs` 在 `src/channels/types.ts:331` 声明了「Set when status transitions out of "running"」，但 `buildToolUseEvent`（`src/transport/streaming-prompt.ts:435` 签名）与 `mapRuntimeToolEvent`（`src/bridge/engine/runtime-engine.ts:3020`）都不赋值。**Runtime 引擎是第二个独立的 ToolUseEvent 构造点，CLI 与 Runtime 两条链路都必须改。**
- 卡片正文重复标题：`toolUseEventToStepDto`（`packages/channel-relay/src/tool-presentation.ts:217`）对 read/execute/search/edit 四类把同一字符串同时写进 `title` 与 detail 主字段，`ToolDetail.vue` 又原样打印。
- 失败原因丢失：`errMsg` 的实际回退顺序（`tool-presentation.ts:236-238`）是 `rawOutput.error → rawOutput.message → textFromBlocks(blocks) → rawOutput.output → rawOutput.text → formatted_output → rawOutputText`，而 `{type:"terminal"}` block 在 `textFromContentBlock`（`:43-58`）的 default 分支返回 `undefined`，导致 Kimi `9:call_j3bu7654qhe1gtmrbqwburoo`（35 帧全程无 rawOutput，终帧只有 terminal block）只剩红三角。
- 帧全量广播：`parseStreamingChunks` → `onToolEvent`（每帧）→ control `tool-event`（每帧）→ hub `capToolStep` + broadcast（每帧）→ web `upsertTool`（每帧）。2468 帧的连续广播无任何一层合批。
- `turn-usage` 事件带 `cost.amount`（ses_04759 实测 0.008556584999999998 / 0.0249013 / 0.0411 / 0.0513 USD **递增**，`src/transport/types.ts:19` 注释口径为 session 累计），但 `UsagePopover` 只展示累计值。
- `MessageRecordDto.structured` 当前无 usage 字段（`packages/relay-protocol/src/dtos.ts:375-378`），单回合成本无法跨 reload 存活。

## 问题清单与方案

优先级：P0 = 直接造成「看不清 / 看不见」，P1 = 明显的体验缺口，P2 = 锦上添花与成本。标注 **[BLOCKER-修正]** 的是子代理审查推翻或修正了初版写法的条目。

### P0-1 卡片正文重复标题

**现象**：read 卡展开后第一行是 path，标题栏也是 path；command 卡展开后 `$ npm test` 与标题完全一致。

**方案（已按落地修正）**：在**连接器侧**丢弃只会复述标题的 detail，而不是在 `ToolDetail.vue` 里做展示层去重。

原设计写的是给 `ToolDetail.vue` 加 `title?: string` prop 并由三个调用方传入。落地时发现 `origin/main` 已独立实现了同一目标且机制更彻底：连接器在派生 title 时就知道它会与 detail 主字段重复，因此**直接不产生该 detail**，连空抽屉一起去掉。两套机制做同一件事必然互相打架（实测保留 UI 侧去重会打挂对方的 4 个既有测试），故采纳连接器方案作为唯一实现：

- `toolUseEventToStepDto` 在 read/edit/execute/search 四个分支判断「detail 除主字段外是否还有内容」，没有则整体省略 detail（`SubagentTraceDialog` 因此无需改动）。
- `ToolDetail.vue` 保持**纯渲染器**，不引入 title prop，不感知标题——单一机制让所有消费方受益，而不是只有接了 prop 的三处。
- 已知残余：`think` / `fields` 变体不参与去重（其主字段是自由文本/多字段，与 title 不同源，强行去重会误删）。

**边界**：search 分支的 echo guard 放行「无 output 文本但 driver 报告了 `count`/`truncated`」的情况——那是元数据不是回显，随 detail 一起丢掉会让命中数丢失（rebase 时发现的真 bug，已修）。

### P0-2 中途帧把参数 JSON 当输出流式刷出 **[BLOCKER-修正]**

**现象**：展开进行中的 read/edit 卡，正文是 `{"path":"packages/relay-web/src/components/NewSess…` 的残破 JSON，随帧增长。

**初版方案的错误**：初版写「对 `in_progress` 帧丢弃 `content`，终帧保留即可」。证据表已证明 **Kimi 的 diff block 在倒数第二帧（`in_progress`），终帧没有**——按初版实现会删掉全部 30/30 个 Kimi Edit 的 diff。

**修正后方案**：不按「mid vs terminal」二分，改为按帧内容判断：

1. **保留** `content` 中含 `{type:"diff"}` block 的帧（这是 diff 的唯一来源，无论它在第几帧）。
2. **保留** `content` 中含可提取 agent_send 回执的文本帧（`extractAgentMessageId` 依赖它，见下）。
3. **丢弃** `content` 仅为 `{type:"content", content:{type:"text"}}` 且文本是参数 JSON 增量形态的中间帧。
4. 其余（terminal block、text 摘要）照常合并。

判据 3 的落地方式：只在该帧 `status === "in_progress"`、无 diff block、且**同一 `toolCallId` 的后续还会来帧**时才丢——但「后续还会来帧」需要预知。更稳妥的等价实现：**不丢弃，改为「该帧的 text content 若与已合并 `rawInput` 序列化结果的前缀一致则视为冗余」**，即只在 `content` 是参数回显时才丢。实现时二选一，倾向后者（无需预知未来帧）。

**[BLOCKER-修正] 必须同时改三处合并点**，否则 Runtime 链路行为不一致：

| 合并点 | 文件 |
|---|---|
| CLI 链路 | `src/transport/streaming-prompt.ts:394` `mergeToolCallUpdate` |
| Runtime 链路 | `src/bridge/engine/runtime/runtime-tool-call-merge.ts:61` `normalizeRuntimeToolCallEvent`（`content` 用 `isEmptyToolField` 判存，同样会把参数 JSON 累进快照） |
| Runtime 事件映射 | `src/bridge/engine/runtime/runtime-adapter.ts:286`（透传 `event.content`） |

**已核查安全的消费方**（不会因丢弃参数回显而受损）：Cursor plan 归一化只读 `rawInput`/`rawOutput`（`streaming-prompt.ts:581-582`）；Claude `_meta.claudeCode.toolResponse` 走 `rawOutput`；Codex `_meta.codex.subagent` 走 `_meta`；legacy TEXT 渲染用**原始 `update`** 而非 merged 值（`streaming-prompt.ts:256` `formatToolCallEvent(update, …)`）；`channel-feishu` 的 `ToolUseStore` 只读 status/summary/durationMs/isSubagent/parentToolCallId。

**真实风险（须保留终帧 content）**：`extractAgentMessageId` 的多个分支依赖 `content` 里的 text block 与版本化回执标记；若某驱动的终帧只把回执放在 `content` 而后续没有更丰富的帧，丢弃会静默丢掉 `agentMessageId`，导致发送卡错位。因此判据 2 不可省。

**附带收益（修正表述）**：初版写「把每帧 `{...prev}` 的对象展开从 8745 次降到只覆盖有变化的字段」——**不成立**，`{...prev}` 在 `:400` 无条件执行，与是否吸收 `content` 无关。真实收益是：中途巨型 JSON 串不再进入合并累加器与后续 DTO，内存与序列化体积下降。

### P0-3 失败原因不可见

**现象**：Kimi Bash 失败后卡片只有一个红三角，展开无任何文字；用户必须去终端翻日志。

**方案（两层）**：
1. **立即层（纯 xacpx）**：`textFromContentBlock` 对 `{type:"terminal"}` 返回 `[terminal] <id>` 而非 `undefined`，让 `errMsg` 至少拿到一条线索；同时把 `terminalId` 透传进 `ToolStepDto`（新可选字段），卡片显示「终端输出由 agent 侧持有，未随卡片回传」。
2. **完整层（待验证，不阻塞）**：xacpx 持有该 `terminalId` 对应的 `terminal/output` 能力（acpx `TerminalManager`），由 transport 在终态帧补齐输出。**前提是确认 acpx 侧 terminal 生命周期覆盖 prompt 结束**——`TerminalManager.releaseTerminal` 存在，若 agent 在终帧前已 release 则取不到输出，只能做第 1 层。

### P1-1 进行中的工具没有计时 **[BLOCKER-修正]**

**现象**：长 Bash / 长 Edit 永远只显示转圈，无法区分「刚开始」与「卡了 5 分钟」；`turnIdleTimeoutSeconds`（默认 600s，见 `docs/config-reference.md`）超时前用户没有任何预期。

**方案**：
- **first-seen 记录位置**：`buildToolUseEvent`（`:435`）是纯函数，无 state 无时钟，不能在那里记时间。修正为：在**合并层**（`mergeToolCallUpdate` / `normalizeRuntimeToolCallEvent`）首次见到某 `toolCallId` 时写入一个 side map（`toolFirstSeen: Map<string, number>`，与 `toolCalls` 同生命周期，随 prompt 结束销毁），再把 first-seen 值作为参数传给两个 `ToolUseEvent` 构造点（CLI 的 `buildToolUseEvent` 与 Runtime 的 `mapRuntimeToolEvent`）。
- **durationMs 生产**：仅当 status 由 running 迁移到终态时计算 `now - firstSeen`；已经是终态的首帧（罕见）记 0。
- **协议**：`ToolStepDto` 新增 `startedAt?: number`（hub/connector 时钟 epoch ms），供 web 侧对 running 状态显示递增 elapsed。注意 `MessageRecordDto` 已有同名 `startedAt`（回合级），`ToolStepDto.startedAt` 是**步骤级**，命名冲突需在 DTO 注释中明确区分，避免误读为回合开始时间。
- **web**：`ToolStepCard.vue` 在 `status === "running"` 时用本地 1s 时钟显示 elapsed，终态显示服务端 `durationMs`。legacy 聚合面板 `ToolCallPanel.vue` 同样补 running elapsed（它的行没有 running 态渲染分支，需新增）。两处时钟抽到 `lib/use-live-elapsed.ts`：`useLiveElapsed`（单卡）与 `useLiveElapsedClock`（面板级，一个列表一个 interval），并共享 `formatStepDuration`。
- **不替换** `SubagentStepCard.vue` 自建的时钟逻辑（它还需要 heartbeat，且无 wire 时间戳可依）。

**Runtime 链的落地陷阱（PR #357 审查发现，已修）**：`firstSeen` 必须在**类型契约**里显式存在。`XacpxRuntimeEvent` 的 `tool_call` 变体原本没有 `firstSeen` 字段——合并层返回的 snapshot 对象运行时带着它，但结构类型不含，任何一处重新塑形该事件的地方都会静默丢掉它，导致 Runtime 链路 `durationMs` 永不生产而 CLI 链路正常（极难发现的单边失效）。修复是把 `firstSeen?: number` 加进 `runtime-contract.ts` 的 `tool_call` 变体，让丢失它成为类型错误。同理，Runtime 侧「终态但无 firstSeen」最初返回 `undefined`，与 CLI 的 `0` 不一致，已对齐为 `0`。

**校验**：`web-dtos.ts` 的 `validToolStep` 补 `startedAt` 的 `finiteNonNegative` 检查；`validStateSyncParts` 路径同样覆盖（state-sync 的 parts 会带 step）。

**跨机时钟**：`startedAt` 仅用于 running 计时；终态用 `durationMs`（同机测量）；持久化的 `startedAt` 不参与任何排序（slot 锚点仍是 `slotAfterId`）。

### P1-2 Kimi 工具归一化 **[BLOCKER-修正]**

**现象**：Grep 渲染成「查阅」+ 扩展名角标；TodoList 变成 `other` 噪音卡，而 Cursor 的同类工具会进 PlanPanel。

**修正点 1——driver kind 表必须置于适配器 kind 之前。** `normalizeToolKind`（`streaming-prompt.ts:703-707`）先 `switch (kindRaw)` 直接放行任何合法 ACP kind，`if (driver !== "cursor") return "other"` 之后才是 Cursor 表。Kimi 的初始帧**已经盖了 kind**（Grep=read 20/20），所以初版「在 Cursor 表旁加一张 Kimi 表」的位置**永远不可达**。修正：把驱动表查询提到 `kindRaw` 放行之前，仅当驱动表命中时才覆盖；未命中仍走原有逻辑（避免破坏已正确的 Bash/Edit/Read 映射）。

Kimi 表：`Grep|Glob|Search→search`、`Read→read`、`Edit→edit`、`Bash→execute`、`TodoList→think`、`FetchURL|WebFetch→fetch`、`AskUserQuestion→other`、`TaskStop→other`。驱动各自隔离，避免跨驱动误判（Cursor 的 `StrReplace` 与 Kimi 的 `Edit` 不应混表）。

**修正点 2——Kimi plan 工具的身份与状态词表都不同。**
- Kimi 的 plan 工具有两个 title：`TodoList` 与 `Updating todo list`，**都不在 `CURSOR_PLAN_TOOL_NAMES` 里**；需为 kimi 单列 plan 工具名集合。
- Kimi todo 项是 `{title, status}`（Cursor 是 `{content, status, priority?}`），`title → content` 映射。
- Kimi 的 status 用 `done`（53/98 观测），**ACP `PlanEntryDto.status` 只接受 `pending/in_progress/completed`**，必须 `done → completed`。
- Kimi 每条 `Updating todo list` 都带**完整列表**（19/19 观测到恰好一帧带 todos），语义是全量替换；Cursor 才有 `merge:true` 增量。共享 `state.cursorPlanEntries` 累加器 + merge 分支会让 Kimi 留下陈旧条目。修正：kimi 分支强制 clear-then-set，并把累加器按驱动拆开（或传 replace 标志）。

**边界**：`{todos:[]}` 的清空调用（观测到 1 例）应清空计划而非被当作 malformed 忽略——Cursor 侧已有此语义（`todos.length === 0 → clear`），kimi 对齐。

### P1-3 截断与命中数等结构化元数据进协议

**现象**：8KB 被截断的命令输出与完整输出视觉上无差别；search 卡的 `searchCount`（数 output 非空行）与 `metadata.matches=19` 打架。

**方案**：
- 协议：`ToolDetailDto` 增加 `truncated?: boolean` 与 `count?: number`（optional，旧 connector / 旧 web 双向兼容）。
- connector：`toolUseEventToStepDto` 从 `rawOutput.metadata.truncated` / `metadata.count` / `metadata.matches` 取值，优先结构化、回落现有行计数。
- web：`ToolDetail.vue` 在 command/search/read 输出块右上角渲染 `19 matches · 已截断` 小标。
- **compact 必须保留**：`compactDetail`（`packages/relay/src/http/compact-history.ts:55-82`）对 command/search/read 是**重建对象**（只保留 command/exitCode、query、path/lines），会静默丢掉新字段；必须在每个重建分支显式带上 `count`/`truncated`，否则历史页回退成「数字行数」。
- **校验**：`validToolDetail` 补两个字段的类型检查（`optBool` / `finiteNonNegative`）。
- **附带 `capTail`**：对 execute/read/search 的 `output`/`preview` 改用 `capTail`（长输出保尾不留头，日志尾部的失败摘要才是用户要看的）。**截断标记不匹配是已确认的坑**：`cap()` 追加后缀 `"\n…(truncated)"`，`capTail()` 追加前缀 `"(truncated)…\n"`，而 `ToolStepCard.vue` 的 `showErrorBanner:98` 和 `diffStats:45` 只匹配后缀那一种。修正：把标记提为共享常量（connector 与 web 各一份，值必须一致），`showErrorBanner` / `diffStats` 改为双向匹配。

### P2-1 每帧全量广播

**现象**：2468 帧连续广播，流式滚动时主线程被工具帧占满。

**方案**：微批。仅当帧**改变卡片外观**时才发布——首次拿到 title、status 迁移、内容增量超过阈值（如 512 字符）。

**[BLOCKER-修正] 批处理不能放在 transport 层。** `streaming-prompt.ts` 是逐帧的解析器，没有回合边界概念，无法保证 flush 时机。修正：批次逻辑放在 **transport 之上的回合边界层**（`src/control/session-turn-runner.ts` 的 `onToolEvent` 回调处包一层），或在 hub 侧合批。硬约束：

- 终态帧（completed/failed）同步直通，绝不进批——否则 spinner 悬挂。
- `turn-finished` 的**所有**路径（ok / error / cancelled）都必须按 FIFO 顺序 flush 待发布集合，否则最后几步丢失或乱序。
- Cursor plan 工具路径（`consumedAsPlan`）不参与微批，保持逐帧替换语义。
- 合批不得改变首次插入顺序——`pushToolPart`（hub `server.ts:369`、state-mirror `:181`）与 web `upsertTool` 都依赖到达顺序构建 `parts`，乱序会连带影响 `MAX_TOOL_STEPS` 的取舍（谁被截断会变）。

### P2-2 稀疏终态帧的标题回退链

**现象**：OpenCode grep 的终态 title 被换成正则本身，glob 终态连 title 都没有；Kimi 的 title 会从 `Bash` 漂移到 `Running: ls …`。

**方案**：把标题派生优先级固化为与 kind 派生解耦的独立函数：

```
locations[0].path
→ kind 专用 rawInput 字段（execute=command，read=file_path，search=pattern + path 组合）
→ event.summary
→ 适配器 title
```

**[BLOCKER-修正] 不可简单「钉死」标题。** web DTO 的标题已经从 `rawInput` 派生（`tool-presentation.ts` 的 read/execute/search 分支就是 `title = path/command/query`），若在 transport 层也钉死，会连带破坏三处：

- `buildToolUseEvent` 的 `summaryRaw !== title` 去重（`:449-450`）——钉死后 summary 恒等于 title，think/other/fields 三类工具的 summary 会被全部吞掉；
- Feishu 卡片与 legacy TEXT 渲染的 `toolName: summary` 后缀（`tool-use-text-format.ts`）；
- Kimi `Bash → Running: …` 的实时进度感（这是有价值的信息，不是噪音）。

修正：**保留现有优先级链**，只做一件事——当适配器 title 明显退化（为空、等于工具名本身、或等于裸正则/裸路径而 `rawInput` 里有更具体的字段）时，用 `rawInput` 专用字段替代。`summarizeToolInput` 的所有调用点随之一起调整，避免去重逻辑失真。

### P2-3 折叠 trace 头只报数不报事

**现象**：成功回合默认折叠（`TurnParts.vue` 的 `headerLabel`），一个 30 步回合折叠后只剩「已工作 4分32秒 · 30 步工具 · 5 段思考」，用户不知道改了哪些文件。

**方案**：`extractCollapsedTraceSummary`（`packages/relay-web/src/lib/turn-presentation.ts:294`）多产出一段聚合文案，从 `presentation.nodes` 统计：`编辑 3 个文件`、`运行 12 条命令`、`搜索 5 次`，以及失败步数（红色小标）。数据已在手，不新增 wire 字段。

**注意**：`i18n-parity.test.ts` 要求 en/zh 键集合完全一致，新键必须同批加入两个语言文件；`turnparts-collapse.test.ts` 现有断言钉住了 `headerLabel` 的文案，需同批更新。

### P2-4 每回合成本只在累计值里

**现象**：`turn-usage` 已带 `cost.amount`，但只有 UsagePopover 展示累计。

**[BLOCKER-修正] 初版漏了持久化。** `MessageRecordDto.structured` 没有 usage 字段，任何 footer 小标在 reload 后都会消失。修正：先加 `structured.usage?`（该回合的 `{used,size,cost,breakdown?}` 快照），在 hub 的 `turn-finished` flush 处盖章，footer 从持久化字段渲染；`compact-history.ts` 保留该字段（它很小，不需要压缩）。前置依赖未落地前，此项不做。

**另需修正口径**：观测到的 `cost.amount` 随回合递增（0.0086 → 0.0249 → 0.0411 → 0.0513 USD），`src/transport/types.ts:19` 的口径是 **session 累计**，不是「本回合花费」。要做单回合增量必须自己差分，且跨 reload 的基线会丢。建议先只做 token 增量（`used` 差分在会话内可靠），成本增量列为待评估。

## 协议层改动汇总

| 位置 | 改动 |
|---|---|
| `src/channels/types.ts` `ToolUseEvent` | 无新字段（`durationMs` 已存在，只需生产） |
| `src/transport/streaming-prompt.ts` | 合并层丢弃参数回显型 mid content（保留 diff block 与回执帧）；`toolFirstSeen` side map；生产 `durationMs`；驱动 kind 表前置；plan 工具驱动解耦 + kimi replace 语义；标题退化替代 |
| `src/bridge/engine/runtime/runtime-tool-call-merge.ts` | 同上合并层逻辑（**独立第二处，必须同步改**） |
| `src/bridge/engine/runtime/runtime-adapter.ts` | 透传 first-seen 与合并后的 content 判断 |
| `src/bridge/engine/runtime-engine.ts` | `mapRuntimeToolEvent` 接收 first-seen，生产 `durationMs`（**独立第二个 ToolUseEvent 构造点**） |
| `packages/relay-protocol/src/dtos.ts` | `ToolStepDto.startedAt?`、`ToolStepDto.terminalId?`、`ToolDetailDto.truncated?`、`ToolDetailDto.count?`、`MessageRecordDto.structured.usage?`（P2-4） |
| `packages/relay-protocol/src/web-dtos.ts` | `validToolStep` / `validToolDetail` / `validStateSyncParts` 补上述字段校验 |
| `packages/channel-relay/src/tool-presentation.ts` | search 结构化 count、truncated 透传、execute/read/search 的 output 改 `capTail`、terminalId 透传、截断标记常量化 |
| `packages/relay/src/http/compact-history.ts` | compact search/command/read 时保留 `count`/`truncated`；保留 `structured.usage` |
| `packages/relay-web/src/components/*` | 正文去重（`ToolDetail` 加 title prop + 三处调用方）、running elapsed（`ToolStepCard` + legacy `ToolCallPanel`）、truncated 标记、折叠头动词摘要 |

## 执行顺序

1. **P0-1**（web 展示 + `ToolDetail` title prop，零协议）——可立即独立验证。
2. **P0-2**（两处合并点 + Runtime 链路）——**必须在 P0-1 之后或同批**：P0-1 让正文不再重复标题，P0-2 减少噪音内容，两者叠加才是「干净的卡片」；单独上 P0-2 会让卡片更空。实现时严格保留 diff block 帧与回执帧。
3. **P1-2**（kimi 归一化：kind 表前置 + plan 驱动解耦）——数据收益最大，改动集中在 `streaming-prompt.ts`。
4. **P1-1**（durationMs + startedAt，两条链路 + 协议三层 + 两个 web 组件）。
5. **P0-3 第 1 层**（terminal block 降级 + terminalId 透传）——第 2 层待确认 acpx terminal 生命周期后再评估。
6. **P1-3**（count/truncated/capTail）——connector + validator + compact 必须**同批原子落地**，任一部分单独上都会造成「live 有标记、历史没有」或反之的不一致。
7. **P2-1 / P2-2 / P2-3**，最后 **P2-4**（依赖 usage 持久化）。

## 验证覆盖（提案要求）

- **P0-1**：`tooldetail.test.ts` 增加「detail 主字段与 title 相同时不渲染主字段行」用例（覆盖 diff/read/command/search 四变体，text 变体断言不参与）；`toolstepcard.test.ts` 断言展开后正文不含重复 path；`ToolDetail` 不传 title 时行为不变（向后兼容）。
- **P0-2**：`streaming-prompt` 单测——一个 Kimi Edit 帧序列（pending → N 个参数 JSON content → 倒数第二帧带 diff block → 终帧 text+rawOutput），断言最终事件**仍带 diff**、且 mid 参数帧的 `rawInput` 仍被正确合并；agent_send 回执帧不被丢。Runtime 侧 `runtime-tool-call-merge.test.ts` 同等用例。
- **P1-1**：CLI 与 Runtime 两条链路各自断言 running→completed 产出非零 `durationMs`；`web-dtos.test.ts` 拒绝负数 `startedAt`；`toolstepcard.test.ts` 与 `toolcallpanel.test.ts` running 态渲染 elapsed。
- **P1-2**：kimi 驱动下 `Grep → search`、`TodoList → onPlan`（而非 `onToolEvent`）、`done → completed`、`{todos:[]}` 清空计划；Cursor 侧行为零回归。
- **P0-3**：`toolstepcard.test.ts` 失败态仅有 terminal block 时渲染可见提示（而非空红框）。
- **P1-3**：`tool-presentation.test.ts` 结构化 count/truncated 透传；`compact-history` 单测断言压缩后 count/truncated 保留；`showErrorBanner` 对 `capTail` 前缀标记同样生效。
- **P2-3**：`turnparts-collapse.test.ts` 断言折叠头含动词摘要与失败步数；`i18n-parity.test.ts` 绿。
- **回归**：`streaming-prompt-tool-events`、`runtime-fanout`、`runtime-tool-call-merge`、`toolcallpanel`、`subagentstepcard`、`chatpane`、`messagelist`、feishu 卡片测试全绿。
- **端到端**：真实 Kimi 会话跑一条 Bash（长输出）+ 一条 Grep + 一次失败命令 + 一次 Edit，逐项核对卡片。

## 风险

| 风险 | 缓解 |
|---|---|
| P0-2 丢弃 mid content 可能弄丢 diff | **已证实是真实风险**（Kimi diff 在倒数第二帧）：判据 1 显式保留含 diff block 的帧，不得按「只留终帧」实现 |
| P0-2 丢弃 mid content 可能弄丢 agent_send 回执 | 判据 2 显式保留可提取回执的帧；`extractAgentMessageId` 增加单测覆盖「回执只在中间帧」的构造 |
| P0-2 只改 CLI 合并点，Runtime 链路行为不一致 | 三处合并点同批改，Runtime 侧补同等用例 |
| P1-1 跨机时钟偏差 | `startedAt` 仅用于 running 计时；终态用 `durationMs`（同机测量）；持久化 `startedAt` 不参与排序 |
| P1-1 命名冲突 | `ToolStepDto.startedAt`（步骤级）与 `MessageRecordDto.startedAt`（回合级）在 DTO 注释中明确区分 |
| P1-2 驱动表覆盖已正确的映射 | 驱动表查询前置但**仅命中才覆盖**，未命中走原逻辑；Cursor 侧加零回归断言 |
| P1-2 Kimi 全量语义污染 Cursor 增量累加器 | 累加器按驱动拆分或传 replace 标志；kimi 强制 clear-then-set |
| P1-3 `capTail` 改变截断标记方向 | 标记提为共享常量，`showErrorBanner`/`diffStats` 双向匹配 |
| P1-3 新字段在 compact 后丢失 | `compactDetail` 每个重建分支显式保留，单测钉住 |
| P2-1 微批延迟或乱序 | 阈值 100–150ms；终态帧同步直通；批次置于回合边界层并按 FIFO flush；不得改变首次插入顺序 |
| P2-2 钉死标题破坏 summary 去重 | 不钉死，只做「退化标题替代」；`summarizeToolInput` 调用点同步调整 |
| P2-4 成本口径是累计非增量 | 先只做 token 增量；成本增量需自差分且跨 reload 基线丢失，列为待评估 |
| 协议加字段影响旧实例 | 全部 optional；`web-dtos.ts` 对缺失字段放行，与 `parentToolCallId`/`durationMs` 同款 |

## 审查记录

2026-09-20 子代理审查（两路并行：事实核查 + 设计审查）推翻/修正了初版 5 处实质错误：

1. **「终帧必定携带 diff」错误** → 实测 Kimi 30/30 的 diff 在倒数第二帧，P0-2 一刀切会删掉所有 Kimi Edit 的 diff。已改为按帧内容判据。
2. **Kimi kind 表不可达** → `normalizeToolKind` 先放行适配器 kind，驱动表必须前置。
3. **只改 CLI 合并点** → Runtime 有独立的第二处合并（`runtime-tool-call-merge.ts`）与第二个 `ToolUseEvent` 构造点（`mapRuntimeToolEvent`），都必须同步改。
4. **微批放在 transport 层** → 该层无回合边界，无法保证 flush；移至回合边界层。
5. **P2-4 漏持久化 + 成本口径错误** → `structured` 无 usage 字段，且 `cost.amount` 是 session 累计非单回合。

另修正若干数据口径：8745 是「tool_call + tool_call_update」总量（update 单项 8438）；2468 帧的那个工具是 Edit 不是 Bash；`errMsg` 回退顺序；`{...prev}` 附带收益表述；Kimi `done` 状态需映射；rich-frame 百分位的分母口径。

---

## 第二轮审查记录（PR #357，2026-09-21）

双轴审查（Standards + Spec）结论：0 硬违反，Spec 4 项偏离（2 partial + 2 wrong）。全部已修：

| # | 级别 | 发现 | 修复 |
|---|---|---|---|
| 1 | Spec-Wrong | **Runtime 链 `durationMs` 永不生产。** `XacpxRuntimeEvent` 的 `tool_call` 变体没有 `firstSeen` 字段，合并层返回的对象运行时带着它但类型不含，重新塑形事件的地方静默丢失 → `mapRuntimeToolEvent` 永远收到 `undefined`。CLI 链正常，形成极难发现的单边失效。 | `runtime-contract.ts` 的 `tool_call` 变体显式加入 `firstSeen?: number`，丢失它现在是类型错误。 |
| 2 | Spec-Wrong | **Runtime 终态无 stamp 返回 `undefined`，CLI 返回 `0`**，两引擎契约不一致。 | 统一为 `0`，并在注释中说明「running=未知时长」与「terminal+无 stamp=瞬时」的区分。 |
| 3 | Spec-Wrong | **kind 表漏 `updatingtodolist`。** Kimi 的 plan 工具有两个 title；表中只有 `todolist`，反而混进了 Cursor 专属的 `updatetodos`。`Updating todo list` 帧在无 `onPlan` 的回退路径下 kind 会在 think↔other 间跳变。 | 补 `updatingtodolist: "think"`，移除不属于 kimi 的 `updatetodos`。 |
| 4 | Spec-Partial | **`tally.failed` 计了但从未渲染。** 折叠头只消费 `byVerb`/`files`/`thoughts`，spec 承诺的「失败步数（红色小标）」不显示。 | `TurnParts.vue` 新增 `trace-failed` 段（`text-danger`），i18n 补 `turnTrace.failedSteps`（en/zh）。 |
| 5 | Spec-Partial | **P0-1 与 spec 文本偏离**：spec 写 `ToolDetail.vue` 加 `title?: string` prop，落地改为连接器侧丢弃 echo-only detail（采纳 origin 方案），`SubagentTraceDialog` 未动、think/fields 无去重。 | 见上文 P0-1 节的「已按落地修正」。 |
| 6 | Standards-judgement | **截断标记三处镜像**（connector 导出常量 / ToolStepCard 本地 / tool-summary 本地），仅靠注释约束易漂移。 | `stripTruncationMarks()` 与标记列表统一收敛到 `relay-web/src/lib/tool-summary.ts`（`diffStatsOf` 同源），connector 侧常量保留为该语言的来源。跨包单源需新建共享包，成本高于收益，故以「同文件内唯一列表 + 注释指向」收敛。 |
| 7 | Standards-judgement | **1s live-elapsed 时钟在 ToolStepCard 与 ToolCallPanel 整块重复。** | 抽 `lib/use-live-elapsed.ts`：`useLiveElapsed`（单卡）+ `useLiveElapsedClock`（面板级，一个列表一个 interval）+ 共享 `formatStepDuration`。 |
| 8 | Standards-perf | **`MessageList.vue` 同一行调 `traceSummaryOf(m)` 两次**（tally + presentation），每行双倍 derive。 | 改为 `traceSummaryEligible(m)` 单一谓词 + 两次取值（走既有 WeakMap 缓存，命中即同对象），并让 `collapse-trace`/`tally`/`presentation` 三个绑定不可能互相矛盾。 |

未修（接受）：`ToolEventBatcher<T>` 泛型 + 3 函数注入仅一个调用方、`DRIVER_TOOL_KIND_TABLES` 仅 kimi 一表——均为有意的扩展点，成本小。
