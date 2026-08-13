# Message Channel Management

xacpx can start multiple message channels at the same time. Currently built in:

- `weixin`: WeChat channel, uses QR code login.

Provided by plugins:

- `feishu`: Feishu channel, provided by `@ganglion/xacpx-channel-feishu`, uses the `App ID` / `App Secret` of a Feishu custom (self-built) app.
- `yuanbao`: Yuanbao channel, provided by `@ganglion/xacpx-channel-yuanbao`, uses `appKey` / `appSecret`, with the Yuanbao signing and WebSocket gateway built in.

Everyday users only need the quick steps in the README; this document records the more complete channel management commands, Feishu configuration, and troubleshooting.

---

## Basic Concepts

Channel configuration is written in the `channels[]` of `~/.xacpx/config.json`. We recommend managing it with the CLI rather than editing the JSON by hand:

```bash
xacpx channel list
xacpx channel show <type>
xacpx channel add <type>
xacpx channel rm <type>
xacpx channel enable <type>
xacpx channel disable <type>
```

`channel` can be abbreviated as `ch`:

```bash
xacpx ch list
xacpx ch show feishu
```

Current limitation: only one instance can be configured per channel type, so the channel `id` must equal its `type`, for example `weixin`, `feishu`, `yuanbao`.

`channel rm <type>` also clears that channel's **stored credentials** (e.g. the relay instance credential at `~/.xacpx/relay/credential.json`, or the WeChat login), so a later re-add re-pairs/re-logs-in cleanly instead of silently reusing an orphaned credential. Pass `--keep-credentials` to remove only the config entry and leave the stored credential in place (e.g. when temporarily disabling a channel without re-authenticating).

---

## WeChat Channel

WeChat still uses the original QR code model:

```bash
xacpx login
xacpx start
```

Log out of WeChat:

```bash
xacpx logout
```

Note: `login` and `logout` only operate on WeChat; they will not log in to or out of Feishu.

If the configuration has no explicit `channels[]`, xacpx will automatically generate an enabled WeChat channel based on the legacy configuration.

---

## Feishu Channel

### 1. Prepare the Feishu App

You need a Feishu custom (self-built) app, and obtain:

- `App ID`
- `App Secret`

Usually you also need to:

- Enable the bot capability.
- Add the bot to the direct chat or group chat you want to use.
- Give the app the permissions required to receive and send messages, and publish it to an available scope.

The Feishu platform pages and permission names may change; rely on the current Feishu Open Platform interface as the source of truth.

### 2. Add the Feishu Channel

Feishu is provided by the first-party plugin package `@ganglion/xacpx-channel-feishu`. Install the plugin before adding the channel:

```bash
xacpx plugin add @ganglion/xacpx-channel-feishu
xacpx channel add feishu
```

We recommend interactive input to avoid leaving the `appSecret` in shell history:

```bash
xacpx channel add feishu
```

Enter as prompted:

```text
Feishu appId:
Feishu appSecret:
```

You can also add it all at once with parameters, which suits scripts or temporary environments:

```bash
xacpx channel add feishu \
  --app-id cli_xxx \
  --app-secret your_secret
```

Optional parameters:

```bash
xacpx channel add feishu \
  --app-id cli_xxx \
  --app-secret your_secret \
  --domain feishu \
  --require-mention true
```

Notes:

- `--domain feishu`: the default value, suitable for Feishu.
- `--domain lark`: suitable for Lark.
- `--require-mention true`: in group chats, by default the bot must be @-mentioned before a message is processed.
- `--require-mention false`: in group chats the bot does not need to be @-mentioned; use with caution.

### 3. Restart the daemon

After changing channel configuration, the daemon needs to reload the configuration:

```bash
xacpx restart
```

If you only want to use Feishu, we recommend disabling the WeChat channel first, to avoid the daemon waiting for a WeChat QR code scan at startup:

```bash
xacpx channel disable weixin
xacpx restart
```

If you want to use WeChat and Feishu at the same time, keep `weixin` enabled and first complete:

```bash
xacpx login
```

You can also add it directly when changing channels:

```bash
xacpx channel add feishu --restart
```

If you don't want to restart immediately:

```bash
xacpx channel add feishu --no-restart
```

### 4. Using It in Feishu

After adding the bot to a conversation, send the same xacpx commands in Feishu as in WeChat:

```text
/ss codex -d /absolute/path/to/your/repo
/help
```

