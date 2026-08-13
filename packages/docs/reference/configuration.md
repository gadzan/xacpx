# Configuration Reference

`~/.xacpx/config.json` is the main configuration file for xacpx. To manage chat channels (WeChat, Feishu, Yuanbao) from the terminal, see [Channel Management](/guide/channel-management). To modify a subset of fields from within the chat interface, see the [/config Command](/reference/config-command).

## File locations

| File | Default path | Purpose |
|------|-------------|---------|
| Config | `~/.xacpx/config.json` | Main configuration |
| State | `~/.xacpx/state.json` | Sessions, chat contexts, daemon state |
| Plugins | `~/.xacpx/plugins/` | Plugin packages installed by `xacpx plugin add` |
| Runtime logs | `~/.xacpx/runtime/app.log` | Application log |
| Performance log | `~/.xacpx/runtime/perf.log` | Performance debug log (when enabled) |

Environment variable overrides:

| Variable | Description |
|----------|-------------|
| `WEACPX_CONFIG` | Override the config file path (default: `~/.xacpx/config.json`) |
| `WEACPX_STATE` | Override the state file path (default: `~/.xacpx/state.json`) |
| `WEACPX_WEIXIN_SDK` | Force a specific `weixin-agent-sdk` entry file path |
| `WEACPX_ILINK_APP_ID` | `iLink-App-Id` header sent with WeChat channel outbound requests; omit to suppress the header (backward-compatible) |

## Top-level schema

```jsonc
{
  "language": "en",
  "transport": { ... },
  "logging": { ... },
  "channel": { ... },
  "channels": [ ... ],
  "plugins": [ ... ],
  "agents": { ... },
  "workspaces": { ... },
  "orchestration": { ... },
  "later": { ... }
}
```

**Minimal working config:** the following is enough to start xacpx. `transport.type` defaults to `"acpx-bridge"`; `agents` and `workspaces` can be populated later via chat commands.

```json
{
  "transport": {},
  "agents": {},
  "workspaces": {},
  "orchestration": {}
}
```

## Language

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `language` | `"en"` \| `"zh"` | No | Selects the language for all xacpx runtime output (chat replies, CLI output, orchestration prompts, messages). When absent, the language is inferred from the system locale on first run (`$LC_ALL`/`$LC_MESSAGES`/`$LANG`: starts with `zh` → Chinese, otherwise English) and persisted to config. Changeable in chat with `/config set language en`. Takes full effect after `xacpx restart`. |

## Transport configuration

