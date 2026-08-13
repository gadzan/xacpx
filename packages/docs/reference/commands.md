# Command Reference

This page lists every command you can send to xacpx from a chat channel (WeChat, Feishu, Yuanbao, or a plugin channel). For day-to-day essentials only, see the README; come here when you need the full command surface, aliases, and argument formats.

> Looking for the terminal `xacpx` commands (`start`, `update`, `plugin`, `channel`, `doctor`, …)? See [CLI Commands](/reference/cli).

## Command syntax

- `<value>` denotes a required argument.
- `a | b` denotes a choice between two values.
- Wrap values that contain spaces in quotes: `/ws new backend -d "/Users/me/my repo"`.
- Any message that does **not** start with `/` is forwarded to the current session as a plain prompt.
- **Aliases:** `/ss` = `/session`, `/ws` = `/workspace`, `/pm` = `/permission`, `/stop` = `/cancel`, `/lt` = `/later`, `/dg` = `/delegate`.

## Session commands

A session is a logical unit that binds an agent, a workspace, and a chat context.

### List, create, and switch

| Command | Description |
|---------|-------------|
| `/sessions` or `/session` or `/ss` | List all sessions |
| `/ss <agent> -d <path>` | Create or reuse a session using a local path |
| `/ss <agent> --ws <workspace>` | Create or reuse a session using a registered workspace |
| `/ss new <agent> -d <path>` | Force-create a new session using a local path |
| `/ss new <agent> --ws <workspace>` | Force-create a new session using a registered workspace |
| `/session new <alias> --agent <agent> --ws <workspace>` | Create a session with an explicit alias |
| `/session new <alias> -a <agent> --ws <workspace>` | Short form of the above |
| `/use <alias>` | Switch to a session by alias |
| `/use <fragment>` | Switch by partial alias (exact → prefix → substring; lists candidates when ambiguous) |
| `/use -` | Toggle between the current and previous session (like `cd -` in shell) |
| `/session rm <alias>` | Delete a logical session |

A successful switch echoes your new identity, for example:  
`Switched to api-review · codex · backend (previous: frontend-fix)`

**Real-time switching and background execution:** you can `/use` away from a session at any time, even while a task is running. The switched-away session continues executing in the background; its intermediate output is not forwarded to the current chat. Tasks in different sessions run in parallel without blocking each other.

- When a background session finishes, the current chat receives a brief notification: `✅ <alias> done — /use <alias> to see result` (or `⚠️ <alias> failed — /use <alias> for details`).
- In `/sessions`, sessions with an unread result are marked with `●`.
- Switching back replays the **final result** (intermediate output is not replayed) and clears the unread marker. If the task is still running, you see `⏳ <alias> still running…`.

> **Feishu difference (streaming card semantics):** switched-away sessions own their own streaming card, which continues updating in the chat timeline to completion. Switching back does **not** replay the final result — it is already visible in that card. Completion notifications are shorter: `✅ <alias> done` / `⚠️ <alias> failed`. The `●` unread marker in `/sessions` still applies.

```text
/ss codex -d /Users/me/projects/backend
/ss claude --ws backend
/ss new codex -d /Users/me/projects/frontend
/session new api-review --agent codex --ws backend
/use api-review
/use api          # fragment match: uniquely matches api-review
/use -            # toggle back to previous session
/session rm old-review
```

### Attach to an existing transport session

If a transport-level `acpx` session already exists, attach it to a logical session:

| Command | Description |
|---------|-------------|
| `/session attach <alias> --agent <agent> --ws <workspace> --name <transport-session>` | Attach an existing transport session |
| `/ss attach <alias> -a <agent> --ws <workspace> --name <transport-session>` | Short form |

```text
/ss attach demo -a codex --ws backend --name existing-demo
```

### Native agent sessions (`/ssn`)

`/ssn` attaches a locally running native agent session (e.g. Codex) to xacpx. The result is a normal xacpx logical session with an auto-generated alias (e.g. `codex-e8e552e7`) that then appears in `/ss` listings.

Bare `/ssn` uses the current session context; specify context explicitly if none is selected.

| Command | Description |
|---------|-------------|
| `/ssn` | List native sessions for the current context |
| `/ssn codex --ws project` | List Codex native sessions for `project`; attach if only one candidate |
| `/ssn codex -d /Users/me/project` | Same, by path |
| `/ssn codex --ws project --all` | List across all working directories |
| `/ssn 1` | Attach or switch to item 1 from the last listing |
| `/ssn 1 -a fix-ci` | Attach item N with a custom xacpx alias |
| `/ssn attach <sessionId> -a fix-ci` | Attach by full session ID with a custom alias |
| `/ss attach native <sessionId> -a fix-ci` | Long form of the above |

```text
/ssn codex --ws project
/ssn 1
/ssn attach 019e5d48 -a fix-ci
```

### Status, reset, and cancel

| Command | Description |
|---------|-------------|
| `/status` | Show the current session state |
| `/session tail [N]` | Replay the last N lines of history (default 50, max 500) |
| `/session reset` | Reset the current session context |
| `/clear` | Alias for `/session reset` |
| `/cancel [alias]` or `/stop [alias]` | Cancel the running task; without an alias, cancels the current foreground session; with an alias, cancels any session including background ones |

