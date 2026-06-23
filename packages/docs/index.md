---
layout: home

hero:
  name: xacpx
  text: Your agents, in any chat
  tagline: Drive Codex, Claude Code & Gemini sessions from WeChat, Feishu, Yuanbao — no terminal required.
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: View on GitHub
      link: https://github.com/gadzan/xacpx

features:
  - icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>'
    title: Chat-native control
    details: Start sessions, switch context, send prompts, and cancel work — all from a message thread.
    link: /guide/getting-started
    linkText: Get started
  - icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/></svg>'
    title: Web dashboard
    details: Self-host the relay hub and drive every instance's sessions — chat, scheduled tasks, orchestration — from one multi-tenant browser dashboard.
    link: /guide/relay-self-hosting
    linkText: Self-host the hub
  - icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>'
    title: acpx transport bridge
    details: Run agents through the direct acpx CLI transport or the isolated JSON bridge subprocess.
    link: /development/code-wiki
    linkText: How it works
  - icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>'
    title: Extensible channels
    details: Add first-party or external channel plugins without touching the core console.
    link: /plugins/development
    linkText: Build a channel
  - icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>'
    title: Two-layer sessions
    details: Logical sessions map your chat context onto real acpx transport sessions — attach or switch live.
    link: /guide/native-sessions
    linkText: Native sessions
  - icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>'
    title: Scheduled tasks
    details: Queue prompts to fire later with /later — relative or absolute times, temporary or bound sessions.
    link: /guide/scheduled-tasks
    linkText: Scheduled tasks
  - icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>'
    title: Multi-agent orchestration
    details: Delegate sub-tasks across agents and coordinate them through the external MCP surface.
    link: /reference/external-mcp
    linkText: Orchestration
---

## What is xacpx?

xacpx is a chat-channel console for remotely controlling `acpx` agent sessions. It acts as a bridge between your chat application and the agent CLI running on your machine, letting you start, switch, and cancel agent work without leaving your phone.

You can use xacpx to drive Codex, Claude Code, Gemini, OpenCode, and any other agent that `acpx` supports — all from a familiar messaging interface.

## When to use it

xacpx is the right tool when you want lightweight, on-the-go access to long-running agent sessions. Common scenarios include:

- Monitoring or redirecting an agent while you are away from your desk.
- Managing several parallel sessions across different projects from a single chat thread.
- Delegating sub-tasks to other agents without opening a terminal.

If your workflow is entirely local and terminal-based, you do not need xacpx — it adds value specifically through the chat channel layer.

## Core workflow

The typical sequence is four steps:

1. **Start the background daemon** — `xacpx start`
2. **Create or switch a session** — `/ss codex -d /path/to/project` or `/use <alias>`
3. **Send plain text prompts** — any message that does not start with `/` is forwarded to the current session
4. **Check status or cancel** — `/status`, `/cancel`

**Session model.** xacpx maintains two distinct layers of session state. A *logical session* is xacpx-managed: it holds an alias, the chosen agent, a workspace binding, and the per-user chat context. A *transport session* is the actual named `acpx` session running on the backend. `/session new` (or the shorthand `/ss`) creates both at once. `/session attach` creates only the logical session and binds it to a transport session that already exists — useful when you have an `acpx` session running independently and want to hook xacpx's chat layer on top of it without disturbing the existing conversation.

## Supported channels

xacpx ships with WeChat as the built-in default channel. Additional channels are distributed as official plugin packages:

| Channel | Package |
|---------|---------|
| WeChat (built-in) | — |
| Feishu | `@ganglion/xacpx-channel-feishu` |
| Yuanbao | `@ganglion/xacpx-channel-yuanbao` |

Third-party channels follow the same plugin interface. Install a channel plugin with `xacpx plugin add <package>`, configure it with `xacpx channel add <name>`, then restart the daemon.

## Web dashboard (relay hub)

Chat is not the only way to drive xacpx. If you run several instances, self-host the **relay hub** — an npm package (`@ganglion/xacpx-relay`) with a web dashboard bundled in. Each instance dials into the hub over WebSocket and registers; you log in to a multi-tenant dashboard and manage every instance's sessions — chat, scheduled tasks, and orchestration — from one place. Agent replies render as live markdown, and the dashboard installs as a PWA on mobile. A single access token serves both web login and connector pairing.

See [Self-Hosting the Relay Hub](/guide/relay-self-hosting) for the full walkthrough.

## Next steps

- [Getting Started](/guide/getting-started) — install xacpx, log in, and run your first session
- [Command Reference](/reference/commands) — full listing of chat commands (`/ss`, `/use`, `/cancel`, and more)
- [Self-Hosting the Relay Hub](/guide/relay-self-hosting) — run the multi-tenant web dashboard for several instances
- [Configuration](/reference/configuration) — config file fields, transport options, and workspace/agent registration
- [Plugin Development](/plugins/development) — build your own channel plugin