After that, just send plain text to enter the current session.

---

## Yuanbao Channel Plugin

Yuanbao is provided by the first-party plugin package `@ganglion/xacpx-channel-yuanbao` (config parsing, Yuanbao signing, WebSocket, message send/receive, chatKey routing, agent invocation, task notifications).

```bash
xacpx plugin add @ganglion/xacpx-channel-yuanbao
xacpx channel add yuanbao --app-key <key> --app-secret <secret>
xacpx restart
```

If the existing configuration has `type: "yuanbao"` enabled but the plugin is not yet installed, startup will prompt:

```text
频道 yuanbao 需要安装插件：xacpx plugin add @ganglion/xacpx-channel-yuanbao
```

Optional parameters:

```bash
xacpx channel add yuanbao \
  --app-key yb_xxx \
  --app-secret your_secret \
  --bot-id bot_123 \
  --require-mention true \
  --ws-url wss://bot-wss.yuanbao.tencent.com/wss/connection \
  --api-domain bot.yuanbao.tencent.com
```

### Yuanbao Multi-Bot (Multiple Accounts in One Channel)

Yuanbao also supports multiple accounts in a single channel, and the CLI usage is fully aligned with Feishu:

```bash
# First time adding a bot: the yuanbao channel is created automatically
xacpx channel add yuanbao --account main \
    --app-key yb_main --app-secret secret_main

# Add another bot
xacpx channel add yuanbao --account ops \
    --app-key yb_ops --app-secret secret_ops --require-mention false

# View the resolved summary for an account (appSecret is always masked)
xacpx channel show yuanbao --account main

# Temporarily take offline / re-enable
xacpx channel disable yuanbao --account ops
xacpx channel enable  yuanbao --account ops

# Remove a bot; when the last *enabled* account is removed the entire yuanbao channel
# is also deleted, but only when "there is still another enabled channel"; if all
# remaining accounts are disabled this is likewise blocked.
xacpx channel rm yuanbao --account ops
```

The upgrade path is identical to Feishu: an old flat single-bot configuration is automatically migrated into `accounts.default = {...the old per-bot fields}` plus the new account on the first `xacpx channel add yuanbao --account <id> ...`. The specific rules:

- **Kept at the top level** (cross-account fields): `gatewayModule` / `defaultAccount`.
- **Embedded into `accounts.default`** (per-bot fields): `appKey` / `appSecret` / `token` / `botId` / `apiDomain` / `wsUrl` / `requireMention` / `replyToMode` / `overflowPolicy` / `outboundQueueStrategy` / `minChars` / `maxChars` / `idleMs` / `mediaMaxMb` / `historyLimit` / `disableBlockStreaming` / `fallbackReply` / `markdownHintEnabled` / `debugBotIds`, plus any other fields not on the top-level allowlist.
- A channel with `enabled: false` is likewise re-enabled automatically.

A chatKey looks like `yuanbao:<accountId>:<chatType>:<target>`, where `chatType` is `direct` or `group`, and `target` is the account / group identifier on the Yuanbao side (for example `yuanbao:main:direct:<peer>` or `yuanbao:ops:group:<groupId>`).

> Current limitation: `channel add yuanbao --account <id>` only exposes the flags `--app-key / --app-secret / --token / --bot-id / --api-domain / --ws-url / --require-mention / --max-chars / --idle-ms`; `replyToMode / overflowPolicy / outboundQueueStrategy / minChars / mediaMaxMb / historyLimit / disableBlockStreaming / fallbackReply / markdownHintEnabled / debugBotIds` still require hand-editing the JSON under `accounts.<id>`.

> ⚠️ Changing `defaultAccount` likewise causes old chatKeys to lose routing (the state carries `yuanbao:default:...`). If you want to switch the default, we recommend keeping an `accounts.default` alias.

---

## Viewing and Managing Channels

View all channels:

```bash
xacpx channel list
```

View the details of a channel:

```bash
xacpx channel show feishu
```

`appSecret` is displayed as `***` and is never printed verbatim.

Disable a channel:

```bash
xacpx channel disable feishu
xacpx restart
```

Re-enable a channel:

```bash
xacpx channel enable feishu
xacpx restart
```

Delete a channel:

```bash
xacpx channel rm feishu
xacpx restart
```

xacpx does not allow deleting or disabling the last enabled channel, to avoid the daemon starting up with no message entry point at all.

---

## Configuration File Shape

