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
- `TurnParts.vue` 保留原始有序 parts，并通过 `turn-presentation` 把推理/工具锚定到事件到达时正在生成的
  Markdown 顶层块末尾：同一段落、列表、表格或代码围栏内的 text part 会保持连续，显式块边界之间的活动仍与
  文字穿插展示。子工具继续按 `parentToolCallId` 归入对应 Agent；旧历史里没有父子字段的工具仍按普通卡片渲染。
- `SubagentStepCard.vue` 以 `children.length > 0` 判定是否具备真实 trace（provider 无关，仅看数据是否到达）。
  有 trace：默认折叠、运行中轮播当前活动步骤，展开后显示紧凑时间线与 `traceCount`。无 trace：折叠行显示 `detail.output`
  尾行（回退到 prompt）、运行时长与“{ago} 前更新”心跳；展开显示委派 prompt 折叠行 + 输出块（运行中为定高、贴底滚动的
  mono `<pre>`，结束后切换为经 `StreamMarkdown`（`renderMarkdown` = markdown-it `html:false` + DOMPurify）渲染的结果报告）。
  时长/心跳为客户端近似值（刷新会重置，历史行永不处于运行态）。“查看完整过程”打开 `SubagentTraceDialog.vue`：保留委派任务区，
  新增结果报告区（结束后 markdown、运行中 mono 尾行），仅在既无子步骤也无委派/输出时才显示空态占位。轮播尊重
  `prefers-reduced-motion`，弹窗支持焦点圈定、Esc 和点击遮罩关闭。

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
- session/实例切换以独立 context revision 丢弃 model 与 effort 的迟到响应，避免旧会话结果污染
  当前 composer。没有广告 effort 的 agent 不显示控件，也不会触发设置请求。

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
  仅「醒着且 `warm === false`」的会话行显示 `Unplug` 小图标（`data-test="cold-indicator"`，
  title = `instance.sessionColdTitle`：进程已退出，下条消息将冷启动）；`warm` 缺失（老实例）或已睡眠
  的行不显示。Hub 对 RPC 响应透传，老实例无需升级即可兼容。

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
- **分组模式的睡眠会话按组分页加载**：每组底部有「显示已睡眠会话」开关，首次展开时经
  `control.sessions.list {archivedOnly, workspace|agent, offset, limit:5}` 拉第一页，组内「加载更多」
  每次追加一页直到 `hasMore=false`，可再次点击隐藏（缓存保留）。睡眠行排在该组活跃会话下方置灰。
  组状态存 `InstanceView.groupArchived`（键 `${mode}:${groupKey}`，不并入 `inst.sessions`、不喂
  `reconcileTailCache`），`sessions-changed`/archive/unarchive 只刷新已加载的组。最后一个活跃会话
  被睡眠后，已加载过睡眠页的组仍保留显示。**平铺模式保持实例级一次性快照开关**（footer 按钮），
  实例级「加载更多」在所有模式下保留（活跃列表超一页时的唯一入口）。
- **会话列表自动加载**：进入页面、浏览器重连、实例从离线变在线时，自动为所有在线实例加载会话
  列表（`loadSessionsForOnlineInstances`）；手动「加载会话」按钮保留为失败兜底。
- **视觉**：实例=浅色卡片、组=更浅一层的底色块 + 极小缩进（tinted-zone，三种模式视觉同构）。组头 =
  折叠箭头 + 类型图标（workspace→文件夹 / agent→品牌图标）+ 名称 + 计数；agent 分组下行内品牌图标去除。
- **前缀去重**（仅展示层）：workspace 组内剥掉 `<组名>-` 前缀、agent 组内剥掉 `-<组名>` 后缀
  （对应 `<workspace>-<agent>` 自动 alias），hover title 恒为全名；剥空则不剥。
- **组头悬停 ＋**（触屏常显）打开 `NewSessionDialog` 并预填本组 workspace/agent
  （`presetWorkspace`/`presetAgent` props，仍可改）；实例 footer 的 ＋ 不变。移动端零特化。

## 切换会话的渲染性能

长历史会话的切换开销主要在**组件创建**（每个文本 part 同步跑 markdown-it + DOMPurify），
`content-visibility: auto` 只省 layout/paint。两道针对性优化：

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
  `rows`（≤30 条持久化行，剥离 client-only 字段）+ `lastAccess` + `bytes` + `incarnation`
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
  （`seededFromCache`，保持 #199 的重选中途拉取语义）；播种（≤30 行）→ 权威整页替换
  不经过 0→N，`MessageList` 的渐进挂载对该替换同样重新触发
  （prev ≤ INITIAL_ROWS 且一次增长 ≥ REVEAL_BATCH 视为新 transcript）。
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

