# 代码 Wiki

本页是面向代码阅读者和维护者的架构参考手册，涵盖系统边界、启动链路、模块职责、关键类型与函数，以及依赖方向。如需面向用户的文档，请参阅[指南](/zh/guide/getting-started)和[参考](/zh/reference/commands)章节。

## 心智模型

xacpx 是一座"消息频道 ↔ 命令路由 ↔ acpx 会话驱动"的桥梁：

- **入站：** 消息来自微信、飞书、CLI 等频道，每个会话由 `chatKey` 标识。
- **路由器：** 解析斜杠命令（`/ss`、`/use`、`/cancel` 等）和普通文本。命令分发给对应处理器；普通文本则作为 prompt 发往当前会话。
- **会话：** 维护逻辑会话（别名 / 智能体 / 工作区 / 上下文 / 回复模式）到传输会话（acpx 命名会话）的映射关系。
- **传输层：** 以统一接口抽象 `ensureSession / prompt / cancel / setMode`。两种具体实现：
  - `acpx-cli` — 直接以子进程方式启动 `acpx`（可选 `node-pty` PTY 分配）。
  - `acpx-bridge` — 独立桥接子进程 + JSONL 协议；并发控制和事件处理更强。
- **编排**（可选）：在协调器会话下管理向多个工作器会话的任务委派——进度上报、人工确认、群组扇出/汇聚。
- **守护进程：** 后台进程生命周期（start / status / stop）。维护 PID、状态、日志元数据并托管编排 IPC 服务器。
- **MCP**（可选）：将编排能力以 MCP stdio 服务器的形式暴露给外部宿主（Codex、Claude Code 等）。

## 入口点

