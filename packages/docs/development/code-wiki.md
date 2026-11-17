# Code Wiki

An architecture reference for code readers and maintainers. This page covers system boundaries, startup chains, module responsibilities, key types and functions, and dependency direction. For user-facing documentation, see the [Guide](/guide/getting-started) and [Reference](/reference/commands) sections.

## Mental model

xacpx is a "message channel ↔ command router ↔ acpx session driver" bridge:

- **Inbound:** Messages arrive from WeChat, Feishu, CLI, etc. Each conversation is identified by a `chatKey`.
- **Router:** Parses slash commands (`/ss`, `/use`, `/cancel`, …) and plain text. Commands dispatch to handlers; plain text becomes a prompt to the current session.
- **Sessions:** Maintains a mapping from logical sessions (alias / agent / workspace / context / reply mode) to transport sessions (acpx named sessions).
- **Transport:** Abstracts `ensureSession / prompt / cancel / setMode` uniformly. Two concrete implementations:
  - `acpx-cli` — spawns `acpx` directly (with optional `node-pty` PTY allocation).
  - `acpx-bridge` — isolated bridge subprocess + JSONL protocol; stronger concurrency and event handling.
- **Orchestration** (optional): Under a coordinator session, manages task delegation to multiple worker sessions — progress reporting, human confirmation, group fan-out/fan-in.
- **Daemon:** Background process lifecycle (start / status / stop). Maintains PID, status, log metadata and hosts the orchestration IPC server.
- **MCP** (optional): Exposes orchestration capabilities as an MCP stdio server to external hosts (Codex, Claude Code, etc.).

## Entry points

