# xacpx Group Usage Guide

This guide covers two things: **when to delegate a single subtask versus when to open a task group**, and how to stop or clean up group work. The descriptions below stay consistent with the current command behavior of `/help group` / `/help orchestration`.

> There is **no** `/group delete` and **no** `/groups clean`. To stop a group's unfinished work use `/group cancel <groupId>`; to clean up finished task records use `/tasks clean`.

## Delegate or open a group?

The current session is the coordinator. A delegated subtask runs as an independent worker session.

| | Delegate one subtask | Open a task group |
|---|---|---|
| Command | `/dg <agent> <task>` (or `/delegate …`) | `/group new <title>`, then one `/group add <groupId> <agent> <task>` per piece |
| Shape | One task, one worker | Several tasks, several workers |
| Use when | The work is one well-defined piece; you want one result back | The work splits into mutually independent pieces that can run in parallel; you want to watch their progress together |
| Approval | A delegated task can sit in `needs_confirmation` — check `/tasks`, then `/task approve <id>` or `/task reject <id>` | Same per-task approval inside the group |

Rules of thumb:

- **One thing → delegate.** `/dg claude Review the 3 highest-risk points of the current plan`
- **Several independent things → group.** `/group new review-batch`, then one `/group add` per piece.
- **Dependent things → don't parallelize them.** If B needs A's result, delegate them in order instead of putting both in one group; a group is for work that can run at the same time.
- **You can add a delegated task to an existing group:** `/delegate <agent> --group <groupId> <task>`.
- **A role template can shape either path:** `/delegate <agent> --role <role> <task>` or `/group add <groupId> <agent> --role <role> <task>`.

### Not the same "group" as a dashboard Group Conversation

The relay dashboard has a second kind of group: a Group Conversation — a persistent multi-bot conversation where members discuss in rounds (roundtable, 1–3 rounds) or work under automatic routing. That is a different system from the chat `/group` task groups above: it lives in the dashboard / Control API, not in `/group new`, and its members talk to each other (`group_send`) instead of reporting back to one coordinator session. If you want bots to discuss and collaborate with each other, use a Group Conversation; if you want parallel subtasks under your current session, use a chat task group. See [conversation-runtime.md](./conversation-runtime.md) for the conversation model.

## Remember two actions first

| Command | Effect | Affects running tasks? |
|---|---|---|
| `/group cancel <groupId>` | Stops the running work inside a task group | Yes |
| `/tasks clean` | Removes finished tasks and stale worker bindings under the current coordinator | No |

In one line:

- **cancel**: stop the work first.
- **clean**: remove finished task records that are already safe to discard.

`/tasks clean` is **task-scoped, not group-scoped** — it sweeps finished tasks across the current coordinator rather than deleting a specific group shell. There is no command that deletes a single group.

## `/group cancel <groupId>`

The goal of this command is not to "delete the task group", but to **stop the work still running in that group**.

It will:

- Initiate cancellation for all unfinished tasks in the group
- Skip tasks that have already finished
- Keep the task group itself, so you can later keep inspecting it, finalize it, or make a result judgment

Suitable for these scenarios:

- You realize this group went in the wrong direction and want to stop it first
- You want to keep the context, but don't want to keep executing
- You're not yet sure whether the work is done, so let it wind down first

## `/tasks clean`

This command is a **cleanup of finished task records** under the current coordinator. It removes:

1. **Finished tasks** (completed, failed, cancelled)
2. **Stale worker bindings** that are no longer in use

It will not touch tasks that are still executing, nor will it cancel running tasks for you. It is scoped to the current coordinator's main line and does not reach into other coordinators' tasks.

Suitable for these scenarios:

- You want to clear out the already-finished task records under the current main line in one go
- You only care about the current coordinator's main line and don't want to touch other people's tasks across main lines

If a group still has unfinished tasks, cancel them first with `/group cancel <groupId>`, then run `/tasks clean` to clear the finished records.

## When to use which

- **You just want to stop the work still running**: use `/group cancel <groupId>`
- **You want to clear the already-finished task records under the current main line**: use `/tasks clean`

To inspect before acting, use `/groups` to see groups and their status, `/group <id>` for one group's details, and `/tasks` (optionally `/task <id>`) to review individual tasks.

## Minimal decision flow

1. Is this group still running work you no longer want?
   - Yes: first `/group cancel <groupId>`, then wait for the running tasks to stop
   - No: continue to the next step
2. Do you want to tidy up finished task records?
   - Yes: run `/tasks clean` to remove finished tasks and stale bindings under the current coordinator
   - No: nothing else to do; the group is kept for inspection

## Examples

```text
/dg claude Review the 3 highest-risk points of the current plan   # one thing: delegate
/group new review-batch                                            # several independent things: group
/group add review-batch claude Review the interface design
/group add review-batch codex --role reviewer Review test coverage
/group cancel review-batch   # stop the unfinished work in review-batch (group is kept)
/tasks clean                 # remove finished tasks and stale bindings under this coordinator
```

If, when looking at `/group` details, you find:

- The group still has running tasks: cancel first with `/group cancel <groupId>`
- The group has no live tasks left: run `/tasks clean` to clear the finished records