Controls how xacpx communicates with the `acpx` backend.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"acpx-cli"` \| `"acpx-bridge"` | No | Communication mode (default: `"acpx-bridge"`) |
| `command` | `string` | No | Explicit path to the `acpx` binary; overrides automatic resolution |
| `sessionInitTimeoutMs` | `number` | No | Session initialization timeout in milliseconds (default: `120000`) |
| `permissionMode` | `"approve-all"` \| `"approve-reads"` \| `"deny-all"` | No | Permission mode; **defaults to `"approve-all"` when omitted**, so non-interactive prompt turns do not stop on permission requests unless a stricter policy is explicitly configured |
| `nonInteractivePermissions` | `"deny"` \| `"fail"` | No | Policy for non-interactive scenarios (default: `"deny"`) |
| `permissionPolicy` | `string` | No | Path to an `acpx` permission policy file; passed as `acpx --permission-policy <value>` |
| `queueOwnerTtlSeconds` | `number` | No | Idle lifetime of the `acpx` queue owner process in seconds; passed as `--ttl` (default: `1800`; `0` = keep alive indefinitely) |

### Transport types

**`"acpx-cli"`** — spawns a new `acpx` child process for each operation (prompt/cancel/ensureSession). Uses `node-pty` for PTY allocation. Suitable for local development and debugging.

**`"acpx-bridge"`** — starts a persistent bridge subprocess (`bridge-main.ts`). All operations are sent via stdin/stdout JSON RPC; the `acpx` process does not restart between commands. Suitable for production and long-running deployments.

### `acpx` binary resolution order

When `transport.command` is not set, xacpx looks for `acpx` in this order:

1. `node_modules/.bin/acpx` (bundled in the project)
2. `acpx` on the shell `PATH`

Setting `transport.command` explicitly overrides this lookup entirely.

### Reducing cold starts (`queueOwnerTtlSeconds`)

When `acpx` receives a prompt it starts a **queue owner** background process that holds the ACP agent and model context. Each subsequent message from xacpx connects to the same owner via Unix socket — skipping the adapter boot + `session/new`/`load` cold start (typically a few seconds to tens of seconds).

The owner's idle lifetime is set by `--ttl`. xacpx defaults to `1800` seconds (30 minutes), which covers most conversational pauses. After genuine idleness the agent reclaims automatically within 30 minutes.

- Larger values (e.g. `3600`) keep agents warmer but extend the residual window after the daemon stops.
- `0` = keep alive indefinitely; every session maintains a persistent agent process; highest resource use.
- On `xacpx stop`, xacpx terminates the queue owner processes for its known sessions (best-effort; failures do not block shutdown). Sessions with `ttl=0` that survive an unclean shutdown require manual cleanup.
- Changing this value requires restarting the daemon.

### Orchestration MCP auto-injection

Before sending a prompt to an `acpx` session, xacpx starts the `acpx` queue owner and injects an MCP stdio server named `xacpx` via `ACPX_QUEUE_OWNER_PAYLOAD`. The MCP tool prefix is therefore `mcp__xacpx__*` (for example `mcp__xacpx__delegate_request`). This gives the managed agent access to orchestration tools (`delegate_request`, etc.) and scheduled-task tools.

This injection does not modify `.acpxrc.json`, `~/.acpx/config.json`, or replace the `acpx` home directory, so existing sessions, stream logs, and index mappings are unaffected.

Injection command resolution order:
1. `WEACPX_CLI_COMMAND` environment variable
2. `WEACPX_DAEMON_ARG0` + current Node executable
3. `process.argv[1]` + current Node executable
4. `xacpx`

If xacpx is not launched via the standard CLI or daemon, set `WEACPX_CLI_COMMAND` explicitly:

```bash
WEACPX_CLI_COMMAND="node /path/to/xacpx/dist/cli.js" xacpx run
```

## Agents

Registered agent map. Keys are agent names used by `/agent add`, `/session new --agent`, etc.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `driver` | `string` | Yes | Agent driver type; passed as the first positional argument to `acpx` |
| `command` | `string` | No | Raw command for a custom agent; not recommended for built-in drivers |

Built-in templates (use `driver` only; let `acpx` resolve the alias):

| Template | Driver |
|----------|--------|
| `codex` | `"codex"` |
| `claude` | `"claude"` |
| `pi` | `"pi"` |
| `openclaw` | `"openclaw"` |
| `gemini` | `"gemini"` |
| `cursor` | `"cursor"` |
| `copilot` | `"copilot"` |
| `droid` | `"droid"` |
| `factory-droid` | `"factory-droid"` |
| `factorydroid` | `"factorydroid"` |
| `grok-build` | `"grok-build"` |
| `iflow` | `"iflow"` |
| `kilocode` | `"kilocode"` |
| `kimi` | `"kimi"` |
| `kiro` | `"kiro"` |
| `mux` | `"mux"` |
| `omp` | `"omp"` |
| `opencode` | `"opencode"` |
| `qoder` | `"qoder"` |
| `qwen` | `"qwen"` |
| `reasonix` | `"reasonix"` |
| `trae` | `"trae"` |

Add templates via chat with `/agent add <name>` or from the terminal with `xacpx agent add <name>`. Adding an agent that already has the same configuration is idempotent; a name conflict with different settings prompts you to delete first.

```json
{
  "agents": {
    "codex": { "driver": "codex" },
    "claude": { "driver": "claude" },
    "kimi": { "driver": "kimi" },
    "my-agent": { "driver": "custom", "command": "/usr/local/bin/my-agent" }
  }
}
```

## Workspaces

Registered workspace map. Keys are workspace names used by `/workspace new`, `/session new --ws`, etc.

A `home` workspace (`cwd: "~"`) is seeded automatically on first run; remove it with `xacpx workspace rm home`.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cwd` | `string` | Yes | Workspace path; passed as `acpx --cwd`; supports `~` expansion |
| `description` | `string` | No | Description shown in `/workspaces` output |

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

## Channels

The `channels` array lists which message channel runtimes to start.

