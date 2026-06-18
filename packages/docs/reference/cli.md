# CLI Commands

These commands run in a terminal on your computer (the `xacpx` executable). For the chat (slash) commands you send inside WeChat/Feishu/Yuanbao, see [Commands](/reference/commands).

## Overview

```
xacpx login | logout | run | start | status | stop | restart
xacpx update [--all | <name>]
xacpx channel | ch  list | show | add | rm | enable | disable  [--account <id>]
xacpx plugin  list | add | update | remove | enable | disable | doctor | known
xacpx doctor [--verbose] [--smoke] [--agent <a>] [--workspace <w>] [--fix]
xacpx version
xacpx agent | agents  list | add | rm | templates
xacpx workspace | ws  list | add [name] [--raw] | rm <name>
xacpx later | lt  list | cancel <id>
xacpx mcp-stdio [--coordinator-session <s>] [--source-handle <h>] [--workspace <name>]
```

## Daemon lifecycle

| Command | Description |
|---|---|
| `xacpx login` | Log in to WeChat (shows a QR code to scan) |
| `xacpx logout` | Clear the WeChat login credentials saved on this machine |
| `xacpx run` | Run the console in the foreground (useful for debugging) |
| `xacpx start` | Start the service in the background |
| `xacpx status` | Show background status, PID, config path, and log path |
| `xacpx stop` | Stop the background instance |
| `xacpx restart` | Restart the background instance so channel/config changes take effect |
| `xacpx version` | Show the current version |

The first time you run `xacpx start` or `xacpx run` with no sessions, workspaces, or plugins, the CLI asks whether to register the current directory as a workspace and lets you pick a built-in agent template, then creates the initial acpx session through the normal session-creation flow.

## Updating — `xacpx update`

`xacpx update` checks for and installs new versions of xacpx itself and your installed channel plugins.

```bash
xacpx update            # interactive: pick what to update
xacpx update --all      # update everything (core + all plugins) non-interactively
xacpx update <name>     # update a single target (the core, or a specific plugin package)
```

- When plugins are installed, the bare `xacpx update` is interactive and lets you choose which targets to update.
- In a non-interactive environment, updating the core or plugins needs explicit confirmation: use `--all`, or name the target with `xacpx update <name>`.
- To manage a single plugin's version directly, use `xacpx plugin update <name>` (see [Channels](#channels-xacpx-channel) / [Plugins](#plugins-xacpx-plugin) below).
- After updating, run `xacpx restart` so a running daemon loads the new version.
- **Cross-package rename migration:** the project was renamed from `weacpx` to `xacpx`. Only legacy `weacpx` installs run `weacpx update`, which offers to migrate you across to `xacpx` automatically (you confirm the switch). If you are already on `xacpx`, just run `xacpx update` as a normal self-update.

## Channels — `xacpx channel`

