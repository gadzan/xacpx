# WeChat Command Reference

This document lists the commands you can send to `xacpx` from WeChat. The README only keeps the common entry points; if you want the complete list of commands, aliases, and argument formats, read this.

## Reading Conventions

- `<value>` denotes a required argument, e.g. `<agent>`.
- `a | b` means choose one of the two.
- Commands support wrapping values that contain spaces in quotes, e.g. `/ws new backend -d "/Users/me/my repo"`.
- Text that does not start with `/` is not a command and is sent directly to the current session.
- `/ss` is an alias for `/session`, `/ws` is an alias for `/workspace`, `/pm` is an alias for `/permission`, `/stop` is an alias for `/cancel`, and `/lt` is an alias for `/later`.

## Quick Index

| What you want to do | Command entry point |
|------------|----------|
| View help | `/help`, `/help <topic>` |
| Manage agents | `/agents`, `/agent ...` |
| Manage workspaces | `/workspaces`, `/workspace ...`, `/ws ...` |
| Manage sessions | `/sessions`, `/session ...`, `/ss ...`, `/use ...` |
| Attach a local Agent native session | `/ssn ...`, `/ss attach native ...` |
| Adjust the reply mode | `/replymode ...` |
| Adjust the acpx mode | `/mode ...` |
| View or switch the model | `/model ...` |
| Cancel the current task | `/cancel`, `/stop` |
| Modify configuration | `/config ...` |
| Modify the permission policy | `/permission ...`, `/pm ...` |
| Delegate a subtask | `/delegate ...`, `/dg ...` |
| Manage task groups | `/groups`, `/group ...` |
| Manage orchestration tasks | `/tasks`, `/task ...` |
| Scheduled tasks | `/later ...`, `/lt ...` |

## Help

| Command | Description |
|------|------|
| `/help` | View the list of help topics and common entry points |
| `/help <topic>` | View command descriptions for a specific topic |

Common topics include: `agent`, `workspace`, `session`, `native` (or `ssn`), `replymode`, `mode`, `status`, `cancel`, `config`, `permission`, `orchestration`.

Examples:

```text
/help
/help ss
/help ssn
/help pm
/help orchestration
```

## Agent Management

An agent is the configuration of the underlying tool you want to drive, e.g. `codex`, `claude`, `kimi`.

| Command | Description |
|------|------|
| `/agents` | View registered agents |
| `/agent add <codex|claude|pi|openclaw|gemini|cursor|copilot|droid|factory-droid|factorydroid|iflow|kilocode|kimi|kiro|opencode|qoder|qwen|trae>` | Add a built-in agent template; an existing agent with the same name but a different configuration will not be overwritten |
| `/agent add <template> --model <id>` | Add (or update) the agent and set its default model (e.g. `gpt-5.2[high]`), used by every session of that agent unless overridden |
| `/agent rm <name>` | Delete an agent |

Examples:

```text
/agent add codex
/agent add claude
/agent add kimi
/agent add codex --model gpt-5.2[high]
/agents
/agent rm claude
```

## Workspace Management

A workspace is a project directory on your computer. Absolute paths are recommended.

| Command | Description |
|------|------|
| `/workspaces` | View registered workspaces |
| `/workspace` / `/ws` | Common alias for `/workspaces` |
| `/workspace new <name> --cwd <path> [--raw]` | Add a workspace; names containing special characters such as spaces or Chinese will be normalized automatically |
| `/ws new <name> -d <path> [--raw]` | Short form for adding a workspace |
| `/workspace rm <name>` | Delete a workspace |

Examples:

```text
/ws new backend -d /Users/me/projects/backend
/workspaces
/workspace rm backend
```

> Names are normalized to `[a-zA-Z0-9._-]+`: spaces, Chinese characters, and other symbols are replaced with `-`, and on name collisions `-2`, `-3` are appended automatically. To keep the original name with special characters, add `--raw`, e.g.:
>
> ```text
> /ws new "My Project" -d /Users/me/projects/my-project --raw
> ```
>
> After using `--raw`, subsequent commands need quotes: `/ws rm "My Project"`, `/ss codex --ws "My Project"`.

