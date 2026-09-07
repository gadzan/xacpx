# Runtime MCP

`src/bridge/engine/runtime/runtime-mcp.ts` — xacpx-owned MCP launch identity for the acpx Runtime.

- **Identity:** `mcpCoordinatorSession` + `mcpSourceHandle` are **immutable launch identity** (`RuntimeWorkerEnsureParams`, `sameEnsureParams`, `buildEnsureParams`). Absence (`none→coordinator`, `coordinator→none`, `A→B`, `source A→B`) all count as identity change.
- **Server spec:** `buildRuntimeMcpServers` reuses `buildXacpxMcpServerSpec` + `resolveDefaultXacpxCommand` (single `xacpx` stdio server, `mcp-stdio --coordinator-session … [--source-handle …]`), returned as `McpServer[]` for `AcpRuntimeOptions.mcpServers`. Shared with CLI path — no duplicated MCP implementation.
- **Stale handling:** `RuntimeEngine` fences launch identity via `lastMcpIdentity`/`staleAfterTurn` converged helpers (`isMcpStale`, `isStaleActiveForDrain=busy|hasInFlight`, `isStaleActiveForInjectOrCheck=activeTurns|draining|busy|hasInFlight`, `checkMcpStaleAndRotate` for `prompt`/`withWorker`, `drainLoop` head check, `injectMessage` check — fail-closed `shutdown`+`release` with `unref` timer): idle → `shutdown`+`release`+respawn with new `mcpServers`; active/busy/hasInFlight → `staleAfterTurn` + bounded `kickDrain` re-kick, retired in both `prompt` and `withWorker` `finally` after `activeTurns` clears (covers `setMode`/`setModel`/other business ops), never kills mid-turn. Legacy queue heads without `mcpIdentityKnown` fail closed (see `runtime-queue.md`).
- **Convergence:** MCP descendants are children of the Runtime worker, so `worker-eof`/`terminateProcessTree` convergence (handle-bound, `creationDate` fenced) reaps them together on TTL/`freeWarm`/`shutdown`/host-crash. No bare-PID kill.

See `src/bridge/engine/runtime/runtime-worker-main.ts` and `tests/unit/bridge/engine/runtime/runtime-engine-mcp.test.ts` for gates.
