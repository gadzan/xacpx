# xacpx Code Wiki

本 Wiki 面向代码阅读/维护：给出系统边界、启动链路、模块职责、关键类型与关键函数、依赖关系与运行方式。用户视角文档请优先参考 [README.md](./README_zh.md) 与 `docs/` 现有说明。

## 目录

- 1. 系统概览
- 2. 核心概念与数据模型
- 3. 高层架构与依赖方向
- 4. 启动方式与运行模式
- 5. 主要模块详解
- 6. 关键协议与边界（Bridge / Orchestration IPC / Channel）
- 7. 配置、状态与运行时文件
- 8. 构建、测试与本地调试

---

## 1. 系统概览

`xacpx` 的本质是一个“消息渠道 ↔ 命令路由 ↔ acpx 会话驱动”的桥接系统：

- Inbound：从微信/飞书/CLI 等渠道接入消息（chatKey 标识对话）。
- Router：解析 slash command（`/ss`、`/use`、`/cancel`…）与普通文本；命令会落到 handler；普通文本会变成 prompt。
- Sessions：维护“逻辑会话”（alias/agent/workspace/上下文/回复模式）到“transport session”（acpx 命名会话）的映射。
- Transport：把 `ensureSession/prompt/cancel/setMode` 统一抽象，具体通过：
  - `acpx-cli`（直接 spawn `acpx` + 可选 `node-pty`）
  - `acpx-bridge`（子进程 bridge + JSONL 协议，隔离与更强的并发/事件处理）
- Orchestration（可选）：在一个 coordinator 会话下，管理多个 worker session 的任务委派、进度汇报、人类确认、分组汇总等。
- Daemon：后台守护运行（start/status/stop），维护 pid/status/log 等元数据，并承载 orchestration IPC server。
- MCP（可选）：把 orchestration 能力以 MCP stdio server 的形式暴露给外部 host（Codex/Claude Code 等），外部 host 以工具调用方式发起 delegate/group 操作。

仓库关键入口：

