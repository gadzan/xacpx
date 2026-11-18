# External MCP Coordinator

## Overview

`xacpx mcp-stdio` is a standard MCP stdio server. External MCP hosts — Codex, Claude Code, and others — can connect to it and call xacpx orchestration tools such as `delegate_request`, `task_get`, `task_list`, and `task_watch`. Hosts that support MCP Tasks can use native task execution on `delegate_request` and `task_watch`: call now, fetch later.

> **Tool name prefix:** The MCP server is registered under the name `xacpx`. Tool names therefore use the prefix `mcp__xacpx__*` (for example `mcp__xacpx__delegate_request`, `mcp__xacpx__task_get`). (Before v0.8.0 the server was named `weacpx`; hosts that hardcoded the old `mcp__weacpx__*` prefix must update to `mcp__xacpx__*`.)

> **Scheduled task tools** (`scheduled_create`, `scheduled_list`, `scheduled_cancel`) are available only to the internal xacpx session — they reuse the current chat route and group-owner authorization. The external `mcp-stdio` server does not expose them.

**Mental model:**

- **MCP host / current agent** — the coordinator; responsible for decomposing tasks and reading results.
- **`xacpx mcp-stdio`** — a thin stdio shim that converts MCP tool calls to xacpx daemon RPC.
- **xacpx daemon** — holds all orchestration state: coordinators, tasks, worker bindings.
- **Worker agent** — a Claude / Codex / opencode session dispatched by `delegate_request`.
- **`workingDirectory`** — the per-task working directory. It controls where the worker operates; it does not define coordinator identity.

**Minimum setup:**

```bash
xacpx start
xacpx status
```

Add to the MCP host configuration:

```json
{
  "mcpServers": {
    "xacpx": {
      "command": "xacpx",
      "args": ["mcp-stdio"]
    }
  }
}
```

No `--workspace` flag is needed. xacpx generates a process-scoped external coordinator identity, for example `external_codex-mcp-client:3f2a91c0`. This identity tracks which MCP subprocess is acting as coordinator; it does not bind to a directory.

## Tool surface

### Coordinator tools

| Tool | Description |
|------|-------------|
| `delegate_request` | Dispatch a single sub-task. Pass `workingDirectory` (required unless a default workspace is set). Supports MCP Tasks native execution for call-now, fetch-later. |
| `delegate_batch` | Dispatch multiple sub-tasks in one call. Two or more tasks are automatically grouped; results are returned together once all tasks reach a terminal state. Individual task failures include an `error` field without affecting the others. |
| `task_get` | Fetch a task snapshot: summary, latest progress, and (for terminal tasks) the worker's final result. Does not include the original prompt by default; pass `includePrompt: true` to re-read it. `needs_confirmation` tasks always show the prompt for approver review. |
| `task_list` | List all tasks owned by the current coordinator. |
| `task_watch` | Long-poll a task until the next event, until it needs coordinator attention, or until it reaches a terminal state (or times out). Returns `events` and `nextAfterSeq`; pass `nextAfterSeq` as `afterSeq` on the next call to avoid replaying old events. In terminal state the response includes `- Result:`; in attention state it includes `- Open question:` — no separate `task_get` call needed. Default timeout: 60 seconds; maximum: 20 minutes. |
| `task_cancel` | Cancel a task. Cancelling a `needs_confirmation` task is equivalent to rejecting it. Cancelling a `queued` task takes effect immediately, before any session is allocated. |
| `task_approve` | Approve a task that `delegate_request` returned as `needs_confirmation`, once the user has authorized it. The task then starts running. |
| `agent_list` | List authorized peer agent sessions in scope, including their assigned roles, workspaces, and current activities. Inspect this list before sending messages to ensure the target is relevant to your task. |
| `agent_send` | Send a high-value asynchronous peer message to another agent. One-way: returns after the target runtime accepts delivery; it never waits for the target model to understand, finish, or reply. |
| `coordinator_answer_question` | Provide an answer to a blocked question raised by a worker. |
| `coordinator_review_contested_result` | Resolve a contested result raised by a worker. |

### Worker-only tool

| Tool | Description |
|------|-------------|
| `worker_raise_question` | Called from inside a delegated task to block execution and ask the coordinator a question. **Never call this from the coordinator side.** |

### Group-execution-only tools

Exposed only inside a Group Topic execution — never to the external coordinator:

