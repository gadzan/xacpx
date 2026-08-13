# Channel Plugin Development

## Overview

xacpx turns message channels into npm plugins. A channel plugin is an npm package that exports an `XacpxPlugin` object (the legacy name `WeacpxPlugin` also works) declaring one or more `ChannelPluginDefinition` entries. When the daemon starts, it reads `plugins[]` from `~/.xacpx/config.json`, dynamically imports each enabled plugin package from `~/.xacpx/plugins/node_modules/<plugin-name>`, and registers its channel factories and CLI providers.

> **Rename note (0.8.0):** The project was renamed from `weacpx` to `xacpx`. Import from `xacpx/plugin-api`, declare `xacpx` as the peer dependency, and prefer the new names `XacpxPlugin` / `minXacpxVersion` / `compatibleXacpxVersions` in new plugins. For backward compatibility, the legacy names `WeacpxPlugin` / `minWeacpxVersion` / `compatibleWeacpxVersions` are still recognized by the core (when both are declared, the new names take precedence). Published plugins that use the old names continue to work without any changes.

This reference covers everything needed to write, test, and publish a channel plugin: all types, methods, fields, and error codes.

## Package shape

Recommended directory layout:

```
my-channel/
├── package.json           # name, peerDependencies: { xacpx: ">=0.3.x" }
├── tsconfig.json
├── README.md
├── src/
│   ├── index.ts           # default export XacpxPlugin
│   ├── channel.ts         # implements MessageChannelRuntime
│   ├── cli-provider.ts    # implements ChannelCliProvider (optional but strongly recommended)
│   ├── config.ts          # parse / validate options
│   └── ...                # gateway, signing, message codec, etc.
└── dist/                  # published build artifacts (src is not published)
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

Declare `xacpx` as an `optional` peer: install a copy locally during development, and the xacpx runtime provides it at run time. All imports **must** come from `xacpx/plugin-api` — never from `xacpx/dist/*` or `xacpx/src/*` (those are internal, not part of the stable API surface).

## Plugin manifest and exports

### `XacpxPlugin` / `WeacpxPlugin`

```ts
import type { XacpxPlugin } from "xacpx/plugin-api";
import {
  WEACPX_PLUGIN_API_VERSION,
  WEACPX_PLUGIN_MIN_CORE_VERSION,
} from "xacpx/plugin-api";

// New name (preferred):
const plugin: XacpxPlugin = {
  apiVersion: WEACPX_PLUGIN_API_VERSION,       // currently fixed at 1
  minXacpxVersion: WEACPX_PLUGIN_MIN_CORE_VERSION, // e.g. "0.3.3"
  channels: [/* ... */],
};

