# xacpx Channel Plugin Development Reference

> Developer-facing plugin API reference. Every available type, method, field, and error code is listed here.
> For the user guide, see [docs/channel-management.md](./channel-management.md).

`xacpx` exposes message channels as npm plugins. A channel plugin is an npm package whose default export is a `XacpxPlugin` (the old name `WeacpxPlugin` still works), declaring one or more `ChannelPluginDefinition`s. On startup the daemon reads `plugins[]` from `~/.xacpx/config.json`, dynamically imports the plugin package from `~/.xacpx/plugins/node_modules/<plugin-name>`, and registers its channel factories and CLI providers.

> **Renaming note (0.8.0):** The project has been renamed from `weacpx` to `xacpx`. Import from `xacpx/plugin-api`, use `xacpx` as the peer dependency, and prefer the new names `XacpxPlugin` / `minXacpxVersion` / `compatibleXacpxVersions`. For backward compatibility, the old names `WeacpxPlugin` / `minWeacpxVersion` / `compatibleWeacpxVersions` are still read by the core (the new name wins when both are declared), and already-published old plugins continue to work unchanged. The examples below still use the old names to minimize churn; replace them with the new names as equivalent.

---

## Table of Contents

- [Who should read this document](#who-should-read-this-document)
- [Quick start: minimal runnable plugin](#quick-start-minimal-runnable-plugin)
- [Project structure](#project-structure)
- [1. Plugin entry: `WeacpxPlugin`](#1-plugin-entry-weacpxplugin)
- [2. Channel registration: `ChannelPluginDefinition`](#2-channel-registration-channelplugindefinition)
- [3. Channel factory: `ChannelFactory`](#3-channel-factory-channelfactory)
- [4. Channel runtime: `MessageChannelRuntime`](#4-channel-runtime-messagechannelruntime)
- [5. Start context: `ChannelStartInput`](#5-start-context-channelstartinput)
- [6. Outbound quota: `OutboundQuota`](#6-outbound-quota-outboundquota)
- [7. Application logging: `AppLogger`](#7-application-logging-applogger)
- [8. Orchestration callbacks: `OrchestrationDeliveryCallbacks`](#8-orchestration-callbacks-orchestrationdeliverycallbacks)
- [9. Consumer lock: `ConsumerLock`](#9-consumer-lock-consumerlock)
- [10. CLI provider: `ChannelCliProvider`](#10-cli-provider-channelcliprovider)
- [11. CLI provider helper types](#11-cli-provider-helper-types)
- [12. Config shape: `ChannelRuntimeConfig`](#12-config-shape-channelruntimeconfig)
- [13. ChatKey and channelId conventions](#13-chatkey-and-channelid-conventions)
- [14. Validation rules](#14-validation-rules)
- [15. plugin doctor diagnostics](#15-plugin-doctor-diagnostics)
- [16. End-to-end lifecycle](#16-end-to-end-lifecycle)
- [17. Publishing contract](#17-publishing-contract)
- [18. Testing recommendations](#18-testing-recommendations)
- [19. Reference implementations](#19-reference-implementations)

---

## Who should read this document

- Developers who want to add a new channel to xacpx (Feishu, Discord, Slack, WeChat Official Account, ...)
- Teams who want to connect an existing IM system to xacpx's orchestration capabilities
- People who want to fork / extend channel behavior in their own private deployment

If you are only a consumer (installing and using a channel someone else wrote), [docs/channel-management.md](./channel-management.md) is enough.

---

## Quick start: minimal runnable plugin

```ts
// src/index.ts
import type {
  ChannelStartInput,
  CoordinatorMessageInput,
  MessageChannelRuntime,
  WeacpxPlugin,
} from "xacpx/plugin-api";

class HelloChannel implements MessageChannelRuntime {
  readonly id = "hello";

  isLoggedIn(): boolean { return true; }
  async login(): Promise<string> { return "hello credentials configured"; }
  logout(): void {}

  async start(_: ChannelStartInput): Promise<void> {
    // Receiving messages: call input.agent.handle(chatKey, text)
    // Sending messages: keep a reference to input.agent, driven by your gateway callbacks
  }

  async notifyTaskCompletion(): Promise<void> {}
  async notifyTaskProgress(): Promise<void> {}
  async sendCoordinatorMessage(_: CoordinatorMessageInput): Promise<void> {}
}

const plugin: WeacpxPlugin = {
  apiVersion: 1,
  name: "xacpx-channel-hello",
  minWeacpxVersion: "0.3.3",
  channels: [
    {
      type: "hello",
      factory: (options) => new HelloChannel(),
    },
  ],
};

export default plugin;
```

Minimal package structure:

```
xacpx-channel-hello/
├── package.json
├── tsconfig.json
└── src/
    └── index.ts
```

In an environment with xacpx installed:

```bash
xacpx plugin add ./path/to/xacpx-channel-hello   # or the npm package name
xacpx plugin doctor
xacpx channel add hello
xacpx restart
```

Once this chain works end to end, start filling in business logic in `MessageChannelRuntime`.

---

## Project structure

Recommended directory and file layout:

```
my-channel/
├── package.json           # name, peerDependencies: { xacpx: ">=0.3.x" }
├── tsconfig.json          # extends the xacpx top-level tsconfig (first-party package) or a standalone config
├── README.md
├── src/
│   ├── index.ts           # default export WeacpxPlugin
│   ├── channel.ts         # implements MessageChannelRuntime
│   ├── cli-provider.ts    # implements ChannelCliProvider (optional but strongly recommended)
│   ├── config.ts          # parse / validate options
│   └── ...                # gateway, signing, message codec, etc.
└── dist/                  # published artifacts (src is not published)
    ├── index.js
    └── index.d.ts
```

Key `package.json` fields:

```jsonc
{
  "name": "@scope/xacpx-channel-my",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" }
  },
  "files": ["dist", "README.md"],
  "peerDependencies": { "xacpx": ">=0.3.3" },
  "peerDependenciesMeta": { "xacpx": { "optional": true } }
}
```

`xacpx` is declared as a peer and `optional`: install a local copy during development, and at runtime xacpx itself provides it. All imports must go through `xacpx/plugin-api`. It is **forbidden** to pull symbols from `xacpx/dist/*` or `src/*` — those are internal implementation, not part of the stable API surface.

---

## 1. Plugin entry: `WeacpxPlugin`

```ts
import type { WeacpxPlugin } from "xacpx/plugin-api";
import {
  WEACPX_PLUGIN_API_VERSION,
  WEACPX_PLUGIN_MIN_CORE_VERSION,
} from "xacpx/plugin-api";

export interface WeacpxPlugin {
  apiVersion: 1;
  name?: string;
  minWeacpxVersion?: string;
  compatibleWeacpxVersions?: string;
  channels?: ChannelPluginDefinition[];
}

const plugin: WeacpxPlugin = {
  apiVersion: WEACPX_PLUGIN_API_VERSION,        // currently fixed at 1
  minWeacpxVersion: WEACPX_PLUGIN_MIN_CORE_VERSION, // e.g. "0.3.3"
  channels: [/* ... */],
};

export default plugin;
```

| Field | Required | Description |
| --- | --- | --- |
| `apiVersion` | Yes | Currently must be the literal `1`. A future breaking change in xacpx will bump the API version. The set of versions the current xacpx accepts can be read from `WEACPX_PLUGIN_API_SUPPORTED_VERSIONS`. |
| `name` | No | Explicitly declares the plugin name. If set, it must equal the npm package name used at install time (including scope), otherwise startup validation rejects it. |
| `minWeacpxVersion` | Recommended | The **minimum xacpx core version** this plugin works with (e.g. `"0.3.3"`). When the current xacpx is below this version, plugin loading fails with a prompt to `upgrade xacpx`. First-party plugins must declare it; third-party plugins are strongly encouraged to. |
| `compatibleWeacpxVersions` | No | Explicit xacpx compatibility range; supports `x.y.z` / `>=x.y.z` / `^x.y.z`. If declared together with `minWeacpxVersion`, both must be satisfied. |
| `channels` | No | List of channel definitions. May be empty (reserved for future non-channel extension points). |

Constraints:

- Must use a **default export** (`export default plugin`). Named exports do not work.
- The module is imported only once in the daemon process; do not have side effects at the top level (timers, global listeners, etc.).

### Compatibility errors and how to handle them

Compatibility errors that may occur during loading/validation and how to fix them:

| Error keyword | Meaning | What the user should do |
| --- | --- | --- |
| `requires xacpx >=X.Y.Z; ... upgrade xacpx` | The plugin is newer than the current xacpx | Upgrade `xacpx` to ≥ that version, or install an older plugin version compatible with the current xacpx |
| `apiVersion N; supported: ...; install a compatible plugin` | The plugin uses an API version that xacpx does not recognize | Upgrade or downgrade the **plugin** to a version compatible with the local `xacpx` |
| `invalid plugin metadata` | The `minWeacpxVersion` / `compatibleWeacpxVersions` field is malformed | Contact the plugin author or check the published metadata |

`xacpx plugin doctor` also prints these errors as `ERROR <plugin>: ...`, which can be placed in CI or a release pipeline as a pre-flight check.

---

## 2. Channel registration: `ChannelPluginDefinition`

```ts
export interface ChannelPluginDefinition {
  type: string;
  factory: ChannelFactory;
  cliProvider?: ChannelCliProvider;
}
```

| Field | Required | Description |
| --- | --- | --- |
| `type` | Yes | Channel type string, e.g. `"feishu"`, `"yuanbao"`. Globally unique within a process. |
| `factory` | Yes | Factory function, called at daemon startup to instantiate the `MessageChannelRuntime`. |
| `cliProvider` | No | Parsing and prompting logic for `xacpx channel add <type>`. Without it, the user must hand-edit `~/.xacpx/config.json`. Strongly recommended to provide. |

`type` constraints:

- Non-empty, and must not contain `:` (chatKey uses `:` as a separator).
- Must not duplicate an already-registered type (`weixin` is always reserved by the built-in channel).
- Must not be inconsistent with `cliProvider.type` (if a cliProvider is declared).

---

## 3. Channel factory: `ChannelFactory`

```ts
export type ChannelFactory = (
  options: Record<string, unknown> | undefined,
  deps?: CreateChannelDeps,
) => MessageChannelRuntime;

export interface CreateChannelDeps {
  mediaStore?: RuntimeMediaStore;
  allowedMediaRoots?: string[];
}
```

Parameters:

| Parameter | Meaning |
| --- | --- |
| `options` | `channels[].options`, written by user config or `cliProvider.buildDefaultConfig`. **Not type-validated** — the factory must parse it itself. |
| `deps.mediaStore` | Temporary media-persistence tool provided by xacpx. Used when handling image/file attachments. |
| `deps.allowedMediaRoots` | The set of cwds of registered workspaces. Determines which directories are allowed to use local files emitted by the agent as outbound attachments. |

The factory should **only do argument parsing and state initialization** at this step: do not open network connections or read external tokens. Leave all side effects to `start()`. This lets doctor / dry-run import the plugin safely.

Example:

```ts
factory: (options) => new MyChannel(options)

class MyChannel implements MessageChannelRuntime {
  private readonly config: MyConfig;
  constructor(options: Record<string, unknown> | undefined) {
    this.config = parseMyConfig(options); // throw on invalid config
  }
  // ...
}
```

---

## 4. Channel runtime: `MessageChannelRuntime`

```ts
export interface MessageChannelRuntime {
  id: string;

  isLoggedIn(): boolean;
  login(): Promise<string>;
  logout(): void;

  start(input: ChannelStartInput): Promise<void>;

  stop?(): void | Promise<void>;

  createConsumerLock?(options?: ConsumerLockOptions): ConsumerLock;
  configureOrchestration?(callbacks: OrchestrationDeliveryCallbacks): void;

  notifyTaskCompletion(task: OrchestrationTaskRecord): Promise<void>;
  notifyTaskProgress(task: OrchestrationTaskRecord, text: string): Promise<void>;
  sendCoordinatorMessage(input: CoordinatorMessageInput): Promise<void>;
}
```

### `id: string`

The unique id of the channel instance. xacpx currently requires `id === type`, so it is generally written as `readonly id = "<type>"`. It is used in logs to mark context.

### `isLoggedIn(): boolean`

Synchronous, pure function. Returns whether usable credentials are currently held. The daemon calls it once before startup to decide whether `login()` is needed.

### `login(): Promise<string>`

Non-interactive channels (OAuth, appKey/appSecret) usually return a hint message:

```ts
async login(): Promise<string> {
  if (this.isLoggedIn()) return "credentials configured";
  throw new Error("Provide options.appKey and options.appSecret in channels[].options");
}
```

Only interactive channels (WeChat QR-code login) need to run the QR code flow here and block until login succeeds. If your channel **never needs interactive login**, set `cliProvider.supportsLogin` to `false`.

### `logout(): void`

**Destructive**: remove stored credentials, disconnect persistent connections, and clear in-memory sessions. It is reached only when the user explicitly runs `xacpx logout` — never as part of a normal daemon shutdown. **Must be reentrant.**

One legacy exception: for channels that do **not** implement `stop()`, the daemon shutdown path falls back to `logout()`. If you rely on that fallback, `logout()` must not delete anything the user would have to re-acquire interactively (re-login, re-scan QR). New plugins should implement `stop()` and keep credential removal exclusively in `logout()`.

### `start(input: ChannelStartInput): Promise<void>`

The entry point where the channel starts receiving messages. See [§5](#5-start-context-channelstartinput) for details.

Requirements:

- Push messages to `input.agent.handle(chatKey, text)`.
- Listen on `input.abortSignal`, and on abort cleanly stop the gateway, close long-lived connections, and clear queues.
- Before any send operation, reserve quota with `input.quota` (see [§6](#6-outbound-quota-outboundquota)).
- Record key events for any outbound send via `input.logger`, so the user can troubleshoot with `xacpx doctor --verbose` / `app.log`.

`start()` is usually a long-running promise — returning means you have wired up the callbacks, but the message loop can be asynchronous in the background.

### `stop?(): void | Promise<void>`

Optional, **preferred**. Non-destructive shutdown hook: on every daemon shutdown (SIGTERM / Ctrl-C and startup-error cleanup) the registry calls `stop()` when it exists and falls back to `logout()` only when it does not. Release runtime resources here — stop clients, drop `agent` / `quota` / `logger` references, clear queues — but **never touch stored credentials**: a daemon stop or restart must not force the user to log in again. Note that `abortSignal` has usually already fired by the time `stop()` runs, so it is often a small cleanup (or even a no-op).

### `createConsumerLock?(options?): ConsumerLock`

Optional. Implement this method if your channel needs **machine-wide mutual exclusion** (the same WeChat account cannot be connected by two xacpx processes at once). See [§9](#9-consumer-lock-consumerlock).

### `configureOrchestration?(callbacks)`

Optional. The daemon calls this when wiring up the orchestration service, giving you two callbacks: `markTaskNoticeDelivered` and `markTaskNoticeFailed`. If your channel supports task-completion notifications (`notifyTaskCompletion`), save these two callbacks and call them on successful / failed delivery to update orchestration state. See [§8](#8-orchestration-callbacks-orchestrationdeliverycallbacks).

### `notifyTaskCompletion(task): Promise<void>`

Called by the orchestration service to notify the user that a worker task has completed. `task.chatKey` is the routing target. On successful delivery, call `markTaskNoticeDelivered(task.taskId, accountId)`; on failure, call `markTaskNoticeFailed(task.taskId, errorText)`.

Implementation notes:

- If `task.chatKey` does not belong to your channel (judge by prefix), **return immediately** without raising an error. The daemon broadcasts to all channels.
- For content generation you can borrow xacpx's `renderTaskCompletion` (if exposed) or assemble it yourself.
- Mind the quota: `notifyTaskCompletion` counts as a final outbound, so it is recommended to call `quota.reserveFinal(chatKey)` first.

### `notifyTaskProgress(task, text): Promise<void>`

Task heartbeat notification (every 60s by default). Same semantics as above, but controlled by `progressHeartbeatSeconds`, and usually does not reserve final quota. If your channel does not support intermediate heartbeats, just write an empty implementation.

### `sendCoordinatorMessage(input: CoordinatorMessageInput): Promise<void>`

```ts
export interface CoordinatorMessageInput {
  coordinatorSession: string;
  chatKey: string;
  accountId?: string;
  replyContextToken?: string;
  text: string;
}
```

Called when the orchestration service sends text to the channel hosting the coordinator session. Semantically a simplified version of `notifyTaskCompletion`. `replyContextToken` is the reply context (Feishu/yuanbao use it to quote the parent message) and may be ignored.

---

## 5. Start context: `ChannelStartInput`

```ts
export interface ChannelStartInput {
  agent: ChatAgent;
  abortSignal: AbortSignal;
  quota: OutboundQuota;
  logger: AppLogger;
  // Optional fields the core injects when relevant:
  commandHints?: CommandHint[];   // built-in command catalog for input-box hints
  coreVersion?: string;           // xacpx core version string
  locale?: Locale;                // active runtime language ("en" | "zh") — see §5.1
}
```

| Field | Purpose |
| --- | --- |
| `agent` | The xacpx router entry point. After you receive a text message, call `agent.handle(chatKey, text)` to feed it into the command router. |
| `abortSignal` | The daemon shutdown signal. Listen for the `aborted` event and stop all long-lived connections and timers. |
| `quota` | Outbound rate/total quota; see the next section. |
| `logger` | Structured logger; see [§7](#7-application-logging-applogger). |
| `commandHints?` | Built-in command catalog, for channels that support input-box command hints. |
| `coreVersion?` | xacpx core version string, for channels that need it (e.g. command-sync metadata). |
| `locale?` | Active runtime language (`"en"` \| `"zh"`, type `Locale`), resolved from `config.language`. Use it to localize your channel's output. See [§5.1](#51-internationalization-i18n). |

The `ChatAgent` interface itself is internal, but the `MessageChannelRuntime` contract only requires you to `await agent.handle(chatKey, text)` for inbound text. It returns no data; the agent calls your send methods within its own callback chain.

> **Important**: Your channel must hold a reference to `agent` / `quota` / `logger` until `stop()` / `logout()` or `abortSignal` fires. They are not passed again after `start()` returns.

### 5.1 Internationalization (i18n)

xacpx's interface language is controlled by `config.language` (`en` | `zh`), defaulting to the system locale. A channel plugin can make its own user-facing text follow the same language.

**Read the language from `ChannelStartInput.locale`** inside `start(input)` (type `Locale`, exported from `xacpx/plugin-api`). This is the **recommended** source — the core passes it by value, so it is independent of module instances.

`xacpx/plugin-api` also exports `getLocale()`, but **don't rely on it as the primary source**: a plugin package and the daemon are typically bundled with separate copies of the i18n state, so `getLocale()` reads the *plugin's* copy, which may not reflect the daemon's `config.language`. Use it only as a fallback.

**Recommended pattern** — keep a small per-package catalog (do **not** import the core's internal `src/i18n`):

```ts
// my-channel/src/i18n.ts
import { getLocale, type Locale } from "xacpx/plugin-api";

const en = { greeting: "Hi", failed: (id: string) => `Task ${id} failed` };
const zh: typeof en = { greeting: "你好", failed: (id) => `任务 ${id} 执行失败` };

let active: Locale | null = null;
export function setChannelLocale(locale: Locale): void { active = locale; }
export function t() { return (active ?? getLocale()) === "zh" ? zh : en; }
```

```ts
// my-channel/src/channel.ts
async start(input: ChannelStartInput): Promise<void> {
  setChannelLocale(input.locale ?? "en");   // pin the language before emitting any text
  // ... then use t().greeting / t().failed(id) for user-facing output
}
```

> Call `t()` inside function bodies (never capture a catalog value at module load), so language switching takes effect.

**Do not localize strings you match against.** Tokens you compare against user input or external tool output — e.g. Chinese abort words like `停止` / `取消`, or markers matched against acpx output — must be locale-independent constants, **not** gated on `locale`: a Chinese user types `停止` regardless of the UI language.

---

### 5.2 Subagent notices for text channels (`formatSubagentNotice` / `SubagentNoticeTracker`)

When a turn drives a subagent (an `Agent` / `Task` delegation), the transport marks the corresponding tool events with `isSubagent: true` (and, when the provider supplies it, `parentToolCallId`). Rich channels like the Feishu card or the web dashboard fold these into a nested trace. A text-only channel (WeChat, Yuanbao) can't render that, so `xacpx/plugin-api` exports two helpers that degrade the trace to one honest line per delegation:

```ts
import { SubagentNoticeTracker, formatSubagentNotice, type ToolUseEvent } from "xacpx/plugin-api";

// Create ONE tracker per turn (not per event), then feed it every tool event.
const notices = new SubagentNoticeTracker();

const request = {
  // ...
  onToolEvent: (event: ToolUseEvent) => {
    const line = notices.notice(event); // → "↳ [subagent] <task> (running)" or null
    if (line) void sendLine(line);       // your channel's foreground-gated send
  },
};
```

- `SubagentNoticeTracker.notice(event)` returns a line **only** for `isSubagent` events, and **at most once per `toolCallId`** — the first sighting emits, every later frame (including the terminal one) is swallowed, so a `running → success` pair never doubles up. Ordinary tool calls always return `null` to avoid flooding a linear chat.
- `formatSubagentNotice(event)` is the stateless formatter behind it (prefers `event.summary`, falls back to `toolName`, truncates long titles). Use it directly only if you need custom dedup.
- The helpers never invent child activity they can't prove — they surface the delegation itself, nothing more.

---

## 6. Outbound quota: `OutboundQuota`

```ts
export interface OutboundQuota {
  onInbound(chatKey: string): void;
  reserveMidSegment(chatKey: string): boolean;
  reserveFinal(chatKey: string): boolean;
  finalRemaining(chatKey: string): number;
  hasPendingFinal(chatKey: string): boolean;
  drainPendingFinalUpToBudget(chatKey: string, available: number): PendingFinalChunk[];
  prependPendingFinal(chatKey: string, chunks: PendingFinalChunk[]): void;
  enqueuePendingFinal(chatKey: string, chunks: PendingFinalChunk[]): void;
  clearPendingFinal(chatKey: string): void;
}
```

Origin: an abstraction of the WeChat Official Account 24-hour active-message limit. Other channels (Feishu, yuanbao) have unlimited quota, but xacpx uses the same facade for all channels to make orchestration scheduling easier.

The two most commonly used:

- **`onInbound(chatKey)`**: called when a user sends a message in. Resets the 24h window for that chatKey.
- **`reserveFinal(chatKey)`**: called before sending a "final reply"; returns `true` to send. Returning `false` means the quota is exhausted, so you should enqueue and wait for the next inbound to trigger sending.

Non-WeChat channels can usually just:

```ts
async sendFinalText(chatKey: string, text: string) {
  if (!this.quota?.reserveFinal(chatKey)) {
    this.quota?.enqueuePendingFinal(chatKey, [{ text }]);
    return;
  }
  await this.gateway.sendText(chatKey, text);
}
```

See the comments in `src/weixin/messaging/quota-manager.ts` for detailed semantics.

---

## 7. Application logging: `AppLogger`

`AppLogger.info / .warn / .error` are all asynchronous, with a signature like:

```ts
await logger.info(eventCode: string, message: string, fields?: Record<string, unknown>): Promise<void>
```

Conventions:

- Use a `<channel>.<area>.<verb>` style for `eventCode`, e.g. `"feishu.inbound.message"`, `"yuanbao.gateway.connected"`. This makes aggregate queries easier.
- Do not stuff secrets/PII into `fields`. `appSecret` and user tokens must be explicitly filtered out.
- The daemon already stamps the timestamp and pid for you; do not duplicate them.

Logs ultimately land in `~/.xacpx/runtime/app.log` and are captured by `xacpx doctor --verbose`.

---

## 8. Orchestration callbacks: `OrchestrationDeliveryCallbacks`

```ts
export interface OrchestrationDeliveryCallbacks {
  markTaskNoticeDelivered: (taskId: string, accountId: string) => Promise<void>;
  markTaskNoticeFailed: (taskId: string, errorMessage: string) => Promise<void>;
}
```

During the buildApp phase, the daemon calls `configureOrchestration(callbacks)` to hand you these two functions. Their meaning:

- After you successfully deliver a "task-completion notification" to the IM platform, call `markTaskNoticeDelivered(taskId, accountId)`. The orchestration service persists the task's `noticeSentAt`, avoiding duplicate delivery after a restart.
- On delivery failure (API error, quota exceeded), call `markTaskNoticeFailed(taskId, errorMessage)`. Orchestration will replay on the next inbound / restart.

For channels that do not implement `configureOrchestration`, all task notifications are treated as "not delivered", which may lead to duplicate delivery. If your channel supports `notifyTaskCompletion`, it is **strongly recommended to also implement `configureOrchestration`**.

---

## 9. Consumer lock: `ConsumerLock`

```ts
export interface ConsumerLockMetadata {
  pid: number;
  mode: "foreground" | "daemon";
  startedAt: string;
  configPath: string;
  statePath: string;
  hostname?: string;
}

export interface ConsumerLock {
  acquire(meta: ConsumerLockMetadata): Promise<void>;
  release(): Promise<void>;
}

export interface ConsumerLockOptions {
  lockFilePath?: string;
  onDiagnostic?: (event: string, context: Record<string, string | number | boolean | undefined>) => void | Promise<void>;
}
```

When you need to implement it: your channel **connects to a long-lived session gateway with single-point credentials**, and multiple xacpx processes connecting at once would get kicked offline by the peer (typical: the WeChat web protocol).

When you do not need it: pure HTTP webhooks, or applications with independent bot ids (Feishu custom apps, yuanbao multi-bot).

Implementation notes:

- Use a file lock (`proper-lockfile` / your own fcntl) for physical mutual exclusion.
- On `acquire` failure, throw an error with metadata (refer to `ActiveWeixinConsumerLockError`), so the daemon can tell the user in the log that "another process holds the lock, pid=xxx".
- `release` must be idempotent.

Reference implementation: `src/weixin/monitor/consumer-lock.ts`.

---

## 10. CLI provider: `ChannelCliProvider`

```ts
export interface ChannelCliProvider {
  type: string;
  displayName: string;
  supportsLogin: boolean;
  parseAddArgs(args: string[]): ChannelCliParseResult;
  buildDefaultConfig(input: ChannelCliInput): ChannelRuntimeConfig;
  validateConfig(config: ChannelRuntimeConfig): ChannelCliValidationIssue[];
  renderSummary(config: ChannelRuntimeConfig): string[];
  promptForMissingFields(input: ChannelCliInput, io: ChannelCliIo): Promise<ChannelCliInput>;
}
```

All behavior of `xacpx channel add <type>` is determined by the cliProvider. The contract for each method:

### `type / displayName`

- `type` must equal `ChannelPluginDefinition.type`.
- `displayName` is used for interactive prompts, e.g. `"Feishu"`.

### `supportsLogin: boolean`

- `true`: requires `xacpx login` for interactive credential acquisition (currently WeChat only).
- `false`: all credentials are configured via `channels[].options`.

### `parseAddArgs(args): ChannelCliParseResult`

Parses the `--app-id x --app-secret y` part of `xacpx channel add feishu --app-id x --app-secret y` into a `ChannelCliInput` (key/value dictionary). Returns:

```ts
| { ok: true; input: ChannelCliInput }
| { ok: false; message: string }   // printed directly to stderr
```

Requirements:

- Return `{ok: false}` immediately for an unrecognized flag.
- For boolean flags, use `parseBooleanFlag(value, flagName)` (refer to how yuanbao-provider does it).
- Do not throw here — errors must be reported via `ok:false`.

### `buildDefaultConfig(input): ChannelRuntimeConfig`

Converts `ChannelCliInput` (with interactively completed fields) into the `ChannelRuntimeConfig` written to `~/.xacpx/config.json`:

```ts
{
  id: "feishu",
  type: "feishu",
  enabled: true,
  options: { appId: "...", appSecret: "...", domain: "feishu", requireMention: true }
}
```

Note: `id` must equal `type` (multi-instance is not currently supported).

### `validateConfig(config): ChannelCliValidationIssue[]`

Does not throw; returns an array of issues. Two kinds:

```ts
| { kind: "missing-required-field"; flag: string; message: string }
| { kind: "invalid-config"; message: string }
```

`missing-required-field.flag` is which CLI flag is missing (e.g. `"--app-id"`); the CLI uses it to tell the user what to fill in.

### `renderSummary(config): string[]`

Returns multi-line strings for display, for example:

```
type: feishu
appId: cli_xxx
appSecret: ***            ← must be masked
domain: feishu
requireMention: true
```

`xacpx channel show <type>` calls it. **Secret fields must be shown as `***` or with the suffix omitted** — do not output them verbatim.

### `promptForMissingFields(input, io): Promise<ChannelCliInput>`

Only called when `io.isInteractive()` is true. Use `io.promptText` / `io.promptSecret` to complete missing fields. `promptSecret` does not echo and is used for secrets.

---

## 11. CLI provider helper types

```ts
export type ChannelCliInput = Record<string, string | boolean | undefined>;

export interface ChannelCliIo {
  print: (line: string) => void;
  stderr: (text: string) => void;
  isInteractive: () => boolean;
  promptText: (message: string) => Promise<string>;
  promptSecret: (message: string) => Promise<string>;
}
```

The two common parsing helpers `parseBooleanFlag(value, flagName)` and `takeFlagValue(args, index, flagName)` are not yet exported in runtime form from `xacpx/plugin-api`. The first-party packages `@ganglion/xacpx-channel-yuanbao` / `@ganglion/xacpx-channel-feishu` each copy a private implementation — refer to the top 10 lines of `packages/channel-yuanbao/src/yuanbao-provider.ts` and copy them directly.

---

## 12. Config shape: `ChannelRuntimeConfig`

```ts
export interface ChannelRuntimeConfig {
  id: string;
  type: string;
  enabled: boolean;
  options?: Record<string, unknown>;
}
```

Constraints:

- `id === type` (multi-instance is only supported in the future).
- A channel with `enabled: false` is not instantiated by the daemon, but still appears in `xacpx channel list`.
- `options` is an arbitrary JSON object, parsed by your `factory`. It is recommended to write a dedicated `parseMyConfig(options): MyConfig` function in the channel package that first throws with readable errors, so the constructor can trust the result.

Top-level structure of `~/.xacpx/config.json`:

```jsonc
{
  "plugins": [
    { "name": "@scope/xacpx-channel-my", "version": "0.1.0", "enabled": true }
  ],
  "channels": [
    { "id": "weixin", "type": "weixin", "enabled": true },
    {
      "id": "my",
      "type": "my",
      "enabled": true,
      "options": { "appKey": "...", "appSecret": "..." }
    }
  ]
}
```

---

## 13. ChatKey and channelId conventions

`chatKey` is the session identifier in xacpx routing, globally unique across channels. Convention:

```
<channelId>:<channel-internal-id>
```

Examples:

- WeChat: `weixin:wxid_abc123` (note WeChat is compatible with the old format `wxid_abc123`, equivalent to `weixin:wxid_abc123`)
- Feishu: `feishu:oc_xxxx`
- Yuanbao: `yuanbao:<account>:<conv>`

Your channel **must**:

1. Construct a chatKey of the form `<type>:<...>` for inbound messages and pass it to `agent.handle(chatKey, text)`.
2. For outbound messages, parse the chatKey back into the internal id, taking care to strip the `<type>:` prefix.
3. In callbacks like `notifyTaskCompletion`, check whether `task.chatKey` starts with `<type>:`, and if not, return immediately.

`channelId` must not contain `:`. `registerChannelFactory` enforces this check, and a failure is reported at daemon startup.

---

## 14. Validation rules

After importing a plugin, the daemon performs the following checks (`src/plugins/validate-plugin.ts`). Any failure rejects registration and prints an actionable error:

| Check | Failure action |
| --- | --- |
| `apiVersion === 1` | Reports `unsupported plugin apiVersion` |
| `name` (if present) must equal the npm package name | Reports `plugin name does not match package name` |
| Each channel's `type` is non-empty and does not contain `:` | Reports `channel type must be non-empty / must not contain ":"` |
| No duplicate `type` within a single plugin | Reports `plugin registers duplicate channel type` |
| No `type` registered by multiple plugins in the same process | Reports `channel type ... is already provided by ...` |
| Overriding a built-in type (`weixin`) is not allowed | Reports `channel type is already registered: weixin` |

The CLI does not automatically disable a faulty plugin — the user must manually `xacpx plugin disable <name>`, or fix it and run `xacpx plugin doctor`.

---

## 15. plugin doctor diagnostics

The output of `xacpx plugin doctor` is produced by `src/plugins/plugin-doctor.ts`. Common issues and their meaning:

| `level` | `message` pattern | Meaning / what the user should do |
| --- | --- | --- |
| `error` | `package not installed in plugin home; run xacpx plugin add <name>` | The config declares a plugin, but it is not installed in `~/.xacpx/plugins/node_modules`. Reinstall. |
| `error` | `failed to import plugin: ...` | The npm package installs but errors on import. Look at the stack trace in the error — usually a dependency version conflict or a missing `dist`. |
| `error` | `unsupported plugin apiVersion`, etc. | Validation failed. See §14. |
| `error` | `channel type X is already provided by ...` | Two plugins declare the same type. Uninstall one of them. |
| `error` | `channel X is configured but no enabled plugin provides it` | `channels[]` has X but no corresponding plugin is enabled. `xacpx plugin add` or `xacpx plugin enable`. |
| `warn` | `plugin is installed and valid but disabled; run xacpx plugin enable` | Installed but `enabled: false`. |
| `error` | `channel X is configured but provider plugin is disabled` | The channel is configured but its provider plugin is disabled — daemon startup will fail. `plugin enable` or `channel disable`. |
| `ok` | `plugin is installed and valid; channels: ...` | Healthy. |

When writing a plugin, you can work backward from this table: ensure your plugin reliably reaches `ok`, then proceed to `xacpx restart`.

---

## 16. End-to-end lifecycle

### 16.1 The user's CLI path

| Stage | Command | Side effects |
| --- | --- | --- |
| Install | `xacpx plugin add <pkg> [--version <v>]` | `bun add` / `npm install` into `~/.xacpx/plugins`, import + validate, write `plugins[]` |
| Upgrade | `xacpx plugin update <pkg> [--version <v>]` `xacpx plugin update --all` | Reinstall the same-named package, then import + validate; with `--version` it also writes back `plugins[].version` |
| Validate | `xacpx plugin doctor [<pkg>]` | Modifies no state, only reports the health of each plugin / each channel |
| Disable | `xacpx plugin disable <pkg>` | Only sets `plugins[].enabled = false`, does not uninstall the package |
| Re-enable | `xacpx plugin enable <pkg>` | `enabled = true` |
| Uninstall | `xacpx plugin remove <pkg>` (`rm` alias) | Uninstalls the npm package + removes it from `plugins[]` (does **not** automatically `channel rm`) |
| Channel | `xacpx channel add/rm/enable/disable/show/list <type>` | Edits `channels[]`; goes through the plugin-provided `cliProvider` (if any) |
| Apply | `xacpx restart` | The daemon re-imports all enabled plugins |

Every plugin command accepts `--restart` / `--no-restart`, and by default asks in an interactive terminal. See [docs/channel-management.md#plugin-management](./channel-management.md#plugin-management).

### 16.2 daemon startup order

```
1. main() starts
2. Read ~/.xacpx/config.json
3. plugin-loader iterates plugins[].enabled === true:
   3.1 import("<plugin-home>/node_modules/<name>")
   3.2 validateWeacpxPlugin
   3.3 registerChannelPlugin — inject factory + cliProvider
4. createMessageChannels iterates channels[].enabled === true:
   4.1 channelFactories.get(type)
   4.2 factory(options, deps) → MessageChannelRuntime
5. runConsole(...):
   5.1 channel.configureOrchestration?.(callbacks)
   5.2 acquire the required, channel-independent core runtime ownership lock
   5.3 acquire a channel-provided consumer lock when available (legacy-daemon compatibility fence)
   5.4 publish daemon identity, then reconcile shared state and reap stale owners
   5.5 report daemon ready, then channel.start({ agent, abortSignal, quota, logger }) and scheduler.start()
6. Receive messages: channel → agent.handle(chatKey, text) → router
7. Send messages: orchestration → channel.notifyTaskCompletion / sendCoordinatorMessage
8. SIGTERM / SIGINT: abortSignal aborted → dispose/reap while ownership remains held → registry.stopAll: channel.stop?() (fallback: logout()) → release compatibility/core locks → daemon exit
```

Normal exit goes through `abortSignal` plus the non-destructive `stop()`; the destructive `logout()` is triggered only when `xacpx logout` is explicitly invoked — except as the shutdown fallback for legacy channels that do not implement `stop()`.

### 16.3 Module cache semantics (developer must-read)

- At step 3 of §16.2, the daemon `import()`s each plugin once, and **the module object is cached for the daemon process's lifetime**. `xacpx plugin update` only changes the disk; it does **not** make the running daemon see the new code.
- Therefore you must `xacpx restart` after an update. The CLI asks by default; for scripts, explicitly pass `--restart`.
- Conversely, the `xacpx plugin add/update/remove` CLI commands run in their **own** short-lived Node process, and the `import()` during validation uses the new disk version. So during the "installed but not restarted" window: passing CLI validation ≠ the daemon having loaded the new version. This is the root cause of `xacpx plugin doctor` consistently reporting "installed" while the daemon's behavior does not change.

### 16.4 Failure rollback

| Failure point | Symptom | Action |
| --- | --- | --- |
| import fails during `plugin add` | The CLI errors immediately and **does not write config** | Fix the package, or retry with a different `--version` |
| validate fails during `plugin add` (apiVersion mismatch, name not matching the package name, duplicate type within a single plugin, missing factory, etc.) | The CLI errors immediately and **does not write config** | Read the error, fix the package metadata |
| cross-plugin type conflict during `plugin add` | Not detected at the add stage, only discovered during `plugin doctor` or daemon startup | Run `xacpx plugin doctor` to recheck after installing |
| import / validate fails during `plugin update` | The CLI errors; if `plugins[].version` previously had a value, it automatically `npm install`s back to that version; otherwise it prompts the user to reinstall manually | Read the error, and if needed manually `xacpx plugin add <pkg>` to return to latest |
| plugin import fails at daemon startup | The daemon process exits, and the error goes into `~/.xacpx/runtime/app.log` | Run `xacpx plugin doctor` to see the ERROR line; a common workaround is `plugin disable <name>` to bypass it temporarily |
| cliProvider validate fails during `channel add` | The CLI reports which field is missing | Fill it in per the prompt |

---

## 17. Publishing contract

First-party package path: `packages/channel-<type>/`, published as `@ganglion/xacpx-channel-<type>`. Third parties may name it anything, but if `WeacpxPlugin.name` is set, it **must** equal the npm package name.

### 17.1 Official vs third-party plugin discovery

`xacpx plugin known` only lists the **official** channel plugins published alongside the current xacpx version (`src/plugins/known-plugins.ts`):

```text
Official plugins:
- feishu  @ganglion/xacpx-channel-feishu   Feishu channel
- yuanbao @ganglion/xacpx-channel-yuanbao  Tencent Yuanbao channel

Install:
  xacpx plugin add <package>
```

Discovery of third-party plugins goes through npm itself (`npm search` / GitHub / README) and does **not** appear in `plugin known`. `xacpx` does not run a marketplace, an npm index, or auto-install; the user only needs:

```bash
xacpx plugin add <your-npm-package-name>
```

If you write a third-party channel plugin, it is recommended to put this `plugin add` command directly in your repository README rather than rely on xacpx for discovery.

Pre-publish checklist:

- `dist/` contains both `.js` and `.d.ts`.
- `package.json`'s `peerDependencies.xacpx` uses `>=x.y` rather than `^x.y`, to avoid locking to a minor version.
- `peerDependenciesMeta.xacpx.optional = true`, otherwise npm may require installing a copy of xacpx in `~/.xacpx/plugins` at install time, wasting space.
- The published artifact imports **only** `xacpx/plugin-api`. You can verify with `bunx publint`.
- All ESM, `"type": "module"`.

For publish commands, preflight, dry-run, and version-number selection (patch / minor / major), see the [Releases section in docs/developments.md](./developments.md#releases).

---

## 18. Testing recommendations

At a minimum you should have:

1. **Unit layer** (no xacpx dependency): parse / validate config functions, message codec, signing algorithm, chatKey construction and parsing.
2. **CLI provider unit tests**: feed various argument combinations to `parseAddArgs` and assert the `ChannelCliInput`; feed deliberately field-missing configs to `validateConfig` and assert the issues.
3. **Channel contract tests**: instantiate `MyChannel(options)`, inject a fake `ChannelStartInput` (write your own `OutboundQuota` / `AppLogger` mock), and assert that one inbound message reaches the fake `agent.handle`.
4. **Integration layer** (optional): run `runCli(["channel", "add", "<type>", ...])` in a test and assert that `~/.xacpx/config.json` is written correctly.

Refer to `packages/channel-yuanbao/src/access/__tests__` (if present) and `tests/unit/channels/*`.

---

## 19. Reference implementations

| Package | Path | What to look at |
| --- | --- | --- |
| `@ganglion/xacpx-channel-feishu` | `packages/channel-feishu/` | Standard OAuth2 / custom app, HTTP webhook, @ mention, group vs direct routing |
| `@ganglion/xacpx-channel-yuanbao` | `packages/channel-yuanbao/` | Long-lived WebSocket, custom signing, message deduplication, heartbeat notification |
| Built-in `weixin` | `src/channels/weixin-channel.ts` | The only channel using `supportsLogin: true` + `ConsumerLock` |

Each first-party package has `src/index.ts` (plugin entry) + `src/channel.ts` (runtime) + `src/<type>-provider.ts` (CLI provider); reading them side by side is the fastest way.

---

## Further reading

- User-facing channel management: [docs/channel-management.md](./channel-management.md)
- All config file fields: [docs/config-reference.md](./config-reference.md)
- Release / versioning process: [docs/developments.md → Releases](./developments.md#releases)
- Code wiki / module map: [docs/code-wiki.md](./code-wiki.md)