- `DashboardView.vue` 桌面（`lg:` ≥1024px）保持三栏静态布局；窄屏下：
  - 顶部出现移动条（`lg:hidden`）：汉堡 `☰`（开实例树抽屉）+ 居中会话名 + `Tasks`（开任务面板抽屉）。
  - 左栏（实例树）与右栏（任务面板）变成**屏外抽屉**（`fixed inset-y-0` + `transform translate-x`），`lg:` 类把它们覆盖回静态列，
    所以抽屉开合 `leftOpen`/`rightOpen` 仅在移动端可见、桌面无副作用——无需 JS 断点检测。
  - 半透明 backdrop 点击关闭；选中会话自动关左抽屉直达对话；抽屉头部有 `✕` 关闭按钮（`lg:hidden`）。
- 中栏聊天始终占据剩余宽度；登录页/设置页（`max-w-2xl mx-auto`）本身是流式宽度，移动端无需额外处理。
- **Composer 层叠状态面板**：`ChatPane.vue` 在文档流 `composer-stack` 中按「状态条 → 计划面板 → 输入框」
  垂直排列（输入框在最上层）。视觉重叠用负 `margin-top` + 下层预留的 `padding-bottom`（`--stack-overlap`，
  桌面 16px / 窄屏 12px）实现，内容不被裁切；递进缩进让下层卡片边缘露出。消息列表与底部 stack 分栏，
  气泡不被遮挡。`PlanPanel variant="stack"` 限制最大高度并独立滚动；`TransitionGroup` 负责出现/消失动画。
  `PromptInput` 自身结构与样式尽量保持不变，只由外层 stack 包裹。

## 文件地图

- `src/api/client.ts` —— REST 客户端（登录、`/api/instances`、`/api/instances/:id/rpc` 代理调用、历史）；
- `src/lib/render-markdown.ts` —— 净化版流式 markdown 渲染（markdown-it + remend + DOMPurify）；
- `src/api/events.ts` —— WS 客户端（`connectEvents` → `/ws`，自动重连）；
- `src/stores/auth.ts` —— 登录态；`src/stores/instances.ts` —— 实例/会话树 + `applyEvent`；
  `src/stores/chat.ts` —— 聊天流、NUL-key 流式缓冲、`error`、`loadHistory`/`send` + `applyEvent`；
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

- **`files.writeEnabled` 开关**：xacpx daemon 的 `config.files.writeEnabled`（boolean，默认 `false`）控制文件写入及下述结构化 Git mutation；关闭时相关 Control RPC 返回 `files-write-disabled`，只读操作（list/download/Git status）仍可用。在 xacpx 配置文件中设置 `files.writeEnabled: true` 后重启 daemon 生效。
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

- **Tab 上的 `X` = 全局终止**该共享 shell（有 ack：`terminated` 或 `cleanup-pending`）。`viewerCount > 1` 时必须确认。
- **关闭浏览器窗口 / 刷新 / 断网**只 detach 本地 attachment，**不** kill RMUX session；其他设备上的 viewer 继续。
- **多设备**共享同一个 `terminalId`/`generation`：首个打开方为 controller，其余为 spectator；spectator 可 **take control**。
- Tab 布局 / 本地 UI 状态不跨设备共享；只共享底层 shell。
- 用户文案使用「睡眠/唤醒」；API / 代码里仍可见 archive 拼写（兼容）。

实现入口：`packages/relay-web/src/stores/terminal.ts`、`TerminalTab.vue`、recovery reducer
（`src/lib/terminal-recovery.ts`）。权威状态机见 RMUX terminal design spec。

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
- 兼容旧历史格式的聚合面板，默认折叠；展开后列出每个 step（状态图标、kind 图标、title、耗时）。
- 点击行展开 `<ToolDetail>` 详情；折叠头显示总步数。

**`ToolStepCard.vue`**（`packages/relay-web/src/components/ToolStepCard.vue`）

- 有序 `parts` 中单个 tool call 的卡片，标题行始终可见，详情默认折叠。
- 点击标题展开 `<ToolDetail>`；历史消息和实时 streaming 消息使用相同的默认折叠规则。

