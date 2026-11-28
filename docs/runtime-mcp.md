# Runtime MCP

`src/bridge/engine/runtime/runtime-mcp.ts` — xacpx-owned MCP launch identity for the acpx Runtime.

- **Identity:** `mcpCoordinatorSession` + `mcpSourceHandle` are **immutable launch identity** (`RuntimeWorkerEnsureParams`, `sameEnsureParams`, `buildEnsureParams`). Absence (`none→coordinator`, `coordinator→none`, `A→B`, `source A→B`) all count as identity change.
- **Server spec:** `buildRuntimeMcpServers` reuses `buildXacpxMcpServerSpec` + `resolveDefaultXacpxCommand` (single `xacpx` stdio server, `mcp-stdio --coordinator-session … [--source-handle …]`), returned as `McpServer[]` for `AcpRuntimeOptions.mcpServers`. Shared with CLI path — no duplicated MCP implementation.
- **Stale handling:** `RuntimeEngine` fences launch identity via `lastMcpIdentity`/`staleAfterTurn` converged helpers (`isMcpStale`, `isStaleActiveForDrain=busy|hasInFlight`, `isStaleActiveForInjectOrCheck=activeTurns|draining|busy|hasInFlight`, `checkMcpStaleAndRotate` for `prompt`/`withWorker`, `drainLoop` head check, `injectMessage` check — fail-closed `shutdown`+`release` with `unref` timer): idle → `shutdown`+`release`+respawn with new `mcpServers`; active/busy/hasInFlight → `staleAfterTurn` + bounded `kickDrain` re-kick, retired in both `prompt` and `withWorker` `finally` after `activeTurns` clears (covers `setMode`/`setModel`/other business ops), never kills mid-turn. Legacy queue heads without `mcpIdentityKnown` fail closed (see `runtime-queue.md`).
- **Convergence:** MCP descendants are children of the Runtime worker, so `worker-eof`/`terminateProcessTree` convergence (handle-bound, `creationDate` fenced) reaps them together on TTL/`freeWarm`/`shutdown`/host-crash. No bare-PID kill.

See `src/bridge/engine/runtime/runtime-worker-main.ts` and `tests/unit/bridge/engine/runtime/runtime-engine-mcp.test.ts` for gates.

Phase 10B's `claude-read-only-v1` owned execution strips **all** MCP servers at
the ACP boundary and excludes native MCP tools. Thus restricted executions cannot
call `group_send`, external coordinators or arbitrary MCP tools, even if the
ordinary launch wiring supplies them. This is an immutable execution ceiling,
not a permission-mode choice. Policy-aware prompts use a separate trusted ingress
callback; an old plugin/core cannot silently drop the requested ceiling. See
[Enforced execution effects](conversation-runtime.md#enforced-execution-effects-phase-10b).

PR9 Group executions use a private `group-execution:` capability as both launch identities. It derives from a live MemberTurn/sourceTurn/claim, passes only through the core-private Conversation execution port, and is revoked at execution settlement/shutdown. Identity changes rotate the existing worker/queue owner; a retired capability cannot authorize the next turn. A fanout launch exposes only `group_say({text})`, `group_send({to, task, expectedOutput?})` and read-only `group_read_result({assignmentId?, offset?, limit?})`; a roundtable launch mints `group-execution:roundtable:<uuid>` and exposes only `group_say({text})`, with both group tools unavailable. `group_say` publishes one short progress remark as an ordinary public Group message: at most 3 per member turn and at most 1,000 characters each, both counted by the runtime, with a replayed tool invocation returning its first message instead of a second row. It never wakes or dispatches another member and never changes speaking order; when the final reply is that same remark, the runtime does not post the sentence twice. Result reads list settled assignments or page through exact public evidence in the current Run; they recheck the live execution, claim owner/generation and session binding. A member turn that dispatched assignments must end its turn immediately instead of waiting, sleeping or polling; the runtime then wakes that member exactly once, in one followup turn, after every assignment dispatched from that turn has settled. While the current turn still owns unsettled handoffs, `group_read_result` refuses every page with `kind: "pending-handoffs"`, `mustEndTurn: true` and the pending assignment ids. Roundtable turns cannot call `group_send` (`handoff_from_roundtable_refused`) or `group_read_result` (`group_read_result_from_roundtable_refused`); hiding the tools is the first gate, the server refusal is the second. The host supplies handoff invocation identity separately. It does not register an external orchestration coordinator. The daemon rechecks runtime ownership, membership, Run state, quarantine and budget before commit. Local IPC has no presenting-process authentication: possession of another live capability is sufficient within its existing same-OS-user trust boundary. See [Conversation runtime](conversation-runtime.md#public-structured-handoff-pr9) for the scope of the sender guarantee and idempotency/recovery.

## Direct launch isolation (Issue #399)

Direct Conversation dispatch mints an ephemeral direct-execution identity only after the durable execution-start CAS. It is bound through private Chat metadata provenance to the owned logical session and immutable transport/MCP launch. The tool registry exposes only agent_list/agent_send for this Direct identity; server authorization validates the live Run/member/dispatch generation, owner, lease, Topic generation, and lifecycle again on each call and immediately before receiver admission. Completion preparation uses a non-sending discovery identity and cannot become an active sender. Group and restricted launch tool ceilings remain unchanged.

## Direct Bot orchestration tools (Milestones 1–2)

Bot-owned Direct executions additionally receive four orchestration tools (six total with `agent_list` / `agent_send` above), bound through the bot-orchestration transport (`bot-orchestration-service.ts`, `xacpx-mcp-transport.ts`, `orchestration-ipc.ts`) and failing closed when the runtime does not bind them. All sends are fire-and-forget (`completion: "none"`); optional `task` payloads dispatch with no completion callback:

- `xacpx_environment` — workspaces + agents available to this execution. No arguments. Call before creating anything.
- `session_create` (`agent`, `workspace`, optional `name`/`alias`/`model`/`task`) — creates an ordinary manageable `LogicalSession`, visible in the Sessions list. Returns the display alias plus the internal handle (the Web opens the pane via the handle). An optional `task` starts work in the new session fire-and-forget.
- `session_rename` (`alias`, `displayName`) — renames a session's display label. Hidden `brt_*` sessions cannot be renamed.
- `bot_create` (`name`, `agent`, optional `workspace`/`role`/`instructions`/`model`/`effort`/`task`) — spawns a child Bot owned by this execution (`createdByBotId` chain). An optional `task` notifies the child fire-and-forget.

Server-side safety caps, enforced before any creation RPC runs:

- `MAX_SESSIONS_CREATED_PER_EXECUTION = 8` — sessions per execution.
- `MAX_BOTS_CREATED_PER_EXECUTION = 4` — child Bots per execution.
- `MAX_BOT_SPAWN_DEPTH = 3` — depth of the `createdByBotId` chain.
- `MAX_TOTAL_BOTS = 64` — Bots per instance.

Quota violations fail the tool call with an error; nothing is partially created. Bot-created sessions and child Bots are ordinary manageable rows (sessions appear in the Sessions list, bots in the agent directory); product sessions with hidden owners (`brt_*`, `bot-direct`, `group-member`, `group-controller`) stay out of ordinary lists. See [Conversation runtime](conversation-runtime.md#bot↔session-bidirectional-messaging-and-direct-bot-orchestration-milestones-12) for the delivery envelope, the dispatched-session system notice, and private sub-Bot peer topics.
