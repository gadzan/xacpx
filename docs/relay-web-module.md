# Relay Web 看板模块说明（packages/relay-web）

relay hub 的 Web 看板（阶段三 + 阶段四 + 阶段五）：登录后跨实例管理 acpx 会话的三栏 IM 界面。
设计 spec：docs/superpowers/specs/2026-06-13-relay-hub-design.md；服务端见 docs/relay-module.md。

## 目的与形态

三栏 IM 看板：

- **左栏**：实例-会话树（在线状态、运行中 ● 标记），新建/删除逻辑会话；顶部带 Settings / Logout；
- **中栏**：选中会话的聊天流（历史回显 + prompt 流式渲染，运行中可取消，输入框支持 `/命令`）；
- **右栏**：当前会话的任务面板（定时任务 + 编排任务，见下文 `TaskPanel`）。
- **设置页**（`/settings`）：实例接入 token 生成、主题切换、登出、只读历史保留摘要。
- **全局**：底部右下角 `instance.notice` toast、离线时的 “Reconnecting…” 连接徽标。

## 技术栈

- Vue 3 + Vite + Pinia（状态）+ vue-router（路由）+ Tailwind CSS v3（样式）；
- 测试：Vitest + jsdom + @vue/test-utils（`src/__tests__/*.test.ts`）。

## 国际化（i18n）

- 看板支持 **English + 简体中文**两种语言。基于 vue-i18n（`globalInjection`，模板里直接用 `$t(...)`）。
- **首次自动检测**：从浏览器 `navigator.language` 解析（`zh*` → `zh-CN`，其余回退 English）；
  用户偏好持久化在 `localStorage` 键 `relay-locale`，下次进入直接沿用。
- **手动切换**：设置页 → Appearance → Language（内联在 `SettingsView.vue`，无独立组件），
  切换即时生效并写回 `localStorage`。
- **文案目录**：`src/i18n/messages/en.ts`（以 `as const` 结尾）与 `src/i18n/messages/zh-CN.ts`，
  两份按相同 key 形状镜像。**任何新增 UI 文案必须同时加进两份目录**——
  `src/__tests__/i18n-parity.test.ts` 会断言两份 key 集合完全一致（且无空串值），缺哪份就会失败。

## 「快照 + 事件增量」模型

看板状态由 REST 持久化快照和 WebSocket 有序运行态共同维护：

- **快照**：REST 拉取——`GET /api/instances` 列实例，RPC `control.sessions.list` 列会话，
  会话历史经消息缓存 API 拉取（见服务端 `/api/instances/:id/sessions/:alias/messages`）；
- **事件增量**：`src/api/events.ts` 的 `connectEvents(onEvent, onStatus?)` 连接 `/ws`，
  `DashboardView` 把每条 `WebServerEvent` 扇出给四个 store：`instancesStore.applyEvent`
  （实例上下线/会话变更）、`chatStore.applyEvent`（control-event：turn 输出分片、turn 终态等）、
  `tasksStore.applyEvent`（`scheduled-changed`/`orchestration-changed` 信号触发重拉）、
  `noticesStore.applyEvent`（`instance.notice` toast）；并把 `connectEvents` 的 `onStatus`
  回调接到 `connectionStore.setOnline`，驱动连接徽标。
- **实例订阅（`control-event` 扇出收敛）**：`DashboardView` 通过 `sendSubscribe(instanceIds)`
  告诉 hub 本账号拥有的实例集合，hub 据此只把这些实例的 `control-event` 发给它
  （`instance-status`/`notice` 仍账号全量）。触发点：连接/重连成功（`onStatus(true)` 每次都重发，
  所以断线重连会自动重新订阅）、账号实例列表变化。这样即使用户正在查看另一个实例，后台会话的
  working/unread 状态也会继续更新。hub 安装订阅后会在**同一 WebSocket** 上依次发送各实例的
  `state-snapshot`，随后才会排入新的增量事件。Web 以它权威替换对应实例
  的 live turns：补齐离线期间遗漏的 text/tool/subagent parts，并清掉已在离线期间完成的旧 spinner；
  当前会话同时重拉 SQLite 历史以显示最终回复。这样避免了 HTTP active-turn 快照与 WS 增量跨通道竞态。
  首屏不再并行调用 `/api/active-turns`；历史请求还带会话、请求代次和本地消息修订校验，旧响应不能覆盖
  新会话或刚完成的回复。`turn-finished` 会先即时定型 UI，再重拉持久化历史消除临时行重复。
  **未发过 `subscribe` = 收全部**（向后兼容），空数组 `[]` = 收无；订阅携带账号的完整实例集合，
  instance id 最长 128 字符，浏览器 WS 帧最大 256 KiB，hub 通过一次账号实例查询完成去重和所有权过滤。

## 右栏任务面板（阶段四）

- `components/TaskPanel.vue`：选中会话时挂载，watch 聊天选择并调用 `tasksStore.loadFor(instanceId, alias)`；
  内部组合 `ScheduledTasks.vue`（列表 + 用 datetime-local + 文本框创建 / 取消）与
  `OrchestrationTasks.vue`（列表 / 取消）。
- `stores/tasks.ts`：调度器 + 编排的事实源仍在实例侧，store 只做查询/操作 + 事件触发重拉。
  - **设计取舍**：定时任务**按会话过滤**——relay 给 Web 频道盖戳 `chatKey=relay:<accountId>`，
    `control.scheduled.list` 返回的是整账号的任务，store 用 `t.sessionAlias === sessionAlias` 筛到当前会话；
    编排任务**按实例展示**（不按会话隔离），`control.orchestration.list` 整实例返回直接呈现。
  - `applyEvent` 只认当前 scope 实例的 `scheduled-changed`/`orchestration-changed`（裸信号），
    命中即分别 `loadScheduled`/`loadOrchestration` 重拉。

## 通知 / 连接 / 设置 store（阶段四）

- `stores/notices.ts` + `components/NoticeToast.vue`：把 `instance.notice` web 事件渲染成
  右下角可关闭 toast——newest-first，最多保留 20 条、同屏展示最多 4 条。
- `stores/connection.ts` + `components/ConnectionBadge.vue`：`connectEvents` 的 `onStatus`
  报告 `/ws` open/close，离线期间显示 “Reconnecting…” 徽标。
- `views/SettingsView.vue`（路由 `/settings`）：实例接入 token 生成器（回显
  `xacpx channel add relay --url ... --token ...` 命令）、主题切换、登出、
  只读历史保留摘要（来自 `GET /api/config`，保留策略服务端配置、v1 不可在 Web 改）。
  （邀请/角色已移除——认证改为纯令牌，见 docs/relay-module.md。）

## 聊天流式缓冲（阶段四加固）

- `stores/chat.ts` 的流式缓冲按 `${instanceId}\0${sessionAlias}`（NUL 分隔）键存放，
  切换会话时各自缓冲互不覆盖，能跨切换存活；某实例离线时按前缀清掉它名下所有缓冲。
- 发送失败时设置 `error` ref 做错误浮现；`control.command.execute` 与 `control.prompt` 发送均带 `sessionAlias`。
- **prompt RPC 超时被吞掉**：`control.prompt` 的 RPC 超时（HTTP 504 / `ApiError.code "timeout"`）视为**非致命**——
  回合结果仍会经 `/ws` 事件流（`turn-output`/`turn-finished`）抵达，因此长回合不会冒出多余的错误横幅，消息也不标记为失败。
  `/命令`（`control.command.execute`，纯请求/响应、无流式）超时**仍会浮现**。
- **排队 prompt 的执行顺序**：入队响应的 `queueItemId` 会写到乐观消息；对应
  `turn-started` 到达时，store 移动这条原消息到上一轮回复之后（保留附件且不重复）。若事件与 RPC
  响应竞态，则仍以同一 id 合并；回合结束后 Hub 历史以相同顺序收敛。

## Subagent 执行轨迹

- Transport 在合并同一 `toolCallId` 的稀疏 ACP 更新后，按 resolved driver 将 provider 信号统一标准化为
  `ToolUseEvent.isSubagent`：Claude 使用 `_meta.claudeCode.toolName="Agent"`，Qoder 使用
  `_meta.qoder.toolName="Agent"`，Kimi 使用完整的 `prompt + subagent_type` Agent 输入，Codex 使用带线程与活动标识的
  `_meta.codex.subagent`。识别规则按 driver 隔离，只有明确命中的委派工具才进入统一 subagent 卡片；普通 `Agent` 标题不会单独触发。
- Cursor 的 `Task`（带 `subagent_type`/`prompt`）同样在 transport 层标记为 subagent，并把 `Read`、`Grep`、`Glob`、
  `Shell`、`StrReplace` 等 provider 工具名归一化为 relay 的通用 kind。`Glob` 的 `glob_pattern` 与 `target_directory`
  会合并成搜索卡片的可读查询，避免 Web 只显示通用工具名。
- Cursor 的计划工具（`TodoWrite` / `updateTodos` / `todoRead` 等）是 tool call 而非 ACP `session/update` 的
  `plan` 事件。transport 优先用 `rawInput._toolName` 识别工具（显示 title 是散文，会随版本变化），再从
  `rawInput`（必要时回退 `rawOutput`）读取 `todos`/`todoList`，把 `merge: true` 的增量更新转换成完整
  `PlanEntry[]`，交给同一 `onPlan` 管线并抑制重复的普通工具卡。显式空列表会清除旧计划；仅带 `_toolName`、
  没有条目的公告帧不会清掉已有计划。
- Claude subagent 内部工具的 `parentToolUseId` 继续标准化为 `parentToolCallId`，经 channel-relay 和 `ToolStepDto`
  原样进入 Relay Web。Qoder、Kimi、Codex 当前 ACP 主流没有提供子工具父子关系，因此不虚构执行时间线；channel-relay
  在 `event.isSubagent` 步骤上把委派 prompt 放入 `detail.text`、把子代理流式/最终输出放入 `detail.output`，
  卡片据此展示实时进度与结果报告。
- 异步 Agent 的 `async_launched` 只代表启动成功，父步骤保持 `running`；transport 装饰器在 ACP 结束后继续跟踪
  driver 的原生主 transcript（Claude 在 `~/.claude/projects`，Qoder 为兼容 fork，布局相同，位于 `~/.qoder/projects`；
  仅这两个 driver 支持后台跟读），并递归增量读取 `<sessionId>/subagents/**/agent-*.jsonl`。结构化结果里显式的
  `status` 字段是权威判定，只有缺失时才回退到 launch 短语匹配。后台任务真正完成、主 Agent 续写结束后才转为
  `success`；失败通知会把父 Agent 及仍在运行的子步骤收敛为 `error`。实现入口是 provider-neutral 的
  `src/transport/background-followup.ts` 与 `background-followup-transport.ts`；为兼容既有日志查询，遥测事件 key
  暂时保留 `transport.claude_background_followup.*`。
- `TurnParts.vue` 保留原始有序 parts，并消费唯一的 `TurnPresentationPlan`：`turn-timeline` 只按 wire order
  构造 narrative 与 activity offset，`turn-layout`/`markdown-layout` 对整份 Markdown 建立合法 slot，再线性、单调地
  放置 activity（后来的 activity 永不超车）。顶层 paragraph 通过内部 marker 在同一 inline token tree 中拆出安全 HTML
  fragment，跨 `strong`/link label/inline code 时自动闭合并重开格式；list、table、blockquote、fence、heading 等结构块
  保持 atomic，内部 activity 延迟到块末。expanded 与 collapsed 均消费同一 plan，后者只取最后 activity 后的 Markdown
  nodes，不再二次拼接或重新解析 Markdown。每个 Markdown node 同时携带 canonical raw `source`（geometry/debug 用）
  与 plaintext `copyText`（clipboard 用）：`markdownTokensToPlainText`/`markdownSourceToPlainText` 是唯一的 Copy
  contract——text/code 取内容、image 取 alt（空 alt 回退 URL）、link 取 label、break 取换行、reference definition
  永不进入 token 流因此永不泄漏；heal 后的 block 按 healed HTML 的语义复制。copyText 是可组合的：各 block 的
  terminal newline 保留用于分隔相邻 block，任何 block-local trim 都禁止，只有最终 `finalReplyText` join 之后做一次
  outer trimEnd。子工具继续按 `parentToolCallId` 归入
  对应 Agent；旧历史里没有父子字段的工具仍按普通卡片渲染。
- turn layout 有三层流式性能保护：无 activity 的 turn 直接走单个 Markdown render；全量 geometry cache 以
  narrative、activity id/offset/wireIndex 和 streaming 几何为 key，因此 tool status/title/output 更新只替换卡片 payload，
  不重跑 Markdown；block 级 cache 以 block source、activity 几何、streaming flag 和 reference fingerprint 为 key，
  text streaming 追加时已沉降的头部 block 直接复用 marker plan 与 sanitized HTML/copy，只重算 tail block——缓存只存
  block-local 的 nodes 与 exact-inline/atomic disposition，slot 的绝对 sourceOffset 每帧按当前 boundary 重建，因此相邻
  gap 收缩/扩张不会复活 stale slot；每帧按 live block key 剪枝，tail 历史版本不累积。`MessageList` 的 collapsed
  summary cache 以 parts identity 加本 turn 实际 anchor 的 sent-message 条目为依赖（外加每 turn 独立的 layoutCache），
  无关 transcript 行（普通 prompt、历史 prepend、receiver 行、未 anchor 的 sent 卡）不会让已有 trace 重做 layout；同一
  browser frame 内的 text delta 通过 `requestAnimationFrame` 合并。activity-bearing paragraph
  超过 50,000 字符或 256 个 marker 时自动降级为 atomic block，降级只牺牲精确 interleave，不牺牲 Markdown 语义或顺序。
  marker 抽取为单次线性扫描（`MARKER_OPEN → MARKER_CLOSE → Map`），不再按 encoding 逐个 `indexOf`。
- `SubagentStepCard.vue` 以 `children.length > 0` 判定是否具备真实 trace（provider 无关，仅看数据是否到达）。
  有 trace：默认折叠、运行中轮播当前活动步骤，展开后显示紧凑时间线与 `traceCount`。无 trace：折叠行显示 `detail.output`
  尾行（回退到 prompt）、运行时长与“{ago} 前更新”心跳；展开显示委派 prompt 折叠行 + 输出块（运行中为定高、贴底滚动的
  mono `<pre>`，结束后切换为经 `StreamMarkdown`（`renderMarkdown` = markdown-it `html:false` + DOMPurify）渲染的结果报告）。
  时长/心跳为客户端近似值（刷新会重置，历史行永不处于运行态）。“查看完整过程”打开 `SubagentTraceDialog.vue`：保留委派任务区，
  新增结果报告区（结束后 markdown、运行中 mono 尾行），仅在既无子步骤也无委派/输出时才显示空态占位。轮播尊重
  `prefers-reduced-motion`，弹窗支持焦点圈定、Esc 和点击遮罩关闭。

## 统一下拉框（`useDropdown` + `DropdownPanel` / `SelectMenu`）

所有下拉（表单字段、行内文字触发器、图标 `⋯` 菜单）共用一套样式与交互，替代此前的原生 `<select>`
与各处自制菜单：

- `src/lib/use-dropdown.ts` ——  composable：`open`/`highlight`/`query`、`toggle`/`closeMenu`、
  `navigate(count)`，document `pointerdown` 点外部关闭（排除触发器，以及任何带 `data-dd-panel`
  的浮层）、`Esc` 关闭并把焦点还给触发器、同时只开一个（打开新的会关掉旧的）。触发器自己管
  `aria-haspopup` / `aria-expanded`。
- `src/components/DropdownPanel.vue` —— 浮层容器：`rounded-lg shadow-float` 无边框 `p-1`；主内容区
  `bg-surface`（prop `tone="raised"` 时侧栏内 `bg-raised`）；行 `h-8 rounded-sm text-sm px-2`、
  hover `bg-surface-2`，选中 = 右侧 accent `Check` + `font-medium`（不整行染色），危险项
  `text-danger hover:bg-danger/10`，分组标签 `text-xs text-fg-muted`（不大写）；`>7` 项顶部搜索框。
  `<lg` 时同样内容渲染进 `MobileSheet`（行高 `h-11`，`sheet-test-id` 可与桌面面板区分，
  `sheet-z` 供对话框内嵌套使用），该 sheet 用 `dd-panel` 打开 `data-dd-panel`：面板自身必须被
  认作「下拉拥有的浮层」，否则 sheet 内的每次按压都算外部点击，pointerdown 就把弹层关掉，
  随后的 click 到不了行（移动端整个下拉不可用）。
- **`data-dd-panel` 的所有权契约**：只有「就是下拉/行菜单本身」的浮层才带这个标记
  （桌面 popover、`<lg` 的 `MobileSheet`、以及两者形态的 `ContextMenu`）。普通页面 sheet
  （`DashboardView` 的 `⋯`、已打开标签、FAB 实例选择器、`DirectBotPane`、`GroupPane` 的 sheet）
  不带，因此在下拉打开时点它们仍会先关掉下拉。