Manage channels from the terminal:

```bash
xacpx channel list
xacpx channel add feishu
xacpx channel disable weixin
xacpx restart
```

### `ChannelRuntimeConfig` fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | Yes | Unique channel identifier; must match `type` (built-in: `"weixin"`; plugins: `"feishu"`, `"yuanbao"`, etc.) |
| `type` | `string` | Yes | Channel type. Built-in: `"weixin"`. `"feishu"` from `@ganglion/xacpx-channel-feishu`; `"yuanbao"` from `@ganglion/xacpx-channel-yuanbao` |
| `enabled` | `boolean` | No | Whether the channel is active (default: `true`) |
| `options` | `object` | Varies | Channel-specific configuration (see below) |

### Feishu channel options

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `options.appId` | `string` | Required in single-bot mode | Feishu App ID |
| `options.appSecret` | `string` | Required in single-bot mode | Feishu App Secret |
| `options.domain` | `"feishu"` \| `"lark"` | No | API domain (default: `"feishu"`) |
| `options.requireMention` | `boolean` | No | Require @mention in group chats (default: `true`) |
| `options.textMessageFormat` | `"text"` | No | Message send format; currently only `"text"` |
| `options.dedupTtlMs` | `number` | No | Message deduplication TTL in milliseconds (default: `43200000` — 12 hours) |
| `options.dedupMaxEntries` | `number` | No | Maximum deduplication cache entries (default: `5000`) |
| `options.defaultAccount` | `string` | No | Default account ID for multi-bot mode; falls back to `"default"` then the first entry |
| `options.accounts` | `object` | No | Per-account overrides indexed by `accountId`; each entry can override `appId`, `appSecret`, `domain`, `requireMention`, `dmPolicy`, `groupPolicy`, `allowFrom`, `enabled`, `name` |
| `options.dmPolicy` | `"open"` \| `"allowlist"` \| `"disabled"` | No | Direct-message admission policy (default: `"open"`) |
| `options.groupPolicy` | `"open"` \| `"allowlist"` \| `"disabled"` | No | Group-chat admission policy (default: `"open"`); `requireMention` still applies independently |
| `options.allowFrom` | `string[]` | No | Sender `open_id` allowlist; active when either policy is `"allowlist"` |
| `options.replyMode` | `"static"` \| `"streaming"` \| `"auto"` | No | Reply rendering mode; default `"auto"` (DM → streaming, group → static). `"streaming"` uses a CardKit v2 interactive card that updates in place (thinking → streaming → complete/aborted/error, with realtime footer timer, reasoning folding, collapsible tool-call panels in verbose mode, markdown image URL → image_key resolution, character-level streaming). Requires `cardkit:card:write` + `im:message:send_as_bot` bot permissions; falls back to `static` on first-card failure and logs `feishu.streaming.fallback`. Can be overridden per account with `options.accounts.<id>.replyMode` |

### Yuanbao channel options

Provided by `@ganglion/xacpx-channel-yuanbao`. Install with `xacpx plugin add @ganglion/xacpx-channel-yuanbao`, then add the channel.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `options.appKey` | `string` | Yes (with `appSecret`) | Yuanbao bot App Key |
| `options.appSecret` | `string` | Yes (with `appKey`) | Yuanbao bot App Secret |
| `options.token` | `string` | No | Static token; also accepts `appKey:appSecret` form (split on load). True static auth token requires `botId` too |
| `options.botId` | `string` | No | Bot account ID for @-mention recognition and self-message filtering; usually returned by sign-token and filled automatically |
| `options.apiDomain` | `string` | No | Yuanbao API domain (default: `"bot.yuanbao.tencent.com"`) |
| `options.wsUrl` | `string` | No | Yuanbao WebSocket URL (default: `"wss://bot-wss.yuanbao.tencent.com/wss/connection"`) |
| `options.requireMention` | `boolean` | No | Require @mention in group chats (default: `true`) |
| `options.replyToMode` | `"off"` \| `"first"` \| `"all"` | No | Quote-reply strategy (default: `"first"`) |
| `options.overflowPolicy` | `"stop"` \| `"split"` | No | Overflow strategy for long output (default: `"split"`) |
| `options.maxChars` | `number` | No | Character count threshold for splitting outbound text (default: `3000`) |
| `options.mediaMaxMb` | `number` | No | Maximum media size in MB (default: `20`) |
| `options.fallbackReply` | `string` | No | Text sent when the agent returns no text output |
| `options.accounts` | `object` | No | Per-account overrides; entries inherit top-level config |

