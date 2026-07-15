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

看板状态由两条路径维护，重连先拉快照再订阅事件：

- **快照**：REST 拉取——`GET /api/instances` 列实例，RPC `control.sessions.list` 列会话，
  会话历史经消息缓存 API 拉取（见服务端 `/api/instances/:id/sessions/:alias/messages`）；
- **事件增量**：`src/api/events.ts` 的 `connectEvents(onEvent, onStatus?)` 连接 `/ws`，
  `DashboardView` 把每条 `WebServerEvent` 扇出给四个 store：`instancesStore.applyEvent`
  （实例上下线/会话变更）、`chatStore.applyEvent`（control-event：turn 输出分片、turn 终态等）、
  `tasksStore.applyEvent`（`scheduled-changed`/`orchestration-changed` 信号触发重拉）、
  `noticesStore.applyEvent`（`instance.notice` toast）；并把 `connectEvents` 的 `onStatus`
  回调接到 `connectionStore.setOnline`，驱动连接徽标。
- **实例订阅（`control-event` 扇出收敛）**：`DashboardView` 通过 `sendSubscribe([instanceId])`
  告诉 hub 本 socket 当前查看的实例，hub 据此只把该实例的 `control-event` 发给它
  （`instance-status`/`notice` 仍账号全量）。触发点：连接/重连成功（`onStatus(true)` 每次都重发，
  所以断线重连会自动重新订阅）、切换实例（`watch(chat.instanceId)`）。切换实例后还会
  `loadActiveTurns()` 重新补种在别处订阅期间漏掉的在飞回合。**未发过 `subscribe` = 收全部**
  （向后兼容），空数组 `[]` = 收无。

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

## 会话重命名（侧边栏 `⋯` 菜单）

- 会话行的 `⋯` 溢出菜单首项 **「重命名」** 把会话名就地换成输入框（Enter / 失焦提交，Esc 取消）。
- 设置的是一个**纯展示名 `display_name`**（核心 `LogicalSession.display_name` → `SessionDto.displayName`）；
  它**不改会话身份**：`alias`、`/use` 句柄、transport 会话名都不变，仅 relay-web 展示。
- 走 RPC `control.sessions.rename {alias, displayName}`（连接器 → `ControlService.setSessionDisplayName`）；
  store `renameSession` 提交后乐观更新本地行。**空值清除**（回退显示 `alias`），不做唯一性约束。
- 侧边栏与 `ChatPane` 头部均渲染 `displayName || alias`。微信 `/sessions`、`/use` 不受影响。

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

Files 面板支持以下写操作（均需在 relay hub config 启用 `files.writeEnabled`，默认关闭）：

- **新建文件** — 在当前目录创建空文件，返回 `{path, mimeType}`
- **新建文件夹** — 在当前目录创建目录，返回 `{path}`
- **重命名** — 重命名文件或目录，返回 `{path}`
- **复制（副本）** — 复制文件或目录，自动去重（复制后的名称避免与现有文件冲突），返回 `{path}`
- **删除** — 永久删除文件或目录，删除前需二次确认，无回收站，返回 `{path}`
- **下载** — 下载文件（≤5 MiB，超出拒绝），返回 base64 编码的文件内容 + MIME 类型；**下载不受 `files.writeEnabled` 门控影响**，用户总能下载

### 门控与安全模型

- **`files.writeEnabled` 开关**：relay hub `config.files.writeEnabled`（boolean，默认 `false`）控制 5 个写操作的访问权；关闭时写操作（create/rename/delete/copy）返回 403，只读操作（list/download）仍可用。通过 relay hub 启动参数 `--files-write-enabled` 或配置文件 `relay.config.json` 中 `files.writeEnabled: true` 启用。
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
