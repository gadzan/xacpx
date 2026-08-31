# Runtime MCP

`src/bridge/engine/runtime/runtime-mcp.ts` — xacpx-owned MCP launch identity for the acpx Runtime.

- **Identity:** `mcpCoordinatorSession` + `mcpSourceHandle` are **immutable launch identity** (`RuntimeWorkerEnsureParams`, `sameEnsureParams`, `buildEnsureParams`). Absence (`none→coordinator`, `coordinator→none`, `A→B`, `source A→B`) all count as identity change.
- **Server spec:** `buildRuntimeMcpServers` reuses `buildXacpxMcpServerSpec` + `resolveDefaultXacpxCommand` (single `xacpx` stdio server, `mcp-stdio --coordinator-session … [--source-handle …]`), returned as `McpServer[]` for `AcpRuntimeOptions.mcpServers`. Shared with CLI path — no duplicated MCP implementation.
- **Stale handling:** `RuntimeEngine` fences launch identity via `lastMcpIdentity`/`staleAfterTurn` single seam (`checkMcpStale`): idle → `shutdown`+`release`+respawn with new `mcpServers`; active/busy/hasInFlight → `RUNTIME_MCP_STALE` + `staleAfterTurn` and rotate after the in-flight turn settles (never kills mid-turn). `withWorker` `finally` retires stale after `activeTurns` clears.
- **Propagation:** `BridgeServer` forwards `mcpCoordinatorSession`/`mcpSourceHandle` on every `EngineSessionInput` method (`prompt`, `injectMessage`, `ensureSession`, `setMode`, `setModel`, `setSessionEffort`, `cancel`, `removeSession`, `deleteSession`, `freeWarmProcess`, etc.) so coordinator prompts followed by management ops are not mis-identified as `coordinator→none`.
- **Convergence:** MCP descendants are children of the Runtime worker, so `worker-eof`/`terminateProcessTree` convergence (handle-bound, `creationDate` fenced) reaps them together on TTL/`freeWarm`/`shutdown`/host-crash. No bare-PID kill.

See `src/bridge/engine/runtime/runtime-worker-main.ts` and `tests/unit/bridge/engine/runtime/runtime-engine-mcp.test.ts` for gates.
