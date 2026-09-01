# @ganglion/xacpx-channel-discord

Discord channel plugin for `xacpx`. It bridges Discord messages to your `acpx` agent sessions: DM the bot or @-mention it in a server channel, and the text reaches the current session just like it would from WeChat or Feishu.

This is **not** a QR-login / pairing channel. Discord uses a **bot token credential + server installation + Gateway connection** model. There is no `xacpx login discord`; you configure a credential and install the bot. The token is a secret — handle it accordingly.

## Quick start

A first-time setup takes about ten minutes. Follow the steps in order; each one is verifiable before you move on.

### 1. Install the plugin

```bash
xacpx plugin add @ganglion/xacpx-channel-discord
```

### 2. Create a Discord application and bot

1. Open the [Discord Developer Portal](https://discord.com/developers/applications).
2. Create an **Application**.
3. In the **Bot** settings, confirm/create the bot user.
4. Copy the **Bot Token** (use **Reset Token** if you don't have it yet).

The token is shown only under the application's **Bot** settings. Treat it as a password: do not paste it into issues, logs, screenshots, or chat. If it ever leaks, **Reset Token** in the Portal, update `options.token` in xacpx, then `xacpx restart`.

> Discord may rename Portal sections over time; use the current Developer Portal as the source of truth.

### 3. Enable Message Content Intent

Still in the Bot settings, under **Privileged Gateway Intents**, enable **Message Content Intent**.

Message Content is a **privileged** intent, and by default the plugin asks for it on every connect (`options.intents.messageContent` defaults to `true`). If the Portal toggle is still off, Discord rejects the identify and closes the Gateway with **code 4014 (disallowed intents)** — the bot never comes online. So the symptom on this path is "bot offline", not "messages arrive with empty content".

Two layers have to agree:

- **Portal toggle** — the server-side permission. Enable it, or turn the local request off.
- **xacpx `options.intents.messageContent`** — what the plugin requests on connect. A local `true` does **not** enable anything in the Portal; setting it to `false` stops requesting the intent, and the bot then connects fine without Portal approval.

Without the intent, Discord still delivers the content of DMs, of the bot's own messages, and of messages that @mention the bot. A bare reply to one of the bot's messages is **not** on that list: it passes xacpx's `requireMention` gate, but its content still arrives empty, so the plugin drops it. With the intent off, only an actual `@bot` mention reaches an agent in a server — replying to the bot is **not** a substitute for Message Content access.

So the default `requireMention: true` stays usable through the @mention form only, and `requireMention: false` is worse: there the plugin receives empty text and drops the message, so a plain sentence posted to the channel never reaches an agent.

Recommended: enable the Portal intent and leave `intents.messageContent` at its default `true`. Set it to `false` only if you deliberately run a mention-only bot.

### 4. Install the bot into your server

Use **OAuth2 → URL Generator** (or the **Installation** page) to build an invite URL with the `bot` scope, then open it and add the bot to your server. Do **not** grant **Administrator**. The plugin's message-only flow needs only:

```text
View Channels
Send Messages
Read Message History
Add Reactions
Attach Files
Send Messages in Threads   # only if you use threads / forum posts
```

`Send Messages in Threads` is a separate permission — plain `Send Messages` does not cover it. If a feature is unused (e.g. attachments), you can tighten further.

### 5. Enable Developer Mode and copy your User ID

Access control compares Discord **snowflake IDs**, not usernames or display names.

Turn on **Settings → Advanced → Developer Mode**, then right-click → **Copy ID** for:

- **Your User ID** → goes into `allowFrom`
- **Server (guild) ID** → key of `guilds.<guildId>`
- **Channel ID** → `guilds.<guildId>.channels.<channelId>`
- **Role ID** → `guilds.<guildId>.roles`

Thread IDs are resolved by the plugin at runtime; you normally don't fill them in.

### 6. Add the Discord channel to xacpx

Recommended — enter the token through the secret prompt so it stays out of shell history:

```bash
xacpx channel add discord
# Discord bot token:  (paste the token here)
```

For automation, pass it explicitly (mind shell history / CI logs):

```bash
xacpx channel add discord --token '<BOT_TOKEN>'
```

This creates a single `default` account with the safe defaults described below. To add more bots, use `--account` (see [Multiple accounts](#multiple-accounts)).

### 7. Configure the allowlist

`channel add discord` has **no `--allow-from` flag** yet, so the allowlist is set by editing `~/.xacpx/config.json` — either the channel-level `channels[].options.allowFrom`, or the per-account `channels[].options.accounts.<id>.allowFrom`.

Add the User ID from step 5:

```jsonc
{
  "id": "discord",
  "type": "discord",
  "enabled": true,
  "options": {
    "token": "...",
    "dmPolicy": "allowlist",
    "guildPolicy": "allowlist",
    "allowFrom": ["<YOUR_USER_ID>"],
    "requireMention": true
  }
}
```

### 8. Restart and verify

```bash
xacpx channel show discord     # token shown masked, dmPolicy/guildPolicy visible
xacpx plugin doctor            # config diagnostics only — see note below
xacpx restart
```

> `xacpx plugin doctor` runs a **shallow config check** for Discord (missing token, unusually short token, local `intents.messageContent: false`). It does **not** call the Discord REST API to validate the token live. Final "is it actually connected" verification is: the daemon startup log shows the account connected, the bot shows **online** in Discord, and a message round-trips.

Then in Discord, from the allowlisted account:

```text
@your-bot /help
@your-bot /ss codex -d /absolute/path/to/repo
@your-bot hello
```

A DM doesn't need a mention, but is still gated by `dmPolicy` / `allowFrom`. Success = `/help` responds, `/ss` creates/reuses a session, and plain text reaches the agent and comes back.

## Security defaults

`xacpx channel add discord` does **not** open the bot to everyone. The defaults are deliberately restrictive:

| Field | Default | Meaning |
|---|---|---|
| `dmPolicy` | `allowlist` | Only senders in `allowFrom` are handled in DMs |
| `guildPolicy` | `allowlist` | Only allowlisted senders are handled in servers |
| `allowFrom` | *(empty)* | **Empty list rejects every sender** |
| `requireMention` | `true` | In servers, the bot must be @-mentioned (or replied to) — but a reply only carries text if Message Content access exists, see step 3 |

So adding a token is not the same as being able to chat — the bot can connect and appear online while silently ignoring messages, because no sender is allowlisted yet. Complete step 7 before expecting replies. `"*"` in `allowFrom` accepts any sender (still requires a sender id).

**Rejected messages** are dropped silently (no "no permission" reply) and logged to `~/.xacpx/runtime/app.log` under `discord.message.policy_denied` with `accountId/messageId/chatType/senderId/reason`. Reasons: `dm_disabled`, `guild_disabled`, `sender_not_allowlisted`, `missing_sender_id`.

### Temporary smoke test

To confirm the Gateway/message path works before curating an allowlist, you can create an explicitly open channel:

```bash
xacpx channel add discord \
  --token '<BOT_TOKEN>' \
  --dm-policy open \
  --guild-policy open \
  --require-mention true
```

> `open` is for a controlled test server / temporary verification, not a recommended long-term config. Never combine `guildPolicy=open` with `requireMention=false` on a public server.

## Configuration

```jsonc
{
  "channels": [
    {
      "id": "discord",
      "type": "discord",
      "enabled": true,
      "options": {
        "token": "<BOT_TOKEN>",
        "applicationId": "123456789012345678",  // optional for the message flow
        "replyMode": "auto",       // auto | streaming | static
        "tableMode": "code",       // code | bullets | off
        "requireMention": true,    // guilds: require @bot or reply to bot
        "dmPolicy": "allowlist",
        "guildPolicy": "allowlist",
        "allowFrom": [],
        "guilds": {
          "<guildId>": {
            "users": [],
            "roles": [],
            "channels": { "<channelId>": { "requireMention": false } }
          }
        },
        "allowBots": false,
        "intents": { "messageContent": true, "guildMembers": false },
        "media": { "maxBytes": 8388608, "maxAttachments": 10 }
      }
    }
  ]
}
```

- `token` is the only required credential for the current message-channel flow. `applicationId` is **optional** — the CLI/config accept `--application-id`, and basic message routing does not require it.
- `allowFrom` holds Discord **user snowflake IDs** (or `"*"`). Never usernames.
- A `guilds.<guildId>` entry with a non-empty `users`/`roles` list enforces that per-guild allowlist. A `guilds.<guildId>` entry that only sets `channels` (e.g. to relax `requireMention` for one channel) does **not** grant an allowlist — guild allowlist checks only look at `users`/`roles`. When `guildPolicy` is `allowlist` and the guild has no `users`/`roles` entry, the global `allowFrom` is used instead.

Top-level `options` are the defaults; `options.accounts.<id>` overrides per account. This follows the same three-layer pattern as the Feishu channel.

### Reply modes

| Mode | Behavior |
|---|---|
| `auto` (default) | Resolves to `streaming` |
| `streaming` | A preview message is edited in place (throttled ~1200 ms) to show generation progress; the preview is deleted on completion and the final answer is sent as new message(s) |
| `static` | No preview; final text is chunked and sent directly |

Preview editing stops once accumulated text exceeds 2000 chars (Discord hard limit); the final chunked send still delivers the full answer. Preview create/edit failures degrade silently to `static`.

Session startup now shows progress within one throttle window: the first `🚀 Starting <agent>…` ping and subsequent `ℹ️` acpx notes are streamed into the preview (with typing indicator and ack reaction when enabled). The final answer merges streamed progress with the router result, so `/ss` creation confirmations are no longer swallowed. Tool calls and thought chunks are also streamed into the preview for long turns (parity with Feishu streaming cards, without the card UI).

### Slash-command autocomplete (Discord Application Commands)

When `options.applicationId` is set, the plugin registers Discord Application Commands on Gateway start for autocomplete when you type `/` in Discord. Commands registered:

- `/help`, `/ss` (with `agent`, `workspace`, `new` options), `/use`, `/cancel`, `/status`, `/sessions`

They map to the same text-command router (`@bot /ss …` still works), but native `/` shows hints. Registration is best-effort at `account.start()`; failures log `discord.commands.register_failed` and do not block the Gateway session. Toggle with `options.enableAutocomplete` (defaults to `true` when `applicationId` is present, `false` otherwise). Use `--autocomplete true|false` with `xacpx channel add`.

Interaction handling: Discord sends chat-input interactions for native picks; the plugin replies ephemerally with `⏳ Processing …` and then handles the reconstructed `/<name> …` text through the normal message pipeline, delivering the final answer as a channel message (with thread fallback and chunking). No additional permissions beyond the message flow are required.

### Tables

Discord does not render GFM tables. `tableMode` controls the fallback:

- `code` (default): wrap the table in a ``` code fence
- `bullets`: `- col1: val1 · col2: val2` per row
- `off`: leave pipe syntax as-is

### ChatKey and threads

```
discord:<accountId>:dm:<dmChannelId>  # DM (Discord DM channel snowflake)
discord:<accountId>:g:<channelId>     # guild text channel
discord:<accountId>:t:<threadId>      # thread / forum post (always independent session)
```

DM chat keys use the **DM channel id** (the `channelId` carried by inbound DM messages), not the peer user id. Discord DM channels are stable per 1:1 conversation, and keying on them lets outbound deliver directly via `channels.fetch(channelId)` with no extra user→DM resolution call.

Threads are **always independent sessions** (`t:<threadId>`), so each thread keeps its own agent session.

### Multiple accounts

`xacpx channel add discord --account <id> --token ...` adds a named account. Per-account overrides live under `options.accounts.<id>`; startup staggers `identify` by ≥5.5 s per account (Discord's 5-s `identify` rate limit).

Because Discord allows exactly one Gateway session per token, **each enabled account must resolve to a distinct token**. `parseDiscordChannelConfig` rejects two enabled accounts sharing a resolved token — including the case where several accounts inherit the same base `token` — since one Gateway client could not honor two different per-account policies. The rejection names the account ids only, never the token. A disabled account may share a token with an enabled one.

### Consumer lock

Each bot token allows exactly one Gateway session, so two processes driving the same token would kick each other. The channel provides `createConsumerLock()`, a composite of **one file lock per enabled token** at `~/.xacpx/runtime/discord-consumer-<fingerprint>.lock.json`, where `<fingerprint>` is a truncated SHA-256 of the **token itself** (never the `accountId`, never the token plaintext). A process holding N distinct tokens acquires N locks; if any one conflicts, the locks already taken are rolled back and startup is rejected.

Consequence: any overlap in token sets contends — the identical set, a superset like `{X,Y}` vs `{X}`, and the same token under a different `accountId` are all blocked; only fully disjoint token sets coexist. Layering: config validation enforces intra-process token uniqueness (see Multiple accounts); these lock files enforce cross-process mutual exclusion.

### Media

Inbound attachments are written under the media store root; outbound media paths are validated against `mediaStore.rootDir` plus workspace roots, and URLs/paths escaping those roots are rejected. `media.maxBytes` / `media.maxAttachments` cap what a single message may pull.

## Updating / removing

```bash
# Upgrade the plugin, then reload it into the daemon
xacpx plugin update @ganglion/xacpx-channel-discord
xacpx restart

# Manage the channel (all support --account <id> for one account)
xacpx channel disable discord
xacpx channel enable discord
xacpx channel rm discord

# Uninstall the plugin (remove the channel first)
xacpx channel rm discord
xacpx plugin remove @ganglion/xacpx-channel-discord
xacpx restart
```

> An update only changes the disk. A running daemon already imported the old code, so `xacpx restart` is required to load the new version. Always `channel rm` before `plugin remove`, or the next start fails with "no enabled plugin provides it".

## Commands

```bash
xacpx channel add discord [--account <id>] --token <token> [--application-id <id>] [--reply-mode auto|streaming|static] [--table-mode code|bullets|off] [--require-mention true|false] [--dm-policy open|allowlist|disabled] [--guild-policy open|allowlist|disabled] [--restart|--no-restart]
xacpx channel show discord [--account <id>]
xacpx channel enable discord [--account <id>]
xacpx channel disable discord [--account <id>]
xacpx channel rm discord [--account <id>]
xacpx plugin doctor
```

## Security & privacy

- **Allowed mentions**: outbound messages send `allowed_mentions: { parse: [] }`, so agent output containing `@everyone` / `@here` / `@user` is never broadcast as a real mention.
- **Media roots**: outbound media paths are validated against the media store root and workspace roots; anything escaping them is rejected.
- **Token masking**: `channel show` renders the token as `***`; the plaintext token is never logged by the plugin or named in config errors.

## Troubleshooting

| Symptom | Likely cause | Action |
|---|---|---|
| Bot offline | daemon/channel/token | `xacpx status`, `xacpx restart`, check `~/.xacpx/runtime/app.log`; rotate the token if it is invalid |
| Bot goes offline on connect, log shows Gateway close `4014` | Portal **Message Content Intent** is off, but `intents.messageContent` defaults to `true` so the plugin still requests it | enable the intent in the Developer Portal, or set `intents.messageContent: false` |
| Bot online but DM ignored | `dmPolicy=allowlist` + sender not in `allowFrom` | add your User ID, or use an explicit `open` for a controlled test |
| Bot online but server message ignored | guild allowlist empty, or `requireMention=true` | add sender/role to `allowFrom` or `guilds.<gid>.users/roles`; @-mention the bot |
| Bot online, `requireMention: false`, yet plain server messages never reach an agent | no Message Content access, so content arrives empty and the message is dropped | enable the Portal intent and keep `intents.messageContent` on; or run with `requireMention: true` |
| Can read a thread but cannot reply | missing `Send Messages in Threads` | grant that channel/server permission |
| Attachments fail | Discord permission or xacpx `media.maxBytes` | grant **Attach Files**; raise the local limit |
| Second xacpx process fails to start Discord | per-token consumer lock | stop the duplicate process, or use a distinct bot token |
| Config rejected with "duplicates the bot token" | two enabled accounts share one token | give each enabled account its own token |
| Replies never trigger without mention | expected `requireMention=true` | @-mention the bot, or set a per-channel `requireMention: false` override |

`plugin doctor` diagnoses configuration; it is not a live Discord probe. To confirm the connection actually works, watch the daemon startup log and send a test message from an allowlisted account.
