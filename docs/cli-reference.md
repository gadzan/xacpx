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
| `xacpx adapter list\|check [codex\|claude]` | Inspect effective managed ACP adapter versions and optionally compare them with npm |
| `xacpx adapter update <codex\|claude>` / `xacpx adapter update --all` | Verify and save the latest published adapter version locally |
| `xacpx adapter set <codex\|claude> <version>` / `reset <codex\|claude>` | Verify an exact version override, or return to this xacpx release's tested default |
| `xacpx adapter registry [set <url>\|reset]` | Show, change, or reset the npm registry used only for managed adapters |
| `xacpx adapter preinstall <codex\|claude> [version]` | Opt in to an immutable local adapter release and atomically make it active |
| `xacpx adapter list --installed` | List immutable local adapter releases and identify the active one |
| `xacpx adapter uninstall <codex\|claude> <release-id>` | Remove one inactive, unreferenced release; refuses on uncertain state or orphan references |
| `xacpx orphans kill --confirm` | Manually attempt fail-closed cleanup of durable Windows orphan records after operator review |
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
| `xacpx agent add <name>` | Add an agent from a built-in template, e.g. `kimi`, `opencode`, `pool` |
| `xacpx agent rm <name>` | Remove a specific agent |

Common usage:

```bash
xacpx agent templates
xacpx agent add kimi
xacpx agents list
xacpx agent rm kimi
```

The current built-in templates align with acpx's built-in agents (plus `hermes`, launched via an xacpx-bundled ACP shim):

```text
codex, claude, pi, openclaw, gemini, cursor, copilot, droid,
factory-droid, factorydroid, grok-build, hermes, iflow, kilocode,
kimi, kiro, mux, opencode, pool, qoder, qwen, trae, zeroclaw
```

Most templates only write `driver`. xacpx supplies exact npx pins for the managed `codex` and `claude` adapters; other launch commands follow the normal runtime/acpx resolution path. For example, `/agent add kimi` saves `{ "driver": "kimi" }`. `hermes` is not in acpx's registry, so xacpx injects a bundled ACP shim command at spawn time (nothing extra is written to config; see [config-reference.md](./config-reference.md) for details). For config fields see [config-reference.md](./config-reference.md).

## `adapter` CLI

Codex and Claude adapters are downloaded through npm's exec cache at runtime, so they do not increase xacpx's installed dependency size. xacpx nevertheless owns an exact tested default for each package instead of accepting acpx's moving range.

```bash
xacpx adapter list                 # local-only; no registry request
xacpx adapter check               # compare both effective pins with npm latest
xacpx adapter check codex
xacpx adapter update codex        # opt in to latest after an ACP initialize probe
xacpx adapter update --all        # all probes must pass before one config write
xacpx adapter set codex 1.1.2     # exact semver only; verifies before saving
xacpx adapter reset codex         # remove local override; use release default
xacpx adapter registry            # show effective registry and its source
xacpx adapter registry set https://npm.company.example/repository/npm-group/
xacpx adapter registry reset      # return to the public npm registry
```

`set` and `update` use a package/bin allowlist and structured process arguments. A candidate must exist in npm and answer a real ACP protocol-version-1 `initialize` request before `transport.adapterVersions` is written. If any `update --all` probe fails, none of its candidates are saved. Changes are never applied automatically at daemon startup; after a successful mutation, run `xacpx restart`.

The adapter registry defaults to `https://registry.npmjs.org/`, independently of both the machine's generic npm registry and an existing `@agentclientprotocol:registry` scope mapping. It is used consistently for latest-version queries, exact-version checks, verification downloads, and runtime `npx` launches. Set a company registry only if it proxies or hosts `@agentclientprotocol/codex-acp` and `@agentclientprotocol/claude-agent-acp`. Registry authentication stays in npm's scoped `.npmrc`; credentials in the URL are rejected.

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
