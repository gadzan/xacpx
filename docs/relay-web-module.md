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

## 「快照 + 事件增量」模型

看板状态由两条路径维护，重连先拉快照再订阅事件：

- **快照**：REST 拉取——`GET /api/instances` 列实例，RPC `control.sessions.list` 列会话，
  会话历史经消息缓存 API 拉取（见服务端 `/api/instances/:id/sessions/:alias/messages`）；
- **事件增量**：`src/api/events.ts` 的 `connectEvents(onEvent, onStatus?)` 连接 `/ws`，
  `DashboardView` 把每条 `WebServerEvent` 扇出给四个 store：`instancesStore.applyEvent`
  （实例上下线/会话变更）、`chatStore.applyEvent`（control-event：turn 输出分片、turn 终态等）、
  `tasksStore.applyEvent`（`scheduled-changed`/`orchestration-changed` 信号触发重拉）、
  `noticesStore.applyEvent`（`instance.notice` toast）；并把 `connectEvents` 的 `onStatus`
  回调接到 `connectionStore.setOnline`，驱动连接徽标。

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

## 阶段五加固（审计修复）

- **API 客户端始终带 JSON content-type**：无 body 的 mutating 请求也发 `content-type: application/json`，
  与服务端新增的 CSRF 415 守卫对齐（不会被 415 误杀），保留 CSRF 预检属性（见 docs/relay-module.md）。
- **重连重拉快照 + 重连定时器清理**：重连后重新拉一遍快照（实例 + 当前会话的历史/任务）避免 ghost state；
  `connectEvents` 在 teardown 时清掉待定的重连定时器，避免泄漏 socket。
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
- **catalog 驱动的 agent 选择器**：agent 下拉来自 `control.agents.catalog` 的**全部 driver**——未安装的
  driver（`installed: unknown`）仍会列出但**置灰/禁用**，已配置 / `builtin` / PATH 探到的可选。
- **workspace 选或输路径**：workspace 控件可从已配置项里选，也可直接**输入一个路径**——输入路径时按其
  basename 自动新建一个 workspace（提交时先 `control.workspaces.create` 持久化，再
  `control.sessions.create` 在其中建会话）。
- **错误浮现**：实例侧 RPC 错误是 200 + `{error:{code,message}}`（网关 resolve 不 reject），store 的
  `unwrap()` 用 `isErrorPayload` 检出并抛出，对话框渲染错误横幅而非静默吞掉（修了旧表单「点 Create 无反应」）。

## 实例配置管理 Modal（`ManageInstanceDialog.vue`）

- 每个实例行的 **「Manage」** 按钮（实例树）打开一个按实例的管理弹窗，内含 workspace + agent 两个管理器
  （`WorkspacesManager.vue` + `AgentsManager.vue`）。
- **Agents 管理器**：消费 `control.agents.catalog`（带 `configured`/`installed`），可新建
  （`control.agents.create {name,driver}`）/删除（`control.agents.remove {name}`，正被会话占用时实例侧返回
  in-use 错误并浮现）。
- **Workspaces 管理器**：列已配置 workspace，可删除（`control.workspaces.remove {name}`，占用时同样 in-use 拒绝）。

## 流式 Markdown 渲染

- `src/lib/render-markdown.ts` —— `renderMarkdown(text, { streaming })` 把 markdown 渲染成**已净化**的 HTML：
  `markdown-it`（`html:false` 转义任何原始 HTML）+ `DOMPurify`（输出二次净化，纵深防御）。
  链接统一加 `target=_blank rel="noopener noreferrer nofollow"`。
- `streaming: true` 时先经 `remend`（Vercel 抽出的零依赖 healing 引擎）自动补全未闭合的
  `**粗体`/行内代码/围栏代码块/链接，避免流式中途半截语法吞掉后文或显示成裸符号；定型文本不 heal。
- `src/components/StreamMarkdown.vue` —— `{ text, streaming? }` props，`computed` + `v-html` 渲染净化后的 HTML，
  自带非 scoped 的 `.stream-md` 样式（Tailwind preflight 会清掉元素样式，需手动补回标题/列表/代码块等）。
- `MessageList.vue`：**`out` 方向（agent 输出）与流气泡走 `StreamMarkdown`**；`in`（用户输入）保持纯文本 `<pre>` 不渲染 markdown。

## 响应式 / 移动端布局

- `DashboardView.vue` 桌面（`lg:` ≥1024px）保持三栏静态布局；窄屏下：
  - 顶部出现移动条（`lg:hidden`）：汉堡 `☰`（开实例树抽屉）+ 居中会话名 + `Tasks`（开任务面板抽屉）。
  - 左栏（实例树）与右栏（任务面板）变成**屏外抽屉**（`fixed inset-y-0` + `transform translate-x`），`lg:` 类把它们覆盖回静态列，
    所以抽屉开合 `leftOpen`/`rightOpen` 仅在移动端可见、桌面无副作用——无需 JS 断点检测。
  - 半透明 backdrop 点击关闭；选中会话自动关左抽屉直达对话；抽屉头部有 `✕` 关闭按钮（`lg:hidden`）。
- 中栏聊天始终占据剩余宽度；登录页/设置页（`max-w-2xl mx-auto`）本身是流式宽度，移动端无需额外处理。

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
  `TaskPanel.vue`、`ScheduledTasks.vue`、`OrchestrationTasks.vue`、`NoticeToast.vue`、`ConnectionBadge.vue`；
- `src/router/index.ts`（含 `/settings` 路由）、`src/main.ts`、`src/App.vue`、`src/style.css`。

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
- 可折叠面板（默认展开），列出每个 step（状态图标 ⏳/✅/❌、kind 图标、title、耗时）。
- 点击行展开 `<ToolDetail>` 详情；折叠头显示总步数。

**`ReasoningPanel.vue`**（`packages/relay-web/src/components/ReasoningPanel.vue`）

- props: `reasoning: string; defaultOpen?: boolean`。
- 可折叠（`defaultOpen` 默认 `true`）：实时展示时 `defaultOpen` 不传（为 true，展开）；历史消息中 `MessageList` 传 `:default-open="false"` → 折叠。

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

- 历史 `out` 消息：若 `m.structured?.toolSteps?.length` 则在 markdown 下方插入 `<ToolCallPanel>`；若 `m.structured?.reasoning` 则插入 `<ReasoningPanel :default-open="false">`（折叠）。
- 实时流气泡：若 `liveTurn?.toolSteps.length` 则插入 `<ToolCallPanel>`（实时展开）；若 `liveTurn?.reasoning` 则插入 `<ReasoningPanel>`（`defaultOpen` 不传，默认展开）。

## 阶段范围边界

- **阶段三**交付登录 + 实例/会话树 + 对话流。
- **阶段四**补齐：右栏任务面板（定时/编排）、设置页（实例接入 token/保留摘要）、notice toast、
  连接恢复徽标、NUL-key 流式缓冲加固。
- **阶段五**审计修复：API 客户端始终带 JSON content-type（对齐服务端 CSRF 415 守卫）、重连重拉快照 +
  重连定时器清理、聊天错误横幅 + 回合失败浮现 + 失败消息样式 + 切换会话清错 + 乐观失败标记、
  取消在途回合（`control.prompt.cancel`）、左栏实例树会话创建/删除 UI。
- 历史保留策略为服务端配置（`--history-retention-days`），v1 在 Web 端只读、不可编辑（见 docs/relay-module.md）。
