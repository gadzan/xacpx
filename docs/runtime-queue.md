# Runtime Durable Queue

`src/bridge/engine/runtime/runtime-queue.ts` — xacpx-owned durable FIFO for Runtime-bound sessions.

- **Location:** `~/.xacpx/runtime/runtime-queue/<logicalSessionId>.json` (via `coreHomeDir(homedir())/runtime`), not `~/.acpx`.
- **Schema:** `xacpx.runtime-queue.v1` with `logicalSessionId` and `items: RuntimePendingMessage[]` (`messageId`, `text`, `acceptedAt`, `mode: queue|auto`).
- **Atomicity:** `write tmp → rename → readback validate`; corrupt/unreadable → `RUNTIME_INIT_FAILED` fail-closed, never empty.
- **Idempotency:** same `messageId`+same `text` → idempotent queued receipt; same `messageId`+different `text` → `RUNTIME_QUEUE_CONFLICT` fail-closed.
- **Limit:** `RUNTIME_QUEUE_MAX_DEPTH=20` → `RUNTIME_QUEUE_OVERFLOW`.
- **Ack:** only after durable persist; `store.enqueue` holds per-key `withLock` that also gates `deleting`/`coolPending` so delete and enqueue share an atomic boundary.
- **Drain:** `RuntimeEngine.drainLoop` is single-flight per `logicalSessionId` (`draining` map), reuses `executeRuntimeTurn` (same lifecycle as direct prompt), dequeues only on terminal `completed`/`failed`/`cancelled`/`permission_denied` (crash keeps head for at-least-once replay and re-kicks after backoff, respects `shuttingDown`). `primeQueuesFromCatalog` enumerates journals for authoritative sessions but remains dormant in `bridge-main` until activation blockers per plan §0 (see `src/bridge/bridge-main.ts` comment).

See `src/bridge/engine/runtime-engine.ts` for TTL/delete/cancel integration and `tests/unit/bridge/engine/runtime/runtime-queue.test.ts` for gates.
