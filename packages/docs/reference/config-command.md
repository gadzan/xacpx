# `/config` Command

## Overview

`/config` is a **restricted configuration write interface** available from the chat window. Its goal is not to turn the chat window into an arbitrary JSON editor, but to:

- Allow a well-defined set of configuration fields to be modified safely.
- Reject unsupported or non-existent fields.
- Keep `config.json` structurally stable and verifiable.

For the complete list of all configuration fields (including those not exposed via `/config`), see [Configuration Reference](/reference/configuration).

## Show configuration

```text
/config
```

Returns the whitelist of configuration paths that can be modified via chat. No arguments required.

## Get a value

There is no explicit `/config get` command. Use `/config` to see the current whitelist, and consult the [Configuration Reference](/reference/configuration) for field descriptions and defaults. The `/status` command shows the current session state.

## Set a value

```text
/config set <path> <value>
```

Examples:

```text
/config set channel.replyMode final
/config set logging.level debug
/config set transport.permissionMode approve-reads
/config set workspaces.backend.description backend repo
/config set transport.sessionInitTimeoutMs 30000
```

### Currently supported paths

**Fixed fields:**

- `transport.type`
- `transport.command`
- `transport.sessionInitTimeoutMs`
- `transport.permissionMode`
- `transport.nonInteractivePermissions`
- `transport.permissionPolicy`
- `logging.level`
- `logging.maxSizeBytes`
- `logging.maxFiles`
- `logging.retentionDays`
- `channel.replyMode`
- `language`

**Dynamic fields** (the named target must already exist):

- `agents.<name>.driver`
- `agents.<name>.command`
- `workspaces.<name>.cwd`
- `workspaces.<name>.description`

> **Performance logging** (`logging.perf.*`) is not on the `/config set` whitelist. To enable it, edit `~/.xacpx/config.json` directly and restart the daemon — the perf tracer is bound at startup.

> **Transport topology** (`transport.type`, `transport.command`) is written to disk but does not hot-apply: the live transport keeps its current values until the daemon restarts (`config.topology_pending_restart` is logged). Every other path above hot-applies. Restart with `xacpx restart`.

> **Feishu credentials and multi-channel config** are best managed from the terminal: `xacpx channel add feishu`.

## Delete a value

`/config` does not expose a delete operation. To remove a field, edit `~/.xacpx/config.json` directly. For removing agents or workspaces, use the dedicated commands:

```text
/agent rm <name>
/workspace rm <name>
```

## Safety rules

### 1. Whitelist-only paths

Any path not in the list above is rejected:

```text
/config set transport.missing x
→ "This configuration path is not supported"
```

### 2. Dynamic items must already exist

The following paths require the named target to exist first:

- `agents.<name>.*` — the agent named `<name>` must be registered.
- `workspaces.<name>.*` — the workspace named `<name>` must exist.

Attempting to set a field on a non-existent agent or workspace returns an error; xacpx does not auto-create them. Use `/agent add` or `/ws new` first.

### 3. Type validation

Each path validates its value against the expected type:

| Path | Accepted values |
|------|----------------|
| `channel.replyMode` | `stream`, `final`, `verbose` |
| `transport.permissionMode` | `approve-all`, `approve-reads`, `deny-all` |
| `transport.nonInteractivePermissions` | `deny`, `fail` |
| `logging.maxFiles` | Positive integer |
| `logging.maxSizeBytes` | Positive integer |
| `logging.retentionDays` | Positive integer |
| `transport.sessionInitTimeoutMs` | Positive integer |

### 4. Changes are persisted immediately

A successful `/config set` call:

1. Updates the in-memory configuration.
2. Writes the change to `~/.xacpx/config.json`.

This is a real, persistent configuration change — not a temporary session override.

## Examples

```text
/config set channel.replyMode final          # change the global default reply mode
/config set logging.level debug              # enable debug logging
/config set transport.permissionMode approve-reads
/config set transport.sessionInitTimeoutMs 60000
/config set agents.codex.driver codex
/config set workspaces.backend.description backend mono-repo
```

**Relationship with other commands:**

| What you want | Use |
|--------------|-----|
| Change the global reply mode default | `/config set channel.replyMode <value>` |
| Override reply mode for the current session only | `/replymode <value>` |
| Clear the current-session override | `/replymode reset` |
| Add a new agent | `/agent add <name>` |
| Delete an agent | `/agent rm <name>` |
| Add a new workspace | `/ws new <name> -d <path>` |
| Delete a workspace | `/workspace rm <name>` |
| Edit fields not in the whitelist | Edit `~/.xacpx/config.json` directly |

`/config` is intentionally **not** a general JSON editor. Only high-frequency, safely validatable fields are exposed. Everything else requires direct file editing and a daemon restart.
