# Channel Management

## Overview

xacpx can run multiple chat channels simultaneously. Each channel receives incoming messages from a different platform and routes them to your agent sessions. Channel configuration is stored in `~/.xacpx/config.json` under the `channels[]` array. Use the CLI to manage channels — editing the JSON directly is supported but not recommended for day-to-day changes.

## Built-in and plugin channels

**Built-in:**

- `weixin` — WeChat channel, authenticated via QR code scan.

**Plugin-provided:**

- `feishu` — Provided by `@ganglion/xacpx-channel-feishu`. Configured with a Feishu self-built application's App ID and App Secret. See [Feishu Channel](/plugins/feishu).
- `yuanbao` — Provided by `@ganglion/xacpx-channel-yuanbao`. Configured with `appKey` and `appSecret`; includes built-in Yuanbao request signing and WebSocket gateway. See [Yuanbao Channel](/plugins/yuanbao).
- `discord` — Provided by `@ganglion/xacpx-channel-discord`. Configured with a Discord **Bot Token** and the Gateway; the bot is installed into a server rather than QR-paired. See [Discord Channel](/plugins/discord).

Third-party channels can be distributed as external npm plugin packages.

## Channel identities

xacpx currently allows one instance per channel type. The channel `id` must equal the `type` — for example `weixin`, `feishu`, `yuanbao`, or `discord`. Configuring two instances of the same type (e.g. `{ "id": "feishu-review", "type": "feishu" }`) is rejected at startup.

To run multiple bots within a single channel type, use the multi-account (`--account`) feature described in the sections below.

## Add a channel

### WeChat

WeChat uses the existing QR-code login model:

```bash
xacpx login    # show the QR code; scan with the WeChat mobile app
xacpx start
```

If `channels[]` is absent from your config, xacpx automatically generates an enabled WeChat channel from legacy config keys.

Log out of WeChat only:

```bash
xacpx logout
```

`login` and `logout` only affect WeChat. They do not interact with Feishu or Yuanbao credentials.

### Feishu

Feishu is provided by the plugin package `@ganglion/xacpx-channel-feishu`. Install the plugin first, then add the channel:

```bash
xacpx plugin add @ganglion/xacpx-channel-feishu
xacpx channel add feishu
```

The interactive prompt is recommended to avoid leaving `appSecret` in shell history:

```text
Feishu appId:
Feishu appSecret:
```

For scripted or non-interactive environments, pass flags directly:

```bash
xacpx channel add feishu \
  --app-id cli_xxx \
  --app-secret your_secret \
  --domain feishu \
  --require-mention true
```

Flag reference:

| Flag | Values | Default | Description |
|---|---|---|---|
| `--domain` | `feishu` \| `lark` | `feishu` | Use `feishu` for Feishu, `lark` for Lark. |
| `--require-mention` | `true` \| `false` | `true` | When `true`, group messages require an @-mention of the bot before xacpx processes them. Set `false` to process all group messages (use carefully). |

**Prerequisites for the Feishu app:**
- Enable bot capability.
- Add the bot to the target DM or group.
- Grant the app permission to send and receive messages, then publish it to the applicable audience.

### Yuanbao

Yuanbao is provided by the plugin package `@ganglion/xacpx-channel-yuanbao`:

```bash
xacpx plugin add @ganglion/xacpx-channel-yuanbao
xacpx channel add yuanbao --app-key <key> --app-secret <secret>
xacpx restart
```

Optional flags:

```bash
xacpx channel add yuanbao \
  --app-key yb_xxx \
  --app-secret your_secret \
  --bot-id bot_123 \
  --require-mention true \
  --ws-url wss://bot-wss.yuanbao.tencent.com/wss/connection \
  --api-domain bot.yuanbao.tencent.com
```

If a `type: "yuanbao"` entry is in config but the plugin is not installed, the daemon prints:

```text
Channel yuanbao requires a plugin: xacpx plugin add @ganglion/xacpx-channel-yuanbao
```

### Discord