- `src/components/SelectMenu.vue` —— 表单字段触发器（`bg-surface-2 rounded-lg h-9 text-sm`，替换全部
  原生 `<select>`）：`groups`/`modelValue`/`placeholder`，选中值不在选项里时显示 placeholder（老
  `<select>` 的首个 disabled 项语义）；选项行带 `data-value`，可带 `testId` 供测试定位。
- 行内文字触发器 = `text-xs text-fg-muted` + `ChevronDown`（展开 `rotate-180`）；图标触发器
  `h-6 w-6`（触屏 `h-10`）。`<lg` 的 `MobileSheet` 行不显示常驻高亮（当前项只有 ✓，hover/键盘高亮不上色），只保留按压反馈 `active:bg-surface-2`。
- `src/components/Tooltip.vue` —— hover 300ms / 键盘聚焦显示、触屏 2s 的提示气泡
  （`bg-fg text-bg text-xs rounded-sm px-2 py-1`），用于冷会话指示器等（SVG `title` 触屏不显示，已移除）。

## Composer 的模型与 effort 控件

- 会话切换时 `session-controls` store 并行读取 `control.session.model.get` 与
  `control.session.effort.get`。模型 chip 保持原有行为；只有当前 adapter 广告了可选 effort 时，
  才在其旁边显示独立的 effort chip。
- effort 选项完全采用 adapter 返回的 `available`，不在 Web 中固定 `low/medium/high/xhigh`。
  选择后调用 `control.session.effort.set`，界面乐观更新；RPC 失败时回到失败落地时最新的权威值并显示
  全局 toast，因此连续选择中较早成功、较新失败时不会回滚到较早选择之前的旧值。成功值由 Core
  按逻辑 session 持久化并在 adapter 重建后重放，所以刷新或重新进入页面仍显示并实际使用该值；
  用户选择后立刻发送时，prompt 会等待同一会话正在进行的 effort 设置落地。
- model 切换完成后会重新读取 effort，因为 adapter 可能按 model 广告不同的推理强度选项；仅当
  composer 仍指向发起切换的同一会话时应用刷新结果。
- OMP 模型恢复：只有驱动是 `omp` 且报错是精确的 `Could not restore model <id>` 文案才走恢复横幅，其它鉴权/目录/通用报错不视为“模型已下架”，也不做自动映射。横幅隐藏原始报错、只显示受影响的模型 id，并提供“获取模型并选择替代项”动作：该动作经 `control.session.model.get { refresh: true }` 冷探测当前精确启动拿可选项；`current` 是恢复前保存的选择，直到选中替代项并 `control.session.model.set` 成功才被覆盖。选择替代模型走正常 setter 与上面的串行/乐观规则；成功提示明确“原消息尚未重新发送”。
- session/实例切换以独立 context revision 丢弃 model 与 effort 的迟到响应，避免旧会话结果污染
  当前 composer。没有广告 effort 的 agent 不显示控件，也不会触发设置请求。
- 新建会话的控件初始化：逻辑会话先可被 `control.sessions.list` 看到，adapter 启动完成后才广告
  model/effort，因此 composer 可能先读到空结果（模型 chip 置灰、effort chip 不出现）。
  **只有创建/attach 成功后的那条 `sessions-changed` 携带 `readySessionAlias` +
  `readyTransportSession`**（返回体里的真实 display alias 与 transport incarnation）；
  rename、archive、warmth 翻转等普通列表变化仍是 payload-free 事件，因此不会被误当成就绪信号。
  Web 仅当这两个字段与当前选中的实例 / alias / 行内 `transportSession` 完全匹配时补拉一次
  `refreshLiveControls`；等待用户模型设置落地期间或 GET 在飞行时 incarnation 变化则丢弃旧读取。
  model/effort 在缓存恢复、RPC 返回及异常清理的提交点重新校验，过期结果不更新当前值、
  可选项、权威回滚值或持久缓存。
  成功读到空 effort 目录视为该 adapter 不支持 effort（停止重试）；**仅 RPC 失败才重试**，
  最多 3 次（500ms / 1000ms 退避），且不跨 incarnation、不跨账号代次。
  后续同 incarnation 的 ready 事件允许再次补拉（覆盖暂时性失败），普通事件永不触发查询。

## 阶段五加固（审计修复）

- **API 客户端始终带 JSON content-type**：无 body 的 mutating 请求也发 `content-type: application/json`，
  与服务端新增的 CSRF 415 守卫对齐（不会被 415 误杀），保留 CSRF 预检属性（见 docs/relay-module.md）。
- **重连有序快照 + 重连定时器清理**：重连后重新拉实例、当前会话历史/任务；在飞回合由 subscribe 后
  同 socket 返回的 `state-snapshot` 权威校准，避免 ghost state 和离线分片缺失。`connectEvents` 在 teardown
  时清掉待定的重连定时器，避免泄漏 socket。
- **聊天错误浮现**：回合失败（`turn-finished ok:false`）现在浮现 `errorMessage` 并把队尾消息标记为失败；
  `chat.error` 渲染为可关闭的横幅；切换会话时清空错误；发送失败把乐观插入的消息标记为失败。
- **取消运行中回合**：可从聊天面板取消在途回合（`control.prompt.cancel`）。
- **会话创建/删除 UI**：可从左栏实例树创建/删除逻辑会话（补齐 §4.5）。

## 模型选择（`ModelPicker.vue`）

Bot 对话框和新建 Session 对话框共用 `ModelPicker`。它读取 `control.agents.capabilities.get`，状态为 loading、ready、unsupported、needs-setup 或 error。默认选项和自定义 id 始终可以填写。配置里的 `modelCandidates` 标成建议，不显示成适配器结果。选中的 id 和实际生效的 id 分开显示。无效的显式 id 在运行时退回默认时显示为未生效。

Bot 的 model / effort 在保存后作用于之后接受的 Run。已有 Session 作曲器仍用 `control.session.model.set` 做即时切换，不走这条能力 RPC。

effort 随模型结果刷新。刷新失败时保留上一次已经拿到的合法 effort 列表。

已验证的模型列表会持久化在 `state.json` 的 `capability_lists` 段（按键：agent + 工作区 cwd + 启动身份 + 鉴权材料），因此关闭再打开 Bot 编辑框、或重启 daemon 后仍会显示列表。点击“获取模型列表”永远重新探测，不会直接回放旧列表；刷新失败时旧列表仍然可用，但 `reason` 明确标注它不是刚验证过的结果，并提供重试入口。adapter pin、command/argv、工作目录或鉴权材料变化会换键，旧列表不会被误用。

Web 侧另有一层短命缓存，只用于消除重复 RPC：键为 instance + agent + workspace + bot，并发相同读取合并为一次请求。它不能替代 daemon 指纹（前端看不到 command/argv/鉴权），因此失效边界必须显式：`loadInstances`（重连快照）、实例上下线、`workspaces-changed`、`bots-changed` 无条件清理该实例；`loadFormOptions`/`loadWorkspaces` 只在 agent 名称/driver 或 workspace 名称/cwd 实际变化时清理——对话框每次打开都会重载配置，若无条件清理，跨次打开就再也命中不了缓存，PR #444 的收益会被抵消。未被事件覆盖的变更（直接改配置文件、重新登录 adapter）由 60 秒有效期和显式 Probe 兜底。写回只允许最新发出的请求生效，旧响应不能覆盖新 probe；带失败 `reason` 的 ready 只是临时告警，不进入缓存，下一次普通读取仍会询问 daemon。已验证的列表始终保留“获取模型列表”按钮，作为显式刷新入口。

## 会话创建对话框（`NewSessionDialog.vue`）

- 点击实例树 `+ new session` 打开一个弹窗（取代原先简陋的内联三输入框）。打开时经
  `instances.loadFormOptions(instanceId)` 拉取该实例的 catalog（`control.agents.catalog`）+
  `control.workspaces.list`。
- **可选自动别名**：别名输入留空时按 `‹workspace›-‹agent›` 自动生成（与现有别名去重，冲突时追加序号）；
  手填则用手填值。
- **新建即新对话**：所有显式新建路径（Web `control.sessions.create`、`/session new` 与会话快捷创建）
  都分配新的底层 transport incarnation；展示 alias 可复用，但删除后同名重建不会恢复残留的 agent 历史。
  Web 删除成功时 Hub 还会清除 alias 对应的缓存消息。归档后恢复不走 create，也不清缓存，仍复用原历史。
- **catalog 驱动的 agent 选择器**：agent 下拉来自 `control.agents.catalog` 的**全部 driver**——未安装的
  driver（`installed: unknown`）仍会列出但**置灰/禁用**，已配置 / `builtin` / PATH 探到的可选。
- **workspace 选或输路径**：workspace 控件可从已配置项里选，也可直接**输入一个路径**——输入路径时按其
  basename 自动新建一个 workspace（提交时先 `control.workspaces.create` 持久化，再
  `control.sessions.create` 在其中建会话）。
- **目录选择器（`DirectoryPicker.vue`）**：「新路径」输入框旁的文件夹按钮打开一个浏览
  **目标实例文件系统**的目录选择弹窗（RPC `control.fs.browse`，跨实例——实例在哪台机器
  上就浏览哪台）；路径框 Enter 跳转、面包屑/主目录/上一级快捷键、隐藏目录开关、
  ↑/↓/Enter/Backspace 键盘导航；导航即进入、底部「选择此目录」确认当前目录并回填。
  迟到响应按导航序号丢弃，错误内联显示。Manage 弹窗 Workspaces 管理器的新增表单同款按钮。
- **错误浮现**：实例侧 RPC 错误是 200 + `{error:{code,message}}`（网关 resolve 不 reject），store 的
  `unwrap()` 用 `isErrorPayload` 检出并抛出，对话框渲染错误横幅而非静默吞掉（修了旧表单「点 Create 无反应」）。

## 会话重命名（侧边栏 `⋯` 菜单）

- 会话行的 `⋯` 溢出菜单首项 **「重命名」** 把会话名就地换成输入框（Enter / 失焦提交，Esc 取消）。
- 设置的是一个**纯展示名 `display_name`**（核心 `LogicalSession.display_name` → `SessionDto.displayName`）；
  它**不改会话身份**：`alias`、`/use` 句柄、transport 会话名都不变，仅 relay-web 展示。
- 走 RPC `control.sessions.rename {alias, displayName}`（连接器 → `ControlService.setSessionDisplayName`）；
  按 Enter 后 store 会立即乐观更新本地行，不等待 RPC 返回。pending 展示名会覆盖期间
  `sessions-changed` 触发的旧列表快照；同一会话的连续 rename 在 Web 侧按 FIFO 提交，失败时只回滚到
  最近确认值，迟到响应不能覆盖更新的名称。**空值清除**（回退显示 `alias`），不做唯一性约束。
- Hub 仍为 rename 盖戳可信 `chatKey`。rename 不占同会话 turn 锁，因此 agent 回合运行中也能立即
  持久化和跨 dashboard 同步；它仍占 lifecycle/metadata 锁，与 create/remove/archive/unarchive
  保持互斥，避免跨会话 incarnation 写入。
- 侧边栏与 `ChatPane` 头部均渲染 `displayName || alias`。微信 `/sessions`、`/use` 不受影响。

## 会话睡眠（原「归档」）与冷会话指示器

- **睡眠 = 归档的用户可见新名字**：仅改 relay-web 文案（zh-CN「睡眠/已睡眠」，en "Sleep/sleeping"），
  RPC `control.sessions.archive`、`SessionDto.archived` 字段与代码标识符全部不变。`⋯` 菜单项与
  滑动动作块图标换为 `Moon`，并带原生 `title` tooltip（`instance.sleepTooltip`）说明「睡眠会立即
  关闭会话进程，历史保留，发消息即唤醒」；移动端靠睡眠后的 toast（`instance.sessionArchivedToast`）
  传达同一信息。微信端术语统一是独立 follow-up。**睡眠不再清本地 tail 缓存**（睡眠会话切回
  仍可秒开首屏；仅删除会话与 logout 清缓存，见下文「IndexedDB 会话尾部缓存」）。
- **冷会话指示器**：`SessionDto` 可选字段 `warm?: boolean`（实例侧 `SessionWarmthTracker` 60s 轮询
  queue-owner lock pid，温度翻转时推 `sessions-changed`，见 [docs/control-module.md](control-module.md)）。
  仅「醒着且 `warm === false`」的会话行在名称后显示 12px `Unplug` 图标（`data-test="cold-indicator"`），
  理由放在新增的 `Tooltip.vue`（`bg-fg text-bg text-xs rounded-sm px-2 py-1`，hover 300ms / 键盘聚焦显示，
  触屏点按显示 2s 后消失）里，文案 `instance.sessionColdTooltip`；`warm` 缺失（老实例）或已睡眠的行不显示。
  Hub 对 RPC 响应透传，老实例无需升级即可兼容。冷会话行**单行**：名称 + Unplug，无副标题文字
  （SVG `title` 在触屏上不显示，已全部移除）。
- **打开终端指示器**：会话行不另占标题空间。`center-tabs` 里该会话仍挂着 Terminal tab 时，在
  左侧 Agent 图标右下角叠一个极小的 `SquareTerminal` 角标（`data-test="terminal-open-marker"`，
  title = `instance.sessionTerminalOpenTitle`）。切到其他会话时角标留在原行；关掉该 tab、睡眠或
  删除会话后消失。Agent 分组下行内无品牌图标，角标 `position:absolute` 钉在行按钮左侧 padding
  里（不进 flex、不占 `gap-2`），贴底以免挡住注意力圆点。

## 实例配置管理 Modal（`ManageInstanceDialog.vue`）

- 每个实例行的 **「Manage」** 按钮（实例树）打开一个按实例的管理弹窗，内含 workspace + agent 两个管理器
  （`WorkspacesManager.vue` + `AgentsManager.vue`）。
- **Agents 管理器**：消费 `control.agents.catalog`（带 `configured`/`installed`），可新建
  （`control.agents.create {name,driver}`）/删除（`control.agents.remove {name}`，正被会话占用时实例侧返回
  in-use 错误并浮现）。
- **Workspaces 管理器**：列已配置 workspace，可删除（`control.workspaces.remove {name}`，占用时同样 in-use 拒绝）。
- **General tab 的「侧栏分组」三选**（不分组 / 按工作区 / 按 Agent）：按实例记忆的**纯视图偏好**，见下节。

## 侧栏会话分组（workspace / agent 二级分组）

- 每个实例可独立选择侧栏分组模式：`instance`（平铺，默认）/ `workspace` / `agent`。偏好存
  localStorage（`xacpx.sidebar.groupMode.<instanceId>`，helpers 在 `src/lib/sidebar-group-mode.ts`），
  响应式镜像在 instances store（`groupModeFor`/`setGroupMode`），改动即时生效。
- **组由活跃 session 派生**（不读 workspaces/agents 目录），按服务器首现顺序排列；组内 active
  保持顺序。分组模式下**取消 10 行截断**（组折叠即长度控制，折叠为会话内状态、不持久化）。
- **睡眠会话只有一个实例级开关**：tab 行右侧筛选图标菜单（`Filter` 图标触发，勾选「已睡眠会话」
  `instance.sleepingSessions`，开启时图标带 accent 圆点）在平铺与分组模式下都显示、都生效。
  平铺模式开启时加载实例级睡眠快照；分组模式开启时为每个组经
  `control.sessions.list {archivedOnly, workspace|agent, offset, limit:5}` 拉第一页，睡眠行显示在
  **每个组内**、排在该组活跃会话下方置灰；还有更多时组底部只有**一个**「加载更多」，每次追加一页直到
  `hasMore=false`。**组内不再有单独的睡眠开关**。关闭开关即隐藏（缓存保留）；开关开启时切换分组方式
  或出现新组会补拉缺失的组。组状态存 `InstanceView.groupArchived`（键 `${mode}:${groupKey}`，不并入
  `inst.sessions`、不喂 `reconcileTailCache`），`sessions-changed`/archive/unarchive 只刷新已加载的组。
  开关开启时，最后一个活跃会话被睡眠后已加载过睡眠页的组仍保留显示。
  实例级「加载更多」在所有模式下保留（活跃列表超一页时的唯一入口，`w-full h-8 rounded-lg text-ui
  text-accent` 居中，`hover:bg-surface-2`）。
- **会话列表自动加载**：进入页面、浏览器重连、实例从离线变在线时，自动为所有在线实例加载会话
  列表（`loadSessionsForOnlineInstances`）；手动「加载会话」按钮保留为失败兜底。