### WeChat extended configuration (`openclaw.json`)

The built-in `weixin` channel `options` is an empty object. Additional WeChat fields are read from `~/.xacpx/state/openclaw.json` (override path via `OPENCLAW_CONFIG`). This is separate from `~/.xacpx/config.json`.

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
|-------|------|----------|-------------|
| `routeTag` | `string` \| `number` | No | Written to the `SKRouteTag` request header for backend routing or A/B testing; account-level takes precedence |
| `botAgent` | `string` | No | Client identifier written to `base_info.bot_agent`; syntax `name/version[ (comment)]`; truncated at 256 bytes; falls back to `xacpx` when empty; account-level takes precedence |
| `accounts.<id>` | `object` | No | Per-account overrides for `routeTag` and `botAgent` |

### Legacy compatibility

- `channel.type` (old single-channel config) is still loaded and mapped to a single-entry `channels[]` automatically.
- The old `feishu` top-level object is still recognized as a legacy alias; new configs should use `options`.
- `wechat.replyMode` is still mapped to `channel.replyMode` on load.

## Permissions

The `/pm` (or `/permission`) command exposes these configuration values in chat:

| `/pm` command | Config value | Effect |
|--------------|-------------|--------|
| `/pm set allow` | `transport.permissionMode: "approve-all"` | More operations auto-approved |
| `/pm set read` | `transport.permissionMode: "approve-reads"` | Reads auto-approved; writes more cautious |
| `/pm set deny` | `transport.permissionMode: "deny-all"` | Deny operations requiring approval |
| `/pm auto deny` | `transport.nonInteractivePermissions: "deny"` | Auto-deny in non-interactive contexts |
| `/pm auto fail` | `transport.nonInteractivePermissions: "fail"` | Fail immediately in non-interactive contexts |

## Defaults

### Logging

| Field | Default |
|-------|---------|
| `logging.level` | `"info"` |
| `logging.maxSizeBytes` | `2097152` (2 MB) |
| `logging.maxFiles` | `5` |
| `logging.retentionDays` | `7` |
| `logging.perf.enabled` | `false` |
| `logging.perf.maxSizeBytes` | `5242880` (5 MB) |
| `logging.perf.maxFiles` | `3` |
| `logging.perf.retentionDays` | `7` |

The `logging.perf` tracer is bound at `buildApp()` time; changing it requires a daemon restart. Only the built-in WeChat channel writes perf traces; other channels do not emit turns even when the option is enabled.

### Reply mode

`channel.replyMode` defaults to `"verbose"`. Set a per-session override with `/replymode`; clear it with `/replymode reset`.

### Scheduled tasks

`later.defaultMode` defaults to `"temp"` (execute in a temporary session). Set to `"bind"` to execute in the session that created the task.

### Orchestration

| Field | Default |
|-------|---------|
| `orchestration.maxPendingAgentRequestsPerCoordinator` | `3` |
| `orchestration.allowWorkerChainedRequests` | `false` |
| `orchestration.allowedAgentRequestTargets` | `[]` (no restriction) |
| `orchestration.allowedAgentRequestRoles` | `[]` (no restriction) |
| `orchestration.progressHeartbeatSeconds` | `300` (falls back to `300` when omitted or non-finite) |
| `orchestration.maxParallelTasksPerAgent` | `3` |

## Examples

### Full example

```json
{
  "language": "en",
  "transport": {
    "type": "acpx-bridge",
    "command": "acpx",
    "sessionInitTimeoutMs": 120000,
    "permissionMode": "approve-all",
    "nonInteractivePermissions": "deny",
    "queueOwnerTtlSeconds": 1800
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
    "codex": { "driver": "codex" },
    "claude": { "driver": "claude" }
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

### WeChat only

```json
{
  "channels": [
    { "id": "weixin", "type": "weixin", "enabled": true }
  ]
}
```

### WeChat + Feishu

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

### Yuanbao (requires `@ganglion/xacpx-channel-yuanbao`)

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

### Tighter orchestration limits

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