| Tool | Description |
|------|-------------|
| `group_say` | Post one short bounded public remark (`text`) through the same public message path as a final reply; it wakes nobody and dispatches nothing. At most 3 calls per member turn, at most 1,000 characters each. |
| `group_send` | Publicly assign a concrete task to another current Group Bot in this Run (`to`, `task`, optional `expectedOutput`). Acceptance is durable and grants no human permission authority. |
| `group_read_result` | Read-only: list settled assignment metadata (16 rows per page) or read a completed public result (4,000 characters per page), scoped to the live execution's Run. Page with `offset` / `limit` and follow `nextOffset` until null. |

## Delegation lifecycle

```text
delegate_request
  → taskId returned, status: running (or queued if parallel slots are full)
  → monitor via task_watch / tasks/get / task_get
  → terminal: completed / failed / cancelled
         or attention: needs_confirmation / blocked / waiting_for_human / reviewPending
  → read final result via task_watch (included inline) or task_get
```

When `parallel: true` is set on a task and the target agent's parallel slot limit (`orchestration.maxParallelTasksPerAgent`, default 3) is reached, the task is created with status `queued`. It does not consume an `acpx` session. When a slot becomes available, tasks are promoted to `running` in creation-time order.

`task_watch` modes:

- `"next_event"` — returns on the next event; suitable for real-time progress streaming.
- `"until_attention_or_terminal"` — default; skips routine running updates; waits for tasks that need coordinator action or reach a terminal state.

## Task state model

| State | Meaning |
|-------|---------|
| `pending` | Created but not yet started |
| `queued` | Waiting for a parallel execution slot to become available |
| `running` | Worker is executing |
| `needs_confirmation` | Awaiting coordinator approval (`task_approve` or `task_cancel`/reject) |
| `blocked` | Worker is blocked; coordinator action required |
| `waiting_for_human` | Worker has raised a question for the coordinator |
| `completed` | Worker finished successfully |
| `failed` | Worker encountered an error |
| `cancelled` | Task was cancelled |

Tasks with an open `reviewPending` entry also surface as `input_required` in MCP Tasks.

### MCP Tasks protocol mapping

| xacpx state | MCP Tasks status |
|------------|-----------------|
| `running` | `working` |
| `queued` | `working` (slot not yet available; auto-promotes when ready) |
| `needs_confirmation` | `input_required` |
| `blocked` / `waiting_for_human` | `input_required` |
| `reviewPending` present | `input_required` |
| `completed` | `completed` |
| `failed` | `failed` |
| `cancelled` | `cancelled` |

MCP Tasks protocol methods:
- `tasks/get` — query status.
- `tasks/list` — list tasks for the current coordinator.
- `tasks/result` — read the result of a terminal task; if `input_required`, returns an action guide immediately rather than blocking.
- `tasks/cancel` — cancel a task (mapped to `task_cancel` internally).

## Blocking questions

When a worker needs coordinator input, the task enters `needs_confirmation`, `blocked`, or `waiting_for_human` (collectively: attention states). The coordinator should:

1. Call `task_get` to read the details or pending question.
2. Call one of:
   - `task_approve <id>` / `task_cancel <id>` (reject) for `needs_confirmation`.
   - `coordinator_answer_question` for a `waiting_for_human` question.
   - `coordinator_review_contested_result` for a contested review.
3. Resume monitoring via `task_watch` or `tasks/get`.

Hosts using MCP Tasks: `tasks/result` on an `input_required` task returns an action guide immediately. Follow its instructions, then resume with `tasks/get` or `tasks/result`.

## Group fan-in

`delegate_batch` dispatches multiple tasks and links them to the same group. Use it when you want to fan out parallel work and receive consolidated results:

```json
{
  "tasks": [
    {
      "targetAgent": "claude",
      "task": "Review PR A for correctness",
      "workingDirectory": "/repo/a",
      "parallel": true
    },
    {
      "targetAgent": "claude",
      "task": "Review PR B for correctness",
      "workingDirectory": "/repo/b",
      "parallel": true
    }
  ]
}
```

All tasks must reach a terminal state before the batch result is returned. Individual failures carry an `error` field; the batch as a whole is not aborted.

You can also build a group manually using `/group new` in chat and then fan tasks in with `delegate_request --group <groupId>` or via the chat `/group add` command.

## Cancellation

- `task_cancel` cancels any non-terminal task.
- Cancelling a `needs_confirmation` task is equivalent to rejecting it.
- Cancelling a `queued` task is safe and immediate — no session has been allocated yet.
- `/cancel <alias>` or `/stop <alias>` in chat cancels a session's running task, including background sessions.
- `/group cancel <groupId>` in chat cancels all unfinished tasks in a group.

## Integration notes

### `workingDirectory` is required (and intentional)