`xacpx channel` (alias `ch`) manages the message channels configured in `~/.xacpx/config.json`. WeChat is built in; Feishu, Yuanbao, and third-party channels are added as plugins first (see [Plugins](#plugins-xacpx-plugin)).

| Command | Description |
|---|---|
| `xacpx channel list` | List configured channels |
| `xacpx channel show <name>` | Show one channel's resolved configuration |
| `xacpx channel add <name>` | Add a channel; prompts for the required credentials |
| `xacpx channel rm <name>` | Remove a channel |
| `xacpx channel enable <name>` | Enable a configured channel |
| `xacpx channel disable <name>` | Disable a channel without removing its config |
| `... [--account <id>]` | Target a single bot when several accounts share one channel (multi-bot) |

When several bots share a channel, `--account <id>` selects which account a `show` / `enable` / `disable` / `rm` operation applies to. For full credential setup and the multi-bot model, see [Channel Management](/guide/channel-management).

## Plugins — `xacpx plugin`

`xacpx plugin` manages the npm plugin packages that provide non-WeChat channels (and other extensions).

| Command | Description |
|---|---|
| `xacpx plugin known` | List the official plugin packages (e.g. Feishu/Yuanbao package names) |
| `xacpx plugin list` | List installed plugins and their versions |
| `xacpx plugin add <package>` | Install a plugin package |
| `xacpx plugin update <name>` | Update a single installed plugin |
| `xacpx plugin remove <name>` | Remove an installed plugin |
| `xacpx plugin enable <name>` | Enable an installed plugin |
| `xacpx plugin disable <name>` | Disable a plugin without removing it |
| `xacpx plugin doctor` | Diagnose plugin installation/load issues |

```bash
xacpx plugin known
xacpx plugin add @ganglion/xacpx-channel-feishu
xacpx channel add feishu     # enter appId/appSecret when prompted
xacpx restart
```

See [Channel Management](/guide/channel-management) for the end-to-end flow and [Channel Plugin Development](/plugins/development) for writing your own.

## Diagnostics — `xacpx doctor`

```bash
xacpx doctor
xacpx doctor --verbose
xacpx doctor --smoke
xacpx doctor --smoke --agent codex --workspace backend
xacpx doctor --fix
```

- `--verbose` expands the details of each check.
- `--smoke` additionally runs a minimal real transport-level prompt check.
- `--agent` / `--workspace` only affect `--smoke`.
- Without `--smoke`, the related checks show as `SKIP`.
- `--fix` applies safe local repairs (runtime dir permissions, stale consumer locks, invalid state records) and re-runs the affected checks. Repairs that mutate state are withheld while the daemon runs ("stop the daemon first").

## Workspaces — `xacpx workspace`

`xacpx workspace` (alias `ws`) maintains the `workspaces` config in `~/.xacpx/config.json`. Register frequently used project directories here, then reference them in chat with `--ws <name>`.

| Command | Description |
|---|---|
| `xacpx workspace list` | List registered workspaces and their paths |
| `xacpx workspace add` | Register the current directory (name defaults to the directory name, normalized) |
| `xacpx workspace add <name>` | Register the current directory under a specific name |
| `xacpx workspace add [name] --raw` | Keep the original name (including spaces); later commands must quote it |
| `xacpx workspace rm <name>` | Remove a workspace |

```bash
cd /absolute/path/to/backend
xacpx workspace add backend
xacpx ws list
xacpx ws rm backend
```

`workspace add` always registers the **current terminal directory**. Names with spaces/Chinese/etc. are normalized to `[a-zA-Z0-9._-]+` (e.g. `My Project` → `My-Project`), with `-2`, `-3` appended on collisions. Use `--raw` to keep the original name; then `rm` / `--ws <name>` need quoting, e.g. `xacpx workspace rm "My Project"`.

## Agents — `xacpx agent`

`xacpx agent` (alias `agents`) maintains the `agents` config in `~/.xacpx/config.json`.

| Command | Description |
|---|---|
| `xacpx agent list` | List registered agents |
| `xacpx agent templates` | List the built-in templates you can add |
| `xacpx agent add <name>` | Add an agent from a built-in template, e.g. `kimi`, `opencode` |
| `xacpx agent rm <name>` | Remove an agent |

## Scheduled tasks — `xacpx later`

`xacpx later` (alias `lt`) lists and cancels this machine's pending scheduled tasks from the terminal. The CLI only **lists and cancels** — scheduled tasks are created from chat with `/later` (see [Scheduled Tasks](/guide/scheduled-tasks)).

| Command | Description |
|---|---|
| `xacpx later list` | List pending scheduled tasks |
| `xacpx later cancel <id>` | Cancel a pending scheduled task |

## MCP server — `xacpx mcp-stdio`

Exposes xacpx's multi-agent orchestration to external MCP hosts (Codex / Claude Code) as a stdio MCP server.

```bash
xacpx mcp-stdio
xacpx mcp-stdio --coordinator-session <session> --source-handle <handle> --workspace <name>
```

| Flag | Description |
|---|---|
| `--coordinator-session <s>` | Bind the MCP server to a specific coordinator session |
| `--source-handle <h>` | Source handle for the coordinator binding |
| `--workspace <name>` | Default workspace for delegated workers |

For identity rules, `workingDirectory` semantics, the full tool list, and troubleshooting, see [External MCP Coordinator](/reference/external-mcp).

## Relay hub — `xacpx-relay`

A **separate** binary for [self-hosting the relay hub](/guide/relay-self-hosting) (not part of the `xacpx` CLI). It has four subcommands; until the relay packages are published to npm, invoke them as `node packages/relay/dist/cli.js <command>` from a repo checkout.

```bash
xacpx-relay start [--db <path>] [--web-root <dir>] [--host 0.0.0.0] [--http-port 8787] [--ws-port 8788] [--history-retention-days 30] [--request-timeout-ms 120000] [--trust-proxy]
xacpx-relay add token [--label <note>] [--db <path>]
xacpx-relay ls [--db <path>]
xacpx-relay rm token <value-or-id> [--db <path>]
```

| Command | Description |
|---|---|
| `start` | Run the hub. `--db` defaults to `~/.xacpx-relay/relay.db` (auto-creates the directory). `--web-root` defaults to the bundled `packages/relay-web/dist` — the dashboard is served even if omitted. No `stop`/`status` — use `SIGTERM`. |
| `add token` | Create a user and mint a login token; printed **once**. The same token is used for both the web dashboard login (paste into the "Access token" field) and the connector (`--token`). |
| `ls` | List tokens: short id, label, created date, and number of connected instances. |
| `rm token <value-or-id>` | Remove the user behind that token (cascades all data). |

**Example — mint a token:**

```
$ xacpx-relay add token --label "my-instance"
access token: bBS9nN2W2MwdrdksoLTLrQeMLMah9M5flTOyEcBbIHc
(store it now — not shown again)
hint: use this token for web login AND: xacpx channel add relay --url ws://<host>:<ws-port> --token <token>
```

**Connector command** — attach an instance to the hub:

```bash
xacpx channel add relay --url <host> --token <token> [--name <label>]
```

`--url` is a smart shorthand for the instance gateway (port 8788 by default) or a TLS proxy:

| Input | Resolved URL |
|---|---|
| `relay.example.com` | `wss://relay.example.com` |
| `1.2.3.4` | `ws://1.2.3.4:8788` |
| `1.2.3.4:9000` | `ws://1.2.3.4:9000` |
| `localhost` | `ws://localhost:8788` |
| `host:9000` | `ws://host:9000` |
| `ws://…` / `wss://…` | as-is |
| `http://…` / `https://…` | mapped to `ws://…` / `wss://…` |

Full deployment walkthrough: [Self-Hosting the Relay Hub](/guide/relay-self-hosting).