## Session

A session is the logical session you operate from WeChat. Each session is bound to one agent and one workspace.

### View, Create, Switch

| Command | Description |
|------|------|
| `/sessions` | View the session list |
| `/session` / `/ss` | View the session list |
| `/ss <agent> -d <path>` | Create or reuse a session using a local path |
| `/ss <agent> --ws <workspace>` | Create or reuse a session using an existing workspace |
| `/ss new <agent> -d <path>` | Force-create a new session |
| `/ss new <agent> --ws <workspace>` | Force-create a new session using an existing workspace |
| `/session new <alias> --agent <agent> --ws <workspace>` | Create a session with a specified alias |
| `/session new <alias> -a <agent> --ws <workspace>` | Short form for creating a session with a specified alias |
| `/session new <alias> -a <agent> --ws <workspace> --model <id>` | Also pin the session's LLM model (e.g. `gpt-5.2[high]`); `-m` is the short form. Overrides the agent default |
| `/use <alias>` | Switch the current session |
| `/use <fragment>` | Switch by alias fragment: exact > prefix > substring; multiple matches list candidates for you to choose again |
| `/use -` | Switch between the current session and the previous session (like shell's `cd -`) |
| `/session rm <alias>` | Delete a logical session |

A successful switch echoes back the current identity, e.g. `Switched to api-review · codex · backend (previous: frontend-fix)`, so you no longer need to remember aliases or indices.

**Real-time switching and background execution**: you can `/use` away immediately even while a task is running. The session you switch away from keeps running in the background, but its intermediate output is no longer sent to the current chat; tasks in different sessions run in parallel and do not block each other (the session you switch to can be used normally right away).

- When a background session task finishes, the current chat receives a short reminder: `✅ <alias> finished, /use <alias> to view results` (on failure: `⚠️ <alias> failed, /use <alias> for details`).
- In the `/sessions` list, sessions with unread results are marked with `●`.
- When you switch back to that session, its **final result** is replayed (the intermediate process is not replayed), and the unread mark is cleared; if it is still running, it shows `⏳ <alias> is still running…`.

> **Feishu difference (semantics B)**: the session you switch away from has its own independent streaming card, which **keeps streaming and refreshing until completion** in the chat timeline (unlike WeChat, which gates intermediate output to the current session). Therefore, when you switch back, the final result is **not replayed**—the result has long been parked on that card. The completion reminder is also shorter: `✅ <alias> finished` / `⚠️ <alias> failed` (without `/use to view results`). The `●` unread mark in the `/sessions` list still applies.

Examples:

```text
/ss codex -d /Users/me/projects/backend
/ss claude --ws backend
/ss new codex -d /Users/me/projects/frontend
/session new api-review --agent codex --ws backend
/use api-review
/use api          # fragment match: a unique hit on api-review switches; multiple hits list candidates
/use -            # switch back to the previous session
/session rm old-review
```

### Bind an Existing Underlying Session

If the underlying `acpx` session already exists, you can mount it back onto a logical session in WeChat.

| Command | Description |
|------|------|
| `/session attach <alias> --agent <agent> --ws <workspace> --name <transport-session>` | Bind an existing underlying session |
| `/ss attach <alias> -a <agent> --ws <workspace> --name <transport-session>` | Short form |

Examples:

```text
/ss attach demo -a codex --ws backend --name existing-demo
```

### Attach a Local native Session (Codex and other Agents' native sessions)

`/ss` manages xacpx logical sessions; `/ssn` manages local native sessions. A plain `/ss codex --ws project` will not automatically enumerate or attach a new native session; after attaching via `/ssn`, a regular xacpx logical session alias is generated (e.g. `codex-e8e552e7`), which you can later see in the `/ss` list and switch back to with `/session use <alias>`.

A bare `/ssn` uses the current session context directly; if there is no currently selected session, use `/ssn codex --ws project` or `/ssn codex -d /Users/me/project` to specify the context first. For a more complete workflow, `--all`, aliases, and troubleshooting, see [native-sessions.md](./native-sessions.md). For a concise in-chat help, use `/help ssn`.

| Command | Description |
|------|------|
| `/ssn` | View local native sessions for the current context |
| `/ssn codex --ws project` | Query local Codex sessions in the project workspace; attach directly when there is only one candidate |
| `/ssn codex -d /Users/me/project` | Query local Codex sessions by path; attach directly when there is only one candidate |
| `/ssn codex --ws project --all` | Query this agent's native sessions across cwds |
| `/ssn 1` | Attach to or switch to the 1st native session in the most recent list |
| `/ssn 1 -a fix-ci` | Pick the Nth candidate from the list and specify an xacpx alias (use when the full id is not visible in WeChat) |
| `/ssn attach <sessionId> -a fix-ci` | Attach a native session with a specified xacpx alias (suitable when the full id is known) |
| `/ss attach native <sessionId> -a fix-ci` | Long form of the previous line |

Examples:

```text
/ssn codex --ws project
/ssn 1
/ssn codex -d /Users/me/project
/ssn attach 019e5d48 -a fix-ci
```

### Status, Reset, Cancel

| Command | Description |
|------|------|
| `/status` | View the current session status |
| `/session tail [N]` | Pull the most recent N lines of the current session's history (default 50, max 500) |
| `/session reset` | Reset the current session context |
| `/clear` | Alias for `/session reset` |
| `/cancel [alias]` / `/stop [alias]` | Without an argument, cancels the running task of the current foreground session; with an alias, cancels the task of the specified (including background) session. |

## Plain Messages

As long as a message does not start with `/`, `xacpx` will send it to the current session.

```text
Please read the current repository and find the root cause of the recent test failures
```

If there is no current session yet, run `/ss ...` or `/use ...` first.

## Reply Mode

The reply mode controls how much output you see in WeChat.

| Command | Description |
|------|------|
| `/replymode` | View the global default, the current session override, and the effective value |
| `/replymode stream` | Stream intermediate text |
| `/replymode verbose` | Stream and show tool-call summaries |
| `/replymode final` | Send only the final text |
| `/replymode reset` | Clear the current session override and return to the global default |

Recommendations:

- Use `stream` for everyday development.
- Use `verbose` when you want to see what the agent is doing.
- Use `final` when you just want to receive fewer messages.

## acpx mode

`/mode` is passed directly to the underlying agent. The available values depend on the agent you use.

| Command | Description |
|------|------|
| `/mode` | View the mode saved for the current session |
| `/mode <id>` | Set the mode for the current session |

Examples:

```text
/mode
/mode plan
```

Known common values:

- `codex`: `plan`
- `cursor`: `agent`, `plan`, `ask`

## Model

`/model` views or switches the LLM model of the current session. acpx validates the id against the models the agent advertises and applies it to the running session (immediately during an active turn, otherwise from the next turn). There are three ways to set a model, in increasing precedence: the agent default (`/agent add <template> --model <id>`), the per-session pin (`/session new ... --model <id>`), and a live switch (`/model <id>`).

| Command | Description |
|------|------|
| `/model` | View the current session's model and the available model ids |
| `/model <id>` | Switch the current session's model (e.g. `gpt-5.2[high]`) |

Examples:

```text
/model
/model gpt-5.2[high]
```

## Configuration

`/config` only allows modifying configuration items on the whitelist. For complete configuration field descriptions, see [config-reference.md](./config-reference.md); for the in-WeChat configuration command, see [config-command.md](./config-command.md).

| Command | Description |
|------|------|
| `/config` | View the configuration paths that can be modified |
| `/config set <path> <value>` | Modify one supported configuration value |

Currently supported paths:

- `language`
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

Note: the performance debug logs `logging.perf.*` are currently not on the `/config set` whitelist; edit `~/.xacpx/config.json` directly and restart the daemon for them to take effect. See [config-reference.md](./config-reference.md#loggingperf) for details.

- `channel.replyMode`
- `agents.<name>.driver`
- `agents.<name>.command`
- `workspaces.<name>.cwd`
- `workspaces.<name>.description`

Examples:

```text
/config set channel.replyMode final
/config set logging.level debug
/config set transport.sessionInitTimeoutMs 30000
```

## Permission Policy

The permission policy affects whether the underlying agent can perform read/write operations automatically.

| Command | Actual config value | Description |
|------|------------|------|
| `/pm` / `/permission` | - | View the current permission policy |
| `/pm set allow` | `approve-all` | Allow more operations to pass automatically |
| `/pm set read` | `approve-reads` | Automatically allow read operations; write operations remain more cautious |
| `/pm set deny` | `deny-all` | Deny operations that require approval by default |
| `/pm auto` | - | View the non-interactive permission policy |
| `/pm auto deny` | `deny` | Automatically deny in non-interactive scenarios |
| `/pm auto fail` | `fail` | Fail directly in non-interactive scenarios |

Examples:

```text
/pm
/pm set read
/pm auto deny
```

## Multi-Agent Orchestration

Orchestration commands require a current session first. The current session acts as the coordinator session, and subtasks are dispatched to other agent sessions for execution.

If you are not yet sure when to use delegate versus when to start a group, read [xacpx-group-usage-guide.md](./xacpx-group-usage-guide.md) first.

### Delegate a Single Subtask

| Command | Description |
|------|------|
| `/dg <agent> <task>` | Quickly delegate a subtask |
| `/delegate <agent> <task>` | Delegate a subtask |
| `/delegate <agent> --role <role> <task>` | Delegate according to a specified role template |
| `/delegate <agent> --group <groupId> <task>` | Add the delegated task to an existing task group |
| `/delegate <agent> --role <role> --group <groupId> <task>` | Specify both a role and a task group |

Examples:

```text
/dg claude Review the 3 highest-risk points of the current plan
/delegate codex --role planner Break this requirement into minimal implementation steps
/delegate claude --group review-batch Review the interface design
```

### Manage Task Groups

A group is suitable for dispatching multiple mutually independent subtasks in parallel and then viewing progress together.

| Command | Description |
|------|------|
| `/group new <title>` | Create a task group |
| `/groups` | View the task group list |
| `/groups --status <pending|running|terminal>` | Filter task groups by status |
| `/groups --stuck` | Only show task groups that appear stuck |
| `/groups --sort <updatedAt|createdAt>` | Set the sort field |
| `/groups --order <asc|desc>` | Set the sort direction |
| `/group <id>` | View the details of a single task group |
| `/group add <groupId> <agent> <task>` | Add a subtask to the task group |
| `/group add <groupId> <agent> --role <role> <task>` | Add a subtask to the task group according to a role template |
| `/group cancel <groupId>` | Cancel all unfinished tasks in the group |

Examples:

```text
/group new review-batch
/group add review-batch claude Review the interface design
/group add review-batch codex --role reviewer Review test coverage
/groups --status running --sort updatedAt --order desc
/group review-batch
/group cancel review-batch
```

The current version has no `/group delete`. If you only want to stop unfinished tasks in the group, use `/group cancel <groupId>`; if you want to clean up finished tasks, use `/tasks clean`.

### Manage Orchestration Tasks

| Command | Description |
|------|------|
| `/tasks` | View the task list under the current coordinator session |
| `/tasks --status <state>` | Filter by task status |
| `/tasks --stuck` | Only show running tasks whose heartbeat has timed out |
| `/tasks --sort <updatedAt|createdAt>` | Set the sort field |
| `/tasks --order <asc|desc>` | Set the sort direction |
| `/tasks clean` | Clean up finished tasks and invalid bindings under the current coordinator session |
| `/task <id>` | View the details of a single task |
| `/task approve <id>` | Approve a `needs_confirmation` task |
| `/task reject <id>` | Reject a `needs_confirmation` task |
| `/task cancel <id>` | Cancel a task |

`/tasks --status` currently supports:

- `pending`
- `needs_confirmation`
- `running`
- `completed`
- `failed`
- `cancelled`

Examples:

```text
/tasks
/tasks --status running --sort updatedAt --order desc
/tasks --stuck
/task task_123
/task approve task_123
/task cancel task_456
/tasks clean
```

## Scheduled Tasks

`/later` (alias `/lt`) is used to create, view, and cancel one-off scheduled tasks. By default they run in a temporary session; `--bind` binds the current session.

> For complete time formats, task states, delivery reachability, and other details, see [later-command.md](./later-command.md).

### Create a Scheduled Task

| Command | Description |
|------|------|
| `/lt <time> <message>` | Create a one-off scheduled task (runs in a temporary session) |
| `/lt --bind <time> <message>` | Create a scheduled task bound to the current session |
| `/lt --temp <time> <message>` | Explicitly specify a temporary session (use when the default has been changed to bind) |
| `/later <time> <message>` | Same as `/lt` (full name, supports the same flags) |

Supported time formats:

| Format | Example |
|------|------|
| Relative time (English) | `/lt in 2h Check CI`, `/lt in 30m Summarize`, `/lt in 1d Re-review` |
| Relative time (Chinese) | `/lt 30分钟后 Summarize progress`, `/lt 2小时后 Check`, `/lt 1天后 Re-review` |
| Date words | `/lt today 21:30 Continue working`, `/lt tomorrow 09:00 Look at the PR`, `/lt 明天 09:00 Look at the PR` |
| Day of week | `/lt 周五 09:00 Continue working`, `/lt friday 09:00 Look at the PR` |

More examples:

```text
/lt in 2h Check CI
/lt 30分钟后 Summarize progress
/lt tomorrow 09:00 Look at the PR
/lt 周五 09:00 Continue working
```

### View and Cancel

| Command | Description |
|------|------|
| `/lt list` | View pending scheduled tasks |
| `/lt cancel <id>` | Cancel a pending scheduled task |

```text
/lt list
/lt cancel #k8f2
```

### Limitations

- Only **one-off** tasks are supported; repeated execution is not supported.
- The scheduled time must be **at least 10 seconds from now and within 7 days**.
- By default it runs in a temporary session; add `--bind` to run it bound to the current session; the default mode can be configured via `later.defaultMode`.
- `/lt list` shows pending tasks created in the **current chat** only; other chats' tasks are never visible, and their ids cannot be cancelled from here.
- Cancellation follows the **trusted channel model**: in group chats, only the group owner can cancel.
- Delaying execution of xacpx commands that start with `/` is **not supported** (e.g. `/lt in 1h /status` will be rejected). If you need the agent to discuss a command, describe it in a plain sentence.
- The trigger notification and the agent reply reuse the existing **channel routing**; WeChat reply quotas are controlled by the existing routing.

### Help

```text
/help later
```

## Group Permissions

In group chats, only read-only commands (`/help`, `/status`, `/sessions`, `/config`, ...) and plain prompts are open to every member. Control commands (`/clear`, `/use`, `/session new`, `/mode`, `/model <id>`, `/permission`, `/later` control, ...) are restricted to the chat owner:

- Channels that report group roles grant owner automatically (e.g. Yuanbao recognizes the bot owner).
- WeChat carries **no group-role information**, so configure your own sender id in `channel.ownerIds` (or `channels[].ownerIds`) to authorize yourself; see [config-reference.md — `channel.ownerIds`](./config-reference.md#channelownerids). Your sender id appears as `senderId` in the `command.blocked` entry written to `~/.xacpx/runtime/app.log` when a command is denied.
- If a channel fails to report whether a chat is direct or group, control commands are denied (fail closed) and a `channel.chat_type_missing` warning is logged.

## Common Errors

### Command Treated as a Plain Message

Only recognized `/` commands are parsed. Unknown commands are sent to the current session as plain text.

### A Recognized Command Returns an Argument Error

If the command prefix is recognized, e.g. `/session`, `/group`, `/task`, but the arguments do not match, `xacpx` returns a command-format error. Prefer using `/help <topic>` to look up the corresponding topic.

### Session Creation Fails

Check three things first:

1. The workspace path exists on the computer running `xacpx`.
2. The agent is registered; you can check with `/agents`.
3. The underlying agent command itself is runnable.

If an underlying session already exists, you can bind it back with `/session attach ...`.