The CLI writes `channels[]`, like:

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
        "appSecret": "your_secret",
        "domain": "feishu",
        "requireMention": true,
        "textMessageFormat": "text",
        "dedupTtlMs": 43200000,
        "dedupMaxEntries": 5000
      }
    }
  ]
}
```

`channel.replyMode` is still the global default reply mode; the channel CLI does not switch channels by modifying `channel.type`.

按频道设置默认回复模式：

```bash
xacpx channel set-reply-mode feishu final
xacpx restart
```

`channels[].replyMode` 覆盖全局 `channel.replyMode`，但仍低于会话级 `/replymode`。优先级：会话覆盖 → 频道默认 → 全局默认 → `verbose`。`/config set channels.<id>.replyMode` 是运行时热改路径；`xacpx channel set-reply-mode` 改盘后需 `xacpx restart` 生效。

For the full field descriptions, see: [docs/config-reference.md](./config-reference.md).

### Feishu Multi-Bot (Multiple Accounts in One Channel)

The Feishu channel supports hanging multiple bots inside **a single channel**; each bot connects to the Feishu WebSocket with its own `appId/appSecret`, and inbound messages are routed per bot to the chatKey prefix `feishu:<accountId>:<chatId>`, without interfering with one another.

#### CLI Usage (Recommended)

`xacpx channel add/rm/enable/disable/show feishu --account <id>` supports the full multi-bot workflow, with no need to hand-edit `config.json`:

```bash
# 1) First time adding a bot: the feishu channel is created automatically
xacpx channel add feishu --account main \
    --app-id cli_main --app-secret secret_main

# 2) Add another bot
xacpx channel add feishu --account ops \
    --app-id cli_ops --app-secret secret_ops --require-mention false

# 3) View the resolved summary for an account (appSecret is always masked)
xacpx channel show feishu --account ops

# 4) Temporarily take a bot offline without deleting its config
xacpx channel disable feishu --account ops
xacpx channel enable  feishu --account ops

