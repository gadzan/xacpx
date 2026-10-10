# Chat help and status

A user in a direct chat can list command help and inspect the current session. Dry-run hits the same command router without connecting to WeChat.

## Sub-features

- `chat-help-index` lists quick access and top-level topics.
- `chat-help-topic` shows the `status` topic.
- `chat-status-empty` reports that no session is selected.

## How to get to it (user POV)

- Send `/help` in a direct chat.
- Send `/help status` (or `/help ss` for the session topic).
- Send `/status`.

## Driving it with control-xacpx

Preconditions:

- Isolated verify `HOME` is seeded.
- No session exists for `wx:verify` (fresh home).
- `LANG=en_US.UTF-8`.

- **Help index.** Run `control-xacpx dry-run -- --chat-key wx:verify -- "/help"`. Exit code `0`. Stdout contains `> /help`, then `Quick access:`, `- /status - view current session status`, `Top-level commands:`, and `- /help <topic>`.
- **Status topic.** Run `control-xacpx dry-run -- --chat-key wx:verify -- "/help status"`. Stdout contains `Help topic: status` and `- /status - Show the current session status`.
- **Empty status.** Run `control-xacpx dry-run -- --chat-key wx:verify -- "/status"`. Stdout contains `> /status` and `No session is currently selected. Run /session new ... or /use <alias> first.`
- **Combined turn.** One process can send both. Run `control-xacpx dry-run -- --chat-key wx:verify -- "/help" "/status"`. Both replies appear in order.
- **Proof.** Save the combined transcript to `$VERIFY_EVIDENCE/chat-help-status/transcript.txt`. The file contains both `Quick access:` and the no-session status sentence. Doctor still reports `WARN WeChat: wechat is not logged in`.

## Gotchas

- Dry-run without `--chat-key` uses chat key `dry-run`. Feature recipes use `wx:verify` so artifacts stay consistent.
- Chat commands that are not `/…` are prompts to the current session. `/help` is a command; `help` is not.
- `/status` with a selected session prints `Current session:` and name/agent/workspace. That is a different proof; this file covers the empty state only.
- `/session new` is not this feature. It needs a working acpx transport and a registered workspace/agent.
- Dry-run still writes `$HOME/.xacpx/` as the console runtime. Isolation is the disposable `HOME`, not “no files written”.
