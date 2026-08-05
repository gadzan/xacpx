# xacpx Configuration Reference

`~/.xacpx/config.json` is xacpx's main configuration file.

If you want to manage WeChat/Feishu message channels, see [`docs/channel-management.md`](./channel-management.md). If you want to modify part of the configuration directly from chat instead of hand-editing JSON, see [`docs/config-command.md`](./config-command.md).

## Full Example

```json
{
  "language": "zh",
  "transport": {
    "type": "acpx-bridge",
    "command": "acpx",
    "sessionInitTimeoutMs": 120000,
    "permissionMode": "approve-all",
    "nonInteractivePermissions": "deny",
    "queueOwnerTtlSeconds": 1800,
    "adapterRegistry": "https://registry.npmjs.org/",
    "adapterVersions": {
      "codex": "1.1.9",
      "claude": "0.64.2"
    }
  },
  "logging": {
    "level": "info",
    "maxSizeBytes": 2097152,
    "maxFiles": 5,
    "retentionDays": 7,
    "perf": {
      "enabled": false,
      "maxSizeBytes": 5242880,
      "maxFiles": 3,
      "retentionDays": 7
    }
  },
  "channel": {
    "replyMode": "verbose"
  },
  "channels": [
    { "id": "weixin", "type": "weixin", "enabled": true }
  ],
  "plugins": [],
  "agents": {
    "codex": {
      "driver": "codex"
    },
    "claude": {
      "driver": "claude"
    }
  },
  "workspaces": {
    "backend": {
      "cwd": "/absolute/path/to/backend",
      "description": "backend repo"
    }
  },
  "orchestration": {
    "maxPendingAgentRequestsPerCoordinator": 3,
    "allowWorkerChainedRequests": false,
    "allowedAgentRequestTargets": [],
    "allowedAgentRequestRoles": [],
    "maxParallelTasksPerAgent": 3
  },
  "later": {
    "defaultMode": "temp"
  }
}
```

---

## `language`

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `language` | `"en"` \| `"zh"` | 否 | 选择 xacpx 运行时输出（聊天回复、CLI 输出、编排提示词等）的语言；缺省时按系统 locale 推断：先看 `$LC_ALL`/`$LC_MESSAGES`/`$LANG`，再回退到系统 locale（`zh*` → 中文，否则英文）；可用 `/config set language en` 修改；改后需 `xacpx restart` 生效 |

> **Windows 提示**：`cmd.exe`/PowerShell 默认不设置 `LANG` 等 POSIX 环境变量，自动探测改为读取系统 locale（经 `Intl`，可识别中文 Windows）。若自动结果不准，显式设置最可靠：`/config set language zh`。

---

## `transport`

How xacpx communicates with the acpx backend.

| Field | Type | Required | Description |
|------|------|------|------|
| `type` | `"acpx-cli"` \| `"acpx-bridge"` | No | Communication method, defaults to `"acpx-bridge"`. See notes below |
| `command` | `string` | No | Explicitly specify the acpx binary path. When omitted, it is looked up automatically by priority |
| `sessionInitTimeoutMs` | `number` | No | Session initialization timeout (milliseconds), defaults to `120000` (2 minutes) |
| `permissionMode` | `"approve-all"` \| `"approve-reads"` \| `"deny-all"` | No | Permission mode, defaults to `"approve-all"` |
| `nonInteractivePermissions` | `"deny"` \| `"fail"` | No | Permission policy for non-interactive scenarios, defaults to `"deny"` |
| `permissionPolicy` | `string` | No | Path to the acpx permission policy file (passed through as `acpx --permission-policy <value>`); not enabled when omitted |
| `queueOwnerTtlSeconds` | `number` | No | acpx queue owner idle time-to-live (seconds), passed through to the prompt command as `acpx --ttl <value>`. Defaults to `1800` (30 minutes); `0` = live forever. See the "Reducing agent cold starts" notes below |
| `turnIdleTimeoutSeconds` | `number` | No | Inactivity watchdog for in-flight agent turns. If a turn produces no streamed agent activity (output/tool/thought/usage/plan/command event) for this many seconds, it is aborted and reported as `Turn timed out due to inactivity`, reclaiming its slot. The timer resets on every streamed event, so long but actively-working turns are unaffected — **but a single tool call that stays silent for the whole window (e.g. `sleep`, a long compile/clone with no interleaved output) will still trip it**; raise this value or set `0` for workloads with long silent operations. Defaults to `600` (10 minutes); `0` disables the watchdog. Each reclaim is logged as `control.turn.idle_timeout` (with the session and the concrete threshold) for diagnosis |
| `preferLocalAgents` | `boolean` | No | Prefer a locally-installed native agent CLI over acpx's `npx -y <pkg>` fallback when one is on `PATH` (currently the unpinned-npx drivers `opencode` and `kilocode`). Avoids a per-cold-start npm-registry fetch — faster and immune to network blips (e.g. `ECONNRESET` during agent init). Defaults to `true`; set `false` to always use acpx's default resolution. A per-agent `command` override still takes precedence |
| `adapterVersions` | `{ "codex"?: string, "claude"?: string }` | No | Local exact-version overrides for xacpx-managed ACP adapters. Values must be exact semver versions, not ranges or tags. Omitted entries use xacpx's tested defaults (`codex` `1.1.9`, `claude` `0.64.2` in this release). Prefer the `xacpx adapter` CLI below over editing this object by hand |
| `adapterRegistry` | `string` | No | npm registry used only for xacpx-managed Codex/Claude adapters. Defaults to `https://registry.npmjs.org/` and does **not** inherit the machine/company npm default. Change it with `xacpx adapter registry set <url>`; only credential-free HTTP(S) URLs are accepted |