| Entry point | File | Function |
| --- | --- | --- |
| CLI surface | [`src/cli.ts`](https://github.com/gadzan/xacpx/blob/main/src/cli.ts) | `runCli()` — dispatches all `xacpx <command>` subcommands |
| App assembly / DI | [`src/main.ts`](https://github.com/gadzan/xacpx/blob/main/src/main.ts) | `buildApp()` — wires config, state, logger, sessions, transport, orchestration, router, agent |
| Startup / shutdown sequencing | [`src/run-console.ts`](https://github.com/gadzan/xacpx/blob/main/src/run-console.ts) | `runConsole()` — daemon runtime, consumer lock, channel start, finally cleanup |
| Command routing | [`src/commands/command-router.ts`](https://github.com/gadzan/xacpx/blob/main/src/commands/command-router.ts) | `CommandRouter` |
| Session state | [`src/sessions/session-service.ts`](https://github.com/gadzan/xacpx/blob/main/src/sessions/session-service.ts) | `SessionService` |
| Transport boundary | [`src/transport/types.ts`](https://github.com/gadzan/xacpx/blob/main/src/transport/types.ts) | `SessionTransport` interface |

### App assembly and startup lifecycle

`buildApp()` is the dependency injection center — it assembles config, state, logger, sessions, transport, orchestration, router, and agent into an `AppRuntime`: [`src/main.ts`](https://github.com/gadzan/xacpx/blob/main/src/main.ts)

`runConsole()` owns the startup sequence, signal-driven shutdown, and cleanup consistency: [`src/run-console.ts`](https://github.com/gadzan/xacpx/blob/main/src/run-console.ts)

1. `buildApp(paths)` assembles the runtime.
2. In daemon mode: write daemon runtime metadata, start the orchestration IPC server, start the heartbeat.
3. Acquire the consumer lock (prevents multiple processes consuming the same WeChat account simultaneously).
4. `channels.startAll(...)` — parallel channel startup.
5. `finally`: stop IPC / dispose / stopAll / release lock.

## Command routing

### Data flow (WeChat to acpx)

1. Channel receives a message (`chatKey` + text + optional media).
2. `ConsoleAgent.chat()` calls `router.handle(chatKey, input, reply, replyContextToken, accountId, media)`.
3. `CommandRouter.handle()`:
   - `/`-prefixed input: `parseCommand()` dispatches to the appropriate handler.
   - Plain text: treated as a prompt, resolved to the current session, forwarded to `transport.prompt()`.
4. Transport executes:
   - `acpx-cli`: spawns `acpx ... prompt` and aggregates output.
   - `acpx-bridge`: sends a JSONL request to the bridge; the bridge handles scheduling and writes back events.
5. Reply flows back to the channel (stream / verbose / final, depending on the configured reply mode).

### Key components

- **`parseCommand()`** — slash command parser with alias resolution (`/ss` → `/session`, `/ws` → `/workspace`, `/stop` → `/cancel`): [`src/commands/parse-command.ts`](https://github.com/gadzan/xacpx/blob/main/src/commands/parse-command.ts)
- **`CommandRouter`** — thin router + context assembler; also handles transport call observation, auto-repair, and diagnostic summaries: [`src/commands/command-router.ts`](https://github.com/gadzan/xacpx/blob/main/src/commands/command-router.ts)
- **Handlers** — split by responsibility boundary: session lifecycle, shortcut creation, recovery, reset, config commands: [`src/commands/handlers/`](https://github.com/gadzan/xacpx/blob/main/src/commands/handlers)
- **`router-types.ts`** — explicit `RouterResponse`, `CommandRouterContext`, and session ops interfaces: [`src/commands/router-types.ts`](https://github.com/gadzan/xacpx/blob/main/src/commands/router-types.ts)

See [Commands Module](/development/commands-module) for the full module description.

## Session model

### Two session concepts

**Logical session** (xacpx-managed) — `alias / agent / workspace` plus persisted state (`replyMode`, `modeId`, context, etc.). Managed by `SessionService` and written to `state.json`:

- `createSession()` / `attachSession()`: [`src/sessions/session-service.ts`](https://github.com/gadzan/xacpx/blob/main/src/sessions/session-service.ts)
- `useSession()` / `getCurrentSession()` / `listSessions()`: same file.

**Transport session** (acpx-managed) — the `transportSession` string used as the underlying acpx named session name. `ResolvedSession` is the complete routing context passed to transport (includes `cwd`, `agentCommand`, `transportSession`, …): [`src/transport/types.ts`](https://github.com/gadzan/xacpx/blob/main/src/transport/types.ts)

### Core data concepts

- **`chatKey`** — stable conversation identifier, globally unique across channels. Format: `<channelId>:<channel-internal-id>`. The channel registry uses it to route outbound messages: [`src/channels/channel-registry.ts`](https://github.com/gadzan/xacpx/blob/main/src/channels/channel-registry.ts)
- **`replyMode`** — xacpx reply strategy (`stream` / `final` / `verbose`), stored on the logical session.
- **`modeId`** — underlying agent mode (e.g. `codex plan`), stored on the logical session.
- **Orchestration objects** — `coordinatorSession`, `workerSession`, `task`, `group`. Assembly point in `buildApp()`: [`src/main.ts`](https://github.com/gadzan/xacpx/blob/main/src/main.ts)

## Transport layer

### Unified interface

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

Two implementations:

- **`acpx-cli`** ([`src/transport/acpx-cli/`](https://github.com/gadzan/xacpx/blob/main/src/transport/acpx-cli)) — spawns `acpx` as a child process; optionally allocates a PTY via `node-pty`.
- **`acpx-bridge`** ([`src/transport/acpx-bridge/`](https://github.com/gadzan/xacpx/blob/main/src/transport/acpx-bridge)) — talks to a separate bridge subprocess over a JSONL protocol. Better for concurrency and event isolation. See the [Bridge subsystem](#bridge-subsystem) section for the subprocess and protocol details.

### acpx resolution order

1. `transport.command` in config (explicit override).
2. Bundled `acpx` from the main package's `node_modules`.
3. `acpx` in shell `PATH`.

## Channels

The core ships only the built-in `weixin` channel plus the generic channel/plugin infrastructure. Feishu, Yuanbao, and all other non-WeChat channels are plugin-backed and live in `packages/channel-*` or external npm packages — not in `src/channels/`.

### Channel interfaces

- `MessageChannelRuntime` — login / start / send / task notification: [`src/channels/types.ts`](https://github.com/gadzan/xacpx/blob/main/src/channels/types.ts)
- `MessageChannelRegistry` — aggregator that starts all channels in parallel (partial failure allowed; total failure throws) and routes outbound by `chatKey`: [`src/channels/channel-registry.ts`](https://github.com/gadzan/xacpx/blob/main/src/channels/channel-registry.ts)

### ConsoleAgent

`ConsoleAgent` is the channel-to-router adapter: it normalizes media, rejects empty messages, logs, and calls `router.handle(...)`. Channels depend only on `WechatAgent` behavior, not on `CommandRouter` internals: [`src/console-agent.ts`](https://github.com/gadzan/xacpx/blob/main/src/console-agent.ts)

### Built-in WeChat

`src/weixin/` is the built-in WeChat provider (login, polling, media pipeline, quota management), hosted by `WeixinChannel` in [`src/channels/weixin-channel.ts`](https://github.com/gadzan/xacpx/blob/main/src/channels/weixin-channel.ts).

- Interactive login (QR code, `qrcode-terminal` with URL fallback): [`src/weixin/bot.ts`](https://github.com/gadzan/xacpx/blob/main/src/weixin/bot.ts)
- Outbound quota (`QuotaManager` — per-chatKey sliding-window budget, mid-segment vs. final distinction, final pagination, pendingFinal queue): [`src/weixin/messaging/quota-manager.ts`](https://github.com/gadzan/xacpx/blob/main/src/weixin/messaging/quota-manager.ts)

### Channel capability: native session list format

`/ssn` native session list rendering format is declared per channel via `MessageChannelRuntime.nativeSessionListFormat` (`"cards" | "table"`, default `"table"`; `weixin` declares `"cards"`). The registry exposes `nativeSessionListFormat(chatKey)`, injected by `CommandRouter` into `CommandRouterContext.resolveNativeSessionListFormat` and read by the native-session handler. New channels declare this capability on the runtime — no handler changes needed.

## Daemon subsystem

See [Daemon Module](/development/daemon-module) for the full description.

`DaemonController` — external control surface (CLI calls):
- `getStatus()` — matching PID/status and a live process → `running`; conflicting or incomplete live metadata → read-only `indeterminate`; dead PID metadata is cleaned up (`stopped` with `stale: true`).
- `start()` — spawn detached → write PID → poll `status.json` for readiness (PID match).
- `stop()` — terminate → wait for exit → clean PID and status.

Source: [`src/daemon/daemon-controller.ts`](https://github.com/gadzan/xacpx/blob/main/src/daemon/daemon-controller.ts)

The daemon combines three signals to determine liveness: the PID file, whether that PID's process actually exists, and whether `status.json` has been written. All runtime file paths are centralized in [`src/daemon/daemon-files.ts`](https://github.com/gadzan/xacpx/blob/main/src/daemon/daemon-files.ts).

## Bridge subsystem

The bridge isolates `acpx` driving into a separate subprocess, giving the main process a more controllable concurrency and event channel. It backs the `acpx-bridge` transport implementation.

### Entry and runtime

- [`src/bridge/bridge-main.ts`](https://github.com/gadzan/xacpx/blob/main/src/bridge/bridge-main.ts) — entry point for the bridge subprocess (handles `acpx` stdio).
- [`src/bridge/bridge-server.ts`](https://github.com/gadzan/xacpx/blob/main/src/bridge/bridge-server.ts) — parses bridge protocol JSON lines and delegates to the runtime.
- [`src/bridge/bridge-runtime.ts`](https://github.com/gadzan/xacpx/blob/main/src/bridge/bridge-runtime.ts) — wraps raw `acpx` commands (`sessions new`, `prompt`, `cancel`).

### JSONL protocol

- Methods: `ensureSession / hasSession / prompt / setMode / cancel / removeSession / ...`: [`src/transport/acpx-bridge/acpx-bridge-protocol.ts`](https://github.com/gadzan/xacpx/blob/main/src/transport/acpx-bridge/acpx-bridge-protocol.ts)
- Message kinds: `request` / `response` plus `event` (`prompt.segment`, `session.progress`, `session.note`).
- Strict one-JSON-line-per-message protocol: the main process can receive `session.progress` and `prompt.segment` as events. `prompt.text` may be an empty string only when media is present.

### Server scheduling

`BridgeServer.handleLine()` takes one JSON line in and writes one JSON line out; errors are uniformly wrapped as a `BridgeErrorResponse`. Session-scoped requests (`SESSION_SCOPED_METHODS`) form a `scheduleKey` from `[agentIdentity, cwd, name]` and serialize per key. `cancel` runs on a higher-priority `control` lane so it preempts an in-flight prompt. Source: [`src/bridge/bridge-server.ts`](https://github.com/gadzan/xacpx/blob/main/src/bridge/bridge-server.ts)

## Configuration and state

### Default paths (from `resolveRuntimePaths()`)

| Path | Content | Written by |
| --- | --- | --- |
| `~/.xacpx/config.json` | agents, workspaces, channels, plugins, transport — static config | `ConfigStore`, CLI |
| `~/.xacpx/state.json` | sessions, chat contexts, orchestration state | `DebouncedStateStore` (50 ms merge) → `StateStore` |
| `~/.xacpx/runtime/daemon.pid` | Current daemon PID | `DaemonRuntime` |
| `~/.xacpx/runtime/status.json` | daemon heartbeat / start_at / log paths | `DaemonRuntime` |
| `~/.xacpx/runtime/app.log` | Bounded application log (rolling) | `AppLogger` |
| `~/.xacpx/runtime/orchestration.sock` | Unix socket (or `\\.\pipe\xacpx-orchestration-<hash>` on Windows) | `OrchestrationServer` |
| `~/.xacpx/plugins/` | Plugin npm home (isolated `package.json` + `node_modules`) | `xacpx plugin add/update` |

`XACPX_CONFIG` and `XACPX_STATE` environment variables override the config and state paths respectively; the legacy `WEACPX_CONFIG` / `WEACPX_STATE` names are honored as a fallback.

### Responsibility boundary

- **config** — user-explicit settings (transport, channels, agents, workspaces, logging, orchestration parameters, …).
- **state** — runtime state (sessions, chat contexts, orchestration state machine data, …).

See the [Configuration reference](/reference/configuration) and [/config Command](/reference/config-command) for full field documentation.

### Logging

`AppLogger` — structured events with local rolling file:
- Created by `createAppLogger({ filePath, level, maxSizeBytes, maxFiles, retentionDays })`.
- Rotates at `maxSizeBytes` using `.1/.2/...` suffixes; cleans files beyond `maxFiles`.
- Retains by `retentionDays`.

Source: [`src/logging/app-logger.ts`](https://github.com/gadzan/xacpx/blob/main/src/logging/app-logger.ts)

### State persistence

`DebouncedStateStore` → `StateStore` → `writePrivateFileAtomic` (`proper-lockfile` for cross-process mutual exclusion + `write-file-atomic` for atomic rename + Windows EBUSY fallback): [`src/state/`](https://github.com/gadzan/xacpx/blob/main/src/state)

### MCP stdio server

`xacpx mcp-stdio` starts an MCP stdio server and exposes orchestration tools:
- Identity parsing (`coordinatorSession` / `sourceHandle` / `workspace`) and external coordinator registration: [`src/cli.ts`](https://github.com/gadzan/xacpx/blob/main/src/cli.ts)
- MCP server run loop: [`src/mcp/xacpx-mcp-server.ts`](https://github.com/gadzan/xacpx/blob/main/src/mcp/xacpx-mcp-server.ts)

This mode requires the daemon to be running (the orchestration IPC endpoint must be available). The live MCP server name exposed to external hosts is `xacpx` (tool prefix `mcp__xacpx__*`).