- CLI 入口：[src/cli.ts](../../src/cli.ts)
- 应用装配入口：[buildApp()](../../src/main.ts#L111-L600)
- 前台运行入口：[main()](../../src/main.ts#L608-L637)
- 主循环编排：[runConsole()](../../src/run-console.ts#L45-L152)
- 命令路由中心：[CommandRouter](../../src/commands/command-router.ts#L80-L590)
- 会话模型：[SessionService](../../src/sessions/session-service.ts#L27-L347)
- transport 边界：[SessionTransport](../../src/transport/types.ts#L46-L64)

---

## 2. 核心概念与数据模型

### 2.1 chatKey（对话身份）

- `chatKey` 是“消息对话”的稳定标识，贯穿 channels / sessions / orchestration / quota。
- `MessageChannelRegistry` 通过 `chatKey -> channelId` 路由 outbound：[getByChatKey()](../../src/channels/channel-registry.ts#L49-L52)

### 2.2 两类 Session：Logical vs Transport

- Logical session（xacpx 内部）：`alias/agent/workspace` + 持久化状态（replyMode/modeId/上下文等），由 `SessionService` 管理并存入 `state.json`。
  - 典型 API：
    - `createSession()/attachSession()`：[session-service.ts](../../src/sessions/session-service.ts#L39-L65)
    - `useSession()/getCurrentSession()/listSessions()`：[session-service.ts](../../src/sessions/session-service.ts#L89-L195)
- Transport session（acpx 层命名会话）：`transportSession` 字符串；`xacpx` 使用它作为底层会话名，真正的执行发生在 transport。
  - `ResolvedSession` 是“路由到 transport”的完整上下文（含 cwd/agentCommand/transportSession…）：[transport/types.ts](../../src/transport/types.ts#L21-L33)

### 2.3 ReplyMode / ModeId

- `replyMode`（xacpx 回复策略，stream/final/verbose）存于逻辑会话：[ResolvedSession.replyMode](../../src/transport/types.ts#L30-L31)
- `modeId`（底层 agent 模式，如 codex plan/…）存于逻辑会话：[ResolvedSession.modeId](../../src/transport/types.ts#L29-L30)

### 2.4 Orchestration：Coordinator / Worker / Task / Group

- coordinatorSession：主控会话（通常等于当前 transportSession，或来自外部 MCP identity）
- workerSession：被委派的执行会话（acpx 会话名）
- task：一次委派单元（状态：pending/needs_confirmation/running/completed/failed/cancelled…）
- group：任务组，聚合多个 task，支持 fan-out/fan-in

装配点位于 `buildApp()`：把 worker dispatch / cancel / wake 等能力注入 `OrchestrationService`：[main.ts](../../src/main.ts#L472-L543)

---

## 3. 高层架构与依赖方向

### 3.1 分层与依赖方向（“只能往下依赖”）

- Channels（built-in weixin + plugin-backed feishu/yuanbao examples）
  - 依赖：`ConsoleAgent`（用于把 inbound 交给 router）、`AppLogger`、`QuotaManager`
- ConsoleAgent（协议适配：消息 -> router）
  - 依赖：`CommandRouter`
- CommandRouter（解析命令、调用 handler、封装 transport 调用与诊断）
  - 依赖：`SessionService`、`SessionTransport`、`ConfigStore`、`AppConfig`、`OrchestrationService`（可选）、`QuotaManager`（可选）
- SessionService（逻辑会话 + state 持久化）
  - 依赖：`AppConfig`、`StateStore`
- Transport（acpx-cli / acpx-bridge）
  - 依赖：`acpx` CLI；（可选）`node-pty`；（bridge 模式）依赖 bridge 子进程
- Bridge（子进程）
  - 依赖：bridge JSONL 协议、`acpx` CLI；通过 stdout 发 event（progress/segment）
- Daemon（后台进程控制）
  - 依赖：runtime 文件（pid/status/log）与进程管理（spawn/terminate）
- Orchestration（可选）
  - 依赖：StateStore；通过 transport 驱动 worker session；通过 channels 回推进度/结果通知
- MCP（可选）
  - 依赖：`@modelcontextprotocol/sdk`；通过 orchestration IPC 调用 daemon 内服务

### 3.2 主链路数据流（从微信到 acpx）

1. Channel 收到消息（chatKey + text + 可选 media）
2. `ConsoleAgent.chat()` 调用 `router.handle(chatKey, input, reply, replyContextToken, accountId, media)`
3. `CommandRouter.handle()`：
   - `/` 开头：`parseCommand()` 分发到 handlers
   - 否则：当作 `prompt`，解析当前 session 并走 `transport.prompt()`
4. Transport 执行：
   - `acpx-cli`：spawn `acpx ... prompt` 并聚合输出
   - `acpx-bridge`：向 bridge 发送 JSONL request；bridge 负责调度/回写 event
5. reply 回到 channel（stream/verbose/final 按策略输出）

---

## 4. 启动方式与运行模式

### 4.1 前台运行（开发调试）

- 入口：`xacpx run` -> [defaultRun()](../../src/cli.ts#L487-L524)
- 核心步骤：
  - 解析 runtimePaths：`resolveRuntimePaths()`：[main.ts](../../src/main.ts#L653-L668)
  - 创建 `DaemonRuntime`（即使前台也写 status/heartbeat，便于统一观测）：[cli.ts](../../src/cli.ts#L497-L523)
  - 创建 channels registry 并进入 `runConsole()`：[run-console.ts](../../src/run-console.ts#L45-L152)

### 4.2 后台 daemon（常规使用）

- `xacpx start/status/stop/restart` 通过 `DaemonController` 管理后台进程。
- daemon 的就绪判定：spawn 后轮询 status.json，匹配 pid 即认为 ready：[daemon-controller.ts](../../src/daemon/daemon-controller.ts#L75-L151)

### 4.3 MCP stdio server（外部 host 集成）

- `xacpx mcp-stdio`：
  - 解析 identity（coordinatorSession/sourceHandle/workspace）并注册外部 coordinator：[prepareMcpCoordinatorStartup()](../../src/cli.ts#L49-L104)
  - 运行 MCP server：[runXacpxMcpServer()](../../src/mcp/xacpx-mcp-server.ts)
- 该模式通常需要 daemon 已运行（orchestration IPC endpoint 可用）。

---

## 5. 主要模块详解

### 5.1 CLI 与命令面（src/cli.ts）

- CLI 统一入口：[runCli()](../../src/cli.ts#L242-L372)
- 主要职责：
  - daemon 生命周期控制（start/status/stop/restart）
  - 前台 `run`
  - `login/logout`（对 channel 的封装）
  - `workspace`/`channel` 这些“本机配置管理”命令
  - `mcp-stdio`（MCP server 启动与 identity 规则）

### 5.2 App 装配（src/main.ts）

`buildApp()` 是依赖注入中心，把 config/state/logger/sessions/transport/orchestration/router/agent 组装成 `AppRuntime`：

- 配置与日志：
  - `ensureConfigExists()`：[main.ts](../../src/main.ts#L111-L116)
  - `loadConfig()` + `createAppLogger()`：[main.ts](../../src/main.ts#L114-L125)
- 状态与会话：
  - `StateStore.load()` + `new SessionService(...)`：[main.ts](../../src/main.ts#L127-L131)
- transport 选择：
  - `acpx-bridge`：`spawnAcpxBridgeClient()` + `new AcpxBridgeTransport(...)`：[main.ts](../../src/main.ts#L132-L146)
  - `acpx-cli`：`new AcpxCliTransport(...)`：[main.ts](../../src/main.ts#L145-L146)
- orchestration：
  - `new OrchestrationService({... injected callbacks ...})`：[main.ts](../../src/main.ts#L472-L543)
  - daemon 内承载 IPC server：`new OrchestrationServer(...)`：[main.ts](../../src/main.ts#L569-L573)
- router/agent：
  - `new CommandRouter(...)`：[main.ts](../../src/main.ts#L573-L574)
  - `new ConsoleAgent(...)`：[main.ts](../../src/main.ts#L574-L574)

### 5.3 主循环编排（src/run-console.ts）

`runConsole()` 负责“启动顺序、信号退出、清理一致性”：

- 建 runtime：`runtime = buildApp(paths)`：[run-console.ts](../../src/run-console.ts#L66-L69)
- daemon 模式下：
  - 写 daemon runtime metadata：`daemonRuntime.start(...)`：[run-console.ts](../../src/run-console.ts#L70-L82)
  - 启动 orchestration IPC server：`runtime.orchestration.server.start()`：[run-console.ts](../../src/run-console.ts#L75-L75)
  - 定时 heartbeat：[run-console.ts](../../src/run-console.ts#L76-L81)
- consumer lock（避免多进程重复消费同一渠道）：
  - acquire 失败会抛出 `ActiveWeixinConsumerLockError`：[run-console.ts](../../src/run-console.ts#L84-L129)
- 启动 channels：`channels.startAll(...)`：[run-console.ts](../../src/run-console.ts#L132-L137)
- finally 清理：stop IPC / dispose / stopAll / release lock：[run-console.ts](../../src/run-console.ts#L154-L209)

### 5.4 Channels（src/channels/*）

Core ships only the Weixin runtime plus generic channel/plugin infrastructure. Feishu, Yuanbao, and future non-Weixin channels are plugin-backed and should live in `packages/channel-*` or external npm packages, not as product-specific implementations under `src/channels/`.

统一抽象：`MessageChannelRuntime`（登录/启动/发消息/通知任务进度）：[channels/types.ts](../../src/channels/types.ts#L62-L78)

聚合器：`MessageChannelRegistry`

- `startAll()` 并行启动 channel，允许部分失败，但全部失败会 throw：[channel-registry.ts](../../src/channels/channel-registry.ts#L27-L41)
- 按 chatKey 路由 outbound：`notifyTaskProgress/notifyTaskCompletion/sendCoordinatorMessage`：[channel-registry.ts](../../src/channels/channel-registry.ts#L53-L65)

> Channel 能力位：`/ssn` native 会话列表的渲染格式由 channel 声明的 `MessageChannelRuntime.nativeSessionListFormat`（`"cards" | "table"`，缺省 `table`）决定；weixin 声明 `cards`。registry 暴露 `nativeSessionListFormat(chatKey)`，经 `CommandRouter` 注入到 `CommandRouterContext.resolveNativeSessionListFormat`，由 [native-session-handler.ts](../../src/commands/handlers/native-session-handler.ts) 读取。新增 channel 想用卡片式渲染时声明该能力位即可，无需改 handler。

#### 5.4.1 ConsoleAgent（src/console-agent.ts）

ConsoleAgent 是“渠道消息协议 → router 协议”的适配层：

- `chat()`：规范化 media、拒绝空消息、记录日志，然后调用 `router.handle(...)`：[console-agent.ts](../../src/console-agent.ts#L25-L53)
- 该层是 channels 的唯一“agent 入口”；channels 不直接依赖 CommandRouter 的实现细节，只依赖 `WechatAgent` 行为。

#### 5.4.2 Weixin Bot 与配额（src/weixin/*）

`src/weixin` 实际上是一套仓库内实现的 WeChat provider（登录、轮询收发、媒体处理、风控/配额等），由 WeixinChannel（在 `src/channels/weixin-channel.ts`）作为 channel runtime 承载。

- 交互式登录：`login()`（二维码输出，优先 `qrcode-terminal`，失败回退到打印 URL）：[bot.ts](../../src/weixin/bot.ts#L60-L111)
- 启动轮询：`start(agent, opts)`（解析账号、检查 token、调用 `monitorWeixinProvider`）：[bot.ts](../../src/weixin/bot.ts#L141-L185)
- Outbound 配额：`QuotaManager`（按 chatKey 的滑动窗口预算；区分 mid segment 与 final；支持 final 分页与 pendingFinal 队列）：[quota-manager.ts](../../src/weixin/messaging/quota-manager.ts#L15-L166)

### 5.5 命令系统（src/commands/*）

#### 5.5.1 解析

- `parseCommand()`：slash command 解析与兼容别名（`/ss`→`/session`、`/ws`→`/workspace`、`/stop`→`/cancel`）：[parse-command.ts](../../src/commands/parse-command.ts#L61-L422)

#### 5.5.2 路由与执行

`CommandRouter` 的职责不仅是 switch 分发，还包含“transport 调用观测 + 自动修复 + 诊断摘要”：

- 主入口：`handle(chatKey, input, reply, replyContextToken, accountId, media)`：[command-router.ts](../../src/commands/command-router.ts#L106-L258)
- session handler context 注入（lifecycle/interaction/recovery）：[command-router.ts](../../src/commands/command-router.ts#L264-L358)
- transport 封装：
  - `ensureTransportSession()`：支持缺失 optional dep 的自动安装与二次验证：[command-router.ts](../../src/commands/command-router.ts#L411-L448)
  - `promptTransportSession()`：统一透传 reply/quota/media，并确保 mcpCoordinatorSession 默认值：[command-router.ts](../../src/commands/command-router.ts#L513-L524)
  - `measureTransportCall()`：统一记录成功/失败日志，并对 `PromptCommandError` 提取 stdout/stderr 诊断摘要：[command-router.ts](../../src/commands/command-router.ts#L549-L590)

### 5.6 会话管理（src/sessions/session-service.ts）

`SessionService` 是“逻辑会话”与 `state.json` 的唯一写入方（通过 `AsyncMutex` 串行化写入）：

- 创建/挂载：
  - `createSession()`：默认 transport session 形如 `${workspace}:${alias}`：[session-service.ts](../../src/sessions/session-service.ts#L39-L41)
  - `attachSession()`：绑定到已存在的 transport session：[session-service.ts](../../src/sessions/session-service.ts#L56-L65)
- 当前会话与列表：
  - `useSession()`：把 chatKey 的 current_session 指向某 internal alias：[session-service.ts](../../src/sessions/session-service.ts#L89-L102)
  - `getCurrentSession()`/`listSessions()`：[session-service.ts](../../src/sessions/session-service.ts#L165-L195)
- 关键约束：
  - `validateSession()` 强制 agent/workspace 已在 config 注册：[session-service.ts](../../src/sessions/session-service.ts#L326-L346)
  - 防止 transport session 与 external coordinator 冲突：[session-service.ts](../../src/sessions/session-service.ts#L298-L300)

### 5.7 Transport（src/transport/*）

统一边界：`SessionTransport`：[transport/types.ts](../../src/transport/types.ts#L46-L64)

- `ensureSession()`：为指定 `ResolvedSession` 创建/确保底层会话存在，并可回传 `EnsureSessionProgress`（spawn/initializing/ready 或 note）
- `prompt()`：发送 prompt，支持 reply 回调（流式）与 `PromptOptions`（media、onSegment）
- `cancel()/setMode()/hasSession()`：控制类操作

两套实现：

- `acpx-cli`：[src/transport/acpx-cli](../../src/transport/acpx-cli)
- `acpx-bridge`：[src/transport/acpx-bridge](../../src/transport/acpx-bridge)

### 5.8 Bridge（src/bridge/*）

Bridge 的目标是把 acpx 驱动隔离到子进程，并提供更可控的并发/事件通道。

协议：

- method：`ensureSession/hasSession/prompt/setMode/cancel/removeSession/...`：[acpx-bridge-protocol.ts](../../src/transport/acpx-bridge/acpx-bridge-protocol.ts#L1-L66)
- message：request/response + event（`prompt.segment`、`session.progress`、`session.note`）

服务端：

- `BridgeServer.handleLine()`：一行 JSON in → 一行 JSON out；错误时统一封装为 `BridgeErrorResponse`：[bridge-server.ts](../../src/bridge/bridge-server.ts#L47-L78)
- session scoped 调度：
  - `SESSION_SCOPED_METHODS` 的请求，会基于 `[agentIdentity,cwd,name]` 形成 scheduleKey；同一 key 串行化
  - `cancel` 走 `control` lane（优先级更高）：[bridge-server.ts](../../src/bridge/bridge-server.ts#L81-L103)

### 5.9 Daemon（src/daemon/*）

`DaemonController`：外部控制面（CLI 调用）

- `getStatus()`：PID/status 一致且进程存活→running；非 Windows 平台遇到新鲜的 status-only 存活 daemon 时补回 PID 文件；存活但元数据过期或不完整→indeterminate；PID 已失效时清理 runtime files：[daemon-controller.ts](../../src/daemon/daemon-controller.ts)
- `start()`：spawn detached → 写 pid → 等待 status ready（pid 匹配）：[daemon-controller.ts](../../src/daemon/daemon-controller.ts#L75-L93)
- `stop()`：terminate → 等待退出 → 清理 pid/status：[daemon-controller.ts](../../src/daemon/daemon-controller.ts#L96-L109)

### 5.10 Orchestration（src/orchestration/*）

`OrchestrationService` 维护 tasks/groups/questions/packages 等状态，并负责：

- 委派 worker（ensure session + dispatch prompt）
- 接收 worker 结果/进度并持久化
- 在需要人工确认时生成“人类问题包”（human question package）
- 触发 coordinator wake（把待处理状态注入到 coordinator session）

依赖注入接口位于 `OrchestrationServiceDeps`：[orchestration-service.ts](../../src/orchestration/orchestration-service.ts#L197-L217)

### 5.11 MCP（src/mcp/*）

`runXacpxMcpServer()` 启动 MCP stdio server 并提供工具列表：

- server 初始化与 tool registry 缓存：[xacpx-mcp-server.ts](../../src/mcp/xacpx-mcp-server.ts)
- identity 解析（coordinatorSession/sourceHandle 或 resolveIdentity）：[xacpx-mcp-server.ts](../../src/mcp/xacpx-mcp-server.ts)
- 连接 stdio transport：[xacpx-mcp-server.ts](../../src/mcp/xacpx-mcp-server.ts)

### 5.12 Logging（src/logging/*）

`AppLogger` 是运行期的核心观测面，关注点是“结构化事件 + 本地 rolling file”：

- 创建：`createAppLogger({ filePath, level, maxSizeBytes, maxFiles, retentionDays })`：[app-logger.ts](../../src/logging/app-logger.ts#L43-L91)
- 旋转策略：超过 `maxSizeBytes` 时按 `.1/.2/...` 轮转，超出 `maxFiles` 清理：[app-logger.ts](../../src/logging/app-logger.ts#L93-L134)
- 保留策略：按 `retentionDays` 清理历史轮转文件：[app-logger.ts](../../src/logging/app-logger.ts#L136-L166)

---

## 6. 关键协议与边界（Bridge / Orchestration IPC / Channel）

### 6.1 Channel Runtime 边界

- `MessageChannelRuntime` 只暴露“登录/启动/发送/通知”能力，不暴露 router/transport 细节：[channels/types.ts](../../src/channels/types.ts#L62-L78)

### 6.2 Bridge JSONL 协议边界

- Bridge 是严格“一行一条 JSON 消息”的协议层，主进程可以以事件方式接收 `session.progress` 与 `prompt.segment`。
- `prompt.text` 允许空字符串，但仅当 media 存在：[bridge-server.ts](../../src/bridge/bridge-server.ts#L285-L295)

### 6.3 Orchestration IPC

- daemon 模式下会启动 `OrchestrationServer`，并通过 socket endpoint 暴露给外部（包括 CLI mcp-stdio）。
- endpoint 的默认路径来自 `resolveRuntimePaths().orchestrationSocketPath`：[main.ts](../../src/main.ts#L665-L667)

---

## 7. 配置、状态与运行时文件

### 7.1 默认路径

由 `resolveRuntimePaths()` 决定：[main.ts](../../src/main.ts#L653-L668)

- config：`~/.xacpx/config.json`（可用 `WEACPX_CONFIG` 覆盖）
- state：`~/.xacpx/state.json`（可用 `WEACPX_STATE` 覆盖）
- runtime dir：`dirname(configPath)/runtime`
  - app log：`${runtimeDir}/app.log`：[main.ts](../../src/main.ts#L678-L682)
  - daemon pid/status/stdout/stderr 等由 `src/daemon/daemon-files.ts` 约定（建议配合 `xacpx status` 查看）

### 7.2 config 与 state 的职责边界

- config：用户显式配置（transport、channels、agents、workspaces、logging、orchestration 参数…）
- state：运行时状态（sessions、chat_contexts、orchestration 状态机数据…）

详细字段请参考：

- 配置说明：[docs/config-reference.md](./config-reference_zh.md)
- `/config` 命令白名单：[docs/config-command.md](./config-command_zh.md)

---

## 8. 构建、测试与本地调试

### 8.1 依赖与构建产物

- `bun run build`：构建到 `dist/`，输出 `dist/cli.js` 与 `dist/bridge/bridge-main.js`（`node-pty` 标记 external）：[package.json](../../package.json#L13-L24)

### 8.2 测试

- `npm test` / `npm run test:unit`：unit tests（`tests/unit/**/*.test.ts`）
- `npm run test:smoke`：smoke tests（依赖真实环境）
- 运行脚本位于：[scripts/run-tests.mjs](../../scripts/run-tests.mjs)

测试分层说明：[docs/testing.md](./testing_zh.md)

### 8.3 本地调试（源码运行）

- `bun install`
- `bun run login`
- `bun run dev`（等价于 `bun run ./src/cli.ts run`）：[package.json](../../package.json#L14-L16)

### 8.4 运行时观测

- 日志默认写入 `~/.xacpx/runtime/app.log`（rolling/retention 由 config.logging 控制）
- daemon 状态建议使用 `xacpx status` 查看（会打印 PID、started/heartbeat、config/state/log 路径）：[cli.ts](../../src/cli.ts#L327-L350)