**`ReasoningPanel.vue`**（`packages/relay-web/src/components/ReasoningPanel.vue`）

- props: `reasoning: string; defaultOpen?: boolean`。
- 可折叠，`defaultOpen` 默认 `false`；历史与实时 reasoning 都默认折叠，用户可按需展开。

**`ToolDetail.vue`**（`packages/relay-web/src/components/ToolDetail.vue`）

按 `ToolDetailDto` 变体渲染，无原始 JSON：
- `diff` — 红/绿行 `-/+` diff 视图，显示路径、删除行（红色 `-`）、新增行（绿色 `+`）。
- `command` — `$ <command>` + 深色背景 preformatted 输出 + exit code。
- `read` — 文件路径 + 可选行范围 + preformatted 预览。
- `search` — 查询串 + preformatted 输出。
- `text` — `whitespace-pre-wrap` 纯文本。
- `fields` — `<dl>` 键值表格 + 可选输出块（用于 other/think 类型）。

**`ChatPane` 状态 HUD**（`packages/relay-web/src/components/ChatPane.vue`）

`chat.busy` 时在输入框上方显示一行 HUD：
- 脉冲点 `●`（`animate-pulse`）+ `Working… M:SS`（每秒刷新的 elapsed 计时，由 `setInterval(1000)` + `liveTurn.startedAt` 驱动）。
- 若有 running 状态的步骤：`· 🔧 N`（N 为 running tool 数量）。
- 右侧 `Cancel` 按钮 → `chat.cancel()`（调 `control.prompt.cancel` RPC）。

**`PromptInput` busy-guard**（`packages/relay-web/src/components/PromptInput.vue`）

- props: `busy?: boolean`。
- `busy=true` 时 textarea 禁用（`disabled` 属性 + `bg-slate-100` 样式）、placeholder 改为 `"Agent is working…"`，Enter 键提交也被 guard 拦截。

**`MessageList.vue` 渲染**（`packages/relay-web/src/components/MessageList.vue`）

- 历史 `out` 消息正文始终展开，复制、时间及失败/停止状态保持可见；消息本身没有折叠开关。
- `structured.parts` 由 `TurnParts` 按 Markdown 顶层块派生展示顺序：工具或推理不会切断正在生成的段落、
  列表、表格或代码围栏，而是在该块结束后显示；若事件本来位于两个块之间，则保持文字—活动—文字的穿插结构。
  实时 streaming 与历史回放使用同一派生规则。
- 旧历史没有 `parts` 时回退到聚合 `ToolCallPanel` + markdown/reasoning，其中工具面板与 reasoning 同样默认折叠。

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
  - 图片（`kind: "image"`）显示缩略图（来自持久化的 `previewUrl`，点击可放大）。
  - 非图片文件（`kind: "file"`）显示文件卡片（文件名 + 大小）。
- **`MessageList.vue`**：每条消息若含 `attachments`，在气泡下方插入 `<MessageAttachments>`。
- **历史重显**：页面刷新后，附件从服务端持久化的 `MessageRecordDto.attachments` 中恢复，
  图片缩略图和文件卡片均可再次显示。

### 相关文件

- `packages/relay-web/src/components/PromptInput.vue` — 上传触发 + chip UI
- `packages/relay-web/src/components/MessageAttachments.vue` — 附件渲染
- `packages/relay-web/src/components/MessageList.vue` — 附件在消息气泡下插入
- `packages/relay-web/src/stores/chat.ts` — 发送时调用 upload + 附件随 media 字段传出

## 阶段范围边界

- **阶段三**交付登录 + 实例/会话树 + 对话流。
- **阶段四**补齐：右栏任务面板（定时/编排）、设置页（实例接入 token/保留摘要）、notice toast、
  连接恢复徽标、NUL-key 流式缓冲加固。
- **阶段五**审计修复：API 客户端始终带 JSON content-type（对齐服务端 CSRF 415 守卫）、重连重拉快照 +
  重连定时器清理、聊天错误横幅 + 回合失败浮现 + 失败消息样式 + 切换会话清错 + 乐观失败标记、
  取消在途回合（`control.prompt.cancel`）、左栏实例树会话创建/删除 UI。
- **阶段七**消息附件：`PromptInput` 附件入口 + `MessageAttachments` 渲染 + 客户端 512px 降采样持久 preview（见上节）。
- 历史保留策略为服务端配置（`--history-retention-days`），v1 在 Web 端只读、不可编辑（见 docs/relay-module.md）。