export default plugin;
```

| Field | Required | Description |
| --- | --- | --- |
| `apiVersion` | Yes | Must be the literal `1`. xacpx will increment this for future breaking changes. `WEACPX_PLUGIN_API_SUPPORTED_VERSIONS` lists versions the current xacpx accepts. |
| `name` | No | If set, must equal the npm package name (including scope); otherwise startup validation rejects it. |
| `minXacpxVersion` | Recommended | Minimum xacpx core version this plugin requires (e.g. `"0.3.3"`). When the installed xacpx is older, loading fails with an `upgrade xacpx` message. First-party plugins must set this; third-party plugins are strongly encouraged to. |
| `compatibleXacpxVersions` | No | Explicit version range (`x.y.z` / `>=x.y.z` / `^x.y.z`). When declared alongside `minXacpxVersion`, both constraints must be satisfied. |
| `channels` | No | List of channel definitions. May be empty (reserved for future non-channel extension points). |

Constraints:

- Must use a **default export** (`export default plugin`). Named exports are ignored.
- The module is imported once per daemon process; avoid top-level side effects (timers, global listeners, etc.).

### Compatibility errors

| Error keyword | Meaning | User action |
| --- | --- | --- |
| `requires xacpx >=X.Y.Z; ... upgrade xacpx` | Plugin is newer than the installed xacpx | Upgrade `xacpx` to ≥ that version, or install a plugin version compatible with the current xacpx |
| `apiVersion N; supported: ...; install a compatible plugin` | Plugin uses an API version xacpx doesn't recognize | Upgrade or downgrade the **plugin** to a version compatible with the installed xacpx |
| `invalid plugin metadata` | `minXacpxVersion` / `compatibleXacpxVersions` field is malformed | Contact the plugin author or check the published metadata |

`xacpx plugin doctor` prints these as `ERROR <plugin>: ...` lines — suitable for CI or pre-publish preflight.

### `ChannelPluginDefinition`

```ts
export interface ChannelPluginDefinition {
  type: string;
  factory: ChannelFactory;
  cliProvider?: ChannelCliProvider;
  retireChannel?: (ctx: ChannelRetireContext) => Promise<void>;
}
```

| Field | Required | Description |
| --- | --- | --- |
| `type` | Yes | Channel type string, e.g. `"feishu"`, `"yuanbao"`. Must be globally unique within the process. |
| `factory` | Yes | Factory function; called during daemon startup to instantiate `MessageChannelRuntime`. |
| `cliProvider` | No | Parsing and prompt logic for `xacpx channel add <type>`. Without it, users must manually edit `~/.xacpx/config.json`. Strongly recommended. |
| `retireChannel` | No | CLI lifecycle hook for `xacpx channel disable` / `xacpx channel rm`. Core dispatches by channel type after configured plugins load; it does not import the plugin package. Use for one-shot resource cleanup. |

`type` constraints: non-empty, no `:` character (the chatKey uses `:` as a separator), cannot conflict with already-registered types (`weixin` is always reserved by the built-in).

## Channel lifecycle

### `ChannelFactory`

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

| Parameter | Description |
| --- | --- |
| `options` | The `channels[].options` object from config — typed as `Record<string, unknown>`, not pre-validated. Parse and validate inside the factory. |
| `deps.mediaStore` | xacpx-provided temporary media storage utility. Use when handling image or file attachments. |
| `deps.allowedMediaRoots` | Set of registered workspace `cwd` paths. Determines which directories may be used as sources for outbound file attachments from agent output. |

**Only parse arguments and initialize state in the factory** — do not open network connections or read external tokens. Reserve all side effects for `start()`. This allows `doctor` and `dry-run` to safely import the plugin.

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

### `MessageChannelRuntime`

```ts
export interface MessageChannelRuntime {
  id: string;

  isLoggedIn(): boolean;
  login(): Promise<string>;
  logout(): void;

  start(input: ChannelStartInput): Promise<void>;

  createConsumerLock?(options?: ConsumerLockOptions): ConsumerLock;
  configureOrchestration?(callbacks: OrchestrationDeliveryCallbacks): void;

