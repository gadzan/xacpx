# Scheduled Tasks

## Overview

`/later` (alias `/lt`) schedules a one-time task: at a specified future time, xacpx sends a message to an agent session and routes the reply back to the originating chat. Tasks are single-fire — they do not repeat.

**Mental model:** schedule a message to be sent at a future time; xacpx handles session setup, delivery, and reply routing automatically.

**Key constraints:**

- You must have an active session at the time of creation. The task snapshots the agent and workspace from the current session.
- The scheduled time must be at least 10 seconds in the future and no more than 7 days away.
- Only regular prompt messages can be scheduled. Messages starting with `/` are rejected — use a plain sentence instead (e.g. "explain what the /status command does" instead of `/lt in 1h /status`).
- The current chat channel must support scheduled message delivery. If it does not, task creation is rejected immediately — no partially created task is left behind.
- Supported channels: WeChat (built-in), Feishu (plugin), Yuanbao (plugin), Discord (plugin). Third-party channel plugins must implement `sendScheduledMessage` to enable this feature.

For the full command reference, see [Command Reference](/reference/commands).

## Create a scheduled task

```text
/later <time> <message>
/lt <time> <message>
```

By default, xacpx creates a **temporary session** for the task: a fresh session that inherits the agent and workspace of the current session at creation time, runs the task in an isolated conversation history, and is destroyed after execution. This avoids polluting the ongoing conversation with the task result.

Use `--bind` to target the current session instead:

```text
/lt in 2h check CI              # temporary session (default)
/lt --bind in 2h check CI       # send to the current session at creation time
/lt --temp tomorrow 09:00 review PR   # explicit temporary (useful when default is changed)
```

`--bind` and `--temp` are mutually exclusive. You cannot use both in the same command.

The default mode can be changed via the `later.defaultMode` config key (`"temp"` | `"bind"`, default `"temp"`). See [Configuration](/reference/configuration).

**Confirmation output (temporary session):**

```text
Scheduled task #k8f2 created
Execute at: 2026-05-23 Sat 21:30
Temp session (backend · codex)
Message: check CI
```

**Confirmation output (bound session):**

```text
Scheduled task #k8f2 created
Execute at: 2026-05-23 Sat 21:30
Session: backend-codex
Message: check CI
```

**Time is always parsed in the local system timezone.** The confirmation reply echoes the absolute date and weekday to eliminate ambiguity.

### Time syntax

**Relative — English (two words: `in` followed by `<amount><unit>`, e.g. `in 10m`):**

```text
/lt in 10m check CI
/lt in 2h check CI
/lt in 1d summarize progress
```

**Relative — Chinese (one compact token, no space):**

The parser also accepts Chinese relative-time tokens, where `分钟后` means "minutes later", `小时后` means "hours later", and `天后` means "days later":

```text
/lt 10分钟后 check CI          # = in 10 minutes
/lt 2小时后 check CI           # = in 2 hours
/lt 1天后 summarize progress   # = in 1 day
```

Supported units:

| Type | Accepted forms |
|---|---|
| Minutes | `m`, `min`, `minute`, `minutes`, `分钟` |
| Hours | `h`, `hour`, `hours`, `小时` |
| Days | `d`, `day`, `days`, `天` |

Decimals (`1.5h`) and Chinese numerals (`一小时后` = "one hour later", `半小时后` = "half an hour later") are not supported. Chinese relative tokens must have no internal spaces (`10 分钟后`, with a space, is not recognized).

**Absolute — today / tomorrow / day-after-tomorrow:**

```text
/lt at 21:30 continue work          # same as "today 21:30"
/lt today 21:30 continue work
/lt tomorrow 09:00 review PR
/lt 后天 14:30 continue debug        # day after tomorrow (Chinese only)
```

Time format: `H:MM` or `HH:MM`, 24-hour clock, minutes must be two digits (`09:00` — `9:0` is not accepted).

If `today` or `at` specifies a time that has already passed today, the command is rejected — it is not auto-shifted to tomorrow:

```text
21:30 today has already passed. Please specify a future time, or use "tomorrow".
```

**Absolute — day of week:**

```text
/lt 周五 09:00 review PR        # 周五 = Friday
/lt fri 09:00 review PR
/lt friday 09:00 review PR
```

Resolves to the nearest upcoming occurrence of that weekday within the next 7 days. If today is the target weekday and the time has not yet passed, it schedules for today. If the time has already passed, it schedules for the same day next week (still within the 7-day limit).

Supported: all 7 days in both Chinese (`周日/周天/星期日` … `周六/星期六`) and English (`sun/sunday` … `sat/saturday`).

**Unsupported expressions** (v1 deliberately excludes these vague natural-language forms to avoid misinterpretation):

```text
明早  今晚  下午三点  周五晚上  下周一  月底  饭后  睡前
```