Discord is provided by the plugin package `@ganglion/xacpx-channel-discord`. Unlike WeChat (QR login) or Feishu/Yuanbao (platform credentials), Discord has **no login/pairing flow**: create a bot in the Discord Developer Portal, put its **Bot Token** into xacpx, and install the bot into a server. The plugin keeps one Gateway connection per token.

```bash
xacpx plugin add @ganglion/xacpx-channel-discord
xacpx channel add discord        # the token is read from a secret prompt
xacpx restart
```

Two things people miss: **Message Content Intent** must be enabled in the Portal (otherwise Discord closes the Gateway with `4014`), and access control compares **snowflake IDs**, so enable Developer Mode and copy your User ID before setting `--dm-policy` / `--guild-policy`. Do not grant the bot Administrator. The full behavior reference is the package README (`packages/channel-discord/README.md`), and the end-to-end walkthrough is `docs/channel-management.md` in the repository.

## List channels

```bash
xacpx channel list
```

Inspect a specific channel (secrets are always redacted as `***`):

```bash
xacpx channel show feishu
```

The `channel` command can be abbreviated as `ch`:

```bash
xacpx ch list
xacpx ch show feishu
```

## Update channel settings

To change a channel's credentials or options, remove and re-add the channel:

```bash
xacpx channel rm feishu
xacpx channel add feishu --app-id cli_new --app-secret new_secret
xacpx restart
```

### Multi-account (Feishu)

A single `feishu` channel can host multiple bots, each with its own App ID and App Secret. Incoming messages are routed per-bot. ChatKeys take the form `feishu:<accountId>:<chatId>`.

```bash
# Add the first bot (creates the feishu channel automatically)
xacpx channel add feishu --account main \
    --app-id cli_main --app-secret secret_main

# Add a second bot
xacpx channel add feishu --account ops \
    --app-id cli_ops --app-secret secret_ops --require-mention false

# Inspect one account (appSecret redacted)
xacpx channel show feishu --account ops

# Temporarily take a bot offline without removing it
xacpx channel disable feishu --account ops
xacpx channel enable  feishu --account ops

# Remove a bot; when the last enabled account is removed the whole feishu channel is deleted
# (only allowed if another enabled channel remains)
xacpx channel rm feishu --account ops
```

**Migration from single-bot config:** The first `xacpx channel add feishu --account <id>` automatically migrates a flat `appId/appSecret` config into `accounts.default = {...old per-bot fields}` and adds the new account alongside it.

Fields that stay at the top level (shared across accounts): `textMessageFormat`, `dedupTtlMs`, `dedupMaxEntries`, `defaultAccount`.

Fields moved into `accounts.default`: `appId`, `appSecret`, `domain`, `requireMention`, `dmPolicy`, `groupPolicy`, `allowFrom`, and any unrecognized fields.

> **Changing `defaultAccount` breaks existing chatKeys.** State records chatKey prefixes like `feishu:default:oc_xxx`. If you rename the default account without keeping an `accounts.default` alias, existing sessions will fail with "feishu account 'default' is not started". Recommended: always keep `accounts.default` as a stable alias.

**Manual JSON equivalent:**

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

**DM/Group admission policy (Feishu):**

To restrict which senders a bot accepts, configure `dmPolicy` and `groupPolicy` per account. The default (`open`) matches historical behavior — any sender is accepted.

```jsonc
{
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
```

| Field | Values | Description |
|---|---|---|
| `dmPolicy` | `open` (default), `allowlist`, `disabled` | DM admission. `allowlist` only accepts senders in `allowFrom`. `disabled` drops all DMs. |
| `groupPolicy` | `open` (default), `allowlist`, `disabled` | Group admission. `requireMention` still applies independently after policy passes. |
| `allowFrom` | array of `open_id` strings | Active when policy is `allowlist`. `"*"` accepts any sender with an `open_id`. Must not be empty when policy is `allowlist`. |

Rejected messages are silently dropped (no reply is sent). They are logged at `~/.xacpx/runtime/app.log` under `feishu.message.policy_denied` with fields `accountId`, `messageId`, `chatType`, `senderOpenId`, and `reason` (`dm_disabled`, `group_disabled`, `sender_not_allowlisted`, `missing_sender_id`).