`delegate_request` requires a non-empty absolute path unless the coordinator has a default workspace. xacpx does not fall back to MCP roots or `process.cwd()`:

- MCP roots are inconsistently supported and may list multiple directories.
- `process.cwd()` depends on how the MCP host launches the stdio subprocess and is not a reliable contract.

The strict rule ensures the worker's working directory is always deterministic.

```json
{
  "targetAgent": "claude",
  "task": "Review the current changes and flag the top 3 risks",
  "workingDirectory": "/absolute/path/to/repo"
}
```

Windows path example:

```json
{
  "workingDirectory": "C:\\path\\to\\your\\repo"
}
```

### Coordinator identity vs. `workingDirectory`

| Concept | Purpose | Contains path? |
|---------|---------|---------------|
| External coordinator identity | Identifies which MCP host / subprocess is coordinating | No (by default) |
| `workingDirectory` | Tells the worker where to operate | Yes |
| Worker session | Scoped to coordinator + cwd | Derived from cwd |

Keeping identity and cwd separate lets the same coordinator dispatch workers to different directories without becoming a different coordinator.

### Multiple simultaneous MCP hosts

Each `xacpx mcp-stdio` process that does not specify `--coordinator-session` gets its own process-scoped identity (`external_<client-name>:<instance-id>`). Multiple Codex or Claude Code windows each get independent coordinators; they can dispatch tasks to separate `workingDirectory` paths without interfering.

To share a coordinator identity across restarts or across multiple hosts, use `--coordinator-session`:

```json
{
  "mcpServers": {
    "xacpx": {
      "command": "xacpx",
      "args": ["mcp-stdio", "--coordinator-session", "codex:daily-review"]
    }
  }
}
```

With a fixed session, `task_list` shows tasks from previous runs. Only use this if you deliberately want shared orchestration context.

### Default workspace (compatibility mode)

`--workspace` provides a fallback `workingDirectory` for `delegate_request` calls that omit it:

```bash
xacpx mcp-stdio --workspace backend
```

The workspace must be registered in `~/.xacpx/config.json`. This is a compatibility convenience; prefer passing `workingDirectory` explicitly in tool calls.

### Windows configuration

Do not put the full `node C:\...\cli.js` string in `command`. Many MCP hosts treat `command` as a filename and fail with `os error 123`. Put only the executable in `command` and everything else in `args`:

```json
{
  "type": "stdio",
  "command": "C:\\Program Files\\nodejs\\node.exe",
  "args": ["C:\\path\\to\\xacpx\\dist\\cli.js", "mcp-stdio"]
}
```

If `xacpx` is globally installed and discoverable by the host:

```json
{
  "type": "stdio",
  "command": "xacpx",
  "args": ["mcp-stdio"]
}
```

### Process lifecycle (Windows orphan prevention)

`xacpx mcp-stdio` monitors for stdio disconnect, `SIGINT`/`SIGTERM`/`SIGBREAK`, and polls the parent process every 5 seconds. On exit it writes a diagnostic line to stderr:

```
[xacpx:mcp] mcp.stdio.shutdown {"reason":"parent_dead","parentPid":1234}
```

Set `XACPX_MCP_PARENT_CHECK_INTERVAL_MS` to adjust the poll interval (milliseconds). Set to `0` to disable parent polling (debug use only). The legacy `WEACPX_MCP_PARENT_CHECK_INTERVAL_MS` name still works as a fallback.

### `sourceHandle` reuse

For coordinator-side tool calls without an explicit `--source-handle` binding, xacpx reuses the `coordinatorSession` as the `sourceHandle`. For worker-side `worker_raise_question`, a separate `sourceHandle` is required and must be explicitly bound; it will not fall back silently.

### Troubleshooting

| Error | Cause | Fix |
|-------|-------|-----|
| `cannot infer workspace from MCP roots` | Old documentation suggested roots-based inference | Use `xacpx mcp-stdio` without `--workspace`; pass `workingDirectory` per task |
| `workingDirectory is required` | No default workspace and `workingDirectory` omitted | Add `workingDirectory` to the `delegate_request` call |
| `workingDirectory must be an absolute path` | Relative path passed | Use an absolute path |
| `os error 123` (Windows) | `command` contains a full command string | Put only the executable in `command`; move script path and args to `args` |
| `Cannot find module '...dist\\cli.js'` | Script path wrong or not built | Verify path in terminal; run `bun run build` if needed |
| Task created but worker has no result | Agent unavailable, `acpx` failed to start, session occupied, or permission policy blocking | Check `xacpx status`, `xacpx doctor --verbose`, and `~/.xacpx/runtime/app.log` |
