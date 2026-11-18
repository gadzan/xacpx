# @ganglion/xacpx-channel-feishu

Feishu channel plugin for `xacpx`.

```bash
xacpx plugin add @ganglion/xacpx-channel-feishu
xacpx channel add feishu
xacpx restart
```

The channel requires a Feishu self-built app `appId` and `appSecret`.

## Reply rendering: `replyMode`

| Mode | Behaviour |
|------|-----------|
| `"auto"` (default) | Streaming for direct (p2p) chats, static for groups. Groups already serialize visually around a thread, so the multi-message static path stays simpler there. |
| `"streaming"` | The channel creates one CardKit v2 interactive card per turn and updates it in place — thinking → streaming → complete (or aborted/error). User sees output appear progressively in one message slot. |
| `"static"` | Every `reply()` chunk + the final agent response are sent as separate text messages, replying to the user's incoming message. |

While streaming, the card uses two CardKit endpoints intelligently:
- `cardElement.content` for pure-text deltas — smaller payload, native typewriter animation.
- Full `card.update` on state transitions, image-key arrival, reasoning panel toggles, and the final state.

Final-state cards include the elapsed turn time in the footer (e.g. `已完成 · 3.4s`). Live streaming cards (thinking/streaming states) also show a ticking elapsed footer (`⏳ 处理中... 8.2s`) so long-running tasks give the user a continuous time signal. Models that emit `<think>...</think>` / `<thinking>...</thinking>` (or a `Reasoning:\n_…_` prefix) get the reasoning rendered above the answer in a separate notation-sized block, with a horizontal divider before the answer body. Markdown image URLs (`![alt](https://...)`) are resolved to Feishu `image_key` references on the fly so the card renders the image inline; URLs that don't resolve within the configurable timeout are stripped.

When `channel.replyMode: "verbose"` (the default) is paired with streaming mode, tool calls are rendered as a collapsible **🔧 工具调用 (N)** panel above the answer body instead of inline text segments. Each step shows status (✅/⏳/❌), a kind icon (📖 read · 🔍 search · 💻 execute · ✏️ edit · 🧠 think · 🔧 other), the tool name, a one-line summary derived from the call's input (e.g. file path, command, search pattern), and the duration once finished. Static mode keeps the legacy inline behavior — each tool call lands as its own text bubble.

The streaming card consumes the structured tool-use side-channel by registering an `onToolEvent` callback. The transport defaults to `toolEventMode: "structured"` whenever a handler is provided, so events flow into the collapsible card panel instead of the legacy text bubbles.

The card terminates gracefully on daemon shutdown: SIGINT/SIGTERM/`beforeExit` drives every in-flight card to its "已停止" state before the process exits, so a killed `xacpx` daemon no longer leaves cards stuck at "处理中..." in the user's Feishu chat.

Streaming mode requires the bot to have **`cardkit:card:write`** plus **`im:message:send_as_bot`** scopes. If the initial `cardkit.v1.card.create` call fails (most commonly: missing scope), the channel logs `feishu.streaming.fallback` and falls back to the static path for that turn. When the failure is a Feishu permission error (code `99991672`) the grant URL is also sent to the user once per 5-minute cooldown.

Set globally:

```jsonc
{
  "channels": [
    {
      "id": "feishu",
      "type": "feishu",
      "options": {
        "appId": "cli_xxx",
        "appSecret": "yyy",
        "replyMode": "streaming"
      }
    }
  ]
}
```

Or per account:

```jsonc
{
  "options": {
    "replyMode": "streaming",
    "accounts": {
      "main":   { "appId": "...", "appSecret": "...", "replyMode": "streaming" },
      "legacy": { "appId": "...", "appSecret": "...", "replyMode": "static" }
    }
  }
}
```

## Cancelling the in-flight turn

While the agent is processing, the user can send `stop`, `/stop`, `abort`, `停止`, `取消`, etc. The channel:

1. Aborts the per-turn `AbortController` (which the router forwards to `transport.cancel()` so the underlying `acpx` process is interrupted).
2. Renders an "已停止" final state on the streaming card, or sends a "已停止当前任务。" reply in static mode.
3. Removes the typing reaction added to the user's original message.

## Real-time session switching & background execution

Each inbound prompt is **bound at dispatch time** to whatever session the chat is currently on, then runs on a **per-session lane**:

- **Different sessions run concurrently.** Switching to another session (`/use`/`/ss`) while a task is in flight lets you use the new session immediately — turns on different sessions don't block each other.
- **Same-session turns serialize**, preserving order within a session.
- **Switch and cancel commands preempt.** `/use`, `/ss`, `/cancel`, `/stop` run on a **control lane**, so they take effect right away even while a prompt is running (the running prompt keeps going in the background — see below).

When you switch away from a running session, its turn keeps executing in the background. Feishu uses **"B-semantics"**, which differs from the WeChat channel:

- The backgrounded session has its **own streaming card** that keeps refreshing **to completion in the chat timeline** — it is *not* gated/suppressed. The result simply stays on that card.
- On completion, a short ping is sent to the chat: `✅ <alias> 已完成` (or `⚠️ <alias> 失败`). Unlike WeChat, there is **no `/use 查看结果`** suffix — there is nothing to replay, because the card already holds the result.
- Switching **back** to that session does **not** re-send the result.
- `/sessions` marks sessions with an unfinished/unread background completion using `●`.

`/cancel <alias>` (and `/stop <alias>`) target a specific session's in-flight turn by alias — fuzzy alias resolution applies, the same as `/use`.