### Managed ACP adapter versions

xacpx does not install the Codex or Claude adapter as a package dependency by default. For these two drivers it normally passes an exact `npx -y --registry=<registry> <package>@<version>` command to acpx. Users may opt in to an immutable local release with `xacpx adapter preinstall <codex|claude> [version]`; a validated active local release then replaces the generated npx command. Resolution priority is:

1. Explicit `agents.<name>.command` (fully user-managed)
2. `transport.adapterVersions.<driver>`
3. The exact version tested and shipped by this xacpx release

Use `xacpx adapter list` to inspect local effective versions, `xacpx adapter check` to compare with npm, and `xacpx adapter update <name>` (or `--all`) to opt in to a newer version. `set` and `update` first confirm the exact package version is published and complete a real ACP `initialize` probe; the config is changed only if that probe succeeds. Adapter version changes require `xacpx restart`. xacpx never updates these pins automatically during daemon startup.

Preinstalled releases live below `~/.xacpx/adapters/<driver>/releases/`; `active.json` is atomically published only after install, containment checks, static validation, and the ACP initialize probe succeed. `xacpx adapter list --installed` shows them. `xacpx adapter uninstall <driver> <release-id>` refuses to remove the active release or any release referenced by state or, on Windows, durable intent/owner/residual records. Reference reads are fail-closed and are repeated immediately before deletion.

All adapter version lookups, publication checks, verification downloads, and runtime `npx` launches use the effective `adapterRegistry`. The default is always the public npm registry; xacpx explicitly overrides both npm's generic registry and any `.npmrc` mapping for the `@agentclientprotocol` scope. A company registry can be selected explicitly when it proxies that scope:

```bash
xacpx adapter registry
xacpx adapter registry set https://npm.company.example/repository/npm-group/
xacpx adapter registry reset   # return to https://registry.npmjs.org/
```

Registry URLs must not include credentials; configure registry-scoped authentication in npm's normal `.npmrc` instead. Restart the daemon after changing the registry.

### `type` Options

#### `"acpx-cli"`

Spawns the acpx child process directly in the current process. Each operation (prompt/cancel/ensureSession) starts a new process that exits after completion. Internally uses `node-pty` to allocate a PTY.

Suitable for: local development and debugging scenarios.

#### `"acpx-bridge"` (default)

Starts a separate bridge child process (`bridge-main.ts`), inside which acpx runs persistently. All operations are sent via the stdin/stdout JSON protocol as RPCs, so the acpx process is not restarted for every command.

Suitable for: production environments, more stable long-running operation.

### `command` Resolution Priority

When `transport.command` is not specified, acpx is looked up in the following order:

1. `acpx` installed inside the current project (`node_modules/.bin/acpx`)
2. `acpx` in the shell `PATH`

Explicitly specifying `command` overrides the above behavior.

### Reducing agent cold starts (`queueOwnerTtlSeconds`)

When acpx receives a prompt, it spins up a **queue owner** background process that holds the actual ACP agent (codex/claude and other adapters) and the model context. The `acpx prompt` that xacpx spawns for each message is just a lightweight frontend that connects to this queue owner over a Unix socket — as long as the owner is still alive, subsequent messages **skip the agent cold start** (adapter boot + `session/new`/`load`, usually a few to tens of seconds).