  notifyTaskCompletion(task: OrchestrationTaskRecord): Promise<void>;
  notifyTaskProgress(task: OrchestrationTaskRecord, text: string): Promise<void>;
  sendCoordinatorMessage(input: CoordinatorMessageInput): Promise<void>;
}
```

**`id`** — Unique instance identifier. xacpx currently requires `id === type`, so write `readonly id = "<type>"`. Used in log context.

**`isLoggedIn()`** — Synchronous, pure. Returns whether usable credentials are present. Called once before startup to decide whether `login()` is needed.

**`login()`** — Non-interactive channels (OAuth, appKey/appSecret) typically return a status string:

```ts
async login(): Promise<string> {
  if (this.isLoggedIn()) return "credentials configured";
  throw new Error("Provide options.appKey and options.appSecret in channels[].options");
}
```

Interactive channels (WeChat QR scan) block here until login completes. If your channel never needs interactive login, set `cliProvider.supportsLogin` to `false`.

**`logout()`** — Release credentials, disconnect persistent connections, clear in-memory sessions. Must be **idempotent** — called on both daemon shutdown and re-login.

**`start(input)`** — The entry point for the channel to begin receiving messages. See [Inbound messages](#inbound-messages) below.

**`createConsumerLock?(options?)`** — Optional. Implement if your channel needs **process-level mutual exclusion** (e.g., a single WeChat account that can only be connected from one xacpx process at a time). See `ConsumerLock` below.

**`configureOrchestration?(callbacks)`** — Optional. Called by the daemon when wiring the orchestration service; provides `markTaskNoticeDelivered` and `markTaskNoticeFailed` callbacks. If your channel supports `notifyTaskCompletion`, store these callbacks and call them on delivery success/failure.

**`notifyTaskCompletion(task)`** — Called by the orchestration service to notify the user that a worker task finished. Route by checking `task.chatKey`. Call `markTaskNoticeDelivered(taskId, accountId)` on success, `markTaskNoticeFailed(taskId, errorText)` on failure. If `task.chatKey` doesn't belong to your channel (check the prefix), return immediately — the daemon broadcasts to all channels.

**`notifyTaskProgress(task, text)`** — Heartbeat notification (default every 60 s, controlled by `progressHeartbeatSeconds`). Write an empty implementation if your channel doesn't support mid-stream heartbeats.

**`sendCoordinatorMessage(input)`**

```ts
export interface CoordinatorMessageInput {
  coordinatorSession: string;
  chatKey: string;
  accountId?: string;
  replyContextToken?: string;
  text: string;
}
```

Called by the orchestration service to send a text message to the coordinator session's channel. `replyContextToken` is a reply context handle (used by Feishu/Yuanbao to quote a parent message) and may be ignored.

## Inbound messages

### `ChannelStartInput`

```ts
export interface ChannelStartInput {
  agent: ChatAgent;
  abortSignal: AbortSignal;
  quota: OutboundQuota;
  logger: AppLogger;
  // Optional fields the core injects when relevant:
  commandHints?: CommandHint[];   // built-in command catalog for input-box hints
  coreVersion?: string;           // xacpx core version string
  locale?: Locale;                // active runtime language ("en" | "zh") — see Internationalization
}
```

| Field | Purpose |
| --- | --- |
| `agent` | xacpx router entry point. When a text message arrives, call `agent.handle(chatKey, text)` to route it through the command system. |
| `abortSignal` | Daemon shutdown signal. Listen for the `aborted` event and stop all long connections and timers. |
| `quota` | Outbound rate/volume quota. See [Replies and media](#replies-and-media). |
| `logger` | Structured logger. See [AppLogger](#applogger). |
| `commandHints?` | Built-in command catalog, for channels that support input-box command hints. |
| `coreVersion?` | xacpx core version string, for channels that need it (e.g. command-sync metadata). |
| `locale?` | Active runtime language (`"en"` \| `"zh"`, type `Locale`), resolved from `config.language`. Use it to localize your channel's output. See [Internationalization](#internationalization-i18n). |

Keep references to `agent`, `quota`, and `logger` until `logout()` is called or `abortSignal` is triggered — they are not passed again after `start()` returns.

`start()` is typically a long-running promise that returns once callbacks are wired up. The message loop may continue in the background asynchronously.

## Internationalization (i18n)

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

## Replies and media

### `OutboundQuota`

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

This abstraction originated from WeChat's 24-hour proactive-message limit. Other channels (Feishu, Yuanbao) have no practical quota, but xacpx uses the same facade for all channels to simplify orchestration scheduling.

The two methods you'll use most:

- **`onInbound(chatKey)`** — Call whenever a user message arrives. Resets the 24-hour window for that chatKey.
- **`reserveFinal(chatKey)`** — Call before sending a final reply. Returns `true` if you may send; `false` if the quota is exhausted. On `false`, enqueue the content and retry after the next inbound.

Non-WeChat channels can usually implement outbound like this:

```ts
async sendFinalText(chatKey: string, text: string) {
  if (!this.quota?.reserveFinal(chatKey)) {
    this.quota?.enqueuePendingFinal(chatKey, [{ text }]);
    return;
  }
  await this.gateway.sendText(chatKey, text);
}
```

### `AppLogger`

```ts
export interface AppLogger {
  debug: (event: string, message: string, context?: LogContext) => Promise<void>;
  info: (event: string, message: string, context?: LogContext) => Promise<void>;
  error: (event: string, message: string, context?: LogContext) => Promise<void>;
}
```

Usage:

```ts
await logger.info("feishu.inbound.message", "received message", { chatKey });
```

Conventions:
- Use `<channel>.<area>.<verb>` event codes, e.g. `"feishu.inbound.message"`, `"yuanbao.gateway.connected"`.
- Strip secrets and PII from the `context` object. Never include `appSecret` or user tokens.
- The daemon already adds timestamps and PID — do not repeat them.

Logs are written to `~/.xacpx/runtime/app.log` and surfaced by `xacpx doctor --verbose`.

### `OrchestrationDeliveryCallbacks`

```ts
export interface OrchestrationDeliveryCallbacks {
  markTaskNoticeDelivered: (taskId: string, accountId: string) => Promise<void>;
  markTaskNoticeFailed: (taskId: string, errorMessage: string) => Promise<void>;
}
```

The daemon calls `configureOrchestration(callbacks)` during app assembly. Call `markTaskNoticeDelivered` after a task completion notice is successfully delivered to the IM platform; call `markTaskNoticeFailed` on delivery failure (API error, quota exceeded). Orchestration uses these signals to avoid duplicate delivery after a restart.

Channels that implement `notifyTaskCompletion` but not `configureOrchestration` will be treated as "never delivered" for every task, which may cause repeated notifications.

### `ConsumerLock`

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

Implement `createConsumerLock` when your channel uses single-point credentials connected to a persistent gateway session — where multiple xacpx processes connecting simultaneously would cause mutual disconnection (the WeChat web protocol is the canonical example). Pure HTTP webhooks or channels with independent bot IDs (Feishu self-built apps, Yuanbao multi-bot) do not need this.

Implementation notes:
- Use a file lock (`proper-lockfile` or a custom `fcntl`) for physical mutual exclusion.
- On `acquire` failure, throw an error with metadata (see `ActiveWeixinConsumerLockError`) so the daemon can report "another process holds the lock, pid=xxx" in the log.
- `release` must be idempotent.

Reference implementation: [`src/weixin/monitor/consumer-lock.ts`](https://github.com/gadzan/xacpx/blob/main/src/weixin/monitor/consumer-lock.ts).

## Configuration

### `ChannelRuntimeConfig`

```ts
export interface ChannelRuntimeConfig {
  id: string;
  type: string;
  enabled: boolean;
  options?: Record<string, unknown>;
}
```

- `id === type` (multi-instance support is planned but not yet available).
- `enabled: false` channels are not instantiated by the daemon but still appear in `xacpx channel list`.
- `options` is any JSON object; your factory parses it. Write a dedicated `parseMyConfig(options): MyConfig` function that throws a readable error on bad input, then let the constructor trust the result.

Top-level `~/.xacpx/config.json` shape:

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

### CLI provider

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

All behavior of `xacpx channel add <type>` is driven by the CLI provider. Method contracts:

- **`type` / `displayName`** — `type` must match `ChannelPluginDefinition.type`. `displayName` is used in interactive prompts (e.g. `"Feishu"`).
- **`supportsLogin`** — `true` means `xacpx login` will trigger interactive credential acquisition (currently only WeChat). `false` means all credentials are passed via `channels[].options`.
- **`parseAddArgs(args)`** — Parse CLI flags from `xacpx channel add feishu --app-id x --app-secret y`. Return `{ ok: true; input: ChannelCliInput }` or `{ ok: false; message: string }`. Do not throw — always use `ok: false` for errors. Unrecognized flags must immediately return `ok: false`.
- **`buildDefaultConfig(input)`** — Convert the fully-filled `ChannelCliInput` into a `ChannelRuntimeConfig` suitable for writing to `~/.xacpx/config.json`. `id` must equal `type`.
- **`validateConfig(config)`** — Return an array of validation issues (never throw). Two kinds: `{ kind: "missing-required-field"; flag: string; message: string }` and `{ kind: "invalid-config"; message: string }`. The `flag` field of `missing-required-field` is the CLI flag that is missing (e.g. `"--app-id"`).
- **`renderSummary(config)`** — Return display lines for `xacpx channel show <type>`. **Secret fields must be shown as `***`** — never print them verbatim.
- **`promptForMissingFields(input, io)`** — Called only when `io.isInteractive()` is true. Use `io.promptText` / `io.promptSecret` to fill in missing fields. `promptSecret` does not echo to the terminal.

Supporting types:

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

The helper functions `parseBooleanFlag` and `takeFlagValue` are **not** currently exported from `xacpx/plugin-api` at runtime. Both first-party plugins (`@ganglion/xacpx-channel-yuanbao`, `@ganglion/xacpx-channel-feishu`) carry private copies — copy the first ~10 lines of [`packages/channel-yuanbao/src/yuanbao-provider.ts`](https://github.com/gadzan/xacpx/blob/main/packages/channel-yuanbao/src/yuanbao-provider.ts) directly.

### ChatKey convention

`chatKey` is the globally-unique conversation identifier across all channels:

```
<channelId>:<channel-internal-id>
```

Examples:
- WeChat: `weixin:wxid_abc123`
- Feishu: `feishu:oc_xxxx`
- Yuanbao: `yuanbao:<account>:<conv>`

Your channel must:
1. Construct `<type>:<...>` chatKeys for inbound messages and pass them to `agent.handle(chatKey, text)`.
2. Strip the `<type>:` prefix when translating a chatKey back to an internal ID for outbound messages.
3. In `notifyTaskCompletion` and similar callbacks, check whether `task.chatKey` starts with `<type>:` before acting — return immediately if not (the daemon broadcasts to all channels).

## Testing a plugin

Minimum recommended test coverage:

1. **Unit layer** (no xacpx dependency): config parse/validate functions, message encoding/decoding, signature algorithm, chatKey construction and parsing.
2. **CLI provider unit tests**: feed various argument combinations to `parseAddArgs` and assert the resulting `ChannelCliInput`; feed intentionally incomplete configs to `validateConfig` and assert the issues.
3. **Channel contract tests**: instantiate `MyChannel(options)`, inject a fake `ChannelStartInput` (a mock `OutboundQuota` and `AppLogger`), and assert that one inbound message reaches the fake `agent.handle`.
4. **Integration layer** (optional): run `runCli(["channel", "add", "<type>", ...])` in a test and assert that `~/.xacpx/config.json` is written correctly.

See `packages/channel-yuanbao/src/access/__tests__` and `tests/unit/channels/*` for examples.

### Validation rules enforced at startup

The daemon validates every imported plugin (`src/plugins/validate-plugin.ts`). Any failure rejects registration with an actionable error:

| Check | Failure message |
| --- | --- |
| `apiVersion === 1` | `unsupported plugin apiVersion` |
| `name` (if set) must equal the npm package name | `plugin name does not match package name` |
| Each channel `type` is non-empty and contains no `:` | `channel type must be non-empty / must not contain ":"` |
| No duplicate `type` within a single plugin | `plugin registers duplicate channel type` |
| No two plugins register the same `type` in one process | `channel type ... is already provided by ...` |
| Cannot override built-in `weixin` type | `channel type is already registered: weixin` |

CLI does not automatically disable a failing plugin. Users must manually run `xacpx plugin disable <name>` or fix the issue and re-run `xacpx plugin doctor`.

### plugin doctor diagnostics

`xacpx plugin doctor` output (from `src/plugins/plugin-doctor.ts`):

| Level | Message pattern | Meaning / action |
| --- | --- | --- |
| `error` | `package not installed in plugin home; run xacpx plugin add <name>` | Plugin listed in config but not installed. Reinstall. |
| `error` | `failed to import plugin: ...` | Package installed but import fails. Check the stack trace — usually a dependency version conflict or missing `dist`. |
| `error` | `unsupported plugin apiVersion` | Validation failed. |
| `error` | `channel type X is already provided by ...` | Two plugins declare the same type. Remove one. |
| `error` | `channel X is configured but no enabled plugin provides it` | Channel referenced in config but no matching enabled plugin. Run `xacpx plugin add` or `xacpx plugin enable`. |
| `warn` | `plugin is installed and valid but disabled; run xacpx plugin enable` | Installed but `enabled: false`. |
| `error` | `channel X is configured but provider plugin is disabled` | Channel configured but provider plugin is disabled — daemon startup will fail. Run `plugin enable` or `channel disable`. |
| `ok` | `plugin is installed and valid; channels: ...` | Healthy. |

Use this table to verify that your plugin reaches the `ok` state before running `xacpx restart`.

## Publishing a plugin

### Official plugin naming

First-party plugins follow the path `packages/channel-<type>/` and are published as `@ganglion/xacpx-channel-<type>`. Third-party plugins may use any npm package name, but if `XacpxPlugin.name` is set it **must** match the npm package name exactly.

Official plugins listed by `xacpx plugin known`:

```text
- feishu   @ganglion/xacpx-channel-feishu   Feishu channel
- yuanbao  @ganglion/xacpx-channel-yuanbao  Tencent Yuanbao channel

Install:
  xacpx plugin add <package>
```

Third-party plugins are discovered through npm itself (search / GitHub / README) and do not appear in `plugin known`. If you publish a third-party channel plugin, include the `xacpx plugin add <your-package-name>` command directly in your README.

### Pre-publish checklist

- `dist/` contains both `.js` and `.d.ts` files.
- `peerDependencies.xacpx` uses `>=x.y` (not `^x.y`) to avoid locking minor versions.
- `peerDependenciesMeta.xacpx.optional = true` (otherwise npm may try to install xacpx into the plugin home directory).
- Published artifacts only import from `xacpx/plugin-api`. Verify with `bunx publint`.
- Full ESM: `"type": "module"`.

### Plugin lifecycle CLI commands

| Phase | Command | Effect |
| --- | --- | --- |
| Install | `xacpx plugin add <pkg> [--version <v>]` | `bun add` / `npm install` to `~/.xacpx/plugins`, import + validate, write `plugins[]` |
| Upgrade | `xacpx plugin update <pkg> [--version <v>]` or `--all` | Reinstall, re-import + validate; `--version` updates `plugins[].version` |
| Check | `xacpx plugin doctor [<pkg>]` | Read-only health report for each plugin and channel |
| Disable | `xacpx plugin disable <pkg>` | Set `plugins[].enabled = false`; package stays installed |
| Re-enable | `xacpx plugin enable <pkg>` | Set `enabled = true` |
| Remove | `xacpx plugin remove <pkg>` (alias: `rm`) | Uninstall npm package and remove from `plugins[]`; **does not** auto-remove from `channels[]` |
| Channel | `xacpx channel add/rm/enable/disable/show/list <type>` | Modify `channels[]` via the plugin's `cliProvider` (if provided) |
| Activate | `xacpx restart` | Daemon re-imports all enabled plugins |

Each plugin command accepts `--restart` / `--no-restart`; interactive terminals prompt by default.

### Module caching semantics

The daemon imports each plugin once in step 3 of the startup sequence. **Module objects are cached for the daemon process lifetime.** `xacpx plugin update` only changes disk — the running daemon does not see new code until `xacpx restart`.

The `plugin add/update/remove` CLI commands run in a separate short-lived Node process, so their import validation uses the disk version. The window between "CLI says valid" and "daemon actually loaded the new version" is exactly one `xacpx restart` away.

### Rollback behavior

| Failure point | Behavior | Recovery |
| --- | --- | --- |
| `plugin add` import fails | CLI reports error immediately; **config is not written** | Fix the package or try a different `--version` |
| `plugin add` validation fails | CLI reports error immediately; **config is not written** | Fix the plugin metadata |
| Cross-plugin type conflict | Not caught at `add` time; caught by `plugin doctor` or daemon startup | Run `xacpx plugin doctor` after each install |
| `plugin update` import/validate fails | CLI reports error; rolls back to the previous `plugins[].version` if set | See the error; manually `xacpx plugin add <pkg>` to return to latest |
| Daemon startup import fails | Daemon exits; error written to `~/.xacpx/runtime/app.log` | Run `xacpx plugin doctor`; use `plugin disable <name>` to bypass temporarily |
| `channel add` cliProvider validation fails | CLI reports which fields are missing | Supply the missing fields |

### Reference implementations

| Package | Path | What to study |
| --- | --- | --- |
| `@ganglion/xacpx-channel-feishu` | `packages/channel-feishu/` | Standard OAuth2 / self-built app, HTTP webhook, mention handling, group/direct chat routing |
| `@ganglion/xacpx-channel-yuanbao` | `packages/channel-yuanbao/` | Long-lived WebSocket, custom signing, message deduplication, heartbeat notifications |
| Built-in `weixin` | [`src/channels/weixin-channel.ts`](https://github.com/gadzan/xacpx/blob/main/src/channels/weixin-channel.ts) | The only channel with `supportsLogin: true` and a `ConsumerLock` |

Each first-party package has `src/index.ts` (plugin entry) + `src/channel.ts` (runtime) + `src/<type>-provider.ts` (CLI provider). Reading them in parallel is the fastest way to understand the pattern.
