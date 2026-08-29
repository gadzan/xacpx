# @ganglion/xacpx-channel-discord

Discord channel plugin for `xacpx`.

```bash
xacpx plugin add @ganglion/xacpx-channel-discord
xacpx channel add discord --token <bot-token>
xacpx restart
```

The bot token is a Discord Bot token (`MT...`). Create it in [Discord Developer Portal](https://discord.com/developers/applications) → Bot → Reset Token.

> **Message Content intent**: guild message content is empty unless **Message Content Intent** is enabled in the Developer Portal (Bot → Privileged Gateway Intents). Without it the bot appears to "receive nothing" in servers. `xacpx plugin doctor` reports this as a `warn` (`discord-message-content-disabled`). DMs are unaffected.

## Configuration

```jsonc
{
  "channels": [
    {
      "id": "discord",
      "type": "discord",
      "enabled": true,
      "options": {
        "token": "MTxxx.xxx.xxx",
        "applicationId": "123456789012345678",
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
}
```

> **Guild allowlist note**: a `guilds.<guildId>` entry that only sets `channels` (e.g. to relax `requireMention` for one channel) does **not** grant an allowlist — guild allowlist checks only `users`/`roles`. When `guildPolicy` is `allowlist` and the guild has no `users`/`roles` entry, the global `allowFrom` is used. Document per-guild allowlists explicitly via `guilds.<gid>.users` / `roles` if you rely on them.

Top-level `options` are the defaults; `options.accounts.<id>` overrides per-account. This follows the `channel-feishu` three-layer pattern.

### Reply modes
| `auto` (default) | Resolves to `streaming` |
| `streaming` | Preview message is edited in place (throttled ~1200 ms) to show generation progress; the preview is deleted on completion and the final answer is sent as new message(s) |
| `static` | No preview, final text is chunked and sent directly |

Preview editing stops once accumulated text exceeds 2000 chars (Discord hard limit); the final chunked send still delivers the full answer. Preview create/edit failures degrade silently to static.

### Tables

Discord does not render GFM tables. `tableMode` controls the fallback:

- `code` (default): wrap the table in a ``` code fence
- `bullets`: `- col1: val1 · col2: val2` per row
- `off`: leave pipe syntax as-is

### ChatKey

```
discord:<accountId>:dm:<dmChannelId>  # DM (Discord DM channel snowflake)
discord:<accountId>:g:<channelId>     # guild text channel
discord:<accountId>:t:<threadId>      # thread / forum post (always independent session)
```

DM chat keys use the **DM channel id** (the `channelId` carried by inbound DM messages), not the peer user id. Discord DM channels are stable per 1:1 conversation, and keying on them lets outbound deliver directly via `channels.fetch(channelId)` with no extra user→DM resolution call.

Threads are **always independent sessions** (`t:<threadId>`). No `Map<chatKey, threadId>` binding — see spec F1.

### Multiple accounts

`xacpx channel add discord --token ...` adds the default account. Per-account overrides via `options.accounts.<id>`; startup staggers `identify` by ≥5.5 s per account (Discord 5-s `identify` rate limit).

### Consumer lock

Each bot token allows exactly one Gateway session. The channel provides `createConsumerLock()`, a file lock at `~/.xacpx/runtime/discord-consumer-<fingerprint>.lock.json` where `<fingerprint>` is a truncated SHA-256 of the enabled `accountId:token` set. A second `xacpx` process started with the same token(s) is rejected; processes running different bot tokens use distinct lock files and coexist.

### Security

- Global `allowed_mentions: { parse: [] }` — agent output containing `@everyone`/`@here` is never broadcast.
- Outbound media paths are validated against `mediaStore.rootDir` + workspace roots; URLs and paths escaping the roots are rejected.

## Commands

```bash
xacpx channel add discord --token <token> [--application-id <id>] [--reply-mode auto|streaming|static] [--table-mode code|bullets|off] [--require-mention true|false] [--dm-policy open|allowlist|disabled] [--guild-policy open|allowlist|disabled]
xacpx plugin doctor
```