| 入口点 | 文件 | 功能 |
| --- | --- | --- |
| CLI 入口 | [`src/cli.ts`](https://github.com/gadzan/xacpx/blob/main/src/cli.ts) | `runCli()` — 分发所有 `xacpx <command>` 子命令 |
| 应用组装 / 依赖注入 | [`src/main.ts`](https://github.com/gadzan/xacpx/blob/main/src/main.ts) | `buildApp()` — 组装配置、状态、日志、会话、传输、编排、路由、智能体 |
| 启动 / 关闭序列 | [`src/run-console.ts`](https://github.com/gadzan/xacpx/blob/main/src/run-console.ts) | `runConsole()` — 守护进程运行时、消费者锁、频道启动、最终清理 |
| 命令路由 | [`src/commands/command-router.ts`](https://github.com/gadzan/xacpx/blob/main/src/commands/command-router.ts) | `CommandRouter` |
| 会话状态 | [`src/sessions/session-service.ts`](https://github.com/gadzan/xacpx/blob/main/src/sessions/session-service.ts) | `SessionService` |
| 传输层边界 | [`src/transport/types.ts`](https://github.com/gadzan/xacpx/blob/main/src/transport/types.ts) | `SessionTransport` 接口 |

### 应用组装与启动生命周期

`buildApp()` 是依赖注入中心——将配置、状态、日志、会话、传输、编排、路由和智能体组装为一个 `AppRuntime`：[`src/main.ts`](https://github.com/gadzan/xacpx/blob/main/src/main.ts)

`runConsole()` 负责启动序列、信号驱动的关闭流程以及清理一致性：[`src/run-console.ts`](https://github.com/gadzan/xacpx/blob/main/src/run-console.ts)

1. `buildApp(paths)` 组装运行时。
2. 守护进程模式下：写入守护进程运行时元数据，启动编排 IPC 服务器，启动心跳。
3. 获取消费者锁（防止多个进程同时消费同一微信账号）。
4. `channels.startAll(...)` — 并行启动所有频道。
5. `finally`：停止 IPC / 释放资源 / stopAll / 释放锁。

## 命令路由

### 数据流（从微信到 acpx）

1. 频道收到消息（`chatKey` + 文本 + 可选媒体）。
2. `ConsoleAgent.chat()` 调用 `router.handle(chatKey, input, reply, replyContextToken, accountId, media)`。
3. `CommandRouter.handle()`：
   - 以 `/` 开头的输入：`parseCommand()` 分发到对应处理器。
   - 普通文本：视为 prompt，解析到当前会话，转发给 `transport.prompt()`。
4. 传输层执行：
   - `acpx-cli`：启动 `acpx ... prompt` 子进程并聚合输出。
   - `acpx-bridge`：向桥接子进程发送 JSONL 请求；桥接子进程负责调度并回写事件。
5. 回复流回频道（流式 / 详细 / 最终，取决于配置的回复模式）。

### 关键组件

- **`parseCommand()`** — 斜杠命令解析器，内置别名解析（`/ss` → `/session`，`/ws` → `/workspace`，`/stop` → `/cancel`）：[`src/commands/parse-command.ts`](https://github.com/gadzan/xacpx/blob/main/src/commands/parse-command.ts)
- **`CommandRouter`** — 精简路由器 + 上下文组装器；同时处理传输调用观测、自动修复和诊断摘要：[`src/commands/command-router.ts`](https://github.com/gadzan/xacpx/blob/main/src/commands/command-router.ts)
- **处理器** — 按职责边界拆分：会话生命周期、快捷方式创建、恢复、重置、配置命令：[`src/commands/handlers/`](https://github.com/gadzan/xacpx/blob/main/src/commands/handlers)
- **`router-types.ts`** — 显式定义 `RouterResponse`、`CommandRouterContext` 和会话操作接口：[`src/commands/router-types.ts`](https://github.com/gadzan/xacpx/blob/main/src/commands/router-types.ts)

完整模块说明请参阅[命令模块](/zh/development/commands-module)。

## 会话模型

### 两种会话概念

**逻辑会话**（xacpx 管理）— `alias / agent / workspace` 加上持久化状态（`replyMode`、`modeId`、上下文等）。由 `SessionService` 管理，写入 `state.json`：

- `createSession()` / `attachSession()`：[`src/sessions/session-service.ts`](https://github.com/gadzan/xacpx/blob/main/src/sessions/session-service.ts)
- `useSession()` / `getCurrentSession()` / `listSessions()`：同一文件。

**传输会话**（acpx 管理）— `transportSession` 字符串，用作底层 acpx 命名会话的名称。`ResolvedSession` 是传递给传输层的完整路由上下文（包含 `cwd`、`agentCommand`、`transportSession` 等）：[`src/transport/types.ts`](https://github.com/gadzan/xacpx/blob/main/src/transport/types.ts)

### 核心数据概念

- **`chatKey`** — 稳定的会话标识符，在所有频道中全局唯一。格式：`<channelId>:<channel-internal-id>`。频道注册表用它来路由出站消息：[`src/channels/channel-registry.ts`](https://github.com/gadzan/xacpx/blob/main/src/channels/channel-registry.ts)
- **`replyMode`** — xacpx 回复策略（`stream` / `final` / `verbose`），存储在逻辑会话上。
- **`modeId`** — 底层智能体模式（如 `codex plan`），存储在逻辑会话上。
- **编排对象** — `coordinatorSession`、`workerSession`、`task`、`group`。组装点在 `buildApp()` 中：[`src/main.ts`](https://github.com/gadzan/xacpx/blob/main/src/main.ts)

## 传输层

### 统一接口

```ts
// src/transport/types.ts
interface SessionTransport {
  ensureSession(session: ResolvedSession, opts?): Promise<void>;
  prompt(session: ResolvedSession, text: string, opts?: PromptOptions): Promise<void>;
  cancel(session: ResolvedSession): Promise<void>;
  setMode(session: ResolvedSession, modeId: string): Promise<void>;
  hasSession(session: ResolvedSession): Promise<boolean>;
}
```

两种实现：

- **`acpx-cli`**（[`src/transport/acpx-cli/`](https://github.com/gadzan/xacpx/blob/main/src/transport/acpx-cli)）— 以子进程方式启动 `acpx`；可选通过 `node-pty` 分配 PTY。
- **`acpx-bridge`**（[`src/transport/acpx-bridge/`](https://github.com/gadzan/xacpx/blob/main/src/transport/acpx-bridge)）— 通过 JSONL 协议与独立桥接子进程通信。并发和事件隔离性更好。子进程和协议细节请参阅[桥接子系统](#桥接子系统)章节。

### acpx 解析顺序

1. 配置中的 `transport.command`（显式覆盖）。
2. 主包 `node_modules` 中内置的 `acpx`。
3. Shell `PATH` 中的 `acpx`。

## 频道

核心仅内置 `weixin` 频道以及通用的频道/插件基础设施。飞书、元宝及所有其他非微信频道均由插件提供，位于 `packages/channel-*` 或外部 npm 包——而非 `src/channels/`。

### 频道接口

- `MessageChannelRuntime` — 登录 / 启动 / 发送 / 任务通知：[`src/channels/types.ts`](https://github.com/gadzan/xacpx/blob/main/src/channels/types.ts)
- `MessageChannelRegistry` — 聚合器，并行启动所有频道（允许部分失败；全部失败时抛出异常），并按 `chatKey` 路由出站消息：[`src/channels/channel-registry.ts`](https://github.com/gadzan/xacpx/blob/main/src/channels/channel-registry.ts)

### ConsoleAgent

`ConsoleAgent` 是频道到路由器的适配器：它规范化媒体内容、拒绝空消息、记录日志，并调用 `router.handle(...)`。频道只依赖 `WechatAgent` 的行为，不依赖 `CommandRouter` 的内部细节：[`src/console-agent.ts`](https://github.com/gadzan/xacpx/blob/main/src/console-agent.ts)

### 内置微信频道

`src/weixin/` 是内置微信服务提供者（登录、轮询、媒体管线、配额管理），由 `WeixinChannel` 托管：[`src/channels/weixin-channel.ts`](https://github.com/gadzan/xacpx/blob/main/src/channels/weixin-channel.ts)。

- 交互式登录（二维码，`qrcode-terminal` 含 URL 兜底）：[`src/weixin/bot.ts`](https://github.com/gadzan/xacpx/blob/main/src/weixin/bot.ts)
- 出站配额（`QuotaManager` — 每个 chatKey 的滑动窗口预算，区分中间段与最终段，最终段分页，pendingFinal 队列）：[`src/weixin/messaging/quota-manager.ts`](https://github.com/gadzan/xacpx/blob/main/src/weixin/messaging/quota-manager.ts)

### 频道能力：原生会话列表格式

`/ssn` 原生会话列表的渲染格式由各频道通过 `MessageChannelRuntime.nativeSessionListFormat` 声明（`"cards" | "table"`，默认 `"table"`；`weixin` 声明为 `"cards"`）。注册表通过 `nativeSessionListFormat(chatKey)` 暴露该值，由 `CommandRouter` 注入到 `CommandRouterContext.resolveNativeSessionListFormat` 中，再由原生会话处理器读取。新频道只需在运行时声明此能力——无需修改处理器。

## 守护进程子系统

完整说明请参阅[守护进程模块](/zh/development/daemon-module)。

`DaemonController` — 外部控制接口（CLI 调用）：
- `getStatus()` — PID/状态匹配且进程存活 → `running`；存活元数据冲突或不完整 → 只读 `indeterminate`；已消亡的 PID 元数据会被清理（`stopped` 且 `stale: true`）。
- `start()` — 以分离模式启动 → 写入 PID → 轮询 `status.json` 等待就绪（PID 匹配）。
- `stop()` — 终止进程 → 等待退出 → 清理 PID 和状态文件。

源码：[`src/daemon/daemon-controller.ts`](https://github.com/gadzan/xacpx/blob/main/src/daemon/daemon-controller.ts)

守护进程通过三个信号综合判断存活状态：PID 文件、该 PID 对应进程是否实际存在，以及 `status.json` 是否已写入。所有运行时文件路径集中管理于：[`src/daemon/daemon-files.ts`](https://github.com/gadzan/xacpx/blob/main/src/daemon/daemon-files.ts)。

## 桥接子系统

桥接子系统将 `acpx` 的驱动逻辑隔离到独立的子进程中，使主进程获得更可控的并发性和事件通道。它是 `acpx-bridge` 传输实现的后端支撑。

### 入口与运行时

- [`src/bridge/bridge-main.ts`](https://github.com/gadzan/xacpx/blob/main/src/bridge/bridge-main.ts) — 桥接子进程的入口点（处理 `acpx` stdio）。
- [`src/bridge/bridge-server.ts`](https://github.com/gadzan/xacpx/blob/main/src/bridge/bridge-server.ts) — 解析桥接协议 JSON 行并委派给运行时。
- [`src/bridge/bridge-runtime.ts`](https://github.com/gadzan/xacpx/blob/main/src/bridge/bridge-runtime.ts) — 封装原始 `acpx` 命令（`sessions new`、`prompt`、`cancel`）。

### JSONL 协议

- 方法：`ensureSession / hasSession / prompt / setMode / cancel / removeSession / ...`：[`src/transport/acpx-bridge/acpx-bridge-protocol.ts`](https://github.com/gadzan/xacpx/blob/main/src/transport/acpx-bridge/acpx-bridge-protocol.ts)
- 消息类型：`request` / `response` 以及 `event`（`prompt.segment`、`session.progress`、`session.note`）。
- 严格的单行 JSON 协议：主进程可接收 `session.progress` 和 `prompt.segment` 作为事件。仅当有媒体内容时 `prompt.text` 才可为空字符串。

### 服务器调度

`BridgeServer.handleLine()` 接收一行 JSON 输入，输出一行 JSON；错误统一包装为 `BridgeErrorResponse`。会话范围内的请求（`SESSION_SCOPED_METHODS`）以 `[agentIdentity, cwd, name]` 为 `scheduleKey`，在同一 key 内串行执行。`cancel` 运行在更高优先级的 `control` 车道，可抢占正在进行的 prompt 请求。源码：[`src/bridge/bridge-server.ts`](https://github.com/gadzan/xacpx/blob/main/src/bridge/bridge-server.ts)

## 配置与状态

### 默认路径（来自 `resolveRuntimePaths()`）

| 路径 | 内容 | 写入方 |
| --- | --- | --- |
| `~/.xacpx/config.json` | 智能体、工作区、频道、插件、传输——静态配置 | `ConfigStore`、CLI |
| `~/.xacpx/state.json` | 会话、聊天上下文、编排状态 | `DebouncedStateStore`（50 ms 合并）→ `StateStore` |
| `~/.xacpx/runtime/daemon.pid` | 当前守护进程 PID | `DaemonRuntime` |
| `~/.xacpx/runtime/status.json` | 守护进程心跳 / start_at / 日志路径 | `DaemonRuntime` |
| `~/.xacpx/runtime/app.log` | 有界应用日志（滚动） | `AppLogger` |
| `~/.xacpx/runtime/orchestration.sock` | Unix socket（Windows 上为 `\\.\pipe\xacpx-orchestration-<hash>`） | `OrchestrationServer` |
| `~/.xacpx/plugins/` | 插件 npm 主目录（独立的 `package.json` + `node_modules`） | `xacpx plugin add/update` |

`XACPX_CONFIG` 和 `XACPX_STATE` 环境变量分别覆盖配置和状态文件路径；旧名 `WEACPX_CONFIG` / `WEACPX_STATE` 仍作为回退生效。

### 职责边界

- **config** — 用户显式设置（传输、频道、智能体、工作区、日志、编排参数等）。
- **state** — 运行时状态（会话、聊天上下文、编排状态机数据等）。

完整字段说明请参阅[配置参考](/zh/reference/configuration)和 [/config 命令](/zh/reference/config-command)。

### 日志

`AppLogger` — 带本地滚动文件的结构化事件日志：
- 通过 `createAppLogger({ filePath, level, maxSizeBytes, maxFiles, retentionDays })` 创建。
- 达到 `maxSizeBytes` 时使用 `.1/.2/...` 后缀滚动；超出 `maxFiles` 的文件将被清理。
- 按 `retentionDays` 保留。

源码：[`src/logging/app-logger.ts`](https://github.com/gadzan/xacpx/blob/main/src/logging/app-logger.ts)

### 状态持久化

`DebouncedStateStore` → `StateStore` → `writePrivateFileAtomic`（`proper-lockfile` 实现跨进程互斥 + `write-file-atomic` 实现原子重命名 + Windows EBUSY 兜底）：[`src/state/`](https://github.com/gadzan/xacpx/blob/main/src/state)

### MCP stdio 服务器

`xacpx mcp-stdio` 启动一个 MCP stdio 服务器并暴露编排工具：
- 身份解析（`coordinatorSession` / `sourceHandle` / `workspace`）和外部协调器注册：[`src/cli.ts`](https://github.com/gadzan/xacpx/blob/main/src/cli.ts)
- MCP 服务器运行循环：[`src/mcp/xacpx-mcp-server.ts`](https://github.com/gadzan/xacpx/blob/main/src/mcp/xacpx-mcp-server.ts)

此模式要求守护进程正在运行（编排 IPC 端点必须可用）。暴露给外部宿主的 MCP 服务器名称为 `xacpx`（工具前缀 `mcp__xacpx__*`）。