# 5) Remove a bot; when the last *enabled* account is removed the entire feishu channel
#    is also deleted, but only when "there is still another enabled channel"; if all
#    remaining accounts are disabled this is likewise blocked.
xacpx channel rm feishu --account ops
```

Upgrade path: if `~/.xacpx/config.json` already contains a **flat** single-bot configuration (writing `appId/appSecret` directly at the top level), the first `xacpx channel add feishu --account <id> ...` makes the CLI automatically migrate the old configuration into `accounts.default = {...the old per-bot fields}`, and hang the new account under `accounts.<id>`. The specific rules:

- **Kept at the top level** (cross-account fields): `textMessageFormat` / `dedupTtlMs` / `dedupMaxEntries` / `defaultAccount`.
- **Embedded into `accounts.default`** (per-bot fields): `appId` / `appSecret` / `domain` / `requireMention` / `dmPolicy` / `groupPolicy` / `allowFrom`, plus any other fields not on the top-level allowlist.
- If the channel was previously `enabled: false`, `add --account` will incidentally set it back to `enabled: true` and print a hint line, so that the user doesn't think it's already active after adding the bot.

> Current limitation: `channel add feishu --account <id>` does not yet support setting `dmPolicy / groupPolicy / allowFrom`; these fields still require hand-editing the JSON under `accounts.<id>`. The `--dm-policy / --group-policy / --allow-from` flags may be added later.

#### Hand-Editing config.json (Fallback)

Write the following JSON into `~/.xacpx/config.json`, and after editing run `xacpx restart`:

```jsonc
{
  "channels": [{
    "id": "feishu",
    "type": "feishu",
    "enabled": true,
    "options": {
      "defaultAccount": "main",
      "domain": "feishu",
      "requireMention": true,
      "accounts": {
        "main":   { "appId": "cli_main",   "appSecret": "secret_main" },
        "review": { "appId": "cli_review", "appSecret": "secret_review", "requireMention": false }
      }
    }
  }]
}
```

Field descriptions:

- `accounts` is an object indexed by `accountId`, **not** an array.
- The top-level `domain / requireMention / appId / appSecret` serve as the defaults for each account; each `accounts.<id>` can override these fields.
- `defaultAccount` selects the default account; when omitted, `default` is preferred, otherwise the first `accounts.<id>` is used.
- There must be at least one account that has `enabled !== false` and also has both `appId/appSecret` configured, otherwise the daemon will reject that channel at startup.
- It is not allowed to achieve multi-bot by adding new `channels[]` instances (`{ "id": "feishu-review", "type": "feishu" }`) — that shape is still rejected by the `id === type` validation.

When troubleshooting, always use `xacpx channel show feishu` to see whether each account is recognized (`appSecret` is still masked to `***`).

> ⚠️ **Changing `defaultAccount` causes old chatKeys to lose routing**: sessions in the state file store the chatKey prefix (such as `feishu:default:oc_xxx`). If you change `defaultAccount` from `default` to another value and do **not** keep an `accounts.default` with the same name, old sessions will be unable to send or receive because `feishu account "default" is not started`. Two ways out:
>
> - Keep `accounts.default` (recommended, zero migration): you can change `defaultAccount` however you like, as long as `accounts.default` always exists.
> - Re-attach the old sessions to the chatKey prefix of the new accountId, or simply clear the old session state and start over.

### Feishu DM/Group Admission Policy

To avoid exposing an outward-facing Feishu bot nakedly to strangers, Feishu accounts support an admission policy based on the sender's `open_id`. The default `open` is equivalent to the historical behavior (anyone can send messages), and it only tightens when you explicitly switch to `allowlist` or `disabled`. The configuration takes effect independently per account; with multiple bots you can keep one bot fully open and another bot for ops use only.

```jsonc
{
  "channels": [{
    "id": "feishu",
    "type": "feishu",
    "enabled": true,
    "options": {
      "defaultAccount": "main",
      "accounts": {
        "main": {
          "appId": "cli_main",
          "appSecret": "secret_main",
          "dmPolicy": "open",
          "groupPolicy": "open"
        },
        "ops": {
          "appId": "cli_ops",
          "appSecret": "secret_ops",
          "dmPolicy": "allowlist",
          "groupPolicy": "allowlist",
          "allowFrom": ["ou_admin1", "ou_admin2"]
        }
      }
    }
  }]
}
```

Field semantics:

- `dmPolicy`: direct-chat admission. `open` (default) = allow; `allowlist` = only accept senders in the `allowFrom` list; `disabled` = drop everything.
- `groupPolicy`: group-chat admission, same semantics as above. `requireMention` still takes effect independently — the message must first pass the policy, then the mention is evaluated.
- `allowFrom`: an array of sender `open_id`s, effective only in `allowlist` mode. Including `"*"` means "any sender that has an `open_id`" (it can still block events with a missing `open_id`).
- When either policy is `allowlist`, `allowFrom` cannot be empty, otherwise the daemon will reject that channel at startup.

**Messages rejected by the policy**: xacpx silently drops them (does not reply "no permission"), and only records `accountId/messageId/chatType/senderOpenId/reason` under `feishu.message.policy_denied` in `~/.xacpx/runtime/app.log`, for later auditing. The reason values are: `dm_disabled`, `group_disabled`, `sender_not_allowlisted`, `missing_sender_id`.

---

## Secret Security

The current version stores the Feishu/Yuanbao `appSecret` locally in `~/.xacpx/config.json`.

Recommendations:

- Prefer the interactive `xacpx channel add feishu` / `xacpx channel add yuanbao` to enter secrets.
- Avoid writing `--app-secret` directly in shared terminals, CI logs, or shell history.
- Do not commit a real `config.json` to Git.

---

## FAQ

### Feishu doesn't take effect after adding

First confirm whether you restarted the daemon:

```bash
xacpx restart
xacpx status
```

Then check whether the channel is enabled:

```bash
xacpx channel list
xacpx channel show feishu
```

### Sending a message in a group gets no response

If `requireMention` is `true`, group messages need to @-mention the bot. You can verify the configuration:

```bash
xacpx channel show feishu
```

If you really want group chats to respond without an @-mention, you can delete and re-add it:

```bash
xacpx channel rm feishu --no-restart
xacpx channel add feishu --require-mention false
xacpx restart
```

### `channel add feishu` reports missing parameters

A non-interactive environment will not pop up input prompts, so you need to pass the parameters explicitly:

```bash
xacpx channel add feishu --app-id cli_xxx --app-secret your_secret
```

### The existing channel configuration is different

Only one instance per channel type is currently allowed. If you want to switch the Feishu app, delete it first and then add:

```bash
xacpx channel rm feishu
xacpx channel add feishu
xacpx restart
```

---

## Plugin Management

Non-WeChat channels (Feishu, Yuanbao, third-party) are distributed as npm plugins. There are two layers:

- **Plugin** (`plugin`): manages installation, upgrade, uninstallation, and enable / disable of the npm package itself.
- **Channel** (`channel`): manages the `channels[]` in `~/.xacpx/config.json`, deciding which channels the daemon starts.

Install the plugin first, then add the channel; `channel rm` first, then `plugin remove`.

### Where Plugins Are Stored

- Default directory: `~/.xacpx/plugins/`, which contains an independent `package.json` + `node_modules/`, and **does not pollute** the global or the current project.
- Custom: export the environment variable `WEACPX_PLUGIN_HOME=/some/path`, and all `xacpx plugin *` commands will switch to this directory.
- Automatic package-manager selection: if `bun` is detected it uses `bun add/remove`, otherwise it falls back to `npm install/uninstall`.
- Install and update fetch from `https://registry.npmjs.org` (and the `@ganglion` scope) so company mirrors cannot 404 optional platform packages such as `@ganglion/xacpx-rmux-bridge-*`. Override with `XACPX_PLUGIN_REGISTRY` when the official registry is unreachable.

