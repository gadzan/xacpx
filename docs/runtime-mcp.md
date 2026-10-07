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

PR9 Group executions use a private `group-execution:` capability as both launch identities. It derives from a live MemberTurn/sourceTurn/claim, passes only through the core-private Conversation execution port, and is revoked at execution settlement/shutdown. Identity changes rotate the existing worker/queue owner; a retired capability cannot authorize the next turn. This launch exposes only `group_send({to, task, expectedOutput?})`; the host supplies invocation identity separately. It does not register an external orchestration coordinator. The daemon rechecks runtime ownership, membership, Run state, quarantine and budget before commit. Local IPC has no presenting-process authentication: possession of another live capability is sufficient within its existing same-OS-user trust boundary. See [Conversation runtime](conversation-runtime.md#public-structured-handoff-pr9) for the scope of the sender guarantee and idempotency/recovery.