### Multi-account (Yuanbao)

Yuanbao supports multiple bots in the same channel, with CLI usage identical to Feishu's `--account` flag:

```bash
# Add the first bot
xacpx channel add yuanbao --account main \
    --app-key yb_main --app-secret secret_main

# Add a second bot
xacpx channel add yuanbao --account ops \
    --app-key yb_ops --app-secret secret_ops --require-mention false

xacpx channel show yuanbao --account main
xacpx channel disable yuanbao --account ops
xacpx channel enable  yuanbao --account ops
xacpx channel rm yuanbao --account ops
```

ChatKeys take the form `yuanbao:<accountId>:<chatType>:<target>` where `chatType` is `direct` or `group`.

> **Changing `defaultAccount`** carries the same chatKey-routing caveat as Feishu. Keep `accounts.default` as an alias to avoid breaking existing sessions.

## Remove a channel

```bash
xacpx channel rm feishu
xacpx restart
```

xacpx will refuse to remove or disable the last enabled channel — the daemon must always have at least one message entry point.

## Restart after changes

Channel configuration changes take effect only after a daemon restart:

```bash
xacpx restart
```

Some subcommands accept `--restart` or `--no-restart` to control this behavior at the time of the change:

```bash
xacpx channel add feishu --restart      # add and restart immediately
xacpx channel add feishu --no-restart   # add now, restart manually later
```

If you want to run Feishu only (without waiting for a WeChat QR scan on each startup):

```bash
xacpx channel disable weixin
xacpx restart
```

## Common patterns

**Switch from WeChat-only to Feishu-only:**

```bash
xacpx plugin add @ganglion/xacpx-channel-feishu
xacpx channel add feishu --app-id cli_xxx --app-secret your_secret
xacpx channel disable weixin
xacpx restart
```

**Run WeChat and Feishu simultaneously:**

```bash
xacpx login                              # authenticate WeChat first
xacpx plugin add @ganglion/xacpx-channel-feishu
xacpx channel add feishu --app-id cli_xxx --app-secret your_secret
xacpx restart
```

**Full plugin lifecycle (install → upgrade → uninstall):**

```bash
# Install
xacpx plugin add @ganglion/xacpx-channel-feishu
xacpx plugin doctor
xacpx channel add feishu
xacpx restart

# Upgrade
xacpx plugin update @ganglion/xacpx-channel-feishu
xacpx plugin doctor
xacpx restart

# Temporarily disable without uninstalling
xacpx plugin disable @ganglion/xacpx-channel-feishu
xacpx restart

# Uninstall
xacpx channel rm feishu
xacpx plugin remove @ganglion/xacpx-channel-feishu
xacpx restart
```

**Troubleshoot a channel not activating after being added:**

```bash
xacpx restart
xacpx status
xacpx channel list
xacpx channel show feishu
```

**Group messages not getting a response (Feishu):**

If `requireMention` is `true`, group messages must @-mention the bot. Confirm the setting:

```bash
xacpx channel show feishu
```

To remove the @-mention requirement:

```bash
xacpx channel rm feishu --no-restart
xacpx channel add feishu --require-mention false
xacpx restart
```

**Plugin management commands:**

```bash
xacpx plugin list
xacpx plugin update @ganglion/xacpx-channel-feishu --version 0.3.0
xacpx plugin update --all
xacpx plugin disable @ganglion/xacpx-channel-feishu
xacpx plugin enable  @ganglion/xacpx-channel-feishu
xacpx plugin remove  @ganglion/xacpx-channel-feishu
xacpx plugin doctor
xacpx plugin doctor @ganglion/xacpx-channel-feishu
```

Run `xacpx plugin doctor` after every install or upgrade before restarting the daemon. It validates API version compatibility, detects type conflicts between plugins, and flags missing or broken packages.

**Secret storage note:** `appSecret` values are stored in `~/.xacpx/config.json`. Prefer the interactive `xacpx channel add` prompt, avoid passing `--app-secret` on shared terminals or in CI logs, and never commit a real `config.json` to git.

For the full configuration schema, see [Configuration](/reference/configuration).
