# Getting Started

This guide walks you through installing xacpx, connecting a chat channel, and running your first agent session.

## Requirements

- **Node.js 22.12+** (or Bun as an alternative runtime for local development)
- **An agent CLI** — Codex, Claude Code, Gemini, OpenCode, or any other agent supported by `acpx`. You do not need to install `acpx` globally; xacpx ships with a bundled copy.
- **A supported chat client** — WeChat, Feishu, or Yuanbao installed on your phone (or configured as a bot application)

## Install xacpx

Install the `@ganglion/xacpx` package globally:

```bash
npm install -g @ganglion/xacpx --registry=https://registry.npmjs.org
# or with Bun
bun add -g @ganglion/xacpx
```

After installation, the `xacpx` binary is available in your shell. Verify with:

```bash
xacpx version
```

## Run the console

xacpx runs as a background daemon. Start it with:

```bash
xacpx start
```

To run in the foreground (useful when debugging):

```bash
xacpx run
```

Check daemon status at any time:

```bash
xacpx status
```

Stop the daemon:

```bash
xacpx stop
```

Restart the daemon after changing channel configuration:

```bash
xacpx restart
```

## Log in to WeChat

WeChat is the built-in default channel. Authenticate with:

```bash
xacpx login
```

A QR code appears in the terminal. Scan it with the WeChat mobile app. Once authenticated, your credentials are stored locally and reused on subsequent starts.

If you prefer Feishu or Yuanbao instead of WeChat, skip to [Configure channels and workspaces](#configure-channels-and-workspaces) first.

## Create your first session

After `xacpx start`, send the following messages in your WeChat conversation:

```text
/ss codex -d /absolute/path/to/your/project
/help
```

The `/ss` command creates a new logical session (an xacpx-managed alias, agent binding, workspace binding, and chat context) and a corresponding transport session (the actual `acpx` named session on the backend) in one step. The session is immediately set as the active session in the current chat.

Once the session is active, any message that does not start with `/` is forwarded as a prompt to the agent:

```text
Summarize the recent changes in this repo
```

The agent's reply streams back to the chat.

**Common `/ss` flag syntax:**

```text
/ss <agent> -d <absolute-path>
/ss <agent> --ws <workspace-name>
/ss new <agent> -d <absolute-path>   # force-create even if a session already exists
```

Use `--ws <name>` to reference a workspace you registered earlier with `xacpx workspace add`. Use `-d` to specify an absolute path directly without pre-registration.

**Switch between sessions:**

```text
/ss                  # list active sessions
/use <alias>         # switch the active session by alias
```

**Cancel the current task:**

```text
/cancel
/stop
```

## Attach to an existing acpx session

If you already have an `acpx` session running independently (for example, one you created manually on the backend), you can hook xacpx onto it without disrupting the existing session state.

The `/session attach` command creates only the logical session — the xacpx alias, agent, and workspace binding — and links it to the named transport session. It does not create a new `acpx` session.

```text
/ss attach <alias> -a <agent> --ws <workspace> --name <acpx-session-name>
```

Here `-a <agent>` (short for `--agent`) selects the agent to bind, and `--name <acpx-session-name>` is the name of the existing `acpx` transport session.

For example, if you created a session manually:

```bash
./node_modules/.bin/acpx --verbose --cwd /absolute/path/to/project codex sessions new --name my-session
```

You can attach it in the chat:

```text
/ss attach demo -a codex --ws backend --name my-session
```

After attaching, the session behaves identically to one created with `/ss new`. See [Command Reference](/reference/commands) for the full syntax.

## Configure channels and workspaces

### Add a channel

WeChat is built in. To add Feishu or Yuanbao, install the corresponding plugin package and configure it:

```bash
# Feishu
xacpx plugin add @ganglion/xacpx-channel-feishu
xacpx channel add feishu     # follow the prompts for appId / appSecret
xacpx restart

# Yuanbao
xacpx plugin add @ganglion/xacpx-channel-yuanbao
xacpx channel add yuanbao    # follow the prompts for appKey / appSecret
xacpx restart
```

List officially supported plugin packages:

```bash
xacpx plugin known
```

For full channel configuration options — including `enable`, `disable`, and `rm` — see [Configuration](/reference/configuration).

### Register workspaces

A workspace maps a short name to an absolute path on your machine. Register one from your terminal:

```bash
cd /path/to/your/project
xacpx workspace add backend   # registers current directory as "backend"
# short alias:
xacpx ws add frontend
xacpx ws list
xacpx ws rm frontend
```

After registering, reference the workspace by name in chat commands:

```text
/ss codex --ws backend
```

Names with spaces or special characters are automatically normalized to use only letters, digits, dots, underscores, and hyphens. Pass `--raw` to preserve the original name, but note that you will need to quote it everywhere.

### Register agents

Default configuration includes `codex` and `claude`. Add other agents from the built-in template list:

```bash
xacpx agent templates         # list available templates
xacpx agent add kimi          # add the kimi template
xacpx agent list
xacpx agent rm kimi
```

## Local dry run

This section is for contributors working from the repository source; published-binary users can skip it.

You can test the console without a WeChat account or any chat credentials using the built-in dry-run mode:

```bash
bun run dry-run --chat-key wx:test -- "/status"
```

Pass multiple slash commands as additional arguments to simulate a conversation sequence:

```bash
bun run dry-run --chat-key wx:test -- "/session new demo --agent codex --ws backend" "/status"
```

This is useful for verifying command routing and session state logic during development.

## Troubleshooting pointers

**Daemon is not running.** Run `xacpx status` to confirm. If the daemon exited unexpectedly, check the log at `~/.xacpx/runtime/app.log`.

**Session creation fails (`/ss new` errors).** The most common cause is the underlying `acpx` session not starting cleanly. Verify that the agent binary works from the terminal first. If needed, create the `acpx` session manually and then use `/session attach` to bind xacpx to it.

**WeChat QR code is not appearing.** Run `xacpx login` directly to re-authenticate. After scanning, restart the daemon with `xacpx restart`.

**Plugin channel not activating.** After `xacpx channel add`, always run `xacpx restart` to reload the channel configuration. Use `xacpx channel list` to confirm the channel is enabled.

**`acpx` not found or wrong version.** xacpx resolves `acpx` in this order: the `transport.command` config key (explicit override), the bundled copy in `node_modules`, then `acpx` in your shell `PATH`. If you have a stale `transport.command` entry pointing to a missing binary, remove it from `~/.xacpx/config.json` to fall back to the bundled copy.

**Run the environment doctor.** For a comprehensive pre-flight check:

```bash
xacpx doctor
xacpx doctor --verbose
```

For the full command reference, see [Command Reference](/reference/commands). For all configuration fields, see [Configuration](/reference/configuration).

---

## Local development (from source)

If you are working from the repository source rather than the published package, use these commands instead of the installed `xacpx` binary:

```bash
bun run dev            # run the console in the foreground (dev mode)
bun run login          # show the WeChat login QR code
node ./dist/cli.js start    # start the daemon in the background
node ./dist/cli.js status   # check daemon status
node ./dist/cli.js stop     # stop the daemon
```

Build the CLI first if you have not already:

```bash
bun run build
```
