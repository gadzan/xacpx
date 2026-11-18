# @ganglion/xacpx-channel-yuanbao

First-party Yuanbao message channel plugin for xacpx.

## Install

```bash
xacpx plugin add @ganglion/xacpx-channel-yuanbao
xacpx channel add yuanbao
xacpx restart
```

## Required options

- `appKey`
- `appSecret`

Existing configs written for the pre-rename `weacpx` CLI with `channels[].type = "yuanbao"` remain valid after this plugin is installed.

## Real-time session switching & background execution

Each inbound prompt is **bound at dispatch time** to whatever session the chat is currently on, then runs on a **per-session lane**:

- **Different sessions run concurrently.** Switching to another session (`/use`/`/ss`) while a task is in flight lets you use the new session immediately — turns on different sessions don't block each other.
- **Same-session turns serialize**, preserving order within a session.
- **Switch and cancel commands preempt.** `/use`, `/ss`, `/cancel`, `/stop` run on a **control lane**, so they take effect right away even while a prompt is running (the running prompt keeps going in the background — see below).

When you switch away from a running session, its turn keeps executing in the background. Yuanbao is a linear-text channel, so it follows the **WeChat "A-semantics"** (not Feishu's card-based B-semantics):

- A backgrounded turn's **mid-stream output is suppressed** — it is *not* sent into the chat that now shows a different session.
- On completion, its **final answer is stored** and a short ping is sent to the chat: `✅ <alias> 已完成，/use <alias> 查看结果` (or `⚠️ <alias> 失败，/use <alias> 查看详情`).
- Switching **back** to that session (`/use <alias>`) **replays** the stored result.
- `/sessions` marks sessions with an unfinished/unread background completion using `●`.
