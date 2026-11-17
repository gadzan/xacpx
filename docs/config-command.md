# `/config` Command Reference

`/config` is a **restricted configuration write entry point**.

The goal is not to turn the chat window into an arbitrary JSON editor, but to:

- Allow modifying a set of explicitly supported configuration fields
- Reject unsupported fields
- Reject non-existent dynamic items
- Keep the `config.json` structure stable and verifiable

---

## Commands

### View the fields that can be modified

```text
/config
```

Returns the current allowlist of configuration paths that may be modified via chat commands.

### Modify configuration

```text
/config set <path> <value>
```

For example:

```text
/config set channel.replyMode final
/config set channels.feishu.replyMode final
/config set logging.level debug
/config set transport.permissionMode approve-reads
/config set workspaces.backend.description backend repo
/config set language en
```

---

## Currently Supported Paths

Fixed fields:

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
- `channels.<id>.replyMode`（频道级默认；运行时热改，立即对该频道新回合生效）
- `language`


Note: the performance debug log `logging.perf.*` does not support dynamic toggling via `/config set` in chat. You need to manually edit `logging.perf` in `~/.xacpx/config.json` and then restart the daemon; this tracer is bound at startup.

Note: `/config set transport.type` and `/config set transport.command` are written to `~/.xacpx/config.json` but do **not** hot-apply — the live transport keeps its current type/command until the daemon restarts (`config.topology_pending_restart` is logged). Every other path above hot-applies. Restart with `xacpx restart`.

Backward-compatible fields:

- `channel.type` (old single-channel configuration; for multi-channel, use `xacpx channel ...`)
- `channels[]` (multi-channel runtime configuration; recommended to manage with `xacpx channel ...`)

Feishu credentials and multi-channel configuration should preferably be managed with the channel CLI in your computer's terminal, e.g. `xacpx channel add feishu`. See full instructions in [`docs/channel-management.md`](./channel-management.md).

Dynamic fields:

- `agents.<name>.driver`
- `agents.<name>.command`
- `workspaces.<name>.cwd`
- `workspaces.<name>.description`

---

## Rules

### 1. Only allowlisted paths are allowed

For paths not in the list above, `/config set` rejects them directly.

For example:

```text
/config set transport.missing x
```

returns "modifying this configuration path is not supported".

### 2. Dynamic items are not created automatically

The following paths require the target to already exist:

- `agents.<name>.*`
- `workspaces.<name>.*`

That is:

- `agents.claude.driver` can only be modified when the `claude` agent already exists
- `workspaces.backend.cwd` can only be modified when the `backend` workspace already exists

If it does not exist, it errors out directly and does not create it automatically.

### 3. Validation by field type

Different paths are validated according to their respective types.

For example:

- `channel.replyMode` only supports `stream` / `final` / `verbose`
- `wechat.replyMode` (backward-compatible configuration) likewise only supports `stream` / `final` / `verbose`
- `transport.permissionMode` only supports `approve-all` / `approve-reads` / `deny-all`
- `logging.maxFiles`, `logging.maxSizeBytes`, `logging.retentionDays`, `transport.sessionInitTimeoutMs` must be positive numbers

### 4. Changes are immediately written back to `config.json`

After `/config set` succeeds, it:

1. Updates the current in-memory configuration
2. Persists to `~/.xacpx/config.json`

So this is a **real configuration change**, not a temporary session state.

---

## Relationship with Other Commands

`/config` is not meant to replace existing high-level commands.

- For creating and deleting an `agent`, still prefer:
  - `/agent add`
  - `/agent rm`
- For creating and deleting a `workspace`, prefer the high-level commands:
  - `/ws new`
  - `/workspace rm`
  - Or run `xacpx workspace add [name]` / `xacpx workspace rm <name>` in the computer's current directory
- `/replymode` changes the **current logical session override**
- `channel.replyMode` changes the **global default value**

That is:

- `/config set channel.replyMode final`: changes the global default
- `/replymode final`: changes only the current logical session
- `/config set wechat.replyMode final`: a backward-compatible path, equivalent to changing `channel.replyMode`

---

## Design Boundaries

This command intentionally **does not support arbitrary-depth JSON modification**.

The reason is simple:

1. `config.json` has both fixed fields and dynamic maps such as `agents/workspaces`
2. If arbitrary path writes were fully opened up, it would be easy to corrupt the configuration
3. xacpx's goal is "remotely controllable", not "remotely hand-write the configuration file"

So the principle of `/config` is:

- Only open up high-frequency fields that can be safely validated
- Keep the rest of the fields explicitly implemented