### Install

```bash
# Install the latest version from npm
xacpx plugin add @ganglion/xacpx-channel-feishu

# Install a specific version from npm
xacpx plugin add @ganglion/xacpx-channel-feishu --version 0.2.1

# Install from a local path (common when developing your own plugin or debugging a fork)
xacpx plugin add ./packages/channel-my
xacpx plugin add /absolute/path/to/plugin-dir
```

Parameters:

| Parameter | Meaning |
| --- | --- |
| `--version <semver>` | Lock the version; written into `plugins[].version` of `~/.xacpx/config.json`. |
| `--restart` | Restart the daemon immediately after installation. |
| `--no-restart` | Don't restart; the change takes effect after the next `xacpx restart`. |
| Default (passing nothing) | Asks "restart now?" in an interactive terminal; in a non-interactive environment it defaults to no restart. |

At install time, xacpx immediately runs `import()` once on the newly installed package to run validation: `apiVersion === 1`, `name` matches the package name, the `type` field is non-empty and contains no `:`, `type` is not duplicated within a single plugin, and `factory` exists. If validation fails it **errors immediately**, does not write the config, and makes rollback easy.

> A **cross-plugin `type` conflict** (plugin A and plugin B both declare the same `type`) is not detected at install time — it relies on the other plugin already having been imported in order to compare. The conflict is thrown by `registerChannelPlugin` during `xacpx plugin doctor` or at daemon startup. After installing a new plugin, it is **strongly recommended** to run `xacpx plugin doctor` first.

### Upgrade

```bash
# Upgrade a single plugin to the latest version on the npm registry
xacpx plugin update @ganglion/xacpx-channel-feishu

# Lock to a specific version
xacpx plugin update @ganglion/xacpx-channel-feishu --version 0.3.0

# Upgrade all configured plugins at once
xacpx plugin update --all
```

Parameters:

| Parameter | Meaning |
| --- | --- |
| `--version <semver>` | Pull the specified version, and write it back to `plugins[].version`. |
| `--all` | Upgrade all items in `plugins[]`. **Cannot** be used together with `--version`. |
| `--restart` / `--no-restart` | Same as `add`. |

Inside the upgrade flow: first `bun add <pkg>[@<ver>]` / `npm install <pkg>[@<ver>]`, then re-import + validate; if validation fails it errors and **does not** change the version number in the config — your daemon still runs the old version when restarted (provided the old version is still in node_modules; if the package manager has already overwritten it with the new version, you can explicitly roll back with `xacpx plugin update <pkg> --version <old version>`).

> ⚠️ An upgrade **only** changes the disk. A running daemon has already imported the old code into memory; you must `xacpx restart` to load the new version.

### List and View

```bash
xacpx plugin list
# Output:
# Plugins:
# - @ganglion/xacpx-channel-feishu@0.2.1 (enabled)
# - @ganglion/xacpx-channel-yuanbao (enabled)
```

`@<version>` is shown only for items that have been locked with `--version`; an empty version means it follows the npm latest. There is currently no `plugin show` subcommand; for detailed information look at the `plugins[]` array in `~/.xacpx/config.json`.

### Enable / Disable

```bash
xacpx plugin disable @ganglion/xacpx-channel-feishu
xacpx plugin enable @ganglion/xacpx-channel-feishu
```