- **视觉**：实例=浅色卡片、组=更浅一层的底色块 + 极小缩进（tinted-zone，三种模式视觉同构）。组头 =
  折叠箭头 + 类型图标（workspace→文件夹 / agent→品牌图标）+ 名称 + 计数；agent 分组下行内品牌图标去除。
  所有折叠行（实例、组、已禁用 Bot 组）统一一个 `ChevronRight` + `rotate-90` + `transition 150ms`，
  不再两图标切换；「已禁用」Bot 组作为分组标题行排在启用 Bot 列表下方。
- **选中态**（会话行 / Bot 行）：只有 `bg-accent-soft` + 名称 `font-semibold text-accent`，左侧 3px
  accent 条已移除；未选中行 hover `bg-surface-2`。
- **前缀去重**（仅展示层）：workspace 组内剥掉 `<组名>-` 前缀、agent 组内剥掉 `-<组名>` 后缀
  （对应 `<workspace>-<agent>` 自动 alias），hover title 恒为全名；剥空则不剥。
- **组头悬停 ＋**（触屏常显）打开 `NewSessionDialog` 并预填本组 workspace/agent
  （`presetWorkspace`/`presetAgent` props，仍可改）；实例 footer 的 ＋ 不变。移动端零特化。

## 切换会话的渲染性能

长历史会话的切换开销主要在**组件创建**（每个文本 part 同步跑 markdown-it + DOMPurify），
`content-visibility: auto` 只省 layout/paint。三道针对性优化：

- **compact 历史页**（hub `view=compact` + `HISTORY_PAGE = 10`）：首屏只拉最近 10 条（约 5 轮问答），并剥掉折叠工具卡用不到的 diff/命令输出/文件预览，同时去掉 `parts` 已覆盖的重复 `toolSteps`。滚到顶部再翻更早的一页。展开工具/子代理卡片时 `ensureFullMessage` 再 `GET .../messages/:id` 补全文。`loadHistory` 若本地已有更完整的 `structured`（刚结束的 live flush、已 hydrate、或旧尾部缓存）不会被 compact 页盖掉。旧看板不带 `view=compact`，仍拿完整行。

- **尾部优先渐进挂载**（`MessageList.vue`）：历史页落地（0→N）时先只挂载最新 30 行
  （`INITIAL_ROWS`），随后 rAF 每帧向上补 30 行（`REVEAL_BATCH`）直到全量；`hiddenCount`
  记录未挂载的最旧行数。展开是顶部 prepend：钉底时展开后重新钉底，用户已上滚则按
  distance-from-bottom 不变式锚定视口。`hiddenCount > 0` 时顶部滚动**不**触发 `loadOlder`
  （先本地展开）。turn-finished 收敛整页替换**不**重置 hiddenCount（key 稳定、组件复用）。
  无 rAF 环境（jsdom 测试）同步全量挂载。
- **`structured` 脱离深度响应式**（`stores/chat.ts` `rawStructured`）：历史行不可变、只会整行
  替换，`loadHistory`/`loadOlder`/`flushTurn` 对 `structured`（parts/toolSteps/diff 全文）做
  `markRaw`，避免 Vue 深代理化数百 KB 的对象树。
- **IndexedDB 会话尾部缓存**（`src/lib/session-tail-cache.ts`，spec #205，后迁 IndexedDB）：
  stale-while-revalidate。`chat.select()` 发起异步种子读（chat store 的 `pendingSeed`；落地守卫
  = 选中未变 + transcript 仍为空 + revision 未变），`loadHistory()` 入口先 `await pendingSeed`
  （毫秒级）再决定骨架屏——缓存命中时 `messages.length > 0` 照旧抑制骨架屏；之后权威整页替换
  收敛（key 稳定无闪烁）。成功加载与 turn-finished 后防抖写回（`debounce-flush`，切会话时
  flush，写入 fire-and-forget）。存储 = DB `xacpx.chat-tail` / store `tails`，数组主键
  `[user, instanceId, alias]`（reconcile 用前缀 KeyRange，无需转义含点 alias），值含
  `rows`（≤10 条持久化行，剥离 client-only 字段）+ `lastAccess` + `bytes` + `incarnation`
  （= `SessionDto.transportSession`；chat store 维护由 `loadSessions` 喂的 incarnation 注册表
  （对账时同步剪掉死 alias 的注册项），seed 读/写回都带上，`""` 为通配——**同名重建不复活旧尾部**：
  read 发现两侧都已知且不等即删条目返 miss；`""` 写回保留条目原有标签（刷新后首个 flush 抢跑
  `loadSessions` 时不降级为通配），reconcile 会把存活会话的 live incarnation 盖到存 `""` 的条目上
  （adoption），也会掉 alias 存活但 incarnation 变了的条目；选中中观察到同名重建时取消待写回并重拉
  历史，防止把前任 transcript 打上新 incarnation 回写）。淘汰：事件驱动
  （`removeSession` → chat store `purgeTailCache`（drop + 取消待写回 + 清注册表项），`auth.logout` →
  `dropAll`；**睡眠不清缓存**——归档语义是可唤醒，缓存保留）、对账（`loadSessions` 落地后
  `reconcileTailCache` 掉该实例非存活 alias 或 incarnation 不匹配的条目，含睡眠中的都算存活——
  覆盖 Web 关闭期间其他端的删除/同名重建）、兜底（全局 64MB 按 `lastAccess` LRU 淘汰、30 天 TTL
  惰性过期；**无单条预算**——
  重工具输出的大行也整会话缓存）。首次打开 DB 时懒清扫旧版 localStorage 键
  （`xacpx.chat.tail.*` / `xacpx.chat.tail-index.*`，不迁数据）。所有操作 try/catch +
  `indexedDB` 缺失兼容：read 返回 null、其余静默 no-op（缓存永不成为错误源）。
  仅含缓存播种行的 transcript 在 `loadHistory` 的 pending-prompt 守卫里视同为空
  （`seededFromCache`，保持 #199 的重选中途拉取语义）；播种（≤10 行，与 HISTORY_PAGE 对齐）→ 权威整页替换
  不经过 0→N。旧缓存长于首屏时，read 会裁到 `TAIL_ROWS`。若一次替换仍从短尾跳到很长的一页，
  `MessageList` 仍按 `prev ≤ INITIAL_ROWS` 且增长 ≥ `REVEAL_BATCH` 重新触发渐进挂载。
- **切换视图快照缓存**（`src/lib/view-snapshot-cache.ts`）：切换会话时仍需读取的轻量只读数据采用
  stale-while-revalidate。缓存按 `[user, namespace, instanceId, scope]` 隔离，内存热缓存让同页往返
  同步恢复，IndexedDB `xacpx.view-snapshots` 让刷新后也能先恢复；model、effort、scheduled tasks、
  orchestration tasks、workspace git summary，以及文件面板的目录导航/git 状态快照都先读缓存，再由
  原有 RPC 权威结果覆盖并写回。任何缓存读写失败均静默降级为原实时请求，7 天 TTL 惰性过期；
  每个异步刷新在发起时捕获 write generation，删除会话/登出先推进 generation 再清理，因此更早发起的
  model/effort/task 响应不能在清理后复活旧快照；删除会话会等待该会话的 model/effort/scheduled
  快照清理完成，logout 清全部视图快照。账号变化同时重置 controls/tasks/files 的 Pinia 可见状态，
  防止同 instance/session key 跨账号复用。git 状态刷新遇到传输/临时 RPC 错误会保留已播种 badge，
  仅权威 `not-a-git-repo` 清空。实时 turn、plan、usage、slash commands、queue 已由 WebSocket 按会话
  常驻内存，不重复落此缓存；文件正文、完整 diff 与终端状态不缓存，避免把易陈旧、可参与写操作的数据
  伪装成当前权威状态。

## Conversation slash 与 @

普通 Session composer 的候选菜单、光标替换、方向键、Enter/Tab、Escape 和 IME 组合在
`src/lib/composer-completion.ts`。Direct 与 Group 各自保留发送、取消、幂等和断线恢复。

Conversation 的 slash 列表来自现有 `agent-commands` 事件，按 `conversationId × topicId × botId`
存在 `stores/conversation-commands.ts`。重连时 `state-snapshot.conversationCommands`（以及
`/api/active-turns` 的同名字段）按实例整表替换。换 Topic 或换 Bot 读到的是另一行，不会带上别的 Topic
的命令。菜单只显示该 Bot 运行时广告的命令，不显示 xacpx 管理命令目录。Group 在未明确选中一名成员时
只提示先选择成员，Enter/Tab 不发送。

Group `@` 的权威是 `{ botId, displayToken }`（`src/lib/group-mention.ts`）。菜单展示角色、Lead 和
启用状态。同名成员靠 bot id 区分。无法解析、重名、停用或已移除的手工 `@` 会提示，并清掉由 mention
建立的目标，不沿用上一个目标。Direct 页的导航只打开另一个 Bot 的 Direct，或打开已包含当前 Bot 的 Group。

`group_send` 的公开交接在 `GroupTranscript` 里显示关系、任务、期望、已有结果和一句可操作提示。Run 卡片列出实际执行的成员。`shared-single-writer` 的排队语义只在话题的「文件系统隔离」对话框里说明，不在每次执行的浮层里重复。

话题行 ⋯ 菜单对有 executionTarget 的 Group 话题多一项「文件系统隔离」，打开单选对话框列出三种策略并标出当前值；选择即走 `control.group.topics.set-isolation`。只有「每名成员独立 Git 工作树」会让同一轮派发并行执行（每名成员一个已验证的工作树，物理准入仍要求 cwd 互不相同），其余两种对无法证明只读的工作保持串行。切换只影响之后的派发：话题里还有未结束 Run 时服务端返回 `conversation_not_settled`，对话框保持打开并显示原因。失败不关闭、成功才关闭，与删除/清空一致；移动端返回键先关对话框。Direct 页没有 executionTarget，不渲染这一项。
创建群组时选定工作区模式（`shared` / `per-member`），编辑时只读展示，因为 daemon 拒绝改这个字段。该选择只对公布 `groups.workspace-mode.v1` 的实例显示：旧 core 会丢掉这个字段并建成 `shared` 群组，界面宁可回落到默认也不做静默降级。`per-member` 群组的建话题弹层隐藏工作区与隔离选项，直接创建无 `ExecutionTarget` 的 Topic，并说明成员各自用自己的 Bot 工作区、工作区不同的成员可并行。
确定性拒绝保留草稿。不确定结果仍复用冻结的 `requestId` 和 target。

Group 作曲器里的“自动协作”只在两者同时成立时出现：`control.conversations.router.get` 为 `ready`，且 `control.jev.get` 报告 `keyConfigured: true`。否则（包括读取未返回、旧 daemon 不支持 Jev RPC）该选项完全隐藏，不显示禁用项或原因；默认的负责人模式不变。自动 Run 由路由行承载，行内只显示气泡状态、`waitingQuestion` 和人能处理的原因：Router 自己的 `routingReason`（置信度、回退说明）不再平铺在转录里。执行过程浮层只保留成员自己的过程与需要用户处理的信息（`waitingQuestion`、`blockedReason`、成句的失败原因——裸 token 形式的内核原因码不显示）；派发指令（任务、期望输出）默认折叠，指派 ID、依赖 ID、预算、路由状态、工作区说明和轨迹的 `completenessReason` 都不进浮层。`waiting-human` 保持等待，界面不会把它改成 running。停止会结束这次 Run。停止之后选择一名成员再发送，那是一次新的请求。此版本没有“由我启动这一步”。

实例管理弹层（会话 tab 的齿轮）General 面板提供群组自动协作、Relay 终端和文件写入三个开关。群组自动协作分区显示 daemon 解析出的状态，不暴露 Router 命令、鉴权环境变量或配置路径。开关绑定持久化的 `config.enabled`，不来自可用性状态：探测失败的实例照样显示已开启，并给出修复说明。打开弹层走 `control.conversations.router.update` 的空补丁（纯读，不写盘不探测），切换走同一个 RPC 的非空补丁。开启时若实例没有配置 `conversations.router.command`，daemon 自动写入仓库自带的默认 Router 并运行探测。旧 daemon 对 `update` 答 `unknown-type` 时，store 回落到 `control.conversations.router.get`，面板显示只读状态和升级提示。`conversation-router-changed` 事件触发重读。
Jev 路由配置收拢在“Jev 路由”折叠区，包含 endpoint、API key（只显示掩码，输入即替换，可清除）、可选代理、只读模型 `jev-1.13.0`、保存和连接测试。API key 保存在实例 daemon 侧，不会回传 dashboard。
终端开关读取及更新实例 `channels[id=relay].options.terminal.enabled`，默认关闭；RPC 返回需重启标记，因为 RMUX runtime 与已公布能力在 Relay channel 启动时建立。设置保存后重启该实例的 Relay channel 才会改变实际终端能力。该开关不控制 legacy root `terminal.enabled`。旧 connector 对新 RPC 返回 `unknown-type` 时显示升级提示。

终端不是热切换，和文件写入开关不同，原因在启动期建立的三个不变量：能力集 `terminal.rmux.recovery.v1` / `terminal.multi-view.v1` 只在握手时上报（hub 按 socket 身份落库，改能力必须重连并重新握手）；`bootstrapTerminal()` 一次完成 registry → RMUX sidecar → reconcile，`onRequest` 的路由判断读的是启动期赋值的 `this.terminal` / `terminalReady`；关闭方向还要求 durable registry 先 reaping 再销毁 sidecar（`retireRelayTerminals`），中途打断会留下 tombstone。要热切换就得让 channel 在同一进程内重建 sidecar 并重发能力，而 hub 侧握手的实例记录只在连接时更新，等于变相重启 channel——所以维持「保存即持久化、重启 channel 生效」。

hub 侧配套：tool step 全字段 32K 字符写入截断（见 docs/relay-module.md 的 `TOOL_DETAIL_CAP`）。

## 流式 Markdown 渲染

- `src/lib/render-markdown.ts` —— `renderMarkdown(text, { streaming })` 把 markdown 渲染成**已净化**的 HTML：
  `markdown-it`（`html:false` 转义任何原始 HTML）+ `DOMPurify`（输出二次净化，纵深防御）。
  链接统一加 `target=_blank rel="noopener noreferrer nofollow"`。
- `streaming: true` 时先经 `remend`（Vercel 抽出的零依赖 healing 引擎）自动补全未闭合的
  `**粗体`/行内代码/围栏代码块/链接，避免流式中途半截语法吞掉后文或显示成裸符号；定型文本不 heal。
- `src/components/StreamMarkdown.vue` —— `{ text, streaming? }` props，`computed` + `v-html` 渲染净化后的 HTML，
  自带非 scoped 的 `.stream-md` 样式（Tailwind preflight 会清掉元素样式，需手动补回标题/列表/代码块等）。
- `MessageList.vue`：**`out` 方向（agent 输出）与流气泡走 `StreamMarkdown`**；`in`（用户输入）保持纯文本 `<pre>` 不渲染 markdown。

### Mermaid 图表渲染