## Agent commands

An agent is a named configuration for an underlying tool such as `codex`, `claude`, or `kimi`.

| Command | Description |
|---------|-------------|
| `/agents` | List registered agents |
| `/agent add <name>` | Add a built-in agent template; does not overwrite an existing agent with a different configuration |
| `/agent rm <name>` | Delete an agent |

Built-in template names: `codex`, `claude`, `pi`, `openclaw`, `gemini`, `cursor`, `copilot`, `droid`, `factory-droid`, `factorydroid`, `grok-build`, `iflow`, `kilocode`, `kimi`, `kiro`, `mux`, `omp`, `opencode`, `qoder`, `qwen`, `reasonix`, `trae`.

```text
/agent add codex
/agent add claude
/agent add kimi
/agents
/agent rm claude
```

## Workspace commands

A workspace maps a short name to an absolute directory path on the machine running xacpx.

| Command | Description |
|---------|-------------|
| `/workspaces` or `/workspace` or `/ws` | List registered workspaces |
| `/workspace new <name> --cwd <path> [--raw]` | Add a workspace |
| `/ws new <name> -d <path> [--raw]` | Short form |
| `/workspace rm <name>` | Delete a workspace |

Names are normalized to `[a-zA-Z0-9._-]+`: spaces, CJK characters, and other symbols are replaced with `-`; duplicates get a `-2`, `-3` suffix. Use `--raw` to keep the name exactly as given:

```text
/ws new "My Project" -d /Users/me/projects/my-project --raw
```

With `--raw`, subsequent commands must quote the name: `/ws rm "My Project"`, `/ss codex --ws "My Project"`.

```text
/ws new backend -d /Users/me/projects/backend
/workspaces
/workspace rm backend
```

## Channel commands

Reply mode controls how much output is delivered to your chat.

| Command | Description |
|---------|-------------|
| `/replymode` | Show the global default, the current session override, and the effective value |
| `/replymode stream` | Stream intermediate text |
| `/replymode verbose` | Stream intermediate text and show tool-call summaries |
| `/replymode final` | Send only the final text |
| `/replymode reset` | Clear the current session override; revert to the global default |

Recommendations:
- `stream` — everyday development.
- `verbose` — when you want to see what the agent is doing.
- `final` — when you want fewer messages.

`acpx` mode is passed through directly to the underlying agent. Available values depend on the agent in use.

| Command | Description |
|---------|-------------|
| `/mode` | Show the mode saved for the current session |
| `/mode <id>` | Set the mode for the current session |

Known values: `codex` supports `plan`; `cursor` supports `agent`, `plan`, `ask`.

## Configuration commands

`/config` provides restricted write access to a whitelist of configuration fields. For the full field reference see [Configuration Reference](/reference/configuration). For a detailed explanation of the `/config` command itself, see [/config Command](/reference/config-command).

| Command | Description |
|---------|-------------|
| `/config` | Show the list of paths that can be modified |
| `/config set <path> <value>` | Set a supported configuration value |

Currently supported paths:

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

**Dynamic fields** (target must already exist):
- `agents.<name>.driver`
- `agents.<name>.command`
- `workspaces.<name>.cwd`
- `workspaces.<name>.description`

> **Note:** Performance debug log settings (`logging.perf.*`) are not on the `/config set` whitelist. Edit `~/.xacpx/config.json` directly and restart the daemon for those to take effect.

```text
/config set channel.replyMode final
/config set logging.level debug
/config set transport.sessionInitTimeoutMs 30000
```

## Permission and mode commands

Permission policy controls whether the underlying agent can automatically execute read and write operations.

| Command | Config value | Description |
|---------|-------------|-------------|
| `/pm` or `/permission` | — | Show the current permission policy |
| `/pm set allow` | `approve-all` | Allow more operations to proceed automatically |
| `/pm set read` | `approve-reads` | Auto-approve reads; writes are more cautious |
| `/pm set deny` | `deny-all` | Deny operations that require approval |
| `/pm auto` | — | Show the non-interactive permission policy |
| `/pm auto deny` | `deny` | Auto-deny in non-interactive scenarios |
| `/pm auto fail` | `fail` | Fail immediately in non-interactive scenarios |

```text
/pm
/pm set read
/pm auto deny
```

## Scheduled task commands

`/later` (alias `/lt`) creates, lists, and cancels one-shot scheduled tasks. For full details on time formats, task states, and delivery guarantees, see [Scheduled Tasks](/guide/scheduled-tasks).

### Create

| Command | Description |
|---------|-------------|
| `/lt <time> <message>` | Schedule a task (runs in a temporary session) |
| `/lt --bind <time> <message>` | Schedule a task bound to the current session |
| `/lt --temp <time> <message>` | Explicitly use a temporary session |
| `/later <time> <message>` | Same as `/lt` |

Supported time formats:

| Format | Examples |
|--------|---------|
| Relative (English) | `/lt in 2h check CI`, `/lt in 30m summarize`, `/lt in 1d review` |
| Relative (Chinese) | `/lt 30分钟后 summarize progress`, `/lt 2小时后 check` |
| Named date | `/lt today 21:30 continue`, `/lt tomorrow 09:00 check PR`, `/lt 明天 09:00 look at PR` |
| Day of week | `/lt friday 09:00 check PR`, `/lt 周五 09:00 continue` |

Chinese time tokens map to English as: `30分钟后` = in 30 minutes, `2小时后` = in 2 hours, `明天` = tomorrow, `周五` = Friday. See [Scheduled Tasks](/guide/scheduled-tasks) for the full bilingual time syntax.

### List and cancel

| Command | Description |
|---------|-------------|
| `/lt list` | Show all pending scheduled tasks |
| `/lt cancel <id>` | Cancel a pending task |

```text
/lt in 2h check CI
/lt tomorrow 09:00 check PR
/lt list
/lt cancel #k8f2
```

### Constraints

- **One-shot only** — tasks do not repeat.
- Scheduled time must be **at least 10 seconds and at most 7 days** in the future.
- Default execution mode is a temporary session; use `--bind` for the current session. The default can be changed via `later.defaultMode` in config.
- `/lt list` shows **all** pending tasks globally, not only those for the current session.
- Cancellation follows the trusted-channel model: in a group chat, only the group owner can cancel.
- xacpx commands (messages starting with `/`) **cannot** be scheduled. Use plain sentences to describe what the agent should do.

## Cancellation commands

| Command | Description |
|---------|-------------|
| `/cancel` or `/stop` | Cancel the running task in the current foreground session |
| `/cancel <alias>` or `/stop <alias>` | Cancel the running task in any session, including background sessions |

## Help commands

| Command | Description |
|---------|-------------|
| `/help` | List available help topics and common entry points |
| `/help <topic>` | Show commands for a topic |

Common topics: `agent`, `workspace`, `session`, `native` (or `ssn`), `replymode`, `mode`, `status`, `cancel`, `config`, `permission`, `orchestration`, `later`.

```text
/help
/help ss
/help ssn
/help pm
/help orchestration
/help later
```

---

## Multi-agent orchestration

Orchestration commands require an active current session, which acts as the coordinator. Sub-tasks are dispatched to other agent sessions.

### Delegate a single sub-task

| Command | Description |
|---------|-------------|
| `/dg <agent> <task>` | Quickly delegate a sub-task |
| `/delegate <agent> <task>` | Delegate a sub-task |
| `/delegate <agent> --role <role> <task>` | Delegate with a role template |
| `/delegate <agent> --group <groupId> <task>` | Delegate into an existing task group |
| `/delegate <agent> --role <role> --group <groupId> <task>` | Role + group together |

```text
/dg claude review the 3 highest-risk points in the current plan
/delegate codex --role planner break this requirement into minimal implementation steps
/delegate claude --group review-batch review the API design
```

### Manage task groups

Groups let you fan out multiple independent sub-tasks in parallel and track them collectively.

| Command | Description |
|---------|-------------|
| `/group new <title>` | Create a task group |
| `/groups` | List task groups |
| `/groups --status <pending\|running\|terminal>` | Filter by status |
| `/groups --stuck` | Show only groups suspected of being stuck |
| `/groups --sort <updatedAt\|createdAt>` | Sort field |
| `/groups --order <asc\|desc>` | Sort direction |
| `/group <id>` | Show a single task group's details |
| `/group add <groupId> <agent> <task>` | Add a sub-task to a group |
| `/group add <groupId> <agent> --role <role> <task>` | Add with a role template |
| `/group cancel <groupId>` | Cancel all unfinished tasks in the group |

There is no `/group delete`. To stop unfinished tasks use `/group cancel <groupId>`; to clean up finished tasks use `/tasks clean`.

```text
/group new review-batch
/group add review-batch claude review API design
/group add review-batch codex --role reviewer review test coverage
/groups --status running --sort updatedAt --order desc
/group review-batch
/group cancel review-batch
```

### Manage orchestration tasks

| Command | Description |
|---------|-------------|
| `/tasks` | List tasks under the current coordinator session |
| `/tasks --status <state>` | Filter by state |
| `/tasks --stuck` | Show only tasks with a stale heartbeat |
| `/tasks --sort <updatedAt\|createdAt>` | Sort field |
| `/tasks --order <asc\|desc>` | Sort direction |
| `/tasks clean` | Remove finished tasks and stale bindings |
| `/task <id>` | Show a single task's details |
| `/task approve <id>` | Approve a `needs_confirmation` task |
| `/task reject <id>` | Reject a `needs_confirmation` task |
| `/task cancel <id>` | Cancel a task |

States supported by `/tasks --status`: `pending`, `needs_confirmation`, `running`, `completed`, `failed`, `cancelled`.

```text
/tasks
/tasks --status running --sort updatedAt --order desc
/tasks --stuck
/task task_123
/task approve task_123
/task cancel task_456
/tasks clean
```
