# Discord Channel

## Overview

`@ganglion/xacpx-channel-discord` is the official Discord channel plugin for xacpx. It connects a Discord bot to xacpx over the Discord Gateway and routes DMs, server-channel messages, threads, commands, text, and supported attachments through xacpx's command and session system.

Discord is a **bot-token channel**, not a QR-login channel. There is no `xacpx login discord`: create a Discord application/bot, install it into your server, then configure the bot token in xacpx.

## Install

Install the plugin first:

```bash
xacpx plugin add @ganglion/xacpx-channel-discord
```

Then add the channel. The interactive form is recommended because the token stays out of shell history:

```bash
xacpx channel add discord
# Discord bot token: <paste token>
```

For automation you can pass the token explicitly:

```bash
xacpx channel add discord --token '<BOT_TOKEN>'
```

Do not restart yet if you want to use the default allowlist policy: an empty allowlist rejects everyone, so complete the access-control step below first.

## Create the Discord bot

1. Open the [Discord Developer Portal](https://discord.com/developers/applications).
2. Create an **Application**.
3. Open **Bot** and create/confirm the bot user.
4. Copy the **Bot Token**. Treat it like a password. If it leaks, reset it in the Portal, update xacpx, and restart the daemon.

### Message Content Intent

Under **Bot → Privileged Gateway Intents**, enable **Message Content Intent**.

The plugin requests Message Content by default (`options.intents.messageContent: true`). If the local option is `true` but the Portal toggle is disabled, Discord rejects Gateway identify with **4014 (disallowed intents)** and the bot stays offline.

You can deliberately run without Message Content by setting:

```jsonc
{
  "intents": { "messageContent": false }
}
```

Without the intent, DMs and messages that explicitly `@mention` the bot can still carry content. A bare reply to a bot message is **not** a substitute for Message Content access: xacpx can recognize the reply relationship, but Discord may deliver the reply with empty text. For normal server usage, enabling Message Content is recommended.

## Install the bot into a server

Use Discord's **OAuth2 → URL Generator** or **Installation** page to create an invite with the `bot` scope and add the bot to your server.

Do not grant Administrator. The message-channel flow normally needs:

```text
View Channels
Send Messages
Read Message History
Add Reactions
Attach Files
Send Messages in Threads   # if you use threads / forum posts
```

`Send Messages in Threads` is separate from `Send Messages`.

## Configure access control

Discord access control uses numeric **snowflake IDs**, not usernames or display names.

Enable **Discord Settings → Advanced → Developer Mode**, then use **Copy ID** to get your user ID. You may also need guild, channel, or role IDs for per-server rules.

`xacpx channel add discord` currently has no `--allow-from` flag, so edit `~/.xacpx/config.json` and add your user ID:

```jsonc
{
  "channels": [
    {
      "id": "discord",
      "type": "discord",
      "enabled": true,
      "options": {
        "token": "<BOT_TOKEN>",
        "dmPolicy": "allowlist",
        "guildPolicy": "allowlist",
        "allowFrom": ["<YOUR_DISCORD_USER_ID>"],
        "requireMention": true
      }
    }
  ]
}
```

The safe defaults are intentionally restrictive:

| Field | Default | Meaning |
| --- | --- | --- |
| `dmPolicy` | `allowlist` | Only senders in `allowFrom` are accepted in DMs |
| `guildPolicy` | `allowlist` | Only allowlisted senders are accepted in servers |
| `allowFrom` | empty | Rejects every sender until you add IDs |
| `requireMention` | `true` | Server messages must @mention the bot or reply to it |
| `allowBots` | `false` | Messages from other bots are ignored |

`"*"` in `allowFrom` accepts any sender, but keep that for controlled environments. Avoid `guildPolicy: "open"` together with `requireMention: false` in a public server.

## Restart and verify

```bash
xacpx channel show discord
xacpx plugin doctor
xacpx restart
```

`xacpx plugin doctor` performs a local configuration check; it does **not** validate the token against Discord live.

A real connectivity check is:

1. the daemon starts without a Discord Gateway error;
2. the bot appears online in Discord;
3. a message makes a full round trip.

From an allowlisted server account:

```text
@your-bot /help
@your-bot /ss codex -d /absolute/path/to/repo
@your-bot inspect the current git diff
```

In a DM, a mention is not required:

```text
/help
/ss codex -d /absolute/path/to/repo
run the tests and summarize the failures
```

DMs are still subject to `dmPolicy` and `allowFrom`.

## Temporary smoke test

For a controlled test server, you can temporarily open both policies while still requiring mentions:

```bash
xacpx channel add discord \
  --token '<BOT_TOKEN>' \
  --dm-policy open \
  --guild-policy open \
  --require-mention true
```

Use this only to prove the Gateway/message path, then switch back to an allowlist for normal use.

## Configuration

A fuller single-account configuration looks like this:

```jsonc
{
  "channels": [
    {
      "id": "discord",
      "type": "discord",
      "enabled": true,
      "options": {
        "token": "<BOT_TOKEN>",
        "applicationId": "123456789012345678",
        "replyMode": "auto",
        "tableMode": "code",
        "requireMention": true,
        "dmPolicy": "allowlist",
        "guildPolicy": "allowlist",
        "allowFrom": ["<YOUR_DISCORD_USER_ID>"],
        "guilds": {
          "<GUILD_ID>": {
            "users": [],
            "roles": [],
            "channels": {
              "<CHANNEL_ID>": { "requireMention": false }
            }
          }
        },
        "allowBots": false,
        "intents": {
          "messageContent": true,
          "guildMembers": false
        },
        "media": {
          "maxBytes": 8388608,
          "maxAttachments": 10
        }
      }
    }
  ]
}
```

`token` is the only required credential for basic message routing. `applicationId` is optional for the current message flow.

A guild entry with non-empty `users` or `roles` applies a guild-specific allowlist. If a guild entry only overrides channel settings such as `requireMention`, the global `allowFrom` remains the allowlist source.

## Reply modes

`options.replyMode` controls Discord reply rendering:

| Mode | Behavior |
| --- | --- |
| `auto` | Default; currently resolves to streaming |
| `streaming` | Edits a preview message while output is generated, deletes the preview at completion, then sends the final answer |
| `static` | Sends only the final chunked response |

Discord messages have a 2000-character limit. Final responses are chunked automatically; preview failures degrade to static delivery.

## Threads and sessions

Discord chat keys distinguish DMs, guild channels, and threads:

```text
discord:<accountId>:dm:<dmChannelId>
discord:<accountId>:g:<channelId>
discord:<accountId>:t:<threadId>
```

Each thread/forum post is an independent xacpx chat context and therefore gets its own session mapping. If a thread is archived or disappears while xacpx is replying, the channel attempts to fall back to the parent channel for text, media, and completion notices.

## Multiple Discord bots

Add named accounts with:

```bash
xacpx channel add discord --account work --token '<WORK_BOT_TOKEN>'
xacpx channel add discord --account personal --token '<PERSONAL_BOT_TOKEN>'
```

Per-account overrides live under `options.accounts.<id>`. Every enabled account must resolve to a **different bot token**. xacpx rejects duplicate enabled tokens in one process and also uses a per-token consumer lock to prevent two xacpx processes from driving the same Discord bot simultaneously.

## Media

Inbound Discord attachments can be passed to the agent within the configured size/count limits. Outbound files are only sent from the media-store root or allowed workspace roots; paths escaping those roots and URL-like paths are rejected.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Bot stays offline / Gateway closes with 4014 | Enable Message Content Intent in the Portal, or set local `intents.messageContent` to `false` intentionally |
| Bot is online but ignores every message | Add your numeric Discord user ID to `allowFrom`; the default list is empty |
| Server message is ignored | With `requireMention: true`, use an actual `@bot` mention; also check `guildPolicy` |
| Reply-to-bot text is empty with Message Content disabled | Use an explicit `@bot` mention or enable Message Content |
| Thread replies fail | Grant `Send Messages in Threads`; archived threads fall back to the parent when possible |
| Attachments fail | Grant `Attach Files` and check `media.maxBytes` / `media.maxAttachments` |
| Unsure whether config is valid | Run `xacpx channel show discord` and `xacpx plugin doctor`; use daemon logs for the live Gateway result |

Policy-denied messages are dropped silently and logged under `discord.message.policy_denied` in the xacpx app log.

## Update or remove

```bash
xacpx plugin update @ganglion/xacpx-channel-discord
xacpx restart
```

To remove it:

```bash
xacpx channel rm discord
xacpx plugin remove @ganglion/xacpx-channel-discord
```
