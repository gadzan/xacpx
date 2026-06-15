# xacpx

> Remotely drive Codex, Claude Code, and other acpx sessions from WeChat, Feishu, or Yuanbao.

[![npm](https://img.shields.io/npm/v/@ganglion/xacpx?style=flat-square)](https://www.npmjs.com/package/@ganglion/xacpx)
[![Node.js Version](https://img.shields.io/node/v/@ganglion/xacpx?style=flat-square)](https://nodejs.org)
[![zread](https://img.shields.io/badge/Ask_Zread-_.svg?style=flat-square&color=00b0aa&labelColor=000000&logo=data%3Aimage%2Fsvg%2Bxml%3Bbase64%2CPHN2ZyB3aWR0aD0iMTYiIGhlaWdodD0iMTYiIHZpZXdCb3g9IjAgMCAxNiAxNiIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHBhdGggZD0iTTQuOTYxNTYgMS42MDAxSDIuMjQxNTZDMS44ODgxIDEuNjAwMSAxLjYwMTU2IDEuODg2NjQgMS42MDE1NiAyLjI0MDFWNC45NjAxQzEuNjAxNTYgNS4zMTM1NiAxLjg4ODEgNS42MDAxIDIuMjQxNTYgNS42MDAxSDQuOTYxNTZDNS4zMTUwMiA1LjYwMDEgNS42MDE1NiA1LjMxMzU2IDUuNjAxNTYgNC45NjAxVjIuMjQwMUM1LjYwMTU2IDEuODg2NjQgNS4zMTUwMiAxLjYwMDEgNC45NjE1NiAxLjYwMDFaIiBmaWxsPSIjZmZmIi8%2BCjxwYXRoIGQ9Ik00Ljk2MTU2IDEwLjM5OTlIMi4yNDE1NkMxLjg4ODEgMTAuMzk5OSAxLjYwMTU2IDEwLjY4NjQgMS42MDE1NiAxMS4wMzk5VjEzLjc1OTlDMS42MDE1NiAxNC4xMTM0IDEuODg4MSAxNC4zOTk5IDIuMjQxNTYgMTQuMzk5OUg0Ljk2MTU2QzUuMzE1MDIgMTQuMzk5OSA1LjYwMTU2IDE0LjExMzQgNS42MDE1NiAxMy43NTk5VjExLjAzOTlDNS42MDE1NiAxMC42ODY0IDUuMzE1MDIgMTAuMzk5OSA0Ljk2MTU2IDEwLjM5OTlaIiBmaWxsPSIjZmZmIi8%2BCjxwYXRoIGQ9Ik0xMy43NTg0IDEuNjAwMUgxMS4wMzg0QzEwLjY4NSAxLjYwMDEgMTAuMzk4NCAxLjg4NjY0IDEwLjM5ODQgMi4yNDAxVjQuOTYwMUMxMC4zOTg0IDUuMzEzNTYgMTAuNjg1IDUuNjAwMSAxMS4wMzg0IDUuNjAwMUgxMy43NTg0QzE0LjExMTkgNS42MDAxIDE0LjM5ODQgNS42MDE1NiAxNC4zOTg0IDQuOTYwMVYyLjI0MDFDMTQuMzk4NCAxLjg4NjY0IDE0LjExMTkgMS42MDAxIDEzLjc1ODQgMS42MDAxWiIgZmlsbD0iI2ZmZiIvPgo8cGF0aCBkPSJNNCAxMkwxMiA0TDQgMTJaIiBmaWxsPSIjZmZmIi8%2BCjxwYXRoIGQ9Ik00IDEyTDEyIDQiIHN0cm9rZT0iI2ZmZiIgc3Ryb2tlLXdpZHRoPSIxLjUiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIvPgo8L3N2Zz4K&logoColor=ffffff)](https://zread.ai/gadzan/xacpx)
[![License](https://img.shields.io/npm/l/@ganglion/xacpx?style=flat-square)](./LICENSE)

English · **[中文](./docs/zh/README_zh.md)**

## What is this

`xacpx` is a tool that lets you control ACP agents such as Codex / Claude Code / Gemini / OpenCode directly from WeChat, Feishu, or Yuanbao. It connects chat messages to your agent CLI sessions through `acpx`, so you can, right from your phone:

[![xacpx.png](https://s41.ax1x.com/2026/06/05/pmZXIv6.png)](https://imgchr.com/i/pmZXIv6)

- Create and switch between sessions
- Have the agent keep working in a specific project directory
- View streaming replies, final results, and tool-call summaries
- Adjust permission policies
- Orchestrate multiple agents when needed

If you need to code or work remotely on a temporary basis, `xacpx` gives you a fast, convenient **remote entry point** so you can get things done from WeChat or Feishu anytime, anywhere.

## Who it's for

`xacpx` suits users who want lightweight, on-demand multi-agent work. You can watch tasks, send commands, and view results from WeChat, Feishu, or Yuanbao, and manage multiple sessions within the same chat.

> For everyday use, remember `/ss` first: it creates or reuses an xacpx logical session. If you want to attach to an existing native session of a local agent such as Codex, use `/ssn`; see [docs/native-sessions.md](./docs/native-sessions.md) for advanced details.

## 5-minute quick start

### Prerequisites

Before you start, you need at least:

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

### Log in to WeChat

```bash
xacpx login
```

The terminal will show a QR code; scan it with WeChat to log in.

If you want to use Feishu or Yuanbao instead of WeChat, see "Switch / add other channels" below first.

### Start the service

```bash
xacpx start
```

### Create your first session in WeChat

Send these two messages in WeChat:

```text
/ss codex -d /absolute/path/to/your/repo
/help
```

Then just send plain text, for example:

```text
hello
```

If everything works, plain text goes into the current session and the agent's reply comes back to WeChat.

### Switch / add other channels

WeChat is the built-in default channel. Feishu and Yuanbao are distributed as official plugin packages, and third-party channels follow the same plugin flow. If you can't remember the package names, check the official plugin list first:

```bash
xacpx plugin known
# Install: xacpx plugin add <package>
```

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

For full credential configuration, parameters, and management commands such as `enable/disable/rm`, see [docs/channel-management.md](./docs/channel-management.md). If you want to write your own channel plugin, see [docs/plugin-development.md](./docs/plugin-development.md).

## Your everyday workflow

The most common sequence is just four steps:

1. **Start the background service**: `xacpx start`
2. **Create or switch sessions**: `/ss ...`, `/use ...`
3. **Send plain text directly**: let the current session keep working
4. **Check status or cancel the current task when needed**: `/status`, `/cancel`

### 1) Create a session

The most common command:

```text
/ss codex -d /absolute/path/to/your/repo
```

It uses `codex`, binds this working directory, and automatically switches to the new session.

### 2) Send plain messages

Any text not starting with `/` is sent to the current session.

```text
Fix this recent API timeout issue
```

### 3) View replies

`xacpx` supports three common reply modes:

- `stream`: stream back intermediate text
- `final`: return only the final result
- `verbose`: the default; in addition to streaming text, also shows tool-call summaries

For example, in `verbose` mode you'll see:

```text
📖 sed -n '1,220p' README.md
🔍 rg -n 'session new' src tests
💻 bun test tests/unit/main.test.ts
✏️ Edit parse-command.ts
```

### 4) Switch sessions

```text
/ss
/use backend:codex
```

This lets you switch between sessions for different projects and different agents within the same WeChat chat.

## Common CLI commands

These commands run in a terminal on your computer.

| Command | Description |
|------|------|
| `xacpx login` | Log in to WeChat |
| `xacpx logout` | Clear the WeChat login credentials saved on this machine |
| `xacpx run` | Run in the foreground, useful for debugging |
| `xacpx start` | Start the service in the background |
| `xacpx status` | Show background status, PID, config path, and log path |
| `xacpx stop` | Stop the background instance |
| `xacpx restart` | Restart the background instance so channel config changes take effect |
| `xacpx update [--all\|<name>]` | Check and update xacpx and installed plugins; when plugins are installed, it interactively lets you choose what to update |
| `xacpx channel list\|show\|add\|rm\|enable\|disable [--account <id>]` | Manage message channels; `--account <id>` targets one bot when several share a channel (multi-bot) |
| `xacpx plugin list\|add\|update\|remove\|enable\|disable\|doctor\|known` | Manage plugins: list/install/update/remove, toggle, run `doctor`, or list official packages with `known` |
| `xacpx plugin add @ganglion/xacpx-channel-feishu && xacpx channel add feishu` | Install and add the Feishu channel; prompts for Feishu app credentials |
| `xacpx plugin add @ganglion/xacpx-channel-yuanbao && xacpx channel add yuanbao` | Install and add the Yuanbao channel; prompts for Yuanbao appKey/appSecret |
| `xacpx doctor` | Run environment diagnostics |
| `xacpx version` | Show the current version |
| `xacpx agent list` | List agents registered on this machine |
| `xacpx agent add <name>` | Add an agent from a built-in template; an existing agent of the same name with a different config is not overwritten |
| `xacpx agent rm <name>` | Remove an agent |
| `xacpx workspace list` | List workspaces registered on this machine |
| `xacpx workspace add [name] [--raw]` | Register the current directory as a workspace; without `name`, uses the current directory name, and names with special characters are normalized automatically |
| `xacpx workspace rm <name>` | Remove a workspace |
| `xacpx later list` / `xacpx lt list` | List this machine's pending scheduled tasks in the terminal |
| `xacpx later cancel <id>` / `xacpx lt cancel <id>` | Cancel a pending scheduled task in the terminal |

The first time you run `xacpx start` or `xacpx run`, if there are no sessions, workspaces, or plugins, the CLI asks whether to register the current directory as a workspace and lets you choose a built-in agent template; after the service starts, it creates the initial acpx session through the normal session-creation flow.

`workspace` can also be abbreviated as `ws`:

```bash
xacpx ws add
xacpx ws list
xacpx ws rm backend
```

### How to use the `workspace` CLI

`xacpx workspace` maintains the `workspaces` config in `~/.xacpx/config.json` on your local machine. It's good for registering frequently used project directories in the terminal first, then referencing them directly in WeChat with `--ws <name>`.

| Command | Description |
|------|------|
| `xacpx workspace list` | List registered workspaces and their paths |
| `xacpx workspace add` | Register the current directory as a workspace, defaulting the name to the current directory name (normalized automatically) |
| `xacpx workspace add <name>` | Register the current directory under a specific name (normalized if it contains special characters) |
| `xacpx workspace add [name] --raw` | Keep the original name (including spaces, etc.); later commands must quote it |
| `xacpx workspace rm <name>` | Remove a specific workspace |

Common usage:

```bash
cd /absolute/path/to/backend
xacpx workspace add backend

cd /absolute/path/to/frontend
xacpx ws add frontend

xacpx ws list
xacpx ws rm frontend
```

Once registered, you can use it directly in WeChat:

```text
/ss codex --ws backend
/ss new claude --ws frontend
```

Note: `workspace add` always registers the **directory the terminal is currently in**. Without a name, it uses the current directory name as the workspace name. Names containing spaces, Chinese characters, etc. are normalized automatically to `[a-zA-Z0-9._-]+` (for example, the directory `My Project` is saved as `My-Project`), with `-2`, `-3` appended on collisions. To keep the original name, add `--raw`; afterwards `xacpx workspace rm`, `/ws rm`, and `--ws <name>` all need quoting, for example `xacpx workspace rm "My Project"`.

### How to use the `agent` CLI

`xacpx agent` maintains the `agents` config in `~/.xacpx/config.json` on your local machine; `agents` is an equivalent alias.

| Command | Description |
|------|------|
| `xacpx agent list` | List registered agents |
| `xacpx agent templates` | List the built-in templates you can add |
| `xacpx agent add <name>` | Add an agent from a built-in template, e.g. `kimi`, `opencode` |
| `xacpx agent rm <name>` | Remove a specific agent |

Common usage:

```bash
xacpx agent templates
xacpx agent add kimi
xacpx agents list
xacpx agent rm kimi
```

### How to use `doctor`

```bash
xacpx doctor
xacpx doctor --verbose
xacpx doctor --smoke
xacpx doctor --smoke --agent codex --workspace backend
xacpx doctor --fix
```

Notes:

- `--verbose` expands the details of each check
- `--smoke` additionally runs a minimal real transport-level prompt check
- `--agent` / `--workspace` only affect `--smoke`
- Without `--smoke`, the related checks show as `SKIP`
- `--fix` applies safe local repairs (runtime dir permissions, stale locks, invalid state records) and re-checks; state-mutating repairs are withheld while the daemon runs — see [docs/doctor-command.md](docs/doctor-command.md)

### How to use `update`

`xacpx update` checks for and installs new versions of xacpx itself and your installed channel plugins.

```bash
xacpx update            # interactive: pick what to update
xacpx update --all      # update everything (core + all plugins) non-interactively
xacpx update <name>     # update a single target (the core, or a specific plugin package)
```

Notes:

- When plugins are installed, the bare `xacpx update` is interactive and lets you choose which targets to update.
- In a non-interactive environment, updating the core or plugins needs explicit confirmation: use `xacpx update --all`, or name the target with `xacpx update <name>`.
- `update` covers the core package and channel plugins; to manage a single plugin's version directly, see `xacpx plugin update <name>` ([docs/plugin-development.md](./docs/plugin-development.md)).
- After updating, run `xacpx restart` so a running daemon loads the new version.
- Cross-package rename migration: this project was renamed `weacpx` → `xacpx`. If you still have the legacy `weacpx` package installed, running `weacpx update` will offer to migrate you across to `xacpx` automatically (you confirm the switch). Already on `xacpx`? Just use `xacpx update` as a normal self-update.

## Common chat commands

These commands are sent in a WeChat or Feishu chat. For the full command reference, see [docs/commands.md](./docs/commands.md).

### Agent management

The default config usually already includes `codex` and `claude`. If you want to use another acpx-supported agent, you can add it from a built-in template with `/agent add <name>`.

| Command | Description |
|------|------|
| `/agents` | List agents |
| `/agent add gemini` | Add the `Gemini` agent |
| `/agent add opencode` | Add the `OpenCode` agent |
| `/agent rm <name>` | Remove an agent |

The current built-in templates align with acpx's built-in agents:

```text
codex, claude, pi, openclaw, gemini, cursor, copilot, droid,
factory-droid, factorydroid, iflow, kilocode, kimi, kiro,
opencode, qoder, qwen, trae
```

These templates only write `driver`; the actual launch command is resolved by acpx. For example, `/agent add kimi` saves `{ "driver": "kimi" }`. For full command docs see [docs/commands.md](./docs/commands.md), and for config fields see [docs/config-reference.md](./docs/config-reference.md).

### Workspace management

| Command | Description |
|------|------|
| `/workspaces` / `/workspace` / `/ws` | List workspaces |
| `/ws new <name> -d <path> [--raw]` | Add a workspace; `path` is an absolute path on your computer, and Windows does not distinguish forward/back slashes; names with special characters such as spaces/Chinese are normalized automatically, and --raw keeps the original name |
| `/workspace rm <name>` | Remove a workspace |

### Sessions

| Command | Description |
|------|------|
| `/sessions` / `/session` / `/ss` | List sessions |
| `/ss <agent> (-d <path> \| --ws <name>)` | Create or reuse your current most-used session |
| `/ss new <agent> (-d <path> \| --ws <name>)` | Force-create a new session |
| `/ssn <agent> (-d <path> \| --ws <name>)` | Attach to an existing native session of a local agent; see [native sessions](./docs/native-sessions.md) |
| `/use <alias>` | Switch the current session |
| `/status` | Show the current session status |
| `/mode` / `/mode <id>` | View or set the underlying `acpx` mode |
| `/model` / `/model <id>` | View or switch the session's LLM model (also `/session new --model`, `/agent add --model`) |
| `/replymode` | Show the current reply mode |
| `/replymode stream` | Streaming replies |
| `/replymode verbose` | Streaming + tool-call summaries |
| `/replymode final` | Return only the final result |
| `/replymode reset` | Fall back to the global default reply mode |
| `/session reset` | Reset the current session context |
| `/clear` | Shortcut alias for `/session reset` |
| `/cancel` / `/stop` | Stop the current task |

We suggest remembering these three first:

```text
/ss codex -d /absolute/path/to/repo
/use <alias>
/cancel
```

To attach to an existing native session of a local agent such as Codex, use `/ssn codex -d /absolute/path/to/repo`; for full semantics see [docs/native-sessions.md](./docs/native-sessions.md).

### Scheduled tasks (/later)

Have the agent automatically receive a message at some point in the future. **By default it runs in a temporary session created just for that task** (inheriting the agent and workspace of the current session at creation time, with a fresh conversation history, destroyed once finished); adding `--bind` sends it to the current session bound at creation time. When the time comes, the message is delivered as a normal prompt and the result is pushed back to the original chat.

| Command | Description |
|------|------|
| `/lt <time> <message>` | Create a scheduled task (runs in a temporary session by default; `/later` is a synonym) |
| `/lt --bind <time> <message>` | Send to the current session instead |
| `/lt list` | List globally pending tasks |
| `/lt cancel <id>` | Cancel a pending task |

The most common examples:

```text
/lt in 2h check whether CI passes        # temporary session (default)
/lt --bind tomorrow 09:00 review the PR    # bound to the current session
/lt list
```

Notes:

- Runs in a temporary session by default; `--bind` binds to the current session. The default mode can be changed via the config `later.defaultMode` (`temp` / `bind`, default `temp`)
- Only one-time tasks are supported; the time must be more than 10 seconds and within 7 days from now
- The time format is a fixed whitelist (relative time / today·tomorrow·day-after-tomorrow / weekday + time); natural language is not supported
- In normal conversation, the agent can also create, list, and cancel scheduled tasks via the current session's internal tools (`scheduled_create` / `scheduled_list` / `scheduled_cancel`); routing and permissions are resolved by the daemon from the current chat session, and the external `mcp-stdio` does not expose these tools
- You can also manage pending tasks from the terminal with `xacpx later list` / `xacpx later cancel <id>`; the CLI only lists and cancels, it does not create scheduled tasks
- For full time formats, temporary/bound modes, task status, and limits, see [docs/later-command.md](./docs/later-command.md)

### Config and permissions

| Command | Description |
|------|------|
| `/config` | Show the config paths that can be changed via chat commands |
| `/config set <path> <value>` | Change a whitelisted config item |
| `/pm` / `/permission` | Show the current permission mode |
| `/pm set allow` | Switch to `approve-all` |
| `/pm set read` | Switch to `approve-reads` |
| `/pm set deny` | Switch to `deny-all` |
| `/pm auto` | Show the current non-interactive permission policy |
| `/pm auto deny` | Switch to `deny` |
| `/pm auto fail` | Switch to `fail` |

The most common examples:

```text
/config set wechat.replyMode final
/pm set read
/pm auto deny
```

> `/config set language en` (or `zh`) switches the xacpx interface language; it otherwise follows your system locale. See [docs/config-reference.md](./docs/config-reference.md).

### Multi-agent orchestration

The README keeps only the most common user-facing commands.

| Command | Description |
|------|------|
| `/dg <agent> <task>` | Quickly delegate a subtask |
| `/tasks` | List tasks under the current main line |
| `/task <id>` | Show details of a single task |
| `/task approve <id>` | Approve a `needs_confirmation` task |
| `/task cancel <id>` | Cancel a task; cancelling a not-yet-approved task is equivalent to rejecting it |

The most common examples:

```text
/dg claude review the 3 high-risk points of the current plan
/tasks
/task approve task_123
```

Notes:

- The current session is the coordinator session
- What gets delegated out are independent subtask sessions
- Delegation requests initiated by the agent require human confirmation by default
- If you're using an external MCP host (Codex / Claude Code), use `delegate_batch` to dispatch multiple parallel subtasks at once: pass a `tasks` array, a group is created automatically under the hood, and all results are injected back at once with no need to maintain a groupId manually

If you want to first understand when to delegate and when to dispatch multiple subtasks in parallel, see:

- [docs/xacpx-group-usage-guide.md](./docs/xacpx-group-usage-guide.md)


### MCP integration: external coordinator

If you want external MCP hosts such as Codex or Claude Code to use xacpx's multi-agent orchestration directly, you can configure `xacpx mcp-stdio` as a stdio MCP server.

`delegate_request` supports MCP Tasks: a host that supports this capability can make the delegation request return a native task handle immediately, then get status, results, or cancel the task via `tasks/get` / `tasks/result` / `tasks/cancel`; the worker's `[PROGRESS] ...` output shows up in the `statusMessage` of `tasks/get` / `tasks/list`; in the `input_required` state, `tasks/result` returns a next-step hint and ends this result stream rather than blocking for a long time; after the client calls tools such as `task_get` / `task_approve` / `coordinator_answer_question` per the hint, it continues polling `tasks/get` / `tasks/result`. A host that does not support MCP Tasks can still use the compatibility tools `task_get` / `task_list` / `task_watch` / `task_cancel`.

The natural-language creation tool for scheduled tasks is an internal capability of the xacpx current session and does not appear in the external `xacpx mcp-stdio` tool list.

Start the daemon first:

```bash
xacpx start
```

We recommend keeping the MCP config simple and not binding a workspace in the launch arguments:

```json
{
  "mcpServers": {
    "xacpx": {
      "command": "xacpx",
      "args": ["mcp-stdio"]
    }
  }
}
```

When an external host calls `delegate_request`, pass `workingDirectory`, and xacpx will make the delegated worker work in that directory:

```json
{
  "targetAgent": "claude",
  "task": "review the risks of this change",
  "workingDirectory": "/absolute/path/to/your/repo"
}
```

On Windows, if the MCP host won't resolve a `command` with arguments for you, put `node.exe` in `command` and the xacpx script and arguments in `args`:

```json
{
  "type": "stdio",
  "command": "C:\\Program Files\\nodejs\\node.exe",
  "args": [
    "C:\\path\\to\\xacpx\\dist\\cli.js",
    "mcp-stdio"
  ]
}
```

For more identity rules, `workingDirectory` semantics, the tool list, flow diagrams, and troubleshooting, see [docs/external-mcp.md](./docs/external-mcp.md).

## Common scenarios

### Keep watching a local project from your phone

```text
/ss codex -d /absolute/path/to/backend
take a look at today's API timeout issue
```

### Switch between two projects in the same chat

```text
/ss codex -d /absolute/path/to/backend
/ss new codex -d /absolute/path/to/frontend
/ss
/use backend:codex
/use frontend:codex
```

### Attach to an existing local Codex native session

```text
/ssn codex -d /absolute/path/to/backend
/ssn 1
```

For more filtering, aliases, and troubleshooting, see [docs/native-sessions.md](./docs/native-sessions.md).

## Self-hosted relay hub (optional)

If you run several xacpx instances and want to drive them all from one browser dashboard, you can self-host the **relay hub**. Each instance dials out to the hub over WebSocket and registers; you log in to a multi-tenant web dashboard and manage every instance's sessions — chat, scheduled tasks, and orchestration — from one place. Streaming agent replies render as markdown, and the layout works on mobile.

> Status: the relay packages are built and audited but **not yet published to npm**, so today you deploy from a source checkout. See the full guide for the exact steps.

```bash
# Build the hub server + dashboard from a repo checkout
git clone https://github.com/gadzan/xacpx && cd xacpx && bun install
bun run build:relay && bun run build:relay-web

# Create the first admin, then start (point --web-root at the built dashboard)
node packages/relay/dist/cli.js init-admin --username admin --db /var/lib/xacpx-relay/relay.db
node packages/relay/dist/cli.js start --db /var/lib/xacpx-relay/relay.db \
  --web-root packages/relay-web/dist --host 0.0.0.0
```

Full walkthrough — pairing instances, TLS/reverse-proxy, systemd, backups, troubleshooting: **[Self-Hosting the Relay Hub](https://gadzan.github.io/xacpx/guide/relay-self-hosting)** (or [docs/relay-deployment.md](./docs/relay-deployment.md) for the terse runbook).

## Config and runtime files

Default file locations:

- Config file: `~/.xacpx/config.json`
- State file: `~/.xacpx/state.json`
- Runtime log: `~/.xacpx/runtime/app.log`

More runtime files are placed under `~/.xacpx/runtime/`.

## FAQ

### What if `/ss new` fails?

If session creation fails in WeChat, the most common cause is not a wrong `xacpx` command format, but that the underlying session was not created successfully.

You can try these two steps first:

1. Confirm in the terminal that the current project directory and the agent itself work
2. If you're familiar with `acpx`, manually create a session first, then attach to it from WeChat

For example, you can create a session locally first:

```bash
./node_modules/.bin/acpx --verbose --cwd /absolute/workspace/path codex sessions new --name existing-demo
```

Then attach to it from WeChat:

```text
/ss attach demo -a codex --ws backend --name existing-demo
```

### What is the `<id>` in `/mode <id>`?

The valid values for `/mode` depend on the agent you're currently using; `xacpx` does not normalize these values for you.

Currently the more clearly known values are:

- `codex`: `plan`
- `cursor`: `agent`, `plan`, `ask`

If you're unsure whether a value works, check the corresponding agent's docs first; if you get it wrong, you'll usually get an error such as an invalid argument.

## Running from source

If you're using the repo source directly:

```bash
bun install
bun run login
bun run dev
```

## More docs

If what you're about to do is one of the following, you can continue from here:

### Installation and configuration

- Want to configure WeChat, Feishu, Yuanbao, or a third-party plugin channel: [docs/channel-management.md](./docs/channel-management.md)
- Want to write your own channel plugin: [docs/plugin-development.md](./docs/plugin-development.md)
- Want the full config field reference: [docs/config-reference.md](./docs/config-reference.md)
- Want to change config from WeChat: [docs/config-command.md](./docs/config-command.md)

### Everyday use

- Want the full chat-command reference: [docs/commands.md](./docs/commands.md)
- Want to schedule a one-time future message with scheduled tasks (`/later`): [docs/later-command.md](./docs/later-command.md)
- Want to understand when to delegate and when to open a group: [docs/xacpx-group-usage-guide.md](./docs/xacpx-group-usage-guide.md)

### Troubleshooting and verification

- Want to run tests or understand the test layout: [docs/testing.md](./docs/testing.md)

### Development and contribution

- Want to develop, debug, or contribute from source: [docs/developments.md](./docs/developments.md)