The queue owner's idle time-to-live is determined by acpx's `--ttl` (acpx's own default is 300 seconds). WeChat conversations naturally have pauses of a few minutes, and once 300 seconds elapse the next message has to cold start. xacpx defaults it to **1800 seconds (30 minutes)**, covering the vast majority of conversation pauses; once truly idle, the agent is automatically reclaimed within 30 minutes, and after the daemon stops it lingers for at most 30 minutes — self-healing and leak-free.

- Larger values (e.g. `3600`) → warmer, but a longer lingering window during runtime.
- `0` → live forever, zero cold starts for all subsequent messages; during runtime each session keeps a resident agent process, with the highest resource usage.
- **Cleanup on daemon stop**: when xacpx stops, it enumerates its own sessions (regular user sessions + orchestration worker sessions) and terminates the corresponding queue owner processes (it only kills the processes, it does not close the acpx session, so the next startup recovers normally from cold). Therefore, even with `ttl=0`, no owner lingers after stopping. This is best-effort: if cleanup fails or times out, owners expire naturally according to their respective TTLs (those with `ttl=0` need manual cleanup), without affecting the stop flow.
- Regular sessions: passed through as `acpx prompt --ttl <value>`; the queue owner spun up by that prompt inherits this TTL.
- Orchestration coordinator sessions (with `mcpCoordinatorSession` set): xacpx pre-starts the queue owner before the prompt, and that owner is also started with this TTL (converted to milliseconds internally), so it likewise enjoys the warm window.
- Commands like `sessions new/ensure` and `cancel` themselves do not carry `--ttl` and are not affected.
- Changing this value requires restarting the daemon to take effect.

### Automatic orchestration MCP injection

Before sending a regular prompt to an acpx session, xacpx temporarily starts acpx's queue owner and, via `ACPX_QUEUE_OWNER_PAYLOAD`, injects a stdio MCP server named `xacpx` (the tool prefix is therefore `mcp__xacpx__*`, e.g. `mcp__xacpx__delegate_request`, `mcp__xacpx__scheduled_create`). This way the agent managed by acpx can see orchestration and scheduled-task tools such as `delegate_request` and `scheduled_create`.

This compatibility path does not write to the working directory's `.acpxrc.json`, nor does it modify `~/.acpx/config.json` or replace the acpx home, so it does not affect acpx's existing sessions, stream logs, or `index.json` mapping relationships.

The default injection command is resolved in the following order:

1. `WEACPX_CLI_COMMAND`
2. `WEACPX_DAEMON_ARG0` + the current Node executable
3. The current process entry `process.argv[1]` + the current Node executable
4. `xacpx`

If xacpx is not launched through the standard CLI/daemon, or the path needs special wrapping, you can explicitly set `WEACPX_CLI_COMMAND`, for example:

```bash
WEACPX_CLI_COMMAND="node /path/to/xacpx/dist/cli.js" xacpx run
```

---

## Tool-event routing

### Tool-event mode (`toolEventMode`)

`PromptOptions.toolEventMode` controls how `tool_call` / `tool_call_update`
events are surfaced for a single prompt:

- `"text"` — legacy emoji-prefixed segments folded into the reply text stream.
- `"structured"` — events go to the `onToolEvent` callback only.
- `"both"` — events go to `onToolEvent` AND legacy text segments. Useful for
  migration or debugging.

If omitted, the transport infers the mode at the boundary: `"structured"`
when an `onToolEvent` handler is provided, `"text"` otherwise. This
preserves the behavior every existing channel (Weixin, Yuanbao, Feishu
static, Feishu streaming card) relies on today.

**Async semantics for `onToolEvent`:** transports invoke the callback in
event order and await each invocation before dispatching the next. Prompt
completion waits for all in-flight callbacks to settle. A handler error
rejects the prompt with the first observed error.


---

## `logging`

Runtime logging configuration. Regular application logs are written to `~/.xacpx/runtime/app.log`.

| Field | Type | Required | Description |
|------|------|------|------|
| `level` | `"error"` \| `"info"` \| `"debug"` | No | Application log level, defaults to `"info"` |
| `maxSizeBytes` | `number` | No | Maximum size of a single app.log file, defaults to `2097152` |
| `maxFiles` | `number` | No | Number of rotated app.log files to retain, defaults to `5`; `0` means the current file is deleted directly once it exceeds the size |
| `retentionDays` | `number` | No | Number of days after which expired rotated app.log files are cleaned up, defaults to `7` |
| `perf` | `object` | No | Performance debug logging configuration, see below |

### `logging.perf`

When enabled, xacpx writes the key latencies of a Weixin inbound message from receipt to final outbound completion (the text final; including media send completion if media is present) into a separate file `~/.xacpx/runtime/perf.log`. There is one line per checkpoint, with a final `turn.done` summary line.

| Field | Type | Required | Description |
|------|------|------|------|
| `enabled` | `boolean` | No | Whether to enable perf debug logging, defaults to `false` |
| `maxSizeBytes` | `number` | No | Maximum size of a single perf.log file, defaults to `5242880` |
| `maxFiles` | `number` | No | Number of rotated perf.log files to retain, defaults to `3`; `0` means the current file is deleted directly once it exceeds the size |
| `retentionDays` | `number` | No | Number of days after which expired rotated perf.log files are cleaned up, defaults to `7` |

Note: `logging.perf.enabled` is bound at `buildApp()` time; changing this configuration requires restarting the daemon to take effect. Currently only the built-in Weixin channel is wired into perf tracing; other plugin channels do not write their own turns even with this switch enabled. Weixin outbound media records `reply.media_sent` / `reply.media_done`, and the latency includes the total time for local safety checks, uploading to the Weixin CDN, and sending the media message; it does not break down the upload and send phases separately.

---

## `channel`

Global default configuration for messaging platforms.

### `channel.replyMode`

| Field | Type | Required | Description |
|------|------|------|------|
| `replyMode` | `"stream"` \| `"final"` \| `"verbose"` | No | Reply mode. Defaults to `"verbose"` |

Notes:

- `stream`: when there are intermediate text segments, send them in streaming fashion preferentially
- `final`: suppress intermediate text segments, sending the final text only once at the end
- `verbose`: on top of stream, additionally send real-time events such as tool calls
- This configuration is the **global default value**; a channel may override it via `channels[].replyMode`, and a session may override both via `/replymode`. Precedence: session override → `channels[].replyMode` → `channel.replyMode` → `verbose`.
- You can use `/replymode` to set an override for the **current logical session**
- `/replymode reset` clears the current session override, falling back to the channel default (`channels[].replyMode`) if set, otherwise `channel.replyMode`
- `final` only affects whether text is sent in real time; it does not change how the acpx transport generates output

### `channel.ownerIds`

| Field | Type | Required | Description |
|------|------|------|------|
| `ownerIds` | `string[]` | No | Sender ids the operator trusts as channel owners. Group turns from these senders pass owner-gated command authorization (control commands, `/later`, in-session `scheduled_*` tools) even when the channel protocol carries no group-role information. |

Notes:

- WeChat carries **no group-role information** at the protocol level, so without `ownerIds` every privileged command in a WeChat group is denied for everyone — including the operator. Add your own sender id here to authorize yourself.
- The same field is available per channel as `channels[].ownerIds` (use the sender id format of that channel: WeChat `from_user_id`, Feishu `open_id`, Yuanbao account id).
- A sender in `ownerIds` is treated as owner in addition to whatever the channel itself reports (e.g. Yuanbao's `bot_owner_id` detection still works).
- Setting `ownerIds` to an empty array (`[]`) is an explicit revocation: turns on this channel are recorded with owner = false (unless the channel itself reports an owner), which also clears any previously recorded owner state. Removing the field entirely means "not configured" and leaves channel-reported ownership untouched.
- **How to find your sender id**: send any privileged command (e.g. `/clear`) in the group; the denial is logged to `~/.xacpx/runtime/app.log` as a `command.blocked` entry whose `senderId` field is the id to put into `ownerIds`.

```json
{
  "channel": {
    "type": "weixin",
    "ownerIds": ["wxid_xxxxxxxx"]
  }
}
```

### Backward Compatibility

The `wechat.replyMode` in old configuration files still works; it is automatically mapped to `channel.replyMode` on load. After saving, it is written in the `channel` format.

---

## `channels`

Multi-channel runtime configuration. Defines the list of message channels to start. When omitted, it is generated automatically based on `channel.type` (the old single-channel configuration).

It is recommended to manage this section of configuration through the channel CLI:

```bash
xacpx channel list
xacpx channel add feishu
xacpx channel disable weixin
xacpx restart
```

See full operation instructions in: [docs/channel-management.md](./channel-management.md).

### `ChannelRuntimeConfig`

| Field | Type | Required | Description |
|------|------|------|------|
| `id` | `string` | Yes | Unique channel identifier, must be the same as `type` (built-in: `"weixin"`; plugins: e.g. `"feishu"`, `"yuanbao"`) |
| `type` | `string` | Yes | Channel type. The only built-in channel type is `"weixin"`. `"feishu"` is provided by `@ganglion/xacpx-channel-feishu`, `"yuanbao"` is provided by `@ganglion/xacpx-channel-yuanbao`; other types are provided by installed plugins |
| `enabled` | `boolean` | No | Whether to enable. Defaults to `true` |
| `replyMode` | `"stream"` \| `"final"` \| `"verbose"` | No | Per-channel default reply mode. When set, it overrides the global `channel.replyMode` for this channel; when omitted, the channel falls back to `channel.replyMode`. The per-session `/replymode` override still takes precedence over this. |
| `ownerIds` | `string[]` | No | Per-channel trusted owner sender ids; see [`channel.ownerIds`](#channelownerids). Group turns from these senders pass owner-gated command authorization. |
| `options` | `object` | Depends on the channel | Channel configuration (see Feishu/Yuanbao fields below) |

### Feishu Channel Configuration (`options`)

| Field | Type | Required | Description |
|------|------|------|------|
| `options.appId` | `string` | Required for a single bot; optional for multiple bots | Feishu app App ID. Filling one at the top level is equivalent to "the default account for a single bot"; for multiple bots, write each bot's `appId` under `accounts.<id>.appId`, and the top level may be left empty |
| `options.appSecret` | `string` | Required for a single bot; optional for multiple bots | Feishu app App Secret. Same rule as `appId` |
| `options.domain` | `"feishu"` \| `"lark"` | No | API domain. Defaults to `"feishu"` |
| `options.requireMention` | `boolean` | No | Whether group chats require @-mentioning the bot. Defaults to `true` |
| `options.textMessageFormat` | `"text"` | No | Send format. Currently only `"text"` is supported |
| `options.dedupTtlMs` | `number` | No | Message deduplication TTL (milliseconds). Defaults to `43200000` (12 hours) |
| `options.dedupMaxEntries` | `number` | No | Maximum entries in the dedup cache. Defaults to `5000` |
| `options.defaultAccount` | `string` | No | The default account id in multi-bot mode; when omitted, `default` is preferred, otherwise the first `accounts.<id>` is taken |
| `options.accounts` | `object` | No | Multi-account override configuration indexed by `accountId`; each sub-item may override `appId/appSecret/domain/requireMention/dmPolicy/groupPolicy/allowFrom/enabled/name`. The chatKey looks like `feishu:<accountId>:<chatId>`. See [docs/channel-management.md](./channel-management.md#feishu-multi-bot-multiple-accounts-in-one-channel) |
| `options.dmPolicy` | `"open"` \| `"allowlist"` \| `"disabled"` | No | Direct-message admission policy, defaults to `"open"` (preserves old behavior, accepting direct messages from anyone). With `"allowlist"`, only senders in the `allowFrom` list are accepted; with `"disabled"`, all are discarded |
| `options.groupPolicy` | `"open"` \| `"allowlist"` \| `"disabled"` | No | Group-chat admission policy, defaults to `"open"`. Same semantics as `dmPolicy`; `requireMention` still applies independently |
| `options.allowFrom` | `string[]` | No | Sender `open_id` allowlist; only effective when either policy is `"allowlist"`. Including `"*"` is equivalent to "any sender with an open_id". Cannot be empty in `allowlist` mode |
| `options.replyMode` | `"static"` \| `"streaming"` \| `"auto"` | No | Reply presentation method. Defaults to `"auto"` (direct messages use streaming, group chats use static); `"static"` is multiple independent text messages; `"streaming"` switches to a single CardKit v2 interactive card updated in place within one message (thinking → streaming → complete/aborted/error, with a latency footer that ticks in real time, automatic reasoning collapsing, tool calls rendered in verbose mode as a collapsible **🔧 工具调用** panel rather than inline text, markdown image URL → image_key resolution, character-level streaming updates, and the card automatically driven to a "stopped" state when the daemon exits). The bot needs the `cardkit:card:write` + `im:message:send_as_bot` permissions; if card creation fails the first time, it automatically falls back to static and prints a `feishu.streaming.fallback` log (when permissions are missing, it also sends the authorization link to the user once). You can also override at the account level on `options.accounts.<id>.replyMode` |

### Yuanbao Channel Configuration (`options`, provided by `@ganglion/xacpx-channel-yuanbao`)

The Yuanbao channel is provided by the plugin `@ganglion/xacpx-channel-yuanbao`: the plugin has built-in Yuanbao signing, WebSocket, message send/receive, chatKey routing, inbound → agent, deduplication, per-session serialization, and a basic outbound policy. First run `xacpx plugin add @ganglion/xacpx-channel-yuanbao`, then add the channel; normal users do not need to configure the gateway module.

| Field | Type | Required | Description |
|------|------|------|------|
| `options.appKey` | `string` | Required together with `appSecret` | Yuanbao bot App Key |
| `options.appSecret` | `string` | Required together with `appKey` | Yuanbao bot App Secret |
| `options.token` | `string` | No | Static token; compatible with the `appKey:appSecret` form, which is split into appKey/appSecret on load. A real static auth token requires `botId` to be configured as well |
| `options.gatewayModule` | `string` | No | External gateway override for backward compatibility / development debugging; normal users should not configure it |
| `options.botId` | `string` | No | Bot account ID, used to locally recognize @-mentions and filter self-messages; usually sign-token returns it and it is filled in automatically |
| `options.apiDomain` | `string` | No | Yuanbao API domain, defaults to `"bot.yuanbao.tencent.com"` |
| `options.wsUrl` | `string` | No | Yuanbao WebSocket address, defaults to `"wss://bot-wss.yuanbao.tencent.com/wss/connection"` |
| `options.requireMention` | `boolean` | No | Whether group chats require @-mentioning the bot. Defaults to `true` |
| `options.replyToMode` | `"off"` \| `"first"` \| `"all"` | No | Quote-reply policy, defaults to `"first"` |
| `options.overflowPolicy` | `"stop"` \| `"split"` | No | Overlong-text policy, defaults to `"split"` |
| `options.maxChars` | `number` | No | xacpx outbound text splitting threshold, defaults to `3000` |
| `options.outboundQueueStrategy` | `"immediate"` \| `"merge-text"` | No | Reserved field available to the gateway; xacpx currently does not perform queue merging |
| `options.minChars` / `options.idleMs` | `number` | No | Reserved fields available to the gateway; xacpx currently does not perform idle-time-based merging |
| `options.mediaMaxMb` | `number` | No | Media size limit, defaults to `20` |
| `options.historyLimit` | `number` | No | Reserved field available to the gateway, defaults to `100` |
| `options.disableBlockStreaming` | `boolean` | No | Whether to disable block-style streaming replies, defaults to `false` |
| `options.fallbackReply` | `string` | No | Fallback text sent when the agent returns no text |
| `options.markdownHintEnabled` | `boolean` | No | Reserved field available to the gateway, defaults to `true` |
| `options.accounts` | `object` | No | Multi-account override configuration; sub-items inherit the top-level configuration |

### WeChat Channel Extended Configuration (`openclaw.json`)

The `options` of the built-in weixin channel is currently an empty object; the following fields are read from a separate `openclaw.json` file (the path defaults to `~/.xacpx/state/openclaw.json` and can be overridden with the environment variable `OPENCLAW_CONFIG`). This is an extension point xacpx carried over from openclaw, and **it is not the same file as the main `~/.xacpx/config.json`**.

The file root looks like:
```json
{
  "channels": {
    "openclaw-weixin": {
      "routeTag": "...",
      "botAgent": "MyApp/1.0",
      "accounts": {
        "<accountId>": {
          "routeTag": "...",
          "botAgent": "MyApp/1.0 (account-A)"
        }
      }
    }
  }
}
```

| Field | Type | Required | Description |
|------|------|------|------|
| `routeTag` | `string` \| `number` | No | Written into the `SKRouteTag` request header, used by the backend for gray release / traffic splitting; the account-level `accounts.<id>.routeTag` takes precedence over the top level |
| `botAgent` | `string` | No | UA-style client identifier, written into `base_info.bot_agent`. Syntax `name/version[ (comment)]`, multiple tokens separated by spaces; truncated if overlong (>256 bytes); illegal tokens are silently dropped; falls back to `xacpx` when empty. The account-level `accounts.<id>.botAgent` takes precedence over the top level |
| `accounts.<id>` | `object` | No | Override top-level fields by weixin account id; currently `routeTag` and `botAgent` can be overridden |

### Examples

WeChat only:

```json
{
  "channels": [
    { "id": "weixin", "type": "weixin", "enabled": true }
  ]
}
```

WeChat + Feishu:

```json
{
  "channels": [
    { "id": "weixin", "type": "weixin", "enabled": true },
    {
      "id": "feishu",
      "type": "feishu",
      "enabled": true,
      "options": {
        "appId": "cli_xxx",
        "appSecret": "...",
        "domain": "feishu"
      }
    }
  ]
}
```

Yuanbao (requires installing `@ganglion/xacpx-channel-yuanbao` first):

```json
{
  "plugins": [
    { "name": "@ganglion/xacpx-channel-yuanbao", "enabled": true }
  ],
  "channels": [
    {
      "id": "yuanbao",
      "type": "yuanbao",
      "enabled": true,
      "options": {
        "appKey": "yb_xxx",
        "appSecret": "...",
        "requireMention": true
      }
    }
  ]
}
```

### Backward Compatibility

The `channel.type` in old configuration files still works; a single-channel `channels[]` is generated automatically on load. The new multi-channel configuration is recommended to be managed with `xacpx channel ...`.

The `feishu` object in old Feishu configurations is still read for backward compatibility as a legacy alias; new configurations should uniformly be written into `options`.

---

## `plugins`

External plugin packages installed via `xacpx plugin add <npm-package>`.

| Field | Type | Required | Description |
|------|------|------|------|
| `name` | `string` | Yes | npm package name |
| `version` | `string` | No | The version range or version number recorded at install time |
| `enabled` | `boolean` | No | Whether to load this plugin, defaults to `true` |

`plugins[]` is lifecycle metadata for packages installed under `~/.xacpx/plugins`. It does not enable a channel by itself; `channels[]` still controls which channel runtimes start. After changing plugin install, update, enable, disable, or remove state while the daemon is running, restart the daemon so plugin registration is reloaded.

Installing a plugin only means the channel type is available; it does not automatically enable the channel. Enabling a channel still requires:

```bash
xacpx channel add <channel-type>
```

See [`docs/plugin-development.md`](./plugin-development.md).

---

## `agents`

The registered agent mapping, keyed by agent name (used by `/agent add`, `/session new --agent`).

### Agent Configuration

| Field | Type | Required | Description |
|------|------|------|------|
| `driver` | `string` | Yes | Agent driver type, passed as the first positional argument to acpx |
| `command` | `string` | No | Explicitly specify the raw command for an agent. This has highest priority, including over xacpx-managed Codex/Claude adapter pins |
| `model` | `string` | No | Default LLM model id for this agent's sessions (e.g. `gpt-5.2[high]`), passed to acpx as `--model`. A session-level model (`/session new --model` or `/model`) overrides it. When omitted, the agent adapter's default is used |
| `settingsPolicy` | `"provider-only"` \| `"isolated"` \| `"full-user"` | No | Claude user-settings policy. The implicit default is `"provider-only"`; other drivers ignore this field. See below |

### Claude third-party provider settings

acpx isolates built-in Claude sessions from Claude **user** settings by default. xacpx
adds a narrower compatibility layer for third-party providers configured only in
`~/.claude/settings.json` (or the active `CLAUDE_CONFIG_DIR`). No explicit configuration
is required: `settingsPolicy` implicitly defaults to `"provider-only"`.

`"provider-only"` activates only when xacpx finds a third-party provider marker
(`ANTHROPIC_BASE_URL` or `ANTHROPIC_AUTH_TOKEN`) in the daemon environment or in the
user settings `env` object. It then:

- imports only `ANTHROPIC_*` entries from user settings into that Claude session's
  local acpx process environment;
- maps `model` to `ANTHROPIC_MODEL` and passes only `modelOverrides` and
  `availableModels` through the managed adapter's `CLAUDE_MODEL_CONFIG` seam;
- keeps project/local Claude settings enabled, so their normal precedence is preserved;
- excludes user hooks, plugins, skills, MCP servers, and permissions;
- gives the adapter a filtered settings profile while linking Claude's durable session-state
  directories back to the original profile, so native list/resume and transcript persistence
  continue to use the existing history; Claude-managed runtime directories such as
  `session-env` and `shell-snapshots` remain local to the filtered profile because Claude
  may recreate them during a turn;
- never writes provider credentials to xacpx config/state, disk, or the bridge protocol.

Normal first-party Claude OAuth and `ANTHROPIC_API_KEY`-only setups do not trigger the
compatibility layer and retain the existing behavior.

Two explicit overrides are available per Claude agent:

```json
{
  "agents": {
    "claude": {
      "driver": "claude",
      "settingsPolicy": "isolated"
    }
  }
}
```

- `"isolated"`: hide user settings completely, including provider/model fields.
- `"full-user"`: opt into the original complete user settings. This can execute globally
  configured hooks/plugins in the daemon context, so use it only when that is intentional.

Daemon-level `ANTHROPIC_*` values override values extracted from user settings. An
explicit session model still overrides the agent model, which overrides provider/default
model selection. Do not use the literal model id `default` as a substitute for missing
provider settings; it is a model choice, not a provider configuration source.

Verify the same agent/workspace path that the daemon will use:

```bash
xacpx doctor --smoke --agent claude --workspace <workspace> --verbose
```

Notes:

- For built-in templates, write only `driver`; xacpx pins Codex/Claude adapters, while other drivers use the normal runtime/acpx resolution path
- `agent.command` is mainly for custom agents; it is not recommended to hand-write a raw command for a built-in driver
- The legacy `codex` shim command is automatically ignored on load, falling back to xacpx's current managed Codex adapter pin

### Built-in Templates

The following built-in templates are used when you send `/agent add <name>` via WeChat, or run `xacpx agent add <name>` in the terminal; in the terminal you can also use `xacpx agent templates` to view the template list. Adding an agent that already exists with the same configuration is an idempotent operation; if an agent with the same name already has a different configuration, the command prompts you to delete it first and will not silently overwrite the custom configuration.

| Template Name | driver | command |
|--------|--------|---------|
| `codex` | `"codex"` | None (uses xacpx managed pin) |
| `claude` | `"claude"` | None (uses xacpx managed pin) |
| `pi` | `"pi"` | None (uses acpx default) |
| `openclaw` | `"openclaw"` | None (uses acpx default) |
| `gemini` | `"gemini"` | None (uses acpx default) |
| `cursor` | `"cursor"` | None (uses acpx default) |
| `copilot` | `"copilot"` | None (uses acpx default) |
| `droid` | `"droid"` | None (uses acpx default) |
| `factory-droid` | `"factory-droid"` | None (uses acpx default) |
| `factorydroid` | `"factorydroid"` | None (uses acpx default) |
| `grok-build` | `"grok-build"` | None (uses acpx default) |
| `hermes` | `"hermes"` | None (uses xacpx bundled shim) |
| `iflow` | `"iflow"` | None (uses acpx default) |
| `kilocode` | `"kilocode"` | None (uses acpx default) |
| `kimi` | `"kimi"` | None (uses acpx default) |
| `kiro` | `"kiro"` | None (uses acpx default) |
| `mux` | `"mux"` | None (uses acpx default) |
| `opencode` | `"opencode"` | None (uses acpx default) |
| `qoder` | `"qoder"` | None (uses acpx default) |
| `qwen` | `"qwen"` | None (uses acpx default) |
| `trae` | `"trae"` | None (uses acpx default) |

`hermes` is not in acpx's builtin registry, so xacpx supplies its launch command at spawn time: a bundled stdio shim (`dist/adapters/hermes-acp-shim.js`) that runs `hermes acp` and strips the advertised `sessionCapabilities.resume` from the initialize response. This works around hermes-agent replaying the full transcript on every `session/resume` ([NousResearch/hermes-agent#32201](https://github.com/NousResearch/hermes-agent/issues/32201)) by forcing acpx onto its replay-guarded `session/load` path; the shim command is resolved at runtime and never written into `config.json`. It requires [Hermes Agent](https://hermes-agent.nousresearch.com/) installed locally with its ACP extra (`uv pip install -e '.[acp]'`) and provider credentials configured under `~/.hermes/`. Setting an explicit `agents.<name>.command` (other than the literal `hermes acp`, which is treated as the template default) bypasses the shim. Note that the shim command embeds the node executable and xacpx install paths, so upgrading node or relocating the install changes the command string acpx keys session records by — acpx then starts a fresh backend session record for hermes instead of reusing the old one.

### Example

```json
{
  "agents": {
    "codex": {
      "driver": "codex"
    },
    "claude": {
      "driver": "claude"
    },
    "kimi": {
      "driver": "kimi"
    },
    "my-agent": {
      "driver": "custom",
      "command": "/usr/local/bin/my-agent"
    }
  }
}
```

---

## `workspaces`

The registered workspace mapping, keyed by workspace name (used by `/workspace new`, `/session new --ws`).

When the configuration is first created, a `home` workspace is automatically seeded (with `cwd` as `~`) so it works out of the box; if you do not need it, you can delete it with `xacpx workspace rm home`.

### Workspace Configuration

| Field | Type | Required | Description |
|------|------|------|------|
| `cwd` | `string` | Yes | Workspace path, acpx's `--cwd` argument; supports paths starting with `~`, which is expanded to the user's home directory on load |
| `description` | `string` | No | Description information, used for display by the `/workspaces` command |

### Example

```json
{
  "workspaces": {
    "backend": {
      "cwd": "/Users/name/Projects/backend",
      "description": "backend repo"
    },
    "frontend": {
      "cwd": "/Users/name/Projects/frontend"
    }
  }
}
```

---

## `orchestration`

Controls the default guard policy for when an agent initiates a delegate request.

### `orchestration.*`

| Field | Type | Required | Default | Description |
|------|------|------|--------|------|
| `maxPendingAgentRequestsPerCoordinator` | `number` | No | `3` | The upper limit of agent-initiated delegate tasks simultaneously in `needs_confirmation` / `running` state under a single coordinator |
| `allowWorkerChainedRequests` | `boolean` | No | `false` | Whether to allow worker sessions to initiate further delegate requests. Denied by default to avoid multi-hop fan-out |
| `allowedAgentRequestTargets` | `string[]` | No | `[]` | Allowlist of target agents that an agent may specify when initiating a delegate. An empty array means no additional restriction |
| `allowedAgentRequestRoles` | `string[]` | No | `[]` | Allowlist of roles that an agent may use when initiating a delegate. An empty array means no additional restriction |
| `maxParallelTasksPerAgent` | `number` | No | `3` | The upper limit of parallel delegate tasks each agent may run simultaneously (integer ≥ 1), counted globally across all coordinators and workspaces. `parallel: true` tasks exceeding the limit are created in `queued` state and do not occupy an acpx session; when a slot is freed, they are automatically promoted to `running` in creation-time order and begin execution. `queued` tasks still count toward the `maxPendingAgentRequestsPerCoordinator` quota |
| `progressHeartbeatSeconds` | `number` | No | `300` | Interval (seconds) for emitting progress heartbeats on long-running delegate tasks. Accepts any finite number; falls back to `300` when omitted or non-finite |

### Example

```json
{
  "orchestration": {
    "maxPendingAgentRequestsPerCoordinator": 5,
    "allowWorkerChainedRequests": false,
    "allowedAgentRequestTargets": ["claude", "codex"],
    "allowedAgentRequestRoles": ["reviewer", "planner"],
    "maxParallelTasksPerAgent": 5
  }
}
```

---

## `later`

### `later.defaultMode`

The default execution session mode for scheduled tasks (`/lt`).

- `"temp"` (default): at the scheduled time, create a temporary session to execute, which is destroyed once finished.
- `"bind"`: at the scheduled time, send to the current session that was bound at creation.
- A single task can use `--temp` / `--bind` to override the default value.

---

## `files`

File tree operations configuration for relay-web file browser.

### `files.writeEnabled`

| Field | Type | Required | Description |
|------|------|------|------|
| `writeEnabled` | `boolean` | No | Enable or disable file writes and structured Git mutations in relay-web. Git mutations include stage/unstage/commit, fetch, fast-forward-only pull, push, branch switch/create, and managed worktree creation. Read-only file browsing/download and Git status remain available. Defaults to `false` (write disabled). Requires daemon restart to take effect when changed |

### Example

```json
{
  "files": {
    "writeEnabled": true
  }
}
```

---

## Environment Variable Overrides

The following environment variables can override configuration file paths:

| Environment Variable | Description |
|----------|------|
| `WEACPX_CONFIG` | Configuration file path (defaults to `~/.xacpx/config.json`) |
| `WEACPX_STATE` | State file path (defaults to `~/.xacpx/state.json`) |
| `WEACPX_WEIXIN_SDK` | Force-specify the weixin-agent-sdk entry file path |
| `WEACPX_ILINK_APP_ID` | The `iLink-App-Id` header carried by the WeChat channel's outbound requests. When left empty, this header is not sent (backward compatible) |

---

## Minimal Configuration

The following configuration is enough to start normally:

```json
{
  "transport": {},
  "agents": {},
  "workspaces": {},
  "orchestration": {}
}
```

`transport.type` defaults to `"acpx-bridge"`, and other fields can be left empty or omitted. agents and workspaces can be left empty for now and created later via commands in chat.

---

## Modifying Configuration via Chat Commands

xacpx supports modifying **some supported fields** via `/config` and `/config set <path> <value>`.

Note:

- `/config` is not an arbitrary JSON editor
- Only paths in the allowlist may be modified
- `agents.<name>.*` / `workspaces.<name>.*` may only be modified when the target already exists

See [`docs/config-command.md`](./config-command.md).