In English these read, in order: *tomorrow morning, tonight, 3 p.m., Friday evening, next Monday, end of month, after a meal, before bed*. Use the explicit relative/absolute/day-of-week forms above instead.

When a time expression is not recognized, xacpx shows a format guide (the guide is bilingual; `30分钟后` means "in 30 minutes" and `周五` means "Friday"):

```text
Time format not recognized.

Supported formats:
- /lt in 2h message        (2 hours from now)
- /lt 30分钟后 message
- /lt tomorrow 09:00 message
- /lt 周五 09:00 message
```

## List scheduled tasks

```text
/lt list
```

Shows all globally pending tasks — not filtered by the current chat or session:

```text
Pending scheduled tasks:

#k8f2  2026-05-23 Sat 21:30  Temp session (backend · codex)
check CI status

#p91a  2026-05-24 Sun 09:00  Session: frontend-claude
continue working through yesterday's issues
```

When there are no pending tasks: `No pending scheduled tasks.`

You can also manage tasks from the terminal when the chat channel is unavailable:

```bash
xacpx later list
xacpx later cancel k8f2
xacpx lt list
xacpx lt cancel #k8f2
```

The CLI supports only `list` and `cancel` — it cannot create tasks.

## Show task details

Task details are included in the list output and in the creation confirmation reply. There is no separate "show" subcommand in v1.

## Cancel a scheduled task

```text
/lt cancel k8f2
/lt cancel #k8f2     # the # prefix is optional; case-insensitive
```

Anyone who can run `/lt list` (which shows all pending tasks globally) can also cancel any pending task. In group chats, only the group owner can use `/lt cancel`.

## Temporary sessions

When a task runs in temporary session mode (the default):

1. xacpx sends a visible notification to the originating chat: `Executing scheduled task #id ...` indicating whether a temporary or bound session is used.
2. xacpx creates a new clean session inheriting the agent and workspace snapshotted at task creation time, with a fresh conversation history.
3. The message is sent to this temporary session as a normal prompt.
4. The agent's reply is routed back to the originating chat via the usual channel delivery mechanism.
5. The temporary session is destroyed after execution.

**Temporary sessions are not resumable.** If you reply to the result message, the reply goes to your current active session — it does not revive the temporary session.

When a task runs in bound session mode (`--bind`), the message is delivered to the session that was active at task creation time. If that session no longer exists at execution time, the task is recorded as `failed`.

**Task state machine:**

| State | Meaning |
|---|---|
| `pending` | Waiting to execute (`/lt list` shows only these) |
| `triggering` | Execution claimed and delivery in progress |
| `executed` | Successfully dispatched |
| `cancelled` | Cancelled via `/lt cancel` |
| `missed` | Daemon found the task overdue on startup — not re-sent |
| `failed` | Delivery failed (bound session missing, agent/workspace deregistered, transport unavailable) |

**Missed tasks are not replayed.** If the daemon was not running when the scheduled time passed, the task is marked `missed` on next startup to prevent stale tasks from firing unexpectedly.

**Crash safety:** Tasks interrupted mid-`triggering` are marked `failed` on restart rather than re-triggered.

## Channel capability requirements

The originating channel must support outbound scheduled message delivery (`sendScheduledMessage`). If it does not, task creation is rejected at the start:

```text
This channel does not support scheduled tasks and the task was not created.

Reason: this channel has not implemented scheduled message delivery, so there is
no way to send the result back to this chat when the task fires.
Please switch to a supported channel before using /lt.
```

**WeChat delivery note:** WeChat outbound delivery depends on the session context window. A task scheduled close to the 7-day maximum, where no new messages have been sent in the interim, may fail to deliver. If the notification send fails but a delivery context is still available, the agent still executes and the final result is delivered via the fallback slot. Only when no delivery path exists at all does xacpx abort agent execution.

For long-horizon tasks, ensure there is recent chat activity on the channel, or keep schedules within a day or two.

## Examples

**Run a CI check two hours from now:**

```text
/lt in 2h check whether CI has recovered and summarize results
```

**Schedule a morning review:**

```text
/lt tomorrow 09:00 review open pull requests and flag anything blocking
```

**Schedule for Friday:**

```text
/lt friday 17:00 write a progress summary for the week
```

**Bind to the current session instead of using a temporary one:**

```text
/lt --bind in 30m run the full test suite and report results
```

**Cancel a task:**

```text
/lt list
/lt cancel k8f2
```

**Natural language (via agent):** In addition to the `/lt` command, agents can create, list, and cancel scheduled tasks via built-in MCP tools when they understand natural-language intent ("remind me tomorrow at 9 to…"). These tools are only available to the agent managing the current session — they are not exposed through the external `xacpx mcp-stdio` interface. All constraints (time limits, channel capability check, group-owner permission) apply identically.