` ```mermaid ` 代码块会渲染成 SVG 图表。管线：`render-markdown` 通过 fence 覆写发出
`<pre class="mermaid-block" data-mermaid="<base64 源码>">` 占位符；`render-mermaid` 按需
`import('mermaid')` 懒加载，在 `securityLevel: "strict"` 下把每个占位符渲染为 SVG，再经
DOMPurify（svg profile）净化，并按 `theme+源码` 缓存；`StreamMarkdown.vue` 在 `v-html`
打补丁之后再水合——绝不在流式中途做（半截 fence 会解析失败），并在主题切换时重新水合。
非法图表保留源码作为代码块兜底。非 relay-web 频道（微信/终端）仍为纯文本。

已渲染的图表支持平移/缩放：**内联**（`inline-mermaid.ts` 就地增强——Ctrl/⌘+滚轮缩放、鼠标拖拽平移、
双指捏合；单指仍滚动页面）配一条 − / 复位 / + / ⤢ 控件条；点 ⤢ 打开**全屏**查看器（`MermaidViewer.vue`，
平滑滚轮/单指拖拽/双指缩放 + Esc/✕/点空白关闭）。两种模式共用纯 `pan-zoom.ts` 控制器与
`pan-zoom-gestures.ts` 手势装配；均复用已注入 DOM 的（已净化）SVG，不重新解析。

## 响应式 / 移动端布局

- `DashboardView.vue` 桌面（`lg:` ≥1024px）保持三栏静态布局；未选中任何会话 / Bot / 群组 / 实例桌面时
  中栏渲染空状态、右栏整体隐藏（见下文「桌面空状态与右栏折叠」）。窄屏（`<lg`）按选择状态分两种形态：
  - **选中会话 / Direct Bot**：全局顶栏（品牌、连接徽标、搜索、终端/桌面/主题/设置）在 `<lg` 隐藏
    （`:class="mobileSingleBar ? 'hidden lg:flex' : 'flex'"`，纯 CSS，桌面不受影响），改为**一条 52px 顶栏**
    （`h-[calc(3.25rem+env(safe-area-inset-top))]`）：左按钮 `←` 44px（返回首页列表，`data-test="mobile-back"`）、
    中间头像（会话 = `AgentIcon`，Bot = `BotAvatar` 32）+ 标题（`text-base`）+ 副标题（`text-xs`：
    `实例 · agent · 分支`，缺项跳过，不会出现前导或连续 `·`）、右侧 `⋯` 40px 打开底部弹出菜单
    （`components/MobileSheet.vue`：`bg-raised rounded-t-[24px] shadow-float`，backdrop / Esc 关闭，
    `useModalA11y` 负责焦点进入与归还，条目 ≥48px；`dd-panel` 把面板标成「打开的下拉拥有的浮层」，
    只有下拉 / 行菜单自己的 sheet 才开，见「统一下拉框」）。会话栏由 `DashboardView` 渲染；Bot 栏由
    `DirectBotPane` 渲染（它自己拥有 edit / removal / nav 状态），副标题是当前话题、可点开话题选择 sheet；
    Group 栏由 `GroupPane` 渲染（副标题同样是当前话题，`⋯` 只带编辑群组条目），`DashboardView` 不再渲染
    群组静态标题条，`mobileSingleBar` 也因此把群组选择算进去（全局顶栏在 `<lg` 让位）。
  - **`←` 返回**（会话 / Bot / 群组页通用）：不再直接清选择，而是弹掉浏览器历史里我们自己的条目，
    由 popstate 关掉一层（sheet → 右抽屉/全屏标签 → 首页）。没有自有条目时（冷启动 / 深链 /
    PWA 恢复）直接 `router.replace` 回首页，绝不离站。完整规则见下文「手机端返回：浏览器历史即层栈」。
  - **未选中任何会话 / Bot / 群组（移动端首页）**：实例树直接作为主内容渲染——复用**同一个**
    `InstanceTree` 实例，左栏在 `<lg` 只在首页显示（全宽），选中后 `max-lg:hidden`（不挂第二份副本，避免本地视图状态分叉）；列表底部 `max-lg:pb-24`，FAB 不会盖住最后一行的 `⋯`；从树上打开的实例桌面也算离开首页，
    中栏占位符 `max-lg:hidden`；右下角 FAB「新建会话」（48px pill，`bg-accent text-on-accent shadow-float
    rounded-full`，含 safe-area）：唯一在线实例直接开 `NewSessionDialog`（经 `InstanceTree` 暴露的
    `openNewSession`），多个在线实例先弹实例选择 sheet，**上次使用的实例排最前**（来源 = `localStorage["xacpx.lastInstance"]`，每次打开会话时
    由 `DashboardView` 记录；取消选择会清掉持久化的聊天选择，所以不能直接用它）。
  - `⋯` 菜单项顺序：已打开标签（n）→ 文件 → 任务 → 终端（无能力时禁用并给出原因）→ 桌面（仅
    `desktopCapableForSelection`）。没有单独的「工作区」项，「文件」就是右抽屉里的文件面板（移动端全屏）。**没有模型项**——模型只留在
    composer 的 chip 上。底部 sheet 互斥，同一时间只开一个（`DashboardView` / `DirectBotPane` 各用一个 `activeSheet`）。「已打开标签」
    会替换掉 `⋯` sheet（不叠加），关闭后直接回到页面、不回 `⋯`：Chat + 每个打开的文件/diff/终端标签，点击切换、
    关闭走与桌面标签条同一 `requestCloseTab` 守卫路径（脏文件先确认、终端先 terminate）。
  - `ChatPane.vue` 的头部 chip 行在 `<lg` 隐藏（`hidden lg:flex`），桌面不变。
  - 移动端**没有左抽屉**。右栏（文件 / 任务面板）仍是**屏外抽屉**（`fixed inset-y-0` + `transform translate-x`），
    `lg:` 类把它覆盖回静态列，所以 `rightOpen` 仅在移动端可见、桌面无副作用；半透明 backdrop 点击关闭，
    右边缘左滑仍可打开。桌面（≥lg）左侧实例栏保持静态列，行为不变。
- **连接提示条**：`components/MobileConnStrip.vue` 紧跟移动顶栏下方，仅当本页面生命周期内连接**曾经成功过**
  且当前离线时显示（「连上过」由 `DashboardView` 在 `onStatus` 里记录并通过 `provide(CONN_EVER_OPENED)`
  下发，Bot 页的条在断线期间挂载也能正确显示；connection store 仍只有 `online` 布尔，中性态属后续 PR）。
- **触控目标**（`<lg`）：图标按钮 ≥40×40（`h-10 w-10 lg:h-7 lg:w-7` 之类，桌面尺寸保持原样），
  主要操作（composer 发送/停止、FAB、返回 ←）44px；bottom sheet 条目 ≥48px。
- **缩放与输入框字号**：`index.html` viewport 去掉 `maximum-scale=1, user-scalable=no`（恢复双指缩放），
  并在 `style.css` 末尾追加 `@media (pointer: coarse) { input, textarea, select { font-size: 16px !important } }`，
  避免 iOS 聚焦字号 <16px 的字段时自动放大。
- 中栏聊天始终占据剩余宽度；登录页/设置页（`max-w-2xl mx-auto`）本身是流式宽度，移动端无需额外处理。
- **Composer 层叠状态面板**：`ChatPane.vue` 在文档流 `composer-stack` 中按「状态条 → 计划面板 → 输入框」
  垂直排列（输入框在最上层）。视觉重叠用负 `margin-top` + 下层预留的 `padding-bottom`（`--stack-overlap`，
  桌面 16px / 窄屏 12px）实现，内容不被裁切；递进缩进让下层卡片边缘露出。消息列表与底部 stack 分栏，
  气泡不被遮挡。`PlanPanel variant="stack"` 限制最大高度并独立滚动；`TransitionGroup` 负责出现/消失动画。
  `TransitionGroup` 只负责各层的进入/离开淡入（`composer-layer-enter/leave`），**不定义 `.composer-layer-move`**：
  move 过渡是 FLIP（Vue 记录更新前后的 `getBoundingClientRect` 并写入内联 `translate(dx,dy)`），而这个 stack 位于
  `v-show` 面板内，面板隐藏时所有子元素量到 0,0，重新显示后的第一次更新会把输入框从 `(-paneLeft, -paneTop)`
  补间回原位——表现为“从左上角飞入”。没有 move 类时 Vue 直接跳过 FLIP，增减计划/队列层只是立即重排。
  `PromptInput` 自身结构与样式尽量保持不变，只由外层 stack 包裹。
- **三个对话面板共用一套组件**：会话（`ChatPane`）、Direct Bot（`DirectBotPane`）、Group（`GroupPane`）
  共用 `TranscriptRow.vue`（消息行：sticky agent 头像、说话人标签、`content-visibility` 虚拟化）、
  `ConversationComposer.vue`（输入卡片：圆角卡片、自增高 textarea、发送/停止按钮）与
  `TranscriptJumpLatest.vue`（回到底部 pill + 底部渐变）。三者共享同一套气泡、头像、时间戳、
  复制按钮、滚动内边距与 `max-w-3xl` 居中列语法。面板各自的特有控件（附件、model/effort、目标选择器、
  斜杠与 @ 补全菜单）通过 `ConversationComposer` 的 `menus` / `controls-top` / `controls` / `actions`
  slot 挂载；各自的 `data-test` 通过 `sendTestId` / `stopTestId` / `textareaTestId` 透传，
  因此测试选择器没有移动。
- **Composer 的 caret 契约**：textarea 归 `ConversationComposer` 所有，面板侧键盘逻辑不再直接读
  `selectionStart` / `selectionEnd`，改听 `caret` 事件。该事件在 input、keyup、click、select 以及
  外部值变更（发送清空、历史召回填充）时都会发出，所以面板不会读到过期 caret。`onInput` 在 jsdom 下
  （`setValue` 不移动选区）按值长度推导 caret。

### 桌面空状态与右栏折叠

- **未选中会话 / Bot / 群组 / 实例桌面时**（`nothingSelected`）：桌面中栏渲染
  `components/EmptySessionState.vue`（`absolute inset-0`，与 `DirectBotPane` / `GroupPane` 同一条
  v-if 链）：标题 `chat.emptyStateTitle`（zh-CN「继续上次的工作」）、最近会话列表（最多 5 条，跨在线实例）、
  「新建会话」主按钮（复用 `instance.newSession`）。`<lg` 时中栏 `max-lg:hidden`，空状态不出现
  （首页仍是实例树 + FAB）。
- **最近会话排序**：`SessionDto` 没有活动时间戳，不虚构相对时间。顺序 = store 列表顺序，持久化的
  上次打开会话（`loadPersistedSelection()`）置顶；离线实例的会话不进列表。
- **点最近会话行**走与实例树相同的 `onSelect` 路径。「新建会话」复用 `InstanceTree` 暴露的
  `openNewSession`：唯一在线实例直接开 `NewSessionDialog`，多个在线实例弹按钮上方的内联实例选择器
  （顺序同 `fabInstances`，上次使用排前）；无在线实例时按钮禁用。
- **右栏折叠**：桌面新增 `localStorage["xacpx.rightCollapsed"]`（镜像 `leftCollapsed`）。未选中会话时
  右栏不渲染（`showRightColumn`）；选中会话后恢复该开关的状态。右栏头部关闭按钮桌面也可见
  （`nav.hidePanel`：桌面写 `rightCollapsed`，移动端仍关 `rightOpen` 抽屉），折叠后中栏右缘出现
  `expand-right` 细手柄（`nav.showPanel`）恢复。移动端屏外抽屉行为不变。
- `ChatPane.vue` 不再自带「选择一个会话」占位：空状态归 `DashboardView` 所有，
  `chat.selectSession` i18n 键随之删除。

## 手机端返回：浏览器历史即层栈（`src/lib/mobile-back.ts`）

`<lg` 下顶栏 `←`、iOS Safari 左缘右滑、安卓返回键/手势共用同一个浏览器历史：一条历史条目 = 界面上一层，
三者行为完全一致。`popstate` 只关一层，所有关闭路径都走同一个 `navigateBack()`，没有第二套 close 逻辑。

- **条目从哪来**：`useMobileBack({ pane, full })`（会话 / Bot / 群组 pane 1 条，全屏层 = 中栏
  文件/diff/终端/实例桌面标签 + 右文件/任务抽屉）+ `pushModal()`（遮罩层：MobileSheet、对话框、
  ImageLightbox、Mermaid、SubagentTrace、ConfirmDialog、CommandPalette，`DropdownPanel`
  在 `<lg` 也渲染成 MobileSheet，因此自动覆盖）。群组进程详情 `GroupRunDetailSheet` 也由 MobileSheet
  登记一条遮罩历史，自定义头部的 × 与遮罩、Esc 共用 `navigateBack()`；安全初始焦点和滚动恢复保持不变。
  桌面 `GroupRunDetailPopover` 不登记历史。同类叠同类（sheet→sheet、sheet→dialog、全屏→全屏）
  走 `router.replace`，所以「返回」永远先回到首页。桌面小下拉 / ContextMenu / tooltip / 话题切换 /
  首页 tab 切换**不建条目**。新建会话流程：FAB → 实例 sheet（push）→ 新建对话框（replace）→
  创建成功 → pane（replace 成 `pane`），一次返回即回首页。
- **返回顺序**：先关最上层遮罩（与 Esc 栈同序，一次一层）→ 再收全屏层（中栏标签回到「对话」标签，
  标签仍留在已打开列表；右抽屉收起）→ 再 `goHome()`。在首页时不再拦截，正常离开站点
  （没有「再按一次退出」）。
- **`navigateBack()` 是唯一返回入口**（顶栏 `←`、sheet ×、backdrop、Esc、ConfirmDialog 取消、
  ImageLightbox 关闭都走它）：有自己的条目就 `history.back()`，让 popstate 去关那一层；没有自有条目
  （冷启动 / 深链 / PWA 恢复，或 Chrome「历史操作干预」跳过了非用户手势写入的条目）时直接
  `router.replace` 回首页，**绝不离站**。返回飞行中 `backInFlight` 置位、`←` 禁用，连点不会逃逸。
- **冷启动 / 深链**：顶层不是我们自己的条目时，`adoptHomeEntry()` 先 `router.replace` 回首页再
  `router.push` 进 pane，vue-router 的 state（`back`/`current`/`position`）保持正确，`←` 与安卓返回键
  都回首页；深链的 `?instanceId&sessionAlias` 照旧清掉。刷新时 `history.state` 保留，若顶层是遮罩 /
  全屏条目则静默 `history.go(-n)` 回到 pane 条目。
- **状态标签**：条目带 `history.state.xacpx = { layer, id, depth }`，popstate 按 `depth` 关到对应层；
  快速连按返回时每个 popstate 只同步关一层，程序化返回用计数器跟踪，不会出现空条目。
- **会话被别处删除**（CLI / 其他客户端，reconcile 移除）：自动回首页——`goHomeReclaiming()` 先关层再
  `history.go(-depth)` 回收条目并忽略这次 popstate，不留死条目，同时 toast「该会话已被删除」
  （`session.deletedElsewhere`，en / zh-CN）。Bot / 群组的 `clearSelection` 走同一条同步路径，
  同样不留死条目。
- **桌面（≥1024px）不建任何条目**；`<lg` → `≥lg`（iPad 旋转）时自动关闭仅移动端的浮层并回收其条目。
- **不做自定义手势**：只用 iOS Safari 原生左缘右滑，pane↔首页、关层都没有滑动/淡入动画；左缘 24px 内
  没有可横向滑动的元素（`use-swipe-actions` 在 `clientX < 24` 时不让行滑动接管）。

## 文件地图

- `src/api/client.ts` —— REST 客户端（登录、`/api/instances`、`/api/instances/:id/rpc` 代理调用、历史）；
- `src/lib/render-markdown.ts` —— 净化版流式 markdown 渲染（markdown-it + remend + DOMPurify）；
- `src/lib/use-dropdown.ts` —— 统一下拉框 composable（开关、键盘导航、外部点击/Esc 关闭、焦点归还；keydown 走捕获阶段，Esc 只关下拉不关宿主对话框；桌面面板在 Tab 把焦点移出触发器+面板时关闭）；
- `src/lib/mobile-back.ts` —— 手机端返回：浏览器历史即层栈（`<lg` 的 `←`/iOS 右滑/安卓返回键共用，见「手机端返回」一节）；
- `src/components/DropdownPanel.vue`、`SelectMenu.vue`、`Tooltip.vue` —— 统一下拉浮层 / 表单字段下拉 /
  hover 提示（见「统一下拉框」一节）；
- `src/api/events.ts` —— WS 客户端（`connectEvents` → `/ws`，自动重连）；
- `src/stores/auth.ts` —— 登录态；`src/stores/instances.ts` —— 实例/会话树 + `applyEvent`；
  `src/stores/chat.ts` —— 聊天流、NUL-key 流式缓冲、`error`、`loadHistory`/`loadOlder`/`ensureFullMessage`/`send` + `applyEvent`；
  `src/stores/tasks.ts` —— 定时/编排（loadFor/create/cancel + `applyEvent`）；
  `src/stores/notices.ts` —— notice toast 队列；`src/stores/connection.ts` —— `/ws` 在线态；
- `src/views/LoginView.vue`、`src/views/DashboardView.vue`、`src/views/SettingsView.vue`；
- `src/components/InstanceTree.vue`、`ChatPane.vue`、`MessageList.vue`、`PromptInput.vue`、
  `NewSessionDialog.vue`、`ManageInstanceDialog.vue`、`WorkspacesManager.vue`、`AgentsManager.vue`、
  `TaskPanel.vue`、`ScheduledTasks.vue`、`OrchestrationTasks.vue`、`NoticeToast.vue`、`ConnectionBadge.vue`、
  `TurnParts.vue`、`SubagentStepCard.vue`、`SubagentTraceDialog.vue`；
- `src/router/index.ts`（含 `/settings` 路由）、`src/main.ts`、`src/App.vue`、`src/style.css`。

## 文件树浏览器（Files 面板 / 子项目 A）

`FilesPanel.vue` 的 **Files tab** 是懒加载**树视图**（`FileTreeNode.vue` 递归 + `ContextMenu.vue`）：

- **树 / 懒加载**：根 = 会话 workspace 根；展开文件夹时按需调 `control.fs.list` 拉该层（`store.tree` 逐目录缓存，`store.expanded` 集合按 workspace 存 localStorage）。去掉了旧的面包屑 + 向上按钮。文件夹开/合图标（`FolderOpen`/`Folder`），文件按扩展名映射 lucide 图标（`src/lib/file-icons.ts`）。
- **gitignore / 点文件**：`control.fs.list` 的每个条目带 `ignored`（后端 `git check-ignore`）；点文件按名判定。两个切换「显示点文件 / 显示 Git 忽略文件」默认关（存 localStorage），显示时以低透明度 + 斜体呈现（视觉「被忽略」）。默认隐藏使 `node_modules`/`.git` 不进树。
- **git 状态点**：改动过的文件/含改动的目录在树节点上显示 M/A/D/? 状态点（复用 `store.changed`，由 `loadStatus()` 填充）。
- **高级搜索**：主查询 + 三开关「精确大小写 / 匹配整词 / 正则」+「包含 / 排除」glob + 模式切换「文件名 / 内容」。内容模式为 grep（后端优先 `git grep`，非 git 回退手写走查；include/exclude 对返回路径后置过滤、`path` 限定作用域）。协议 `FsSearchPayload` 携带 `mode/matchCase/wholeWord/regex/include/exclude/path`，`FsSearchResult` 返回 `matches`(名字) / `hits`(内容 `{path,line,text}`)。
- **右键菜单（只读子集）**：复制路径（**主机绝对路径** = `FsListResult.root + sep + relPath`）、复制相对路径（workspace 根相对）、（文件夹）在此文件夹搜索。写操作（新建/重命名/删除/下载/在 OS 打开）属**子项目 B**，本面板只搭右键菜单骨架。
- **移动端**：右栏抽屉在 `<lg` 满屏宽（`w-full`）。

后端只读、复用 `WorkspaceFs.resolve()` 三道闸（account-owns-instance → workspace 名白名单 → realpath 包含），无新增 config 门。

## 文件写能力（子项目 B）

Files 面板支持以下写操作（均需在 xacpx daemon config 启用 `files.writeEnabled`，默认关闭）：

- **新建文件** — 在当前目录创建空文件，返回 `{path, mimeType}`
- **新建文件夹** — 在当前目录创建目录，返回 `{path}`
- **重命名** — 重命名文件或目录，返回 `{path}`
- **复制（副本）** — 复制文件或目录，自动去重（复制后的名称避免与现有文件冲突），返回 `{path}`
- **删除** — 永久删除文件或目录，删除前需二次确认，无回收站，返回 `{path}`
- **下载** — 下载文件（≤5 MiB，超出拒绝），返回 base64 编码的文件内容 + MIME 类型；**下载不受 `files.writeEnabled` 门控影响**，用户总能下载

### 门控与安全模型

- **`files.writeEnabled` 开关**：xacpx daemon 的 `config.files.writeEnabled`（boolean，默认 `false`）控制文件写入及下述结构化 Git mutation；关闭时相关 Control RPC 返回 `files-write-disabled`，只读操作（list/download/Git status）仍可用。**该开关可从看板热切换**：实例管理弹层 General 面板的「文件写入与 Git 改动」开关走 `control.files.settings.get/update`，写入 `files.writeEnabled` 后立即发布到 daemon 的内存 config（门控每次操作读取该对象），无需重启。老 connector 对这两个 RPC 回 `unknown-type`，老 daemon 回 `unsupported`，两者都渲染升级提示。
- **安全隔离**：写操作复用 `WorkspaceFs.resolveParent()` 和 `WorkspaceFs.resolve()` 三道闸（account-owns-instance → workspace 名白名单 → realpath 包含），确保操作不脱离 workspace 容器。
- **删除确认**：Web UI 在执行删除前弹出确认对话框，删除后无法恢复（永久删除）。
- **下载大小限制**：单个文件≤5 MiB；超出大小的文件下载请求被 relay hub 拒绝（413）。

### 实现细节

- `control.fs.create(path, kind)` — `kind: "file" | "directory"`
- `control.fs.rename(path, newName)`
- `control.fs.delete(path)`  
- `control.fs.copy(path, destName?)`  — destName 自动避开现有同名文件
- `control.fs.download(path)` — 返回 `{base64, mimeType, size}`

Web 侧 `FilesPanel.vue` 在树节点右键菜单或行操作按钮中暴露这些操作；关闭时菜单项禁用。

## Changes 面板 Git 操作（A + C）

Changes tab 在原有差异列表上增加结构化 Git 工作流：

- **紧凑上下文（A）**：顶部显示/切换本地分支、upstream 与 ahead/behind，并提供
  Fetch、`Pull --ff-only`、普通 Push。首次 Push 需确认后才执行 `--set-upstream origin`；
  不提供 force push、merge 或 rebase。
- **改动与提交**：每个文件可暂存/取消暂存，也可按组或全部暂存；底部固定提交输入区，
  只提交 staged 文件。运行中的 Git 操作会锁住冲突控件，并在面板内显示进度、成功或错误，
  完成后重新读取 Git 状态与 diff。
- **未推送撤销（行内）**：每个改动行提供两个破坏性操作，均走 danger ConfirmDialog 二次确认：
  - **取消追踪（untrack）**：`git rm --cached`，从索引移除但保留磁盘文件（随后以未追踪状态出现）；
    未追踪行（`??`）不显示此按钮，也不改动 `.gitignore`。
  - **恢复到基线（discard）**：把文件恢复到 HEAD（同时丢弃 staged 与工作区改动）；对未追踪文件，
    discard 语义为从磁盘删除。重命名会连带复原源路径。
- **分支安全**：可切换或从指定起点创建本地分支；dirty worktree 拒绝切换和 pull，Web
  不自动 stash，也不会隐式丢弃用户改动。
- **worktree 上下文（C）**：按需展开当前仓库的 worktree 列表。创建时客户端只提交分支与
  workspace 名称，宿主路径由 daemon 在 `~/.xacpx/worktrees` 下生成；成功后注册 workspace，
  并用当前会话的 agent 新建、切换到该 worktree 会话。v1 不提供删除或 prune UI。
- **异步上下文隔离**：diff 请求记录 instance/workspace 与请求序号；切换会话或工作区后返回的
  旧响应（包括错误与 loading 收尾）会被丢弃，不能覆盖新工作区的 Changes 状态或成为后续 Git
  mutation 的路径来源。
- **前端边界**：`src/lib/use-changes-git.ts` 持有 Changes 面板的分支、同步、暂存、提交与
  worktree 工作流；`FilesPanel.vue` 只负责文件导航和组合渲染。

Git 状态使用 `control.git.status`；写 RPC 为 `control.git.stage/unstage/untrack/discard/commit/fetch/pull/push/checkout/worktree.create`。
所有 Git 写 RPC 与文件写操作共用 `files.writeEnabled`（默认关闭）。

### 范围说明

"在 OS 打开"（open-in-browser/open-in-finder）已明确排出范围，不实现。仅提供下载供本地查看。

## 如何与 relay 通信

- **REST**：`/api/*`（登录、实例列表、会话/历史快照），其中
  `POST /api/instances/:id/rpc` 是服务端盖戳的代理（覆写 chatKey/senderId/isOwner，只放行 control.*）；
- **WS**：`/ws`（cookie 鉴权的 web 事件扇出端点，与实例网关 wsPort 分离）。

## 生产托管与开发

- **生产**：`xacpx-relay start --web-root <dist>` 由 relay 服务静态托管构建产物（SPA fallback）；
- **开发**：`bun run --cwd packages/relay-web dev` 起 Vite dev server，
  Vite 代理把 `/api` 与 `/ws` 转发到 `:8787`（见 `packages/relay-web/vite.config.ts`）；
- **构建**：仓库根 `bun run build:relay-web`（先 build relay-protocol 再 vite build）；
- **测试**：仓库根 `bun run test:web`（Vitest）。

## RMUX 共享终端（看板行为）

当实例在线且同时具备 `terminal.rmux.recovery.v1` 与 `terminal.multi-view.v1` 时，会话 Tab 可打开可恢复终端。

用户语义（与 legacy live-PTY 的关键差别）：

- **Tab 上的 `X` = 全局终止**该共享 shell（有 ack：`terminated` 或 `cleanup-pending`）。`viewerCount > 1` 时必须确认。打开从未成功（没有 `terminalId`）时只丢掉本地 Tab，不走 terminate RPC，避免误报「无法打开终端」。
- 看板 `/ws` 断开或 connector 重连中途的 open 失败分别是 `events-offline` / `instance-reconnected`，**不是**实例离线；Tab 会在连接恢复后自动重试。
- **关闭浏览器窗口 / 刷新 / 断网**只 detach 本地 attachment，**不** kill RMUX session；其他设备上的 viewer 继续。
- **多设备**共享同一个 `terminalId`/`generation`：首个打开方为 controller，其余为 spectator；spectator 可 **take control**。顶栏「X 位观看者」是**除自己以外**的连接数（协议 `viewerCount` 仍是总 attachment 数，关闭确认和容量上限继续用总数）。
- Tab 布局 / 本地 UI 状态不跨设备共享；只共享底层 shell。
- 用户文案使用「睡眠/唤醒」；API / 代码里仍可见 archive 拼写（兼容）。
- 终端渲染用 `@xterm/xterm`（DOM 渲染器，随终端 Tab 按需 lazy chunk 加载，`xterm.css` 一并懒加载，无 WASM 资产）。xterm 自己把不可见的 helper textarea 锚定在光标所在单元格（随光标移动更新），IME composition（`compositionstart/update/end`、`isComposing`、keyCode 229）由 xterm 内建 CompositionHelper 处理、最终只提交 committed 文本——adapter 不做任何 IME 锚定 hack，`focus()` 直接 `Terminal.focus()`。adapter 的 fit()/localGeometry() 用 `.xterm-screen` 渲染度量（xterm 把它设为精确 cols×cellW × rows×cellH）。iOS 中文 IME 的确认/空格/中文标点常走 keyCode=229：stock `@xterm/xterm@6.0.0` 的 `_inputEvent` 会丢掉 `composed` + 已见 keydown 的 `insertText`，而 CompositionHelper 的 229 textarea `setTimeout(0)` diff 可能在 value 更新前空跑，或与 #5614 式 `_inputEvent` 门闩双发；相同长度替换还会把整段 textarea 发出去（xtermjs#5835）。单独回移 #5614 不够。adapter 在构造后本地回移 #5836：pending 229 由 keyup/timer 收敛、精确 DEL+insert（含 delete+insert / 相同长度替换 / 重复 keydown），一次 229 只有一个发送方；不把 helper textarea 拉成全屏。真实 iOS Safari 仍需实机验证。
- 同一 `viewerId` 再次打开会替换旧 attachment，避免留下幽灵 controller 把新连接变成 spectator（快捷键栏全灰）。若仍是唯一观看者却是 spectator，看板会自动 take-control。
- 共享协议的 `parseCanonicalBase64` 必须 runtime-neutral（浏览器 `atob`/`btoa`，Node/Bun 可回退 `Buffer`）；浏览器没有 Node `Buffer` 时若直接 `Buffer.from`，`terminal-rebase-chunk` / `terminal-bytes` 会被静默丢弃并陷入 resync 黑屏。快捷键栏没有本地回显：按键只发到 PTY，字符要等 recover 进入 live 后的 `terminal-bytes` 才画上终端。open 成功后会发一次 `terminal-stream-start`；若 recover 一直停在 waiting，controller 第一次输入和 take-control 会再补发一次，避免 rebase-start 丢失后画布空白。同一 pane 的 `recover` / `stop-recover` 在 connector sidecar driver 里按 FIFO 串行，并用 start barrier 让同时打开的 viewer 共享同一次 recover；最后一个 viewer 离开后的 stop 不会因为立即 reopen 而跳过；catch-up cache 超预算触发的 snapshot refresh 同样进入 stopping barrier。Node 的 stop-recover 超时不会解除 stopping，要等 fresh recover ACK。replacement 的 first event 必须是 fresh rebase。显式 `recover` 在 sidecar 里总是重启 recovery task，且 RPC 成功表示已经拿到 initial rebase（stdout 先排队 rebase 再读后续 bytes；启动含 `recover_output` 最多等 10s）。stdin 上只有 Recover 异步，Create/List 仍串行。致命 `terminal-recovery-failed`（含 snapshot refresh 失败、以及 live 后 recovery stream 断开）切到错误态并禁用输入 / take-control，但**不会**把还活着的 shell 收掉；sidecar 进程本身崩溃则按 owner-loss 清理。顶栏观看者只在本地仍 attached 时显示其他人。

实现入口：`packages/relay-web/src/stores/terminal.ts`、`TerminalTab.vue`、recovery reducer
（`src/lib/terminal-recovery.ts`）。权威状态机见 RMUX terminal design spec。

## 实例桌面（RFB/VNC 看板行为）

当实例在线且具备 `desktop.rfb.v1` 时，顶栏出现 Desktop 入口（实例级，不属于任何 session）。点击后打开实例级 Desktop 面板（`DesktopTab.vue` + `stores/desktop.ts` + `lib/desktop-client.ts`）。

- **协议**：面板先经 `/ws` 发 `desktop-open`（15s 截止），拿到 `desktop-opened`（`streamId` + 单次 `wsPath=/desktop/observe?ticket=…` + `security`）后，用独立 WebSocket 连二进制面，再由 noVNC（`@novnc/novnc`，动态 import，`rfb-*.js` 独立 chunk）完成 RFB handshake。VNC 密码只存当前 tab/store 内存，不进 localStorage/sessionStorage；页面刷新或重连必须重新 `desktop-open`（不复用 ticket）。关闭面板发 `desktop-close` + 关 WS。
- **状态**：opening → auth-required（VNC 密码，或 macOS 账户表单）→ connecting → open；busy/unavailable/auth-unsupported/offline 有独立错误码文案；`desktop-instance-offline` / `desktop-stream-timeout` / `events-offline` 可重试。`security=ard` 时 noVNC 只接受 None（type 1）：connector 已经完成 Apple Remote Desktop，浏览器看到的是固定的 RFB 3.8 None 问候。
- **错误横幅**：错误码经 `desktopErrorKey()` 取原始 message（含主机端操作建议）而非改用意译文本，无映射的 code 回退到 code 本身。VNC 密码被拒（`desktop-auth-failed`）绝不能与 `desktop-auth-unsupported` 混淆——前者是重试就能修的用户错，后者是配置问题。`closed` 且带 `lastErrorCode` 的行展示该 code 的文案，而不是笼统的「已关闭」。
- **排障与平台限制**：见 [`docs/desktop-rfb-setup.md`](desktop-rfb-setup.md)；后端语义见 `docs/relay-module.md` 实例桌面小节。
- **显示**：Fit / Actual（`scaleViewport`，`resizeSession=false`）；v1 无 viewer count / take-control（多 viewer 需服务端 RFB view-only filter，见设计 Phase C）。
- **边界**：Windows 锁屏/UAC/登录屏不保证；macOS 账户名和密码只在一次 `signIn` 里送出，重连会再问；多 viewer、录像、文件传输、剪贴板自动同步都不做。

## PWA（可安装 + 应用壳缓存）

看板是可安装的 PWA：支持「添加到主屏 / 安装为独立窗口」，并对应用壳（JS/CSS/字体/图标/`index.html`）做 Service Worker 预缓存以加速二次加载。它是 **WS 实时控制台**，所以 PWA 的目标是「可安装 + 秒开」，**不做离线数据**——断网时壳能开，但实时数据仍需 WS 重连。

- **实现**：`vite-plugin-pwa`（`generateSW` + Workbox），选项集中在 `packages/relay-web/src/pwa-options.ts`（vite.config 与漂移测试共用同一对象）：
  - `registerType: "autoUpdate"`——新版本由 SW 后台拉取，下次导航/刷新静默生效，无更新弹窗；
  - `navigateFallback: "/index.html"` 配 `navigateFallbackDenylist: [/^\/api/, /^\/ws/]`——SPA 路由走缓存 index，但**绝不影响 hub 的 `/api`、`/ws`**；
  - SW 在 `src/main.ts` 通过 `virtual:pwa-register` 的 `registerSW({ immediate: true })` 显式注册（`injectRegister: false`）；`devOptions.enabled: false`，`vite dev` 不起 SW（避免开发期缓存困扰）。
- **图标**：两个源文件——`assets/pwa-source.svg`（暗底满铺 + 品牌蓝绿 X，与 `BrandLogo.vue` 同步，用于 any/apple/favicon），`assets/pwa-maskable-source.svg`（同款但 X 内收进 maskable 安全区，专供 maskable）。生成的 PNG 提交在 `public/`（`pwa-64/192/512`、`maskable-icon-512x512`、`apple-touch-icon-180x180`、`favicon.ico`）。重新生成：`bun run --cwd packages/relay-web generate-pwa-icons`（`scripts/generate-pwa-icons.mjs` 调 `bunx @vite-pwa/assets-generator`，故 CI 构建不依赖 sharp）。
- **打包链路**：`vite build` 把 `sw.js`/`workbox-*.js`/`manifest.webmanifest`/图标都输出到 `dist/`，再由 `bundle:relay-web` 整体拷进 `relay/dist/relay-web`；hub 的 hono `serveStatic` 在根作用域服务（`manifest.webmanifest` 命中 hono mime → `application/manifest+json`，`sw.js` 默认作用域 `/`）。
- **部署前提（关键）**：Service Worker / 安装能力要求 **安全上下文**——`https://` 或 `localhost`。自托管 hub 走纯 `http://`（局域网 IP）时 SW 不会注册、也不可安装；需在反向代理上挂 TLS。详见 [relay-deployment.md](relay-deployment.md)。
- **漂移守护**：`src/__tests__/pwa.test.ts` 校验 manifest 引用的每个图标都在 `public/` 存在、`autoUpdate` 与 `/api`·`/ws` denylist 未被删。

## 阶段六：Turn 状态展示（turn-status display）

### `LiveTurn` 模型与 store getters（packages/relay-web/src/stores/chat.ts）

```ts
export interface LiveTurn {
  text: string;          // 累积的流式输出（turn-output chunk）
  toolSteps: ToolStepDto[];  // 已规整的工具步骤列表（tool-event upsert）
  reasoning: string;     // reasoning 文本（turn-thought chunk）
  status: "working" | "streaming";  // working=刚启动，streaming=已收到首个 output chunk
  startedAt: number;     // Date.now() 时间戳，供 HUD 计算 elapsed
}
```

关键 computed getters（`useChatStore`）：

- `liveTurn` — 当前选中会话的 `LiveTurn | null`（按 NUL 键 `${instanceId}\0${alias}` 索引）。
- `busy` — `liveTurn !== null`，控制输入框禁用与 HUD 可见性。
- `streaming` — `liveTurn?.text ?? ""`，传给 `MessageList` 做流式渲染。

### `applyEvent` 处理逻辑

- `turn-started` → `ensureTurn(key)` 创建或重置 accumulator（`{ text:"", toolSteps:[], reasoning:"", status:"working", startedAt:Date.now() }`）。
- `turn-output` → `t.text += chunk; t.status = "streaming"`。
- `tool-event` → 按 `toolCallId` upsert `t.toolSteps`（找到则替换，否则追加）。
- `turn-thought` → `t.reasoning += chunk`。
- `turn-finished` → 删除 `liveTurns[key]`，计算终态 `status`（`cancelled ? "cancelled" : ok ? "done" : "error"`）；若当前选中会话有内容则 push 一条 `ChatMessage`（含 `structured: { toolSteps, reasoning? }`）进 `messages`；`ok=false && !cancelled` 时设置 `error` ref。
- 实例离线（`instance-status online=false`）→ 按前缀批量删除该实例的所有 liveTurns。

历史消息加载（`loadHistory`）返回的 `MessageRecordDto` 携带服务端持久化的 `structured` 字段，reload 后同样可渲染。

### 组件

**`ToolCallPanel.vue`**（`packages/relay-web/src/components/ToolCallPanel.vue`）

- props: `steps: ToolStepDto[]`。
- 兼容旧历史格式的聚合面板，去卡片化单行头部（Wrench 图标、kind 统计小标、步数）；默认折叠，展开后以左侧导向线缩进呈现各 step。
- 点击行展开 `<ToolDetail>` 详情。

**`ToolStepCard.vue`**（`packages/relay-web/src/components/ToolStepCard.vue`）

- 有序 `parts` 中单个 tool call 的去卡片化流式行（zcode 风格）：无外层边框与卡片背景，由图标、操作动词（终端/编辑/写入/查阅/搜索等）、文件扩展名角标（TS/VUE/PY 等）、标题、行级 diff stat（`+4` / `−1`）、耗时及状态图标构成单行摘要。
- 详情默认折叠，点击后在行下方以左侧导向线（`border-l-2`）无缝缩发展开 `<ToolDetail>`；历史消息和实时 streaming 消息遵循同一规则。

**`ReasoningPanel.vue`**（`packages/relay-web/src/components/ReasoningPanel.vue`）

- props: `reasoning: string; defaultOpen?: boolean; streaming?: boolean`。
- 去卡片化极简单行（Brain 图标、思考/思考中文案、streaming 脉冲点）；默认折叠，展开后在下方以左侧导向线缩进渲染思考正文，不产生外层卡片框线。用户可按需展开。

**`ToolDetail.vue`**（`packages/relay-web/src/components/ToolDetail.vue`）

按 `ToolDetailDto` 变体渲染，无原始 JSON：
- `diff` — 红/绿行 `-/+` diff 视图，显示路径、删除行（红色 `-`）、新增行（绿色 `+`）。
- `command` — `$ <command>` + 深色背景 preformatted 输出 + exit code。
- `read` — 文件路径 + 可选行范围 + preformatted 预览。
- `search` — 查询串 + preformatted 输出。
- `text` — `whitespace-pre-wrap` 纯文本。
- `fields` — `<dl>` 键值表格 + 可选输出块（用于 other/think 类型）。

**运行状态胶囊 `RunStatusChip`**（`packages/relay-web/src/components/RunStatusChip.vue`）

所有“有运行在飞”的界面共用一个状态胶囊，避免两套视觉语言：

- props：`state`（`running` / `queued` / `waiting`）、`label`、`elapsed?`、`shimmer?`。
- 三态**只靠圆点的行为与颜色**区分，不靠给文字染色：`running` 呼吸点（`pulse-dot` + `bg-run-bright`）、
  `queued` 静止弱化点（`bg-fg-muted/60`）、`waiting` 静止 `bg-warn` 点。静止本身就是“等你动手”的信号，
  因此等待人工确认时**不再转动**，不会被误读成仍在工作。
- 耗时用 `border-l` 细线 + `text-fg-muted`（5.4:1）。测试钩子：`run-status`（带 `data-status-state`）、
  `hud-dot`、`hud-quip`、`hud-elapsed`。
- 胶囊是**唯一**的运行指示；调用方的正文区不再渲染第二个 spinner，只保留高度占位。

**工作气泡 `WorkingQuip`**（`packages/relay-web/src/components/LiveTurnAvatar.vue` / `WorkingQuip.vue`）

回合进行中，俏皮状态行 `data-test="hud-quip"`（`chat.workingQuips` 池随机抽、每 20s 轮换不连重；池为空回退 `chat.mentionActivity.working`）+ `M:SS` elapsed 计时（`useWorkingQuip`，由 `liveTurn.startedAt` 驱动）以对话气泡形式挂在**实时回合**行的 sticky 头像上（`[data-avatar-key="live"]`，即最新一条 agent 回合），而不是视口内最靠上的头像。
- 气泡复用 `RunStatusChip`，当前固定为 `running`：会话的 `LiveTurn.status` 只有 `working | streaming`，没有等待/排队态。
- transcript 正文区的 `data-test="live-working"` 槽位只保留 `h-[22px]` 占位，不再渲染独立的 `Loader2`。
- 气泡是 `LiveTurnAvatar` 内的子元素，相对 sticky 头像绝对定位于图标头顶（`bottom: calc(100% + 4px)`），随布局原生移动：无滚动监听、无 `getBoundingClientRect`、无跟随延迟。
- 头像被钉在滚动容器顶部、头顶无空间时，`IntersectionObserver` 观察头顶的哨兵条并切换 `quip-beside` 类，把气泡移到图标右侧；不支持 `IntersectionObserver` 的环境保持默认头顶位置。
- 全局同一时刻只有一个气泡；无实时回合时不渲染。输入框 busy 时 placeholder 保持静态 `chat.working`。

**`PromptInput` busy-guard**（`packages/relay-web/src/components/PromptInput.vue`）

- props: `busy?: boolean`。
- `busy=true` 时 textarea 禁用（`disabled` 属性 + `bg-slate-100` 样式）、placeholder 改为 `"Agent is working…"`，Enter 键提交也被 guard 拦截。

**`MessageList.vue` 渲染**（`packages/relay-web/src/components/MessageList.vue`）

- 历史 `out` 消息的复制、时间及失败/停止状态始终可见；失败行永不折叠（错误必须显眼），
  其余 finished 行的中间过程 trace 默认折叠进回合头部（见下文「回合 trace 折叠」）。
- `structured.parts` 由 `TurnParts` 按 Markdown 顶层块派生展示顺序：工具或推理不会切断正在生成的段落、
  列表、表格或代码围栏，而是在该块结束后显示；若事件本来位于两个块之间，则保持文字—活动—文字的穿插结构。
  实时 streaming 与历史回放使用同一派生规则。
- 旧历史没有 `parts` 时回退到聚合 `ToolCallPanel` + markdown/reasoning，其中工具面板与 reasoning 同样默认折叠。
- **Live-turn 槽位（跨会话 received card）**：`turn-started` 把 live turn 锚在当时最后一条 transcript
  之后（触发用 received card / prompt），而不是列表底部。回合中途再来的 received card 追加到
  `messages[]`，因此出现在 live 气泡**下面**：`card1 → live turn → card2`。`parts.length === 0`
  时仍占据该槽（`live-working` 只留高度占位，运行指示在头像气泡上），避免第二张卡叠在尚未可见的 turn 上。Sent card 仍按
  `agentMessageId` 接入 `TurnParts`（Gate A）；received card 永不抑制、永不嵌进 turn（Gate B）。
  `turn-finished` 把 `out` 行 **splice 进该槽**（带 `startedAt` 作 HUD 遥测，以及 Hub
  `slotAfterId` 作插入序锚点），而不是 `push` 到末尾。`loadHistory` 对带 `slotAfterId`
  的 `out` 把 **Hub id 大于该锚点** 的 transcript 行（received card **以及** 忙时排队的
  user prompt）挪到该 `out` 之后；无 `slotAfterId` 的旧行不重排。**不以** `createdAt` /
  `startedAt` 墙钟比较决定顺序（发送端 daemon、Hub、浏览器时钟不可比）。Stick-to-bottom /
  jump-latest 在 live turn 存在时跟随 live 气泡，而不是最新一行。

### 回合 trace 折叠（turn-trace collapse，spec 2026-09-07）

参照 zcode：回合结束后把思考、工具、子代理以及穿插在过程中的叙述文字等中间过程全部折叠进一条弱化头部行
（`▸ 已工作 4分32秒 · 6 步工具 · 3 段思考`），仅在折叠行下方展示最终回复正文；点击展开恢复完整的交错执行过程。纯文字回合与失败回合不折叠。

- **触发与折叠时机**：`turn-finished` 把 live turn 定型为历史消息的瞬间（`streaming` prop
  消失）即折叠。它就是 ACP `session/prompt` response 落定（`stopReason:"end_turn"`）在
  xacpx 管线里的等价事件，无需引入新的控制事件种类。live（streaming）行不折叠，仍由 HUD 计时。
- **架构与计算分工**：`MessageList` 作为父层持有 `sentAgentMessageById` 并管理复制按钮与折叠参数，通过 `extractCollapsedTraceSummary()` 一次性从同一 presentation 派生提取 `finalReplyText`、`toolCount` 与 `thoughtCount`，并以 WeakMap（`(ChatMessage, parts)` 为键）缓存，避免父子重复解析。计算结果作为 `:collapsed-reply-text`、`:collapsed-tool-count`、`:collapsed-thought-count` 下发给 `TurnParts`；`TurnParts` 在独立测试或未提供预计算 props 时 fallback 执行 `extractFinalReplyText`。折叠时安全提取 Markdown 顶层块级别的最终回复（未闭合的 unsafe block 如代码块/表格/列表、或被切断的 inline 结构通过 fail-safe 仅留折叠头）；点击展开时延迟渲染完整的交错 presentation。复制按钮通过 `copyTextOf` 与折叠态显示使用同一 `finalReplyText` 语义结果。
- **终态持久化**：hub 在三个持久化点（live flush、无 buffer 兜底、offline recovery）把
  `turnStatus: "done" | "cancelled" | "error"`（由 `ok`/`cancelled` 派生）盖进
  `structured`，compact history 以 spread 原样保留。Web 的 `keepRicherStructured()`
  在收到 compact 页面时合并 hub 权威元数据（`turnStatus` / `truncated`），不再整份覆盖
  导致冲掉状态。失败 trace 因此在刷新与收敛后依然不折叠。
- **展开记忆按 `traceKey`**：一律优先 `«instance»:«session»:t:«startedAt»`——hub 在
  `turn-started` 广播中携带自身 buffer 的 `startedAt`，乐观 flush 行与持久行同源同值
  且被 hub 持久化（compact 也保留），所以乐观行 → 持久行收敛时 key 不变，手动展开必然存活；无 `startedAt` 的 legacy 行退回
  `«instance»:«session»:id:«n»`。存模块级 reactive Set（`lib/trace-expansion.ts`）；
  无身份行回退组件局部状态（不记忆）。
- **耗时口径**：`createdAt − startedAt`（浏览器/hub 时钟 − connector 时钟），仅展示用、
  非正值得降级为只显计数，亚秒显示 `<1s`；精确耗时需 hub 落 durationMs 列（未做）。

## 桌面系统通知（Web Push 与 本地 Notification Fallback）

Relay-Web 支持双轨桌面系统通知，在任务或会话回合完成/失败时提醒用户：

1. **服务端 Web Push**：基于 W3C 标准 VAPID 协议，由 Hub 发送至厂商推送端点（Chrome FCM、Apple APNs），即便浏览器标签页完全关闭也能接收。
2. **前端本地 Notification Fallback**：前端通过 WebSocket 接收 Hub 权威广播的 `turn-completion` Web 事件。在用户切到其他窗口（`document.hidden` 或 `!document.hasFocus()`）或正在查看其他会话时，直接调用浏览器 Notification API 弹出系统原生横幅。
   - **权威决策**：由 Hub 严格做 provenance、资格判定与去重，杜绝 recovery replay、scheduled、peer 和 internal worker 回合的误通知。
   - **零外网依赖**：在境内或内网未配置 FCM 代理时，只要标签页挂在后台，也能 100% 弹出通知。
   - **统一 Tag 会话隔离**：使用与 Web Push 相同的 `xacpx-turn:${instanceId}:${sessionAlias}` tag，避免跨会话覆盖，并在多端/双轨下优雅合并。
   - **设计 spec**：`docs/superpowers/specs/2026-08-26-relay-web-local-notification-fallback.md`。
## 消息附件（图片 / 文件上传）
用户可在 `PromptInput.vue` 随 prompt 一并发送图片或文件；附件经 `control.upload` RPC
上传到 daemon，再随 `control.prompt` 的 `media` 字段转发给 agent。

### 触发方式

1. **附件按钮**：输入框左侧的 `📎` 按钮打开系统文件选择器（`<input type="file" multiple>`）。
2. **剪贴板粘贴**：在输入框聚焦状态下按 `Ctrl/Cmd+V`，若剪贴板含图片文件则自动读取。
3. **拖放**：将文件拖入输入框区域即可附加；非文件拖放（如文本）不受影响。

### 限制

- 单次最多 **5 个文件**；超出时忽略多余文件并提示。
- 每个文件最大 **10 MB**；超大文件在客户端侧拒绝，不上传（relay hub 亦有同步 413 守卫）。

### 待发 chips

选中的文件在输入框上方以"附件 chip"形式排列，可单独移除；
发送成功或取消后自动清空。

### 图片预处理（客户端降采样）

类型为 `image/*` 的文件在上传前由 `Canvas` 降缩：长边超过 **512 px** 时按比例缩小，
再以 JPEG 格式编码，得到 base64 `previewUrl`。此 preview 随 `PromptAttachmentRef` 传给
relay hub 并持久化到 `attachments` 列，用于历史重显。非图片文件不做预处理，
`previewUrl` 字段省略。

### 发送流程

1. 选文件后，每个文件单独调用 `control.upload`（`UploadPayload`），
   daemon 返回 `UploadResult`（含服务器绝对路径 `path`）。
2. 构造 `PromptAttachmentRef[]` 并附在 `control.prompt` 的 `media` 字段内发送。
3. Hub 将 `attachments`（`AttachmentMetadata[]`）持久化到消息记录。

### 渲染

- **`MessageAttachments.vue`**：
  - 图片（`kind: "image"`）显示缩略图（来自持久化的 `previewUrl`）。
  - 非图片文件（`kind: "file"`）显示文件卡片（文件名 + 大小）。
- **`MessageList.vue`**：每条消息若含 `attachments`，在气泡下方插入 `<MessageAttachments>`。
- **历史重显**：页面刷新后，附件从服务端持久化的 `MessageRecordDto.attachments` 中恢复，
  图片缩略图和文件卡片均可再次显示。

### 图片全屏查看（lightbox）

- **触发**：两类消息图片均可点击进入全屏查看——附件缩略图
  （`MessageAttachments.vue`，按钮语义 + `cursor-zoom-in`）与 Markdown 正文内嵌的
  `<img>`（`StreamMarkdown.vue` 在根元素上做一次委托 click 监听，仅放行
  `http(s)/data/blob:` src，防止 `javascript:` 之类 URL 进入查看器）。
- **翻页范围 = 单个气泡/渲染段内的全部可看图片**（按出现顺序）：打开的是点击那张，
  左右箭头按钮 / 键盘 ←→ / 移动端横向滑动手势（≥48px，跟随手指位移）在组内切换上一张、
  下一张；顶部显示 `n / total` 计数与文件名。到头时箭头隐藏、键盘停住（不循环）。
- **关闭**：Esc、点击空白遮罩（拖动不误关）、右上角 ✕；打开期间锁定 body 滚动，
  关闭后恢复焦点与滚动。
- **实现**：状态是模块级单例 `src/lib/use-image-lightbox.ts`
  （`openLightbox(images, index)` / `closeLightbox()` / `stepLightbox(±1)`），
  查看器组件 `ImageLightbox.vue` 全局挂载在 `App.vue`（Teleport 到 body，z-[110]），
  任何渲染器无需逐层透传 props 即可打开。

### 相关文件

- `packages/relay-web/src/components/PromptInput.vue` — 上传触发 + chip UI
- `packages/relay-web/src/components/MessageAttachments.vue` — 附件渲染 + 缩略图点击
- `packages/relay-web/src/components/MessageList.vue` — 附件在消息气泡下插入
- `packages/relay-web/src/components/ImageLightbox.vue` — 全屏图片查看器
- `packages/relay-web/src/lib/use-image-lightbox.ts` — lightbox 状态单例
- `packages/relay-web/src/stores/chat.ts` — 发送时调用 upload + 附件随 media 字段传出

## Direct Bot 会话（PR5）

将 PR1–PR4 建立的 Bot 与 Direct Conversation 后端能力接入 Relay Web，提供独立的 Direct Bot 用户界面：

### 产品身份与隔离

- **产品 Identity**：全链路采用 `instanceId × botId × conversationId × topicId × runId × memberTurnId × requestId`，绝不以隐藏的 `brt_*` alias 作为 Web 路由或选择标识；
- **普通会话隔离**：普通 Sessions UI 绝不展示 hidden Bot logical session；普通会话状态树（`useChatStore`）严格忽略带 `conversation` 关联的轮次与事件；Bot 模式下普通会话的 Terminal 按钮、Files/Tasks 面板完全保持隐藏或禁用；
- **独立状态管理**：新增 `packages/relay-web/src/stores/direct-bots.ts`（Pinia `directBots` store），独立管理 Bot CRUD、话题列表与切换、按 `seq` 游标的消息历史加载与翻页、实时 Run 流式状态、Trace 投影及精确取消。

### 导航与 Bot 管理

- **Bot / Group 管理弹层的移动端布局**：`BotDialog.vue` 与 `GroupDialog.vue` 使用 Teleport 挂到 `body`，避免实例侧栏的 `transform` 把 fixed 遮罩限制在侧栏内。遮罩按动态视口高度和设备安全区留白；标题与操作栏不收缩，仅表单内容滚动。Group 的 fieldset 显式允许收缩，长成员名称和说明不会撑宽窄屏表单。

- **实例侧栏模式切换**：在左栏实例卡片中支持 `Sessions | Bots | Groups` 模式切换；切到 Bots 时展示 Bot 列表（名称、角色、agent、workspace 与启用状态），切到 Groups 时展示 Group 列表。Bots 与 Groups 列表顶部各自有标题行和总数；空间不足时模式标签保持单行并以省略号截断，不换行也不撑破导航行。会话过滤（睡眠会话）只在实例头部的过滤菜单里，且仅在 Sessions 模式展开时出现；
- **Bot CRUD（`BotDialog.vue`）**：支持创建与编辑 Bot（name、avatar、role、instructions、agent、workspace、model、effort、enabled；不含 cwd）。新建时工作区默认选择「新建专属工作区」，由所选实例的 daemon 在 `~/.xacpx/bots/` 下创建并注册，也可选择实例已有工作区；自动选项在请求中省略 `workspace`。没有已注册工作区时仍可创建 Bot。编辑仅选择已注册工作区。model / effort 使用 `ModelPicker` 和 `control.agents.capabilities.get`，不再使用写死的 effort 列表。编辑时按 `profileRevision` 回填 instructions，只提交用户改过的字段。旧的 `control.bots.delete` 仍只删除没有依赖的 Bot。
- **自定义动态头像（`BotAvatarEditor.vue` / `BotAvatar.vue`）**：Bot 弹层分为基本设置与头像外观；支持 6 个预设、8 种形状、12 种颜色、16 种表情、动画开关及临时状态预览。预览模式由弹层草稿持有，切换标签页不丢失；保存只提交 dirty 头像，取消不写入，默认图标保存后以 `avatar: null` 清除配置。旧文本完整保留，不下载 URL 或执行 SVG。数据与验收见 [Bot 头像设计方案](superpowers/specs/2026-10-14-relay-web-bot-avatar-design.md)。
- **头像状态与资源**：侧栏只展示身份，不聚合全局忙碌。Direct 按当前 Conversation / Topic / Run，Group 按精确 MemberTurn 与交互归属展示；完成动作只由已观察到的同任务完成事件授权，恢复快照与重连不回放。历史消息、选项、成员选择器和交接双头像静态渲染；可见动态头像共用一个帧时钟，离屏、隐藏、减少动态效果与卸载释放或暂停相应资源。普通 Session 与 Agent 品牌图标仍使用 `AgentIcon`。
- **受控移除（`BotRemovalDialog.vue`）**：侧栏、Direct 页面和 Bot 对话框都能打开。先调用 `control.bots.remove.preview`，再由用户确认 `control.bots.remove`。文案说明群组历史保留，私聊历史是单独勾选。两人组成员关系会挡住确认，不会自动删群或踢掉另一名成员。清理失败或结果不确定时用同一个 `requestId` 重试。`lifecycle.operations.get` 可在刷新后查看这次清理。已移除 Bot 在列表和群组记录里显示为 removed bot，composer 不再发送。预览里带 `dedicatedWorkspace` 时，实例声明 `bots.dedicated-workspace-cleanup.v1` 才会多出一个「同时删除专属工作目录」的勾选；目录仍在使用（`inUse`）时不提供该勾选，只说明它会被保留。

### 禁用 Bot 的整理与恢复

复用 `enabled` 开关，不新增后端状态，权限与调度语义保持不变。

- **侧栏过滤**：Bots 模式的日常列表只显示启用的 Bot。底栏的「已禁用（N）」按钮展开或收起禁用列表；当前选中的禁用 Bot 在收起时仍保留一行，避免禁用后从侧栏消失。全部禁用时显示 `no-enabled-bots` 提示，而不是空列表。Bot 列表顶部标题行的数量仍是 Bot 总数，包含已禁用的 Bot。
- **恢复入口**：禁用行常驻「启用」按钮，调用 `bots.update({ enabled: true })`。成功后提示「禁用期间排队的工作可能立即开始」；失败或超时提示无法确认，并重新拉取 Bot 列表，以列表为准。
- **`BotDialog` 说明**：与已保存的 `enabled`（优先取已加载的详情）比较。由启用改为禁用时说明：新消息被拒绝；已在运行的 Run 会继续，直到结束或在对话中点 Stop；排队的工作等待，重新启用后可能开始；禁用期间其他 Bot 交接给它的任务会失败。由禁用改为启用时提示可能唤醒排队工作。
- **Group 成员状态（`GroupPane.vue`）**：Group 成员配置不受侧栏过滤影响，成员数和目标菜单仍包含禁用成员。Bot 目录已确认时，面板列出禁用成员；Lead 被禁用时，用与 Composer 默认目标相同的 `eligibleTargetFor` 规则说明新消息默认发给谁（启用成员中按 ID 排序的第一个）；全部成员禁用时提示无法发送新工作。目录未确认时不显示，避免把「未加载」误报为「全部禁用」。

### 话题与消息流（`DirectBotPane.vue`）

- **顶部栏**：展示 Bot 头像、名称、角色、工作区/Agent 徽标与操作入口；
- **话题栏**：当前话题显示在一个按钮里。桌面端打开下拉列表，窄屏打开底部列表面板。列表可以搜索，并提供重命名、收起、恢复。额外话题可以删除。默认话题只提供清空，并要求确认。删除和清空会先预览外部绑定与 worktree。有绑定且未确认时不能提交。有未结束的 worktree 时不能提交。切换话题时按 `conversationId + topicId` 隔离历史与实时 Run。已删除话题的迟到列表或 `conversation-topic-changed` 不会把它加回缓存。清空默认话题提升 generation 后，当前历史缓存会被丢掉并重新加载；
- **消息列表（`ConversationMessageList.vue`）**：
  - 历史消息严格按 `seq` 排序并按 message `id` 去重；
  - 支持向上拉取更早消息，保持当前滚动位置不跳动；
  - 实时 Run 复用 `TurnParts.vue` 呈现思考过程（reasoning）、工具调用（tool cards）、计划（plan）与流式文本输出；
  - 轮次完成后将流式累积的 trace parts 关联保存在消息卡片上；
  - 支持明确区分与展示 `queued`、`running`、`waiting-human`、`completed`、`failed`、`cancelled`、`indeterminate` 状态。
  - 失败横幅不再打印裸 token 形式的内核原因码（`execution-failed`、`prompt_failed` 等），成句的提供方错误仍在横幅里原样显示，避免用户无处可查。
  - `queued` / `running` / `waiting-human` 由共享的 `RunStatusChip` 表达（`data-test="run-status"`，`data-status-state`）：
    `running` 呼吸点、`queued` 静止弱化点、`waiting-human` 静止 `bg-warn` 点；状态文字改用 `bot.run.*` 文案。
    正文区在无 parts 时只保留 `run-empty-slot` 高度占位，不再追加第二个 `Loader2`——运行指示只由胶囊承担。
- **输入框（`ConversationPromptInput.vue`）**：
  - 支持输入 prompt 发送，Bot 处于禁用状态时给出明确警告提示；
  - 客户端生成稳定的 `requestId`，发送失败或超时重试时复用原 `requestId` 保持幂等；
  - active Run 运行时提供 Stop 按钮，调用 `control.runs.cancel({ runId })` 精确取消当前 Run。

### 话题切换（`TopicSwitcher.vue`，群聊与 Bot 页共用）

- `GroupPane` 只有一条顶栏：群组名下方是可点的当前话题副标题（纯文字 + `ChevronDown`，无 pill 底色，hover/press `bg-surface-2`），原第二行 `TopicManager` 与 meta 行里重复的话题名都已删除。顶栏不显示「路由 → 负责人」——编辑群组弹窗里的「负责人」已经是同一事实的唯一说明；顶栏下方也不再有「运行 N/M · 排队 · 受阻」统计条——成员状态由消息流里的执行气泡和派发行承担。桌面顶栏因此改为不透明 `bg-surface`：`backdrop-filter` 祖先会成为 `fixed`/`absolute` 后代的包含块，会把切换器 popover、确认框和行菜单一起困在几十 px 高的顶栏里。
- 点副标题：`<lg` 打开 `MobileSheet`「切换话题」（`mobileBar.switchTopic`），≥lg 打开锚在触发器下方的 popover（`shadow-float rounded-lg bg-surface`）。两者内容一致：搜索框、话题列表、底部「+ 新建话题」（`bot.topic.new`）。行点选即切换并关闭；当前行 `bg-accent/10`；已收起 / 删除中的话题保留弱化图标。
- 行内操作收在每行尾部 `⋯`（`ContextMenu`）：重命名（行内表单）、收起 / 恢复、删除 / 清空（默认话题只给清空）。删除与清空先 `topics.preview` 预览外部绑定与 worktree：有绑定未确认、或有未结束 worktree 时禁止提交；确认框沿用居中 / 底部 sheet 既有样式。打开按钮必须带 `@click.stop`：打开瞬间的那次点击会在监听器挂上后继续冒泡到 document，把自己关掉（`FilesPanel` 的根菜单同理）。
- 动作状态机在 `lib/use-topic-actions.ts`；`handlers` 在调用时读取，prop 更新能被拿到。触发器在当前话题已收起 / 删除中时于标题后显示状态文字。
- **Bot 页（`DirectBotPane`）复用同一个 `TopicSwitcher`**（`variant="direct"`，只改测试钩子：`topic-menu` / `new-topic-button` / `bot-topic-sheet`）：桌面放在顶栏 meta 行最前（「Default ⌄ · 角色 · 工作区 · agent · 模型」），popover 左对齐在触发器下方；移动端是顶栏副标题（无活跃话题时 `fallbackLabel` 显示角色 / agent），打开与群聊一致的 sheet。旧的 `TopicManager` 第二行（行内「重命名 / 收起 / 删除」、右侧独立「新建话题」）与 Bot 自制话题 sheet 已删除；「新建话题」只在面板底部，点击后焦点先回到触发器，再打开新建对话框（关闭对话框时焦点回到触发器）。Bot 桌面顶栏同样改为不透明 `bg-surface`（原因同上）。搜索框遵循统一下拉规则：话题 >7 条才出现。

### 断线与重连恢复

- WebSocket 重连后自动调用 `reconcileOnReconnect()`，重新拉取实例 Bots、Topics、当前话题历史与在途 Run 的最新状态；
- WebSocket `state-snapshot` 中包含的 Conversation-correlated live turn 正确恢复；若在离线期间已完成，则自动刷新权威历史，消除残留 spinner；
- 国际化：所有新增文本均提供 `en.ts` 与 `zh-CN.ts` 完整对齐。

### Group 创建、编辑与删除（`GroupDialog.vue`）

- **入口**：实例侧栏 Groups 模式底部常驻「新建群组」（空列表、加载失败时同样可见）；群组行悬停出现编辑按钮；桌面端 `GroupPane` 顶栏右侧的编辑按钮与 `<lg` 顶栏 `⋯` sheet 的「编辑群组」条目都打开 `GroupDialog`。新建成功后自动选中该群组，没有话题时 `GroupPane` 以「创建第一个话题」引导打开 `GroupTopicDialog`。该对话框打开时自行拉取实例工作区（`loadWorkspaces`），不依赖之前是否打开过 Bot 或会话表单；拉取失败时显示重试。
- **表单**：名称（≤80）、说明、至少两个不同成员、可选 Lead。成员行展示角色、Agent 与启用状态，同名 Bot 附带稳定 ID。新建时 Lead 默认取第一个已启用成员，直到用户手动选择；移除当前 Lead 时改选下一个已启用成员（没有则清空）并提示。实例不足两个 Bot 时给出「新建 Bot」引导，Bot 表单关闭后回到群组表单。
- **编辑**：只发送与打开时快照不同的字段，避免回滚其他客户端的并发修改；`groups.update` 成功后才合并列表，并从当前发送目标中剔除已移除成员。
- **成员仍有任务**：`group_member_has_work` 时，按话题调用 `runs.list`（`limit: 200`，并合并 `activeRun`）和 `runs.get`，列出持有被移除成员 `queued` / `dispatched` / `running` MemberTurn 的 Run（含 `indeterminate` Run），提供逐个 Stop（`runs.cancel`）后重新查询。
- **删除**：内联确认列出话题数、先停止排队/执行中的任务、含未提交或未整合修改的成员工作树不会被丢弃（删除停在 `deleting` 等待处理后重试）、成员 Bot 与私聊保留。`groups.delete` 失败或超时后先重新读取列表：群组已消失按成功处理；仍在列表中则报告未完成，`lifecycle: "deleting"` 的群组在侧栏和顶栏显示「删除中」，对话框提供「重试删除」。
- **超时语义**：`timeout` / `instance-offline` / `instance-reconnected` 的创建与保存结果未知（`groups.create` 没有 requestId），界面提示先查看已刷新的列表，不显示为成功或失败。
- **跨页面同步**：`conversations-changed` 会刷新任何已加载过的实例群组列表，即使当前没有选中群组。

自动协作每轮按已有结果选择下一步行动和合适成员，支持分析、执行、验证、修正和结束；无需用户描述人员安排。简单问答可以直接完成，产出类任务需要验证最新结果。已有结果后的路由不确定或无进展会显示 waiting-human；预算耗尽仍是失败。公开指派卡的任务展示当前行动，后续行动沿用同一 Run，不要求所有成员都发言。详见[通用协作策略](conversation-runtime.md#bundled-adaptive-collaboration)。

### Group Agent 思考气泡（PR #447）

多 Agent 群组话题不再渲染底部的 Collaboration Run 卡片。每个真实 MemberTurn 在
`GroupTranscript.vue` 里是一条普通 Bot 行（`GroupAgentTurnRow.vue`）：配置的 32px 头像、
Bot 名称、名称下方的思考气泡（`AgentThinkingBubble.vue`）和下方的规范公开回复。同一个 Bot 被
多次分配时，每次分配各有自己的气泡和过程。零成员的自动 Run 仍由中性的路由行承载，
不虚构 Agent 身份。路由行的气泡状态取 Run 自身状态（排队中 / 选择成员中 / 等待 / 已完成 /
失败 / 已取消 / 结果待确认），终态不再继续显示「选择成员中」；行内不再另起一段标题，
气泡本身已经写着状态。

新功能不改既有调度：气泡只读地投影已有的 durable MemberTurn 与 Run，不写 activeRun、
不给 composer 换目标，也不触发服务端调度。

气泡状态取 MemberTurn 的 durable 状态。`running` 与 `streaming` 才播放脉冲动画，
`prefers-reduced-motion` 下关闭动画；点击区域不小于 44×44 CSS px，带本地化名称、
`aria-haspopup="dialog"` 和指向浮层的 `aria-controls`。

规范回复行同时保留消息 ID 和唯一滚动锚点。交接入口的“跳到回复”将焦点移到整条回复，
后续 Tab 先到思考气泡，再到复制按钮。临时成员行与路由行使用各自的合成锚点，
不复用请求消息的 ID。浮层的关闭按钮和 Escape 将焦点还给原触发按钮，外部点击保留新焦点。

临时成员行与路由行落在**自己 Run 的区块末尾**：锚点是该 Run 已加载的最后一条消息（人消息、
项管自己的回复、handoff、成员回复都算），不是人消息本身。所以还在执行的成员行不会浮到项管
派发之后的发言上方，成员回复落盘（拿到更大的 `seq`）后也不会看起来「从上方掉到下方」——
执行中的行始终贴着本轮末尾，已完成回复按 `seq` 追加在它上面。Run 的最后一条消息不在当前
窗口时退回列表末尾，并照旧标注 `missing-request` / `request-mismatch` 原因。

详情按 `useIsMobile()` 的 1024px 断点分流：移动端 `GroupRunDetailSheet.vue` 经 Teleport
打开模态底部面板（24px 顶部圆角、最高 86dvh、底部安全区留白），背板点击、关闭按钮或
Escape 关闭并回焦气泡；面板打开时先关闭它再操作背景。桌面继续用
`GroupRunDetailPopover.vue` 锚定气泡，保留外部点击与锚点滚出关闭，圆角统一为 16px。
两端共用 `GroupRunDetailHeader.vue`：状态、话题标题、成员/时间/时长、尝试选择与停止按钮；
派发指令（任务、期望输出）折叠在滚动正文的「派发指令」里，默认只显示折叠标签，
展开后完整可读，避免长任务挤掉关闭操作。切换断点保留当前成员和已选尝试。
移动详情打开时显式聚焦关闭按钮，不将初始焦点落到 Stop；运行中的面板直接显示停止全部参与
成员的范围说明，触屏无需悬停。其他 MobileSheet 未声明初始焦点时仍采用原默认规则。

`GroupRunDetailContent.vue` 的过程区统一使用 `GroupTraceTimeline.vue`，复用唯一
`deriveTurnPresentation` 保持 Markdown、思考、工具与子代理顺序。相邻工具以状态圆圈与虚线
连接，叙述打断连线；超过 6 个步骤默认保留最近 3 个，可展开已加载的前序内容。
这与服务端分页独立：记录完整性、错误、加载更多与加载更早事件仍保留。
工具展开体由 `ToolStepDetail.vue` 与消息流的 `ToolStepCard.vue` 共享。
子代理时间线圆圈与展开卡片共用 `resolveSubagentStatus`：任一子步骤失败则失败，仍有子步骤
运行则继续显示运行中，避免父级 success 遮盖子步骤的实际状态。
历史尝试不显示当前尝试的状态、开始时间与实时计时；未记录的历史结果不作推断。
双端按成员/尝试记忆正文滚动位置。`use-detail-scroll-memory.ts` 在打开或切换尝试时保留目标
偏移，短加载正文截断 scrollTop 时不覆盖原记录，异步数据就绪或布局增长后再补恢复。
成功恢复或用户主动 wheel/touch/pointer/滚动键操作后结束恢复阶段，后续流式增量不拉动读者。
详情滚动条使用独立的 6px `detail-scroll`，触屏隐藏；减少动态效果设置关闭面板入场和状态动画。

`MobileSheet.vue` 支持自定义 `#header`、`height="tall"`、`padded` 与 `showClose`，默认调用
仍使用标题栏和列表留白。额外属性绑定到 dialog，`body` 暴露给详情保存滚动位置。


已打开的执行过程沿 Core 已提交游标增量补读。实时帧按 500ms 合并补读请求，
成员或 provider 结束时立即补读；进行中的 RPC 结束后仍会读取等待中的终态更新。
同一成员、同一 attempt 的浮层快速关闭再打开时，共享中的 RPC 完成后也会补读新浮层等待的终态。
缓存最多保留 1000 条事件，较早过程可显式重新加载。重新加载较早事件暂停自动跟随，
避免运行中的输出把读者再次推向尾部。关闭浮层或切换范围会取消待执行的补读。

底部跟随监听投影条目的完整 key。临时活动行被规范回复替换时，即使条目数量不变，
停留在底部的读者仍会跟随；已向上滚动的读者保持当前位置。加载较早历史期间仍由原锚点恢复逻辑负责定位。

### Group 派发聚合行与展开卡片（PR #469）

项管（leader）同一轮发出的派发不再各占一行，而是在 `GroupTranscript.vue` 里聚合成一行
`GroupDispatchRow.vue`：叠放的 Bot 头像、派发数量和该轮的聚合状态。聚合由纯函数
`lib/group-dispatch-presentation.ts` 的 `presentGroupDispatch()` 计算，只读地投影已有的
durable MemberTurn 与消息，不写 activeRun、不触发服务端调度。项管自己被停止时，聚合状态
仍按各成员已证明的结果计算，另输出 `leaderStopped` 供上层显示停止说明。

折叠行左侧的叠放头像是实心圆盘（`bg-surface-2`），每个圆盘加 `ring-2`，描边颜色取所在行
的背景色（`ring-surface`）：叠放处因此出现一圈与行背景同色的描边，头像之间不会连成一片。
相邻头像重叠 6px（`-ml-1.5`，第一个不偏移）。行 hover 时背景从 `bg-surface` 变为
`bg-surface-2`，所以圆盘与描边同步互换（`group-hover/dispatch:bg-surface` +
`group-hover/dispatch:ring-surface-2`）：描边始终等于行背景色，圆盘始终与行背景可区分，
亮色与暗色主题都成立。hover 组是具名的（`group/dispatch`）：派发行嵌在带无名 `group`
的消息行里，用无名 `group-hover` 会在鼠标停在该行别处时也互换，描边就不再等于行背景色。

最多显示 4 个头像（`GROUP_DISPATCH_AVATAR_LIMIT`），超出部分折叠成一个同尺寸圆形徽标
「+N」，N 是被折叠的成员数（`data-test="group-dispatch-overflow"`）。

一轮只有一个成员时同样走聚合行，不再有单独的单条派发条目：折叠行标题按成员数分两种
措辞，多个成员写「派发给 N 个 Bot」/`Sent to N bots`，单个成员直接点名
「派发给 {name}」/`Sent to {name}`（`group.dispatch.sentToOne`）。状态计数与 ■ 停止按钮
和多条时完全一致，展开卡片里也只有那一个成员行。

聚合状态的中文措辞按摘要区分：进行中把 queued 读作「排队中」；整轮全部完成才写
「✓ N 个已完成」；只有部分完成（还有取消、失败或结果未知）时写紧凑的「✓ N 已完成」，
避免和全完成标题混读。全部取消时只显示「⊘ 已取消」。

点击该行（或聚焦后按 Enter / Space）展开行下方的卡片。卡片为 `bg-surface`、16px 圆角、
`max-w-[560px]`：先是一段默认收起的「派发内容」（`group.dispatch.instructions`），正文取该轮
第一条 handoff 的 task，展开后完整可读；移动端底部弹层使用同一个折叠块，不再整段平铺。
标题整轮只出现一次。卡片标题与折叠箭头旋转由 `aria-expanded` 和 `aria-controls` 暴露。

随后每个被派发的 Bot 一行：头像、名字、状态（复用 `group.dispatch.states.*` 的既有措辞）、
以及一行回复预览。没有回复的成员不显示预览行。

行的身份是 MemberTurn，不是 Bot：同一个 Bot 在一轮里被派发两次时是两个成员行，两行
都以自己的 `memberTurnId` 作 `:key`（成员行、叠放头像、移动端底部弹层行都是），跳转
也按 `memberTurnId` 查找。按 `botId` 作 key 会让两行互相覆盖或产生重复 key。

回复预览与跳转都只认精确证据：成员回复必须与该成员 MemberTurn 的 `promptRequestId`
一致、同 Conversation / Topic / Run、同 Bot，且是 handoff 之后的唯一候选；存在歧义、
缺证据或回复不在已加载历史中时，该成员不显示预览，其行 disabled、不可点击。

点击有回复的成员行跳转到该回复，复用 `GroupTranscript.vue` 既有的 `jumpToMessage()`：
给目标消息设置 `tabindex="-1"` 并转移焦点，再定位视口。卡片只是桌面展开形态；
确认框和移动端底部弹层是后续步骤。

可停止的成员（`canStop`：`supportsCancelMember` 为真且成员仍 running / queued）在其行右侧
显示一个 24px 的 ■ 停止按钮（`data-test="group-dispatch-stop-member"`），hover 用 danger 色。
点击时 `@click.stop` 只发出 `stopMember` 事件（携带该成员的 durable `runId` 与
`memberTurnId`），不触发展开/收起，也不触发跳转。`GroupTranscript.vue` 接收该事件后调用
`groupsStore.cancelMember(instanceId, runId, memberTurnId)`，走
`control.runs.cancelMember` 只取消这一个成员 turn：leader 与同轮其他成员继续运行。
core 不支持单成员取消（`supportsCancelMember` 为假）或成员已结束时，该按钮不渲染。

`supportsCancelMember` 不再是写死的假值：`GroupTranscript.vue` 用
`supportsRunsCancelMember(instancesStore.byId(instanceId))` 读实例自身广告的能力
`runs.cancel-member.v1`。该能力由 connector 在 core 暴露 `cancelMemberTurn` 时才上报，
因此老 core 上逐行 ■ 不渲染，页面改为只提供整轮的「全部停止」。

派发行下方还有一个项管停止胶囊（`data-test="group-dispatch-stop-leader"`，`bg-surface`、
`text-fg-muted`、圆角胶囊、小字号）。它出现的条件是「项管可停」：项管自己这一轮还没结束
（项管自己的 MemberTurn 仍 queued / dispatched / running），或者项管自己还没被停止、且它
的唤醒回合（followup）还没到终态。项管派完活后自己那一轮会立刻结束，真正的活在唤醒回合上；
唤醒回合还没插入（派发尚未结算完）时也算没到终态，所以这个窗口里胶囊依然在。四个挂载点
（人消息、Bot 消息、handoff、bubble 锚定的回复）都渲染它。

- core 支持单成员取消时，胶囊文案是「停止{name}」/`Stop {name}`（`group.dispatch.stopLeader`，
  name 为项管名；中文不插空格），点击不弹确认框，直接按 `control.runs.cancelMember` 取消一个 durable
  MemberTurn：已派发的成员继续跑，项管也不会再被唤醒做汇总。取消目标是「停止对象」：
  唤醒回合还在 queued / running 时停唤醒回合的 MemberTurn，否则停项管自己的 MemberTurn。
- core 不支持单成员取消时，胶囊文案改为「全部停止」/`Stop all`，点击走与展开卡
  「全部停止」完全相同的确认框流程，确认后取消整轮 run。

老 core 上只有一条派发时，展开卡片里不再渲染「全部停止」：那一行的胶囊已经写着同样的
「全部停止」，卡片里再放一个就是同一个动作出现两次。此时胶囊是唯一入口；多条派发时
卡片里仍然保留「全部停止」——它和它停掉的成员列在一起，而胶囊在新 core 上只停项管。
手机端底部弹层不受这条约束：弹层打开时胶囊被弹层的模态遮罩挡住，点不到，所以弹层
自己保留「全部停止」。

整轮「全部停止」的确认框（`group.dispatch.stopAllConfirm.*`）以项管命名，而不是群名：
文案是「{项管名}和已派发的 N 个任务都会停止」/`{name} and the N dispatched tasks will stop`。

「已停止」说明来自 durable 证据：项管自己的 MemberTurn 或它的唤醒回合任一带
`cancellationReason: "human-cancelled"` 就显示。core 对已结束的项管写停止意图时状态仍是
`completed`，所以只读状态是不够的，必须读这个字段。

停止只在项管的状态位说一次：`AgentThinkingBubble` 收到 `stopped` 后读「⊘ 已停止」/
`⊘ Stopped`（`group.bubble.status.stopped`），语气与取消一致、脉冲关闭。项管被停止后，
它气泡上原本的「已取消」状态词由「已停止」取代，不再另起一行说明。项管完全没有自己的行时
（历史没加载出来等），停止就没有状态位可写，全页也就没有第二处说明。成员的
状态标签不受影响——成员 bot 被停止时的显示照旧。派发行的「⊘ 已取消」不变：它说的是
整轮的结果，项管状态位说的是项管被停这件事，两者是不同的主语。

聚合行里出现 `indeterminate`（结果未知）的成员时，折叠行和手机摘要都单独显示结果未知的数量：
结果未知既不是已完成也不是失败，混进任何一边都是编造结论。这个计数排在所有计数之后
（它是「还不知道」的空缺，不是这一轮的又一个结论），用中性灰 `text-fg-muted`，前面带一个
lucide 问号图标（`CircleHelp`），不用红色也不用警示色。桌面折叠行的文案是
「N 个结果未知」/`N unknown`（`group.dispatch.indeterminate`）；手机端折叠胶囊放不下长文案，
用短格式「N 未知」/`N unknown`（`group.dispatch.indeterminateShort`），
例如「4 个 Bot · 2 执行中 · 1 未知」。

## 阶段范围边界

Group store 的 MemberTurn 合并保留已收到的 durable assignment 与执行关联字段。同状态的薄 event/detail/reconnect snapshot 缺省 optional 字段时保留已有值，明确提供的值（包括空数组）可以更新；拒绝的旧状态仅补缺失 metadata。合法状态前进仍以新状态的 failure/blocked evidence 为准，`indeterminate` 收到成功或失败证明时不会继承旧状态的失败原因。`cancellationReason` 与 `followupSenderMemberTurnId` 同属这条规则：它们是成员回合的 durable 事实，缺省的薄 snapshot 不能抹掉服务端已经证明的停止意图或唤醒回合身份。

- **阶段三**交付登录 + 实例/会话树 + 对话流。
- **阶段四**补齐：右栏任务面板（定时/编排）、设置页（实例接入 token/保留摘要）、notice toast、
  连接恢复徽标、NUL-key 流式缓冲加固。
- **阶段五**审计修复：API 客户端始终带 JSON content-type（对齐服务端 CSRF 415 守卫）、重连重拉快照 +
  重连定时器清理、聊天错误横幅 + 回合失败浮现 + 失败消息样式 + 切换会话清错 + 乐观失败标记、
  取消在途回合（`control.prompt.cancel`）、左栏实例树会话创建/删除 UI。
- **阶段七**消息附件：`PromptInput` 附件入口 + `MessageAttachments` 渲染 + 客户端 512px 降采样持久 preview（见上节）。
- **PR5** Direct Bot 会话：Relay Web direct Bot vertical slice，包含 `stores/direct-bots.ts`、`BotDialog.vue`、`DirectBotPane.vue`、`ConversationMessageList.vue`、`ConversationPromptInput.vue`、实例树模式切换与完整回归套件。
- 历史保留策略为服务端配置（`--history-retention-days`），v1 在 Web 端只读、不可编辑（见 docs/relay-module.md）。

## Direct Bot composer completions (Issue #399)

ConversationPromptInput uses the shared pure composer-completion helpers and its own Direct capability source. The first /token opens adapter command completion only while the caret is inside that token; choosing replaces the token with /name plus a space, preserving following text and never sending. Skills appear only when the adapter explicitly advertises kind=skill; no global skill directory is scanned. @ queries show the authorized Direct registry candidates, with agent/workspace context for duplicate display names. Only selecting a candidate creates agentMentions; typed @names remain ordinary text.

Menus show at most eight rows, paginate bounded server results, support Up/Down, Enter/Tab, Escape, click/touch, and listbox accessibility. Shift+Enter stays a newline, and IME composition owns its keys. Loading, empty/no-match, unavailable, and error states have en/zh-CN strings and retry; disabled, recovery, in-flight, and active-Run/Stop gates remain intact.

The direct-composer store isolates drafts by instance/Conversation/Topic/Bot. A contiguous edit shifts later UTF-16 ranges and removes references touched by the edit. Send freezes original text/references/target and requestId; rejection or uncertainty preserves the draft and repeat payload. Only an accepted result clears the identical captured draft, including when the view has switched. Scope/profile/event changes fence late capability responses; snapshots and agent-commands events refresh the command projection, including ready-empty advertisements. GroupComposer and the ordinary Session composer keep their existing data sources.