`disable` does not uninstall the package; it just sets `plugins[].enabled` to `false`. The next daemon startup will skip the import, and the corresponding channel's `channel add` will also fail with a "plugin not enabled" message.

This suits temporary troubleshooting: when you suspect a plugin is causing an anomaly, first `disable + restart` to see whether the daemon is normal, without actually uninstalling.

### Uninstall

```bash
xacpx plugin remove @ganglion/xacpx-channel-feishu
# Or abbreviated:
xacpx plugin rm @ganglion/xacpx-channel-feishu
```

This uninstalls the npm package from the plugin home (`bun remove` / `npm uninstall`), and at the same time removes the item from `plugins[]`.

> ⚠️ **Before** uninstalling a plugin you should first `xacpx channel rm <type>`, otherwise the daemon will, on restart, fail to find the provider and report `channel X is configured but no enabled plugin provides it`.

### Health Check

```bash
xacpx plugin doctor                # Check all plugins
xacpx plugin doctor @scope/xxx     # Check only one
```

It outputs the level (`OK` / `WARN` / `ERROR`) and a hint for each issue. Common situations:

| Situation | Level | Meaning / Action |
| --- | --- | --- |
| `package not installed in plugin home` | ERROR | It's in the config but the npm package isn't installed. Re-run `xacpx plugin add`. |
| `failed to import plugin: ...` | ERROR | Installed but the import failed. Check the error stack; it's most likely a wrong dependency version or a missing dist. |
| `unsupported plugin apiVersion` | ERROR | The plugin API doesn't match xacpx. Wait for the plugin author to upgrade, or temporarily `disable`. |
| `channel type X is already provided by ...` | ERROR | Two plugins compete for the same type. `disable` one of them. |
| `channel X is configured but no enabled plugin provides it` | ERROR | `channels[]` is configured but the plugin isn't installed/enabled. `plugin add` or `plugin enable`. |
| `installed and valid but disabled` | WARN | Installed but disabled. `plugin enable` or leave as is. |
| `provider plugin is disabled` | ERROR | The channel is still there but the provider plugin is disabled — the daemon will fail at startup. `plugin enable` or first `channel disable`. |
| `installed and valid; channels: feishu` | OK | Healthy. |

After upgrading / installing a new plugin, it is **strongly recommended** to run `xacpx plugin doctor` first and then `xacpx restart`, to avoid discovering broken configuration only after the daemon comes up.

### Full Lifecycle Overview

```bash
# 1. Install
xacpx plugin add @ganglion/xacpx-channel-feishu
xacpx plugin doctor
xacpx channel add feishu        # Will prompt for credentials
xacpx restart

# 2. Upgrade
xacpx plugin update @ganglion/xacpx-channel-feishu
xacpx plugin doctor
xacpx restart

# 3. Temporarily disable
xacpx plugin disable @ganglion/xacpx-channel-feishu
xacpx restart

# 4. Uninstall
xacpx channel rm feishu
xacpx plugin remove @ganglion/xacpx-channel-feishu
xacpx restart
```

### FAQ

**What if the daemon fails to start after running `xacpx plugin update --all`?**

The most common cause is that a new plugin version changed its options validation or fields. First run `xacpx plugin doctor` to look at the ERROR lines; if a specific plugin's import is failing, you can downgrade just that one back to the old version:

```bash
xacpx plugin update @ganglion/xacpx-channel-feishu --version 0.1.0
xacpx restart
```

**I manually changed `~/.xacpx/plugins/node_modules/...` but xacpx didn't notice?**

xacpx does not watch for file changes; only restarting the daemon re-imports. `xacpx plugin update` / `add` / `remove` all incidentally fix up the `dependencies` in `~/.xacpx/plugins/package.json` correctly; if you bypass xacpx and touch node_modules directly, the next `xacpx plugin doctor` will most likely report `package not installed in plugin home`. We recommend always going through the xacpx CLI.

**I installed a local-path plugin and then changed the source, but the daemon doesn't see the change?**

`xacpx plugin add ./path` resolves the local path as an npm dependency (bun add `./path` creates a link, npm install copies it). After changing the source:

- With bun: it's usually already a symlink, so re-run `bun run build` and then `xacpx restart`.
- With npm: you need to re-run `xacpx plugin add ./path` to make npm install copy it again.

For the detailed plugin development, packaging, and release guide, see [`docs/plugin-development.md`](./plugin-development.md).
