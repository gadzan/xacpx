# xacpx

![xacpx.png](xacpx_banner.png)

> Remotely drive Codex, Claude Code, and other acpx sessions from WeChat, Feishu, or Yuanbao.

[![npm](https://img.shields.io/npm/v/@ganglion/xacpx?style=flat-square)](https://www.npmjs.com/package/@ganglion/xacpx)
[![Node.js Version](https://img.shields.io/node/v/@ganglion/xacpx?style=flat-square)](https://nodejs.org)
[![zread](https://img.shields.io/badge/Ask_Zread-_.svg?style=flat-square&color=00b0aa&labelColor=000000&logo=data%3Aimage%2Fsvg%2Bxml%3Bbase64%2CPHN2ZyB3aWR0aD0iMTYiIGhlaWdodD0iMTYiIHZpZXdCb3g9IjAgMCAxNiAxNiIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHBhdGggZD0iTTQuOTYxNTYgMS42MDAxSDIuMjQxNTZDMS44ODgxIDEuNjAwMSAxLjYwMTU2IDEuODg2NjQgMS42MDE1NiAyLjI0MDFWNC45NjAxQzEuNjAxNTYgNS4zMTM1NiAxLjg4ODEgNS42MDAxIDIuMjQxNTYgNS42MDAxSDQuOTYxNTZDNS4zMTUwMiA1LjYwMDEgNS42MDE1NiA1LjMxMzU2IDUuNjAxNTYgNC45NjAxVjIuMjQwMUM1LjYwMTU2IDEuODg2NjQgNS4zMTUwMiAxLjYwMDEgNC45NjE1NiAxLjYwMDFaIiBmaWxsPSIjZmZmIi8%2BCjxwYXRoIGQ9Ik00Ljk2MTU2IDEwLjM5OTlIMi4yNDE1NkMxLjg4ODEgMTAuMzk5OSAxLjYwMTU2IDEwLjY4NjQgMS42MDE1NiAxMS4wMzk5VjEzLjc1OTlDMS42MDE1NiAxNC4xMTM0IDEuODg4MSAxNC4zOTk5IDIuMjQxNTYgMTQuMzk5OUg0Ljk2MTU2QzUuMzE1MDIgMTQuMzk5OSA1LjYwMTU2IDE0LjExMzQgNS42MDE1NiAxMy43NTk5VjExLjAzOTlDNS42MDE1NiAxMC42ODY0IDUuMzE1MDIgMTAuMzk5OSA0Ljk2MTU2IDEwLjM5OTlaIiBmaWxsPSIjZmZmIi8%2BCjxwYXRoIGQ9Ik0xMy43NTg0IDEuNjAwMUgxMS4wMzg0QzEwLjY4NSAxLjYwMDEgMTAuMzk4NCAxLjg4NjY0IDEwLjM5ODQgMi4yNDAxVjQuOTYwMUMxMC4zOTg0IDUuMzEzNTYgMTAuNjg1IDUuNjAwMSAxMS4wMzg0IDUuNjAwMUgxMy43NTg0QzE0LjExMTkgNS42MDAxIDE0LjM5ODQgNS42MDE1NiAxNC4zOTg0IDQuOTYwMVYyLjI0MDFDMTQuMzk4NCAxLjg4NjY0IDE0LjExMTkgMS42MDAxIDEzLjc1ODQgMS42MDAxWiIgZmlsbD0iI2ZmZiIvPgo8cGF0aCBkPSJNNCAxMkwxMiA0TDQgMTJaIiBmaWxsPSIjZmZmIi8%2BCjxwYXRoIGQ9Ik00IDEyTDEyIDQiIHN0cm9rZT0iI2ZmZiIgc3Ryb2tlLXdpZHRoPSIxLjUiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIvPgo8L3N2Zz4K&logoColor=ffffff)](https://zread.ai/gadzan/xacpx)
[![License](https://img.shields.io/npm/l/@ganglion/xacpx?style=flat-square)](./LICENSE)

English · **[中文](./docs/zh/README_zh.md)**

## What is this

`xacpx` is a tool that lets you control ACP agents such as Codex / Claude Code / Gemini / OpenCode directly from WeChat, Feishu, or Yuanbao. It connects chat messages to your agent CLI sessions through `acpx`, so you can, right from your phone:

- Create and switch between sessions
- Have the agent keep working in a specific project directory
- View streaming replies, final results, and tool-call summaries
- Adjust permission policies
- Orchestrate multiple agents when needed

If you need to code or work remotely on a temporary basis, `xacpx` gives you a fast, convenient **remote entry point** so you can get things done from WeChat or Feishu anytime, anywhere.

> For everyday use, remember `/ss` first: it creates or reuses an xacpx logical session. If you want to attach to an existing native session of a local agent such as Codex, use `/ssn`; see [native sessions](./docs/native-sessions.md).

## 5-minute quick start

### Prerequisites

- Node.js 22+ or Bun
- A working agent CLI you intend to use, such as Codex / Claude Code / Gemini / OpenCode
- A phone with WeChat, Feishu, or Yuanbao installed

> The WeChat channel works on top of `weixin-agent-sdk`, the Feishu channel uses Feishu custom-app credentials, and the Yuanbao channel uses `appKey` / `appSecret`; the underlying agent sessions are driven by `acpx`. Normally you don't need to install `acpx` globally.

### Install

```bash
npm install -g @ganglion/xacpx --registry=https://registry.npmjs.org
# or
bun add -g @ganglion/xacpx
```

### Log in and start

```bash
xacpx login    # shows a QR code; scan it with WeChat
xacpx start    # start the background service
```

To use Feishu or Yuanbao instead of WeChat, see "Other channels" below first.

### Create your first session in WeChat

Send these messages in WeChat:

```text
/ss codex -d /absolute/path/to/your/repo
/help
```

Then just send plain text:

```text
hello
```

If everything works, plain text goes into the current session and the agent's reply comes back to WeChat.

### Other channels

WeChat is the built-in default channel. Feishu and Yuanbao are distributed as official plugin packages, and third-party channels follow the same plugin flow. If you can't remember the package names, run `xacpx plugin known` first.

```bash
# Feishu
xacpx plugin add @ganglion/xacpx-channel-feishu
xacpx channel add feishu     # enter appId/appSecret when prompted
xacpx restart

# Yuanbao
xacpx plugin add @ganglion/xacpx-channel-yuanbao
xacpx channel add yuanbao    # enter appKey/appSecret when prompted
xacpx restart
```

Full credentials, parameters, and management commands (`enable/disable/rm`): [channel-management.md](./docs/channel-management.md). To write your own channel plugin: [plugin-development.md](./docs/plugin-development.md).

## Your everyday workflow

The most common sequence is just four steps:

1. **Start the background service**: `xacpx start`
2. **Create or switch sessions**: `/ss ...`, `/use ...`
3. **Send plain text directly**: any text not starting with `/` goes to the current session
4. **Check status or cancel when needed**: `/status`, `/cancel`

### Reply modes

`xacpx` supports three reply modes (switch per session with `/replymode`):

- `stream`: stream back intermediate text
- `final`: return only the final result
- `verbose`: the default; streaming text plus tool-call summaries

For example, in `verbose` mode you'll see:

```text
📖 sed -n '1,220p' README.md
🔍 rg -n 'session new' src tests
💻 bun test tests/unit/main.test.ts
✏️ Edit parse-command.ts
```

## Command cheat sheet

The essentials to get going. Full references: **CLI → [cli-reference.md](./docs/cli-reference.md)**, **chat commands → [commands.md](./docs/commands.md)**.

**Terminal (on the host):**

| Command | Description |
|------|------|
| `xacpx login` / `logout` | Log in / out of WeChat |
| `xacpx start` / `stop` / `restart` / `status` | Manage the background service |
| `xacpx update` | Update xacpx and installed plugins |
| `xacpx adapter list` / `update <name>` | Inspect or opt in to verified Codex/Claude ACP adapter pins |
| `xacpx doctor` | Run environment diagnostics |
| `xacpx channel add <name>` | Add a message channel (Feishu / Yuanbao / …) |
| `xacpx ws add` / `xacpx agent add <name>` | Register a workspace / agent |

**Chat (in WeChat / Feishu / Yuanbao):**

| Command | Description |
|------|------|
| `/ss <agent> -d <path>` | Create or reuse a session in a project directory |
| `/ss new <agent> --ws <name>` | Force-create a new session |
| `/ssn <agent> -d <path>` | Attach to a local agent's [native session](./docs/native-sessions.md) |
| `/use <alias>` | Switch the current session |
| `/status` · `/cancel` | Show status · stop the current task |
| `/model` · `/mode` | Switch the LLM model · set the acpx mode |
| `/replymode stream\|verbose\|final` | Change how replies stream |
| `/lt <time> <message>` | Schedule a one-time future message ([/later](./docs/later-command.md)) |
| `/dg <agent> <task>` | Delegate a subtask to another agent |
| `/pm set read` · `/config set <path> <value>` | Permissions · whitelisted config |

## Multi-agent orchestration & MCP

The current session acts as the coordinator; delegated subtasks (`/dg`, `/tasks`,
`/task approve`) run as independent worker sessions and need human confirmation by
default. External MCP hosts such as Codex or Claude Code can drive xacpx's
orchestration directly by configuring `xacpx mcp-stdio` as a stdio MCP server
(`delegate_request` / `delegate_batch` support MCP Tasks).

- When to delegate vs. open a parallel group: [xacpx-group-usage-guide.md](./docs/xacpx-group-usage-guide.md)
- External MCP setup, identity rules, tool list, troubleshooting: [external-mcp.md](./docs/external-mcp.md)

## Common scenarios

```text
# Keep watching a local project from your phone
/ss codex -d /absolute/path/to/backend
take a look at today's API timeout issue

# Switch between two projects in the same chat
/ss codex -d /absolute/path/to/backend
/ss new codex -d /absolute/path/to/frontend
/ss
/use backend:codex

# Attach to an existing local Codex native session
/ssn codex -d /absolute/path/to/backend
/ssn 1
```

## Self-hosted relay hub (optional)

If you run several xacpx instances and want to drive them all from one browser dashboard, you can self-host the **relay hub**. Each instance dials out to the hub over WebSocket and registers; you log in to a multi-tenant web dashboard and manage every instance's sessions — chat, scheduled tasks, and orchestration — from one place. The hub ships as an npm package (`@ganglion/xacpx-relay`) with the dashboard **bundled in**, served on a single port, with a single **access token** for both web login and connector pairing.

```bash
npm i -g @ganglion/xacpx-relay
xacpx-relay add token        # prints the access token once
xacpx-relay start            # defaults: --host 0.0.0.0 --http-port 8787

# On each instance host:
xacpx plugin add @ganglion/xacpx-channel-relay   # requires xacpx >= 0.17.0-beta.6
xacpx channel add relay --url wss://relay.example.com --token <access-token> --name my-box
xacpx restart
```

Full walkthrough — pairing, TLS/reverse-proxy, systemd, backups, troubleshooting: **[Self-Hosting the Relay Hub](https://gadzan.github.io/xacpx/guide/relay-self-hosting)** (or [relay-deployment.md](./docs/relay-deployment.md) for the terse runbook).

## Config and runtime files

- Config file: `~/.xacpx/config.json`
- State file: `~/.xacpx/state.json`
- Runtime log: `~/.xacpx/runtime/app.log`

More runtime files are placed under `~/.xacpx/runtime/`. For the full config field reference, see [config-reference.md](./docs/config-reference.md).

## Running from source

```bash
bun install
bun run login
bun run dev
```

For development, debugging, and contribution details, see [developments.md](./docs/developments.md).

## More docs

**Install & configure**
- [channel-management.md](./docs/channel-management.md) — configure WeChat / Feishu / Yuanbao / third-party channels
- [plugin-development.md](./docs/plugin-development.md) — write your own channel plugin
- [config-reference.md](./docs/config-reference.md) — full config field reference
- [config-command.md](./docs/config-command.md) — change config from chat

**Everyday use**
- [cli-reference.md](./docs/cli-reference.md) — full terminal CLI reference
- [commands.md](./docs/commands.md) — full chat-command reference
- [later-command.md](./docs/later-command.md) — scheduled tasks (`/later`)
- [native-sessions.md](./docs/native-sessions.md) — attach to a local agent's native session
- [xacpx-group-usage-guide.md](./docs/xacpx-group-usage-guide.md) — when to delegate vs. open a group
- [external-mcp.md](./docs/external-mcp.md) — external MCP coordinator integration

**Troubleshoot & verify**
- [faq.md](./docs/faq.md) — common questions (`/ss new` fails, `/mode <id>`, …)
- [doctor-command.md](./docs/doctor-command.md) — `xacpx doctor` diagnostics and `--fix`
- [testing.md](./docs/testing.md) — test layout and how to run tests

**Develop & contribute**
- [developments.md](./docs/developments.md) — develop, debug, or contribute from source
- [code-wiki.md](./docs/code-wiki.md) — architecture map
