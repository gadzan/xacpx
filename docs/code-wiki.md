# xacpx Code Wiki

This Wiki is aimed at reading/maintaining the code: it lays out the system boundaries, startup chain, module responsibilities, key types and key functions, dependency relationships, and how to run things. For user-facing documentation, please refer first to [README.md](../README.md) and the existing notes under `docs/`.

## Table of Contents

- 1. System Overview
- 2. Core Concepts and Data Model
- 3. High-level Architecture and Dependency Direction
- 4. Startup Methods and Run Modes
- 5. Detailed Walkthrough of the Main Modules
- 6. Key Protocols and Boundaries (Bridge / Orchestration IPC / Channel)
- 7. Config, State, and Runtime Files
- 8. Build, Test, and Local Debugging

---

## 1. System Overview

At its core, `xacpx` is a bridging system of "message channel ↔ command routing ↔ acpx session driving":

- Inbound: receives messages from channels such as WeChat/Feishu/CLI (chatKey identifies the conversation).
- Router: parses slash commands (`/ss`, `/use`, `/cancel`…) and plain text; commands land on a handler; plain text becomes a prompt.
- Sessions: maintains the mapping from "logical session" (alias/agent/workspace/context/reply mode) to "transport session" (acpx named session).
- Transport: provides a unified abstraction over `ensureSession/prompt/cancel/setMode`, implemented concretely via:
  - `acpx-cli` (directly spawn `acpx` + optional `node-pty`)
  - `acpx-bridge` (subprocess bridge + JSONL protocol, isolation and stronger concurrency/event handling)
- Orchestration (optional): under a coordinator session, manages task delegation, progress reporting, human confirmation, group aggregation, etc., across multiple worker sessions.
- Agent Messaging (optional): a separate one-way `agent_list` / `agent_send` path for peer updates between authorized managed sessions. Local delivery is queue-first; it does not create tasks or wait for peer model output.
- Daemon: runs in the background (start/status/stop), maintains metadata such as pid/status/log, and hosts the orchestration IPC server.
- MCP (optional): exposes orchestration capabilities as an MCP stdio server to external hosts (Codex/Claude Code, etc.), where the external host initiates delegate/group operations through tool calls.

Key repository entrypoints:

- CLI entrypoint: [src/cli.ts](../src/cli.ts)
- Application assembly entrypoint: [buildApp()](../src/main.ts#L111-L600)
- Foreground run entrypoint: [main()](../src/main.ts#L608-L637)
- Main loop orchestration: [runConsole()](../src/run-console.ts#L45-L152)
- Command routing hub: [CommandRouter](../src/commands/command-router.ts#L80-L590)
- Session model: [SessionService](../src/sessions/session-service.ts#L27-L347)
- transport boundary: [SessionTransport](../src/transport/types.ts#L46-L64)

---

## 2. Core Concepts and Data Model

### 2.1 chatKey (conversation identity)

- `chatKey` is the stable identifier for a "message conversation", running through channels / sessions / orchestration / quota.
- `MessageChannelRegistry` routes outbound via `chatKey -> channelId`: [getByChatKey()](../src/channels/channel-registry.ts#L49-L52)

### 2.2 Two Kinds of Session: Logical vs Transport

- Logical session (xacpx internal): `alias/agent/workspace` + persisted state (replyMode/modeId/context, etc.), managed by `SessionService` and stored in `state.json`.
  - Typical APIs:
    - `createSession()/attachSession()`: [session-service.ts](../src/sessions/session-service.ts#L39-L65)
    - `useSession()/getCurrentSession()/listSessions()`: [session-service.ts](../src/sessions/session-service.ts#L89-L195)
- Transport session (acpx-layer named session): the `transportSession` string; `xacpx` uses it as the underlying session name, and the actual execution happens in the transport.
  - `ResolvedSession` is the full context "routed to the transport" (including cwd/agentCommand/transportSession…): [transport/types.ts](../src/transport/types.ts#L21-L33)

### 2.3 ReplyMode / ModeId

- `replyMode` (xacpx reply strategy, stream/final/verbose) is stored in the logical session: [ResolvedSession.replyMode](../src/transport/types.ts#L30-L31)
- `modeId` (the underlying agent mode, such as codex plan/…) is stored in the logical session: [ResolvedSession.modeId](../src/transport/types.ts#L29-L30)

### 2.4 Orchestration: Coordinator / Worker / Task / Group

- coordinatorSession: the coordinator session (usually equal to the current transportSession, or coming from an external MCP identity)
- workerSession: the delegated execution session (acpx session name)
- task: a single delegation unit (states: pending/needs_confirmation/running/completed/failed/cancelled…)
- group: a task group that aggregates multiple tasks and supports fan-out/fan-in

The assembly point is in `buildApp()`: it injects capabilities such as worker dispatch / cancel / wake into the `OrchestrationService`: [main.ts](../src/main.ts#L472-L543)

---

## 3. High-level Architecture and Dependency Direction

### 3.1 Layering and Dependency Direction ("can only depend downward")

- Channels (built-in weixin + plugin-backed feishu/yuanbao examples)
  - Depends on: `ConsoleAgent` (used to hand inbound off to the router), `AppLogger`, `QuotaManager`
- ConsoleAgent (protocol adaptation: message -> router)
  - Depends on: `CommandRouter`
- CommandRouter (parses commands, invokes handlers, wraps transport calls and diagnostics)
  - Depends on: `SessionService`, `SessionTransport`, `ConfigStore`, `AppConfig`, `OrchestrationService` (optional), `QuotaManager` (optional)
- SessionService (logical session + state persistence)
  - Depends on: `AppConfig`, `StateStore`
- Transport (acpx-cli / acpx-bridge)
  - Depends on: the `acpx` CLI; (optional) `node-pty`; (in bridge mode) the bridge subprocess
- Bridge (subprocess)
  - Depends on: the bridge JSONL protocol, the `acpx` CLI; emits events (progress/segment) via stdout
- Daemon (background process control)
  - Depends on: runtime files (pid/status/log) and process management (spawn/terminate)
- Orchestration (optional)
  - Depends on: StateStore; drives worker sessions through the transport; pushes progress/result notifications back through channels
- Agent Messaging (optional)
  - Depends on: the state-backed endpoint registry and `SessionTransport.injectMessage`; shares orchestration IPC but not `OrchestrationService` task semantics
- MCP (optional)
  - Depends on: `@modelcontextprotocol/sdk`; calls in-daemon services through orchestration IPC

### 3.2 Main-path Data Flow (from WeChat to acpx)

1. A channel receives a message (chatKey + text + optional media)
2. `ConsoleAgent.chat()` calls `router.handle(chatKey, input, reply, replyContextToken, accountId, media)`
3. `CommandRouter.handle()`:
   - starting with `/`: `parseCommand()` dispatches to handlers
   - otherwise: treats it as a `prompt`, resolves the current session, and goes through `transport.prompt()`
4. Transport execution:
   - `acpx-cli`: spawns `acpx ... prompt` and aggregates the output
   - `acpx-bridge`: sends a JSONL request to the bridge; the bridge handles scheduling/writing back events
5. reply goes back to the channel (output as stream/verbose/final per the strategy)

---

## 4. Startup Methods and Run Modes

### 4.1 Foreground Run (development/debugging)

- Entrypoints: `xacpx run` and direct [main()](../src/main.ts) both delegate to [runDefaultRuntime()](../src/cli.ts)
- Core steps:
  - Resolve runtimePaths: `resolveRuntimePaths()`: [main.ts](../src/main.ts#L653-L668)
  - Refuse to overlap a live/indeterminate daemon, then acquire the same core runtime ownership lock used by background mode; foreground runs do not create `DaemonRuntime` or write daemon PID/status: [cli.ts](../src/cli.ts)
  - Create the channels registry and enter `runConsole()`: [run-console.ts](../src/run-console.ts#L45-L152)

### 4.2 Background daemon (normal usage)

- `xacpx start/status/stop/restart` manages the background process through `DaemonController`.
- The daemon's readiness check: after spawn, poll status.json, and consider it ready once the pid matches: [daemon-controller.ts](../src/daemon/daemon-controller.ts#L75-L151)

### 4.3 MCP stdio server (external host integration)

- `xacpx mcp-stdio`:
  - Resolve identity (coordinatorSession/sourceHandle/workspace) and register the external coordinator: [prepareMcpCoordinatorStartup()](../src/cli.ts#L49-L104)
  - Run the MCP server: [runXacpxMcpServer()](../src/mcp/xacpx-mcp-server.ts)
- This mode usually requires the daemon to be already running (so the orchestration IPC endpoint is available).

---

## 5. Detailed Walkthrough of the Main Modules

### 5.1 CLI and Command Surface (src/cli.ts)

- Unified CLI entrypoint: [runCli()](../src/cli.ts#L242-L372)
- Main responsibilities:
  - daemon lifecycle control (start/status/stop/restart)
  - foreground `run`
  - `login/logout` (a wrapper around the channel)
  - `workspace`/`channel`, these "local config management" commands
  - `adapter` management: exact defaults, command classification, and the shared trust-boundary decoder live in [src/adapters/adapter-catalog.ts](../src/adapters/adapter-catalog.ts); immutable staging/validation/pointer publication lives in [src/adapters/adapter-preinstall.ts](../src/adapters/adapter-preinstall.ts); cross-process locking lives in [src/adapters/adapter-locks.ts](../src/adapters/adapter-locks.ts); reference-safe double-scan deletion lives in [src/adapters/adapter-gc.ts](../src/adapters/adapter-gc.ts); registry policy/probing and CLI composition remain in the adjacent adapter modules
  - `mcp-stdio` (MCP server startup and identity rules)

### 5.2 App Assembly (src/main.ts)

`buildApp()` is the dependency-injection center; it assembles config/state/logger/sessions/transport/orchestration/router/agent into an `AppRuntime`:

- Config and logging:
  - `ensureConfigExists()`: [main.ts](../src/main.ts#L111-L116)
  - `loadConfig()` + `createAppLogger()`: [main.ts](../src/main.ts#L114-L125)
- State and sessions:
  - `StateStore.load()` + `new SessionService(...)`: [main.ts](../src/main.ts#L127-L131)
  - At startup, `computeAgentOverlayEntries(config)` provisions config-derived `xacpx-managed-*` aliases into `~/.acpx/config.json` via `ensureAgentOverlays` so new structured launches resolve on Windows. Module: [acpx-agent-overlay.ts](../src/transport/acpx-agent-overlay.ts)
- transport selection:
  - `acpx-bridge`: `spawnAcpxBridgeClient()` + `new AcpxBridgeTransport(...)`: [main.ts](../src/main.ts#L132-L146)
  - `acpx-cli`: `new AcpxCliTransport(...)`: [main.ts](../src/main.ts#L145-L146)
- orchestration:
  - `new OrchestrationService({... injected callbacks ...})`: [main.ts](../src/main.ts#L472-L543)
  - hosts the IPC server within the daemon: `new OrchestrationServer(...)`: [main.ts](../src/main.ts#L569-L573)
- Agent Messaging:
  - stable node identity is persisted in `<xacpx-home>/agent-messaging/node.json`; endpoint identities derive from logical sessions and persisted worker/external bindings
  - [AgentEndpointRegistry](../src/orchestration/agent-endpoint-registry.ts) provides same-coordinator discovery and authorization without publishing private runtime metadata
  - [AgentMessageRouter](../src/orchestration/agent-message-router.ts) owns message ids, envelope semantics, FIFO, dedupe/limits, safe delivery logs, and the Local Route receipt
  - [LocalAgentMessageDeliveryAdapter](../src/orchestration/local-agent-message-delivery.ts) resolves the private runtime binding and calls `SessionTransport.injectMessage`
- router/agent:
  - `new CommandRouter(...)`: [main.ts](../src/main.ts#L573-L574)
  - `new ConsoleAgent(...)`: [main.ts](../src/main.ts#L574-L574)

### 5.3 Main Loop Orchestration (src/run-console.ts)

`runConsole()` is responsible for "startup ordering, signal-based exit, cleanup consistency":

- Build the runtime: `runtime = buildApp(paths)`: [run-console.ts](../src/run-console.ts#L66-L69)
- In daemon mode:
  - Write daemon runtime metadata: `daemonRuntime.start(...)`: [run-console.ts](../src/run-console.ts#L70-L82)
  - Start the orchestration IPC server: `runtime.orchestration.server.start()`: [run-console.ts](../src/run-console.ts#L75-L75)
  - Periodic heartbeat: [run-console.ts](../src/run-console.ts#L76-L81)
- required runtime ownership lock (before shared-state reconciliation, orphan sweeps, scheduler, or channel activation):
  - A failed acquire follows the generic `ActiveConsumerLockError` contract; POSIX core ownership is a kernel-held `flock`, while Windows uses the runtime-owner IPC guard: [runtime-consumer-lock.ts](../src/daemon/runtime-consumer-lock.ts), [run-console.ts](../src/run-console.ts)
- Start the channels: `channels.startAll(...)`: [run-console.ts](../src/run-console.ts#L132-L137)
- finally cleanup: stop IPC / dispose / stopAll / release lock: [run-console.ts](../src/run-console.ts#L154-L209)

### 5.4 Channels (src/channels/*)

Core ships only the Weixin runtime plus generic channel/plugin infrastructure. Feishu, Yuanbao, and future non-Weixin channels are plugin-backed and should live in `packages/channel-*` or external npm packages, not as product-specific implementations under `src/channels/`.

Unified abstraction: `MessageChannelRuntime` (login/start/send message/notify task progress): [channels/types.ts](../src/channels/types.ts#L62-L78)

Aggregator: `MessageChannelRegistry`

- `startAll()` starts channels in parallel, tolerating partial failures, but throws if all fail: [channel-registry.ts](../src/channels/channel-registry.ts#L27-L41)
- Routes outbound by chatKey: `notifyTaskProgress/notifyTaskCompletion/sendCoordinatorMessage`: [channel-registry.ts](../src/channels/channel-registry.ts#L53-L65)

> Channel capability bit: the render format of the `/ssn` native session list is determined by the channel-declared `MessageChannelRuntime.nativeSessionListFormat` (`"cards" | "table"`, defaults to `table`); weixin declares `cards`. The registry exposes `nativeSessionListFormat(chatKey)`, which is injected via `CommandRouter` into `CommandRouterContext.resolveNativeSessionListFormat` and read by [native-session-handler.ts](../src/commands/handlers/native-session-handler.ts). A new channel that wants card-style rendering only needs to declare this capability bit; no handler changes are required.

#### 5.4.1 ConsoleAgent (src/console-agent.ts)

ConsoleAgent is the adaptation layer from "channel message protocol → router protocol":

- `chat()`: normalizes media, rejects empty messages, logs, then calls `router.handle(...)`: [console-agent.ts](../src/console-agent.ts#L25-L53)
- This layer is the channels' sole "agent entrypoint"; channels do not directly depend on the implementation details of CommandRouter, only on `WechatAgent` behavior.

#### 5.4.2 Weixin Bot and Quota (src/weixin/*)

`src/weixin` is in fact a WeChat provider implemented inside the repository (login, polling send/receive, media handling, risk control/quota, etc.), hosted as a channel runtime by WeixinChannel (in `src/channels/weixin-channel.ts`).

- Interactive login: `login()` (QR code output, preferring `qrcode-terminal`, falling back to printing the URL on failure): [bot.ts](../src/weixin/bot.ts#L60-L111)
- Start polling: `start(agent, opts)` (resolve account, check token, call `monitorWeixinProvider`): [bot.ts](../src/weixin/bot.ts#L141-L185)
- Outbound quota: `QuotaManager` (a sliding-window budget per chatKey; distinguishes mid segment from final; supports final pagination and a pendingFinal queue): [quota-manager.ts](../src/weixin/messaging/quota-manager.ts#L15-L166)

### 5.5 Command System (src/commands/*)

#### 5.5.1 Parsing

- `parseCommand()`: slash command parsing and compatibility aliases (`/ss`→`/session`, `/ws`→`/workspace`, `/stop`→`/cancel`): [parse-command.ts](../src/commands/parse-command.ts#L61-L422)

#### 5.5.2 Routing and Execution

`CommandRouter`'s responsibility is not just switch dispatch; it also covers "transport call observability + auto-repair + diagnostic summary":

- Main entrypoint: `handle(chatKey, input, reply, replyContextToken, accountId, media)`: [command-router.ts](../src/commands/command-router.ts#L106-L258)
- session handler context injection (lifecycle/interaction/recovery): [command-router.ts](../src/commands/command-router.ts#L264-L358)
- transport wrapping:
  - `ensureTransportSession()`: supports automatic installation and re-verification of a missing optional dependency: [command-router.ts](../src/commands/command-router.ts#L411-L448)
  - `promptTransportSession()`: uniformly passes through reply/quota/media and ensures the mcpCoordinatorSession default value: [command-router.ts](../src/commands/command-router.ts#L513-L524)
  - `measureTransportCall()`: uniformly records success/failure logs and extracts an stdout/stderr diagnostic summary for `PromptCommandError`: [command-router.ts](../src/commands/command-router.ts#L549-L590)

### 5.6 Session Management (src/sessions/session-service.ts)

`SessionService` is the sole writer of the "logical session" and `state.json` (serializing writes via `AsyncMutex`):

- Create/attach:
  - `createSession()`: the default transport session looks like `${workspace}:${alias}`: [session-service.ts](../src/sessions/session-service.ts#L39-L41)
  - `attachSession()`: binds to an already-existing transport session: [session-service.ts](../src/sessions/session-service.ts#L56-L65)
- Current session and listing:
  - `useSession()`: points the chatKey's current_session at some internal alias: [session-service.ts](../src/sessions/session-service.ts#L89-L102)
  - `getCurrentSession()`/`listSessions()`: [session-service.ts](../src/sessions/session-service.ts#L165-L195)
- Key constraints:
  - `validateSession()` enforces that the agent/workspace is already registered in config: [session-service.ts](../src/sessions/session-service.ts#L326-L346)
  - Prevents the transport session from conflicting with an external coordinator: [session-service.ts](../src/sessions/session-service.ts#L298-L300)

### 5.7 Transport (src/transport/*)

Unified boundary: `SessionTransport`: [transport/types.ts](../src/transport/types.ts#L46-L64)

Before entering that boundary, [resolve-agent-command.ts](../src/config/resolve-agent-command.ts) resolves an explicit per-agent command first, then xacpx's exact managed Codex/Claude npx pin, then the local/native fallback for other drivers. Generated managed commands recorded in session state are derived state: [SessionService](../src/sessions/session-service.ts) refreshes them from the current configured/default pin after restart, while preserving genuinely custom recorded commands.

Structured launches (managed pins, hermes shim, local fallbacks, user `argv`) are modeled as an `AgentLaunchSpec` ([agent-launch.ts](../src/config/agent-launch.ts)): `acpxAgent` (positional: content-addressed alias or bare driver), `agentCommand` (canonical acpx session identity), `agentArgv`, and `rawCommand` (legacy / historical `acpx --agent` selector; Windows built-in history is recovered by acpx 0.13 record backfill). Alias provisioning merges `{argv}` entries into `~/.acpx/config.json` under a proper-lockfile ([acpx-agent-overlay.ts](../src/transport/acpx-agent-overlay.ts)); legacy session records are backfilled with `agent_argv` only on exact identity match ([acpx-session-argv-migration.ts](../src/transport/acpx-session-argv-migration.ts)). Persisted preinstalled commands count as derived managed identity only when they match the trusted runtime adapter root and the complete immutable release/package layout; the broader path-shape classifier is fencing-only. The agent selection rule lives in exactly one place — `appendAgentAndTail` in [acpx-command-builder.ts](../src/transport/acpx-command-builder.ts) — and every transport and management by-pass (status/list/reap/doctor) routes through it.

On Windows, a `LogicalSession` whose recorded `transport_agent_command` is a multi-token raw command, or a single-token command that does NOT round-trip losslessly as `[command]`, cannot be launched because acpx rejects raw `--agent` strings there. Convert the agent to structured `argv` in config (see [config-reference.md](./config-reference.md#windows-raw-command-migration)) or rely on acpx record backfill when identity matches exactly. The fail-closed guarantee in `resolveLaunchSpec` ([session-service.ts](../src/sessions/session-service.ts)) stays unchanged when identity cannot be proven or the default is derived.

- `ensureSession()`: creates/ensures the underlying session exists for a given `ResolvedSession`, and can report back `EnsureSessionProgress` (spawn/initializing/ready or note)
- `prompt()`: sends a prompt, supporting a reply callback (streaming) and `PromptOptions` (media, onSegment)
- `cancel()/setMode()/hasSession()`: control-type operations

Two implementations:

- `acpx-cli`: [src/transport/acpx-cli](../src/transport/acpx-cli)
- `acpx-bridge`: [src/transport/acpx-bridge](../src/transport/acpx-bridge)

argv construction for both implementations is centralized in the pure shared module [acpx-command-builder.ts](../src/transport/acpx-command-builder.ts) (no `this`, no I/O; its only import beyond `config/types` is the shared `permission-mode-flag` helper): permission/ttl/model/session/prompt/query args plus `isMissingAcpxSessionError` and `parseAcpxSessionRecordId`, including the permission defaults (`DEFAULT_PERMISSION_MODE`, `DEFAULT_NON_INTERACTIVE`). It is the single source of truth for the shared/global argv prefix (format, cwd, permission, model, ttl, verbose, and agent selection). Ordinary operations still build their own tails, while Agent Messaging uses the shared `buildQueueMessagePromptArgs` helper so both transports produce the exact same `prompt -s <name> --no-wait <envelope>` queue submission. `acpx-cli-transport.ts` and `bridge-runtime.ts` keep their own per-operation orchestration, error handling, capability probing (e.g. bridge's `--verbose` probe), and I/O plumbing (PTY/`child_process` spawning vs. the bridge subprocess).

### 5.8 Bridge (src/bridge/*)

The Bridge's goal is to isolate the acpx driving into a subprocess and provide a more controllable concurrency/event channel.

Protocol:

- method: `ensureSession/hasSession/prompt/setMode/cancel/removeSession/...`: [acpx-bridge-protocol.ts](../src/transport/acpx-bridge/acpx-bridge-protocol.ts#L1-L66)
- message: request/response + event (`prompt.segment`, `session.progress`, `session.note`)

Server side:

- `BridgeServer.handleLine()`: one line of JSON in → one line of JSON out; on error, uniformly wraps it as `BridgeErrorResponse`: [bridge-server.ts](../src/bridge/bridge-server.ts#L47-L78)
- session scoped scheduling:
  - Requests for `SESSION_SCOPED_METHODS` form a scheduleKey based on `[agentIdentity,cwd,name]`; the same key is serialized
  - `cancel` goes through the `control` lane (higher priority): [bridge-server.ts](../src/bridge/bridge-server.ts#L81-L103)

### 5.9 Daemon (src/daemon/*)

`DaemonController`: external control surface (called by the CLI)

- `getStatus()`: matching PID/status and a live process → running; conflicting or incomplete live metadata → read-only indeterminate; dead PID metadata is cleaned up: [daemon-controller.ts](../src/daemon/daemon-controller.ts)
- `start()`: spawn detached → write pid → wait for status ready (pid matches): [daemon-controller.ts](../src/daemon/daemon-controller.ts)
- `stop()`: reconcile daemon identity → revalidate recovered POSIX process identity → terminate → wait for exit → clean up pid/status; status-only POSIX recovery additionally requires consumer-lock and OS start-time proof: [daemon-controller.ts](../src/daemon/daemon-controller.ts)
- Every runtime entry holds a channel-independent, OS-held core consumer lock (plus any legacy channel lock); the stable core JSON file is diagnostic metadata rather than the mutex. Internal Windows `cli.js run` publishes its generation/orphan context only after that ownership: [runtime-consumer-lock.ts](../src/daemon/runtime-consumer-lock.ts), [windows-daemon-runtime.ts](../src/daemon/windows-daemon-runtime.ts), [run-console.ts](../src/run-console.ts)

### 5.10 Orchestration (src/orchestration/*)

`OrchestrationService` maintains state such as tasks/groups/questions/packages, and is responsible for:

- Delegating to workers (ensure session + dispatch prompt)
- Receiving worker results/progress and persisting them
- Generating a "human question package" when human confirmation is required
- Triggering a coordinator wake (injecting pending state into the coordinator session)

The dependency-injection interface is in `OrchestrationServiceDeps`: [orchestration-service.ts](../src/orchestration/orchestration-service.ts#L197-L217)

### 5.11 MCP (src/mcp/*)

`runXacpxMcpServer()` starts the MCP stdio server and provides the tool list:

- Task Orchestration tools model delegated work with eventual results.
- `agent_list` and `agent_send` model one-way peer updates and return only target-runtime delivery acceptance.
- The MCP registry closure injects `coordinatorSession` and `sourceHandle`; tool input cannot provide `from` or broaden its discovery scope.

- server initialization and tool registry cache: [xacpx-mcp-server.ts](../src/mcp/xacpx-mcp-server.ts)
- identity resolution (coordinatorSession/sourceHandle or resolveIdentity): [xacpx-mcp-server.ts](../src/mcp/xacpx-mcp-server.ts)
- connect the stdio transport: [xacpx-mcp-server.ts](../src/mcp/xacpx-mcp-server.ts)

### 5.12 Logging (src/logging/*)

`AppLogger` is the core observability surface at runtime, focused on "structured events + local rolling file":

- Create: `createAppLogger({ filePath, level, maxSizeBytes, maxFiles, retentionDays })`: [app-logger.ts](../src/logging/app-logger.ts#L43-L91)
- Rotation policy: when exceeding `maxSizeBytes`, rotate as `.1/.2/...`, and clean up beyond `maxFiles`: [app-logger.ts](../src/logging/app-logger.ts#L93-L134)
- Retention policy: clean up historical rotated files per `retentionDays`: [app-logger.ts](../src/logging/app-logger.ts#L136-L166)

---

## 6. Key Protocols and Boundaries (Bridge / Orchestration IPC / Channel)

### 6.1 Channel Runtime Boundary

- `MessageChannelRuntime` only exposes "login/start/send/notify" capabilities, not router/transport details: [channels/types.ts](../src/channels/types.ts#L62-L78)

### 6.2 Bridge JSONL Protocol Boundary

- The Bridge is a strict "one JSON message per line" protocol layer; the main process can receive `session.progress` and `prompt.segment` as events.
- `prompt.text` allows an empty string, but only when media is present: [bridge-server.ts](../src/bridge/bridge-server.ts#L285-L295)

### 6.3 Orchestration IPC

- In daemon mode, an `OrchestrationServer` is started and exposed externally (including to the CLI mcp-stdio) through a socket endpoint.
- The endpoint's default path comes from `resolveRuntimePaths().orchestrationSocketPath`: [main.ts](../src/main.ts#L665-L667)

---

## 7. Config, State, and Runtime Files

### 7.1 Default Paths

Determined by `resolveRuntimePaths()`: [main.ts](../src/main.ts#L653-L668)

- config: `~/.xacpx/config.json` (can be overridden with `WEACPX_CONFIG`)
- state: `~/.xacpx/state.json` (can be overridden with `WEACPX_STATE`)
- runtime dir: `dirname(configPath)/runtime`
  - app log: `${runtimeDir}/app.log`: [main.ts](../src/main.ts#L678-L682)
  - daemon pid/status/stdout/stderr, etc. are governed by `src/daemon/daemon-files.ts` (recommended to inspect with `xacpx status`)

### 7.2 Responsibility Boundary Between config and state

- config: user-explicit configuration (transport, channels, agents, workspaces, logging, orchestration parameters…)
- state: runtime state (sessions, chat_contexts, orchestration state-machine data…)

For detailed fields, please refer to:

- Configuration reference: [docs/config-reference.md](./config-reference.md)
- `/config` command allowlist: [docs/config-command.md](./config-command.md)

---

## 8. Build, Test, and Local Debugging

### 8.1 Dependencies and Build Artifacts

- `bun run build`: builds to `dist/`, outputting `dist/cli.js` and `dist/bridge/bridge-main.js` (`node-pty` is marked external): [package.json](../package.json#L13-L24)

### 8.2 Testing

- `npm test` / `npm run test:unit`: unit tests (`tests/unit/**/*.test.ts`)
- `npm run test:smoke`: smoke tests (depend on a real environment)
- The runner script lives at: [scripts/run-tests.mjs](../scripts/run-tests.mjs)

Test layering notes: [docs/testing.md](./testing.md)

### 8.3 Local Debugging (running from source)

- `bun install`
- `bun run login`
- `bun run dev` (equivalent to `bun run ./src/cli.ts run`): [package.json](../package.json#L14-L16)

### 8.4 Runtime Observability

- Logs are written by default to `~/.xacpx/runtime/app.log` (rolling/retention controlled by config.logging)
- For daemon status, it is recommended to use `xacpx status` (which prints PID, started/heartbeat, and the config/state/log paths): [cli.ts](../src/cli.ts#L327-L350)
