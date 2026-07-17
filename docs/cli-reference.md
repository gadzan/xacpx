# CLI Reference

These commands run in a terminal on the machine where xacpx is installed. For chat
commands (sent inside WeChat / Feishu / Yuanbao), see [commands.md](./commands.md).

## All commands

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

## `workspace` CLI

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

## `agent` CLI

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

The current built-in templates align with acpx's built-in agents:

```text
codex, claude, pi, openclaw, gemini, cursor, copilot, droid,
factory-droid, factorydroid, grok-build, iflow, kilocode, kimi,
kiro, mux, opencode, qoder, qwen, trae
```

These templates only write `driver`; the actual launch command is resolved by acpx. For example, `/agent add kimi` saves `{ "driver": "kimi" }`. For config fields see [config-reference.md](./config-reference.md).

## `doctor`

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
- `--fix` applies safe local repairs (runtime dir permissions, stale locks, invalid state records) and re-checks; state-mutating repairs are withheld while the daemon runs — see [doctor-command.md](./doctor-command.md)

## `update`

`xacpx update` checks for and installs new versions of xacpx itself and your installed channel plugins.

```bash
xacpx update            # interactive: pick what to update
xacpx update --all      # update everything (core + all plugins) non-interactively
xacpx update <name>     # update a single target (the core, or a specific plugin package)
```

Notes:

- When plugins are installed, the bare `xacpx update` is interactive and lets you choose which targets to update.
- In a non-interactive environment, updating the core or plugins needs explicit confirmation: use `xacpx update --all`, or name the target with `xacpx update <name>`.
- `update` covers the core package and channel plugins; to manage a single plugin's version directly, see `xacpx plugin update <name>` ([plugin-development.md](./plugin-development.md)).
- After updating, run `xacpx restart` so a running daemon loads the new version.
- Cross-package rename migration: this project was renamed `weacpx` → `xacpx`. If you still have the legacy `weacpx` package installed, running `weacpx update` will offer to migrate you across to `xacpx` automatically (you confirm the switch). Already on `xacpx`? Just use `xacpx update` as a normal self-update.
