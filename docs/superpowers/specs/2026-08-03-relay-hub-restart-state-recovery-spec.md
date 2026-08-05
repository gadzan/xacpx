# Relay Hub Restart: Running-Turn & History Recovery via Connector State Sync

## Problem Statement

When the relay hub (`packages/relay`) restarts, state that lives only in hub memory dies with the process (`packages/relay/src/server.ts:104-136`):

- `turnBuffers` — every in-flight turn's accumulated text / tool steps / reasoning
- `sessionUsage` — the per-session context-usage meter
- `sessionCommands` — the per-session "/" slash-command hints

The concrete losses:

1. **Permanent history gap.** A turn running across the restart never lands in the `messages` table: its `turn-output` chunks are dropped after restart (no buffer exists, `server.ts:235-238`), and `turn-finished` early-returns without persisting (`server.ts:255`). The user's prompt is in history (persisted at `turn-started` / enqueue), the reply is gone forever — a "question with no answer" hole.
2. **Invisible running turns.** On web reconnect, the hub's `state-snapshot` is empty, and `chat.applyStateSnapshot` (`packages/relay-web/src/stores/chat.ts:487-516`) authoritatively deletes locally-live turns, so running turns vanish from every browser.
3. **Stale meters and hints.** `sessionUsage` / `agent-commands` only re-appear when the agents happen to re-emit; commands in particular are advertised once per session lifetime, so they may never come back.
4. **Events during the outage are dropped at the source.** `RelayClient.sendEvent` has no offline queue (`packages/channel-relay/src/relay-client.ts:68-75`), and the re-handshake (`instance.auth`) carries no state. `RelayClient`'s `onReady` hook exists but `RelayChannel` never wires it (`channel.ts:77-86`).

What is NOT broken: finished history lives in SQLite, sessions live in the daemon's `state.json` and are re-fetched via control RPC; the `instance-status online` event and `reloadSnapshot()` already re-pull the session list after reconnect.

## Solution

Two-layer fix, both protocol-additive (old connector × new hub, and new connector × old hub, degrade to today's behavior):

1. **`turn-finished` carries the outcome + a persist fallback.** The daemon attaches the final reply text to `turn-finished`. When the hub receives a `turn-finished` with no buffer, it no longer silently returns: it persists what it can. This alone closes the "no answer in history" hole as a small patch.
2. **Connector-side state mirror + `instance.state-sync` reconciliation.** channel-relay keeps a bounded in-memory mirror of everything it forwards to the hub (per-turn accumulator, last-known usage/commands, plus a bounded queue of turns that finished while offline). On every (re)connect, right after auth, the connector pushes one `instance.state-sync` message with the full snapshot; the hub replaces that instance's in-memory state with it. Running turns re-appear in `state-snapshot` with their original `startedAt`, post-restart output appends to a live buffer again, and the eventual `turn-finished` persists the FULL reply — including output produced while the hub was down.

No sequence-numbered event log is required for the common case — the connector's mirror subsumes it, because events "lost" in transit to a down hub are still present in the connector's local mirror and ride along in the sync snapshot. Delivery is confirmed by a **lightweight per-recovery-id ack** (`instance.recovery.ack`, sent by the hub only after the rows commit), not by the `ws` flush callback: a flush proves the frame left the connector's process, not that the hub persisted it, so confirming on flush would drop the FIFO entries if the hub died between send and SQLite commit — a permanent history hole.

### Explicitly rejected alternatives

- **Replay plain `turn-started` on reconnect.** Re-persists prompts (`server.ts:229-232` appends an `in` row; the queueItemId path falls through to `appendQueuedFallback`), and resets `startedAt` to reconnect time (`server.ts:219`). Recovery must not reuse business events.
- **Hub-side SQLite persistence of turn state.** Write amplification, plus it still can't know what the connector did while offline — meaningless without a reconciliation message anyway.
- **Session registry on the hub.** Sessions stay proxied live from the daemon; the sync carries runtime turn/usage/commands state only.

## User Stories

1. As a user whose turn was running across a hub restart, I want the finished reply in my transcript, so the history has no phantom unanswered prompt.
2. As a user reloading the dashboard after a hub restart, I want turns that are still running to still show as running, so I know work is in progress.
3. As a user, I want the usage meter and "/" hints to survive a hub restart, so the UI doesn't silently degrade.
4. As an operator, I want the connector's recovery cache bounded, so a daemon left running against a long-dead hub never leaks memory.
5. As a maintainer, I want recovery traffic on a dedicated message type with defensive caps, so a hostile/buggy connector can't persist garbage or exhaust hub memory.

## Implementation Decisions

### Protocol (`packages/relay-protocol`)

- `dtos.ts`: extend `ControlEventDto`'s `turn-finished` variant with optional `text?: string` — the final reply text the daemon already has in hand (`session-turn-runner.ts` reads `response.text`).
- `messages.ts`: add `MSG.instanceStateSync = "instance.state.sync"` and
  ```ts
  interface InstanceStateSyncPayload {
    turns: Array<{
      sessionAlias: string;
      prompt?: string;
      scheduled?: ScheduledOriginDto;
      queueItemId?: string;
      /** ms epoch captured by the connector at the ORIGINAL turn start. */
      startedAt: number;
      text: string;
      reasoning: string;
      steps: ToolStepDto[];
      /** true = connector capped the mirror; content after that point is lost. */
      truncated?: boolean;
    }>;
    usage: Array<{ sessionAlias: string; used: number; size: number; cost?: UsageCostDto; breakdown?: UsageBreakdownDto }>;
    commands: Array<{ sessionAlias: string; commands: AgentCommandDto[] }>;
    /** Turns that finished while the hub was unreachable; hub must persist them.
     *  `prompt` lets the hub backfill the `in` row for a turn that STARTED during
     *  the outage too, so its answer never shows as an orphan in history.
     *  `recoveryId` is the connector's stable id for the turn: the hub acks it
     *  back after committing (messages + receipt in one transaction). `truncated`
     *  marks a reply capped at STATE_SYNC_TEXT_CAP. */
    finishedOffline: Array<{ sessionAlias: string; ok: boolean; errorMessage?: string; cancelled?: boolean; text?: string; prompt?: string; recoveryId?: string; truncated?: boolean }>;
  }
  ```

### Daemon (`src/control/`)

- `control-event-bus.ts` + `session-turn-runner.ts`: the `turn-finished` emits gain `text` — success path passes `response.text`; failure paths omit it (`errorMessage` already covers). Existing consumers (WeChat channel etc.) tolerate additive fields by construction.

### Connector (`packages/channel-relay`)

- **New module `src/state-mirror.ts`** — subscribes to the same ControlEvent stream the forwarder uses (`subscribeControlEvents`), maintaining per-`sessionAlias`:
  - an active-turn accumulator mirroring hub semantics — append on `turn-output` / `tool-event` / `turn-thought`, created on `turn-started` (with its `startedAt` timestamped **locally at receipt**, so the sync preserves original start time);
  - last-known `turn-usage` / `agent-commands` (replace-latest);
  - on `turn-finished`: stamp the turn with its `recoveryId` (generated at `turn-started`), forward the live frame with that id, AND move `{…info, text-self, prompt, recoveryId, truncated}` onto a bounded `pendingFinished` FIFO. The entry stays until the hub acks its `recoveryId` — for a live finish the hub persists and acks almost immediately, so the FIFO clears quickly; if the frame never lands (offline / hub died mid-write), the entry rides the next sync and is deduped by the hub's receipt.
- **Caps** (mirror and hub share one source of truth):
  - `STATE_SYNC_TEXT_CAP = 256 * 1024` per turn — hub's own text accumulator is uncapped today; the mirror is deliberately stricter. Over cap: stop appending, set `truncated: true`.
  - tool steps: `MAX_TOOL_STEPS = 200`, reasoning: `REASONING_CAP = 16000`.
  - All three caps live in `packages/relay-protocol/src/limits.ts` and are imported by BOTH the mirror and the hub, so the two sides can never drift apart.
  - `finishedOffline`: FIFO max 32 entries; beyond that, evict oldest and log a warning — accepted loss, hub assumed-down is not the design precondition.
- **Send path**: `RelayChannel.start()` wires the existing `onReady` — `mirror.buildStateSync(liveAliases)` returns `{ snapshot, aliases }`: a PURE snapshot (dead aliases are filtered out of the payload but the mirror is untouched) plus the aliases that existed at build time. The destructive GC is a separate explicit call, `mirror.pruneStateMirror(liveAliases, aliasesAtBuild)`, run only after the frame's flush callback CONFIRMS it left the socket — and it compare-and-deletes ONLY aliases from `aliasesAtBuild`, so state that arrived AFTER the snapshot (new sessions/turns forwarded live while the frame was in flight) is never GC'd by this older callback. Separating build from prune means a failed/not-ready send (or a transiently stale session list) can never destroy mirror state a later sync could still use. **No confirm on the flush for the FIFO** (flush only proves the frame left the socket, not that the hub committed): entries are retired by `mirror.confirmFinished()` only when the hub's `instance.recovery.ack` names their `recoveryId`. An errored/not-ready send or a hub that died before the SQLite commit simply means the next reconnect re-sends the same snapshot; the hub's receipt dedup makes that idempotent. First connect sends whatever is present (usually empty) — harmless and keeps one code path.

### Hub (`packages/relay/src/server.ts`)

- **`turn-finished` fallback (closed independently of the sync work): when no buffer exists, if `event.text` is present (an empty string still counts as a reply) persist `messages.append(..., "out", event.text)`; a FAILED turn without `event.text` falls back to its `errorMessage` (an error row closes the hole for failures the same way text does for successes); only when both are absent do we keep not writing a row (never fabricate empty transcript entries) and log a warn. The BUFFERED path applies the same resolution: a restored running turn that fails with no streamed output persists `errorMessage` instead of leaving a prompt with no answer. This single change seals the history gap even for connectors too old to send sync.
- `instance.state.sync` handler (in the same instance-gateway dispatch as `instanceEvent`):
  - validate payload shape defensively (drop malformed, same posture as `validControlEvent`);
  - **replace** `turnBuffers` / `sessionUsage` / `sessionCommands` entries for this instance with the payload's content (rebuild buffer objects into the same `TurnAccumulator` shape so existing `turn-output` appends and `turn-finished` flush work unchanged); restore each turn's `startedAt` from the payload so the HUD shows true elapsed time;
  - for each `finishedOffline` entry, append the out row (`text`, or `errorMessage` for `ok:false` — a failed turn with empty/missing text must surface its error text, never an empty row), mirroring existing flush semantics; a finished entry and a running turn may share a `sessionAlias` legitimately (turn A finished while the queue started turn B on the same session) — they are distinguished by `recoveryId`, NOT by alias; only the truly contradictory same-`recoveryId` case is skipped. **Finished entries are reconciled BEFORE the running turns are restored** so their rows land at the correct transcript position. **Each entry's rows and its recovery receipt commit in ONE SQLite transaction**, so a crash can never leave "rows without a receipt" (double-persist on redelivery) or "receipt without rows" (permanent hole). A failed transaction calls `gateway.disconnect(instanceId)` — the connector only re-sends on reconnect, so a silent persistence failure would strand the entry in its FIFO until eviction. **Dedup is layered**, because the connector legitimately re-sends after an unconfirmed delivery and blind appends would duplicate rows:
    1. **SQLite receipt** (`recovery_receipts`: `instance_id + recovery_id` PK, written in the same transaction as the rows) — the primary guard for `recoveryId`-carrying entries; it survives ANOTHER hub restart, and a redelivery of an already-receipted id is **re-acked without re-appending**;
    2. an in-memory fingerprint set (`instanceId, alias, prompt, outText`, bounded FIFO at 128) for legacy entries WITHOUT a `recoveryId` — exact idempotence within one hub process;
    3. a SQLite recency fallback (`messages.listBySession(accountId, instanceId, alias, { limit: 5 })`) for legacy entries that cross ANOTHER restart (fingerprint set died with the process): with a `prompt`, the fallback matches the adjacent `in`(prompt) → `out`(reply) **pair** — so two different turns with identical reply text are both kept; only entries WITHOUT a prompt fall back to a bare direction+text match (documented residual, see Further Notes);
  - **prompt backfill (`backfillInboundPrompt`, shared by restored `turns` and `finishedOffline`)**: with a `queueItemId`, `promoteQueued()` (fallback `appendQueuedFallback()`) — a prompt enqueued while the hub was up has a persisted queued row (`queue_item_id` set), so it is PROMOTED to its execution position instead of being duplicated, and the stale queued marker is cleared (UI no longer shows a run prompt as queued). Without a `queueItemId`, append the plain `in` row only when it is not already the trailing row — a turn that started during the outage recovers as an in+out pair instead of an orphan answer. `finishedOffline` / `turns` carry `queueItemId` / `scheduled` for this reconciliation;
  - no broadcast of synthesized `turn-started` events: web learns everything through the existing `state-snapshot` on its own reconnect/subscribe. (Note: any web client that somehow stayed connected through the hub restart is impossible — the restart killed hub-side sockets.)
  - **After the rows commit**, the hub sends `instance.recovery.ack` (payload `{ recoveryIds }`) down the connector socket: one frame per sync covering all committed ids, one per live `turn-finished`. Sending AFTER the transaction means the connector never drops a FIFO entry whose rows did not actually land.
- **`recovery_receipts` table + shared-expiry TTL**: new `RecoveryReceiptStore` (`packages/relay/src/stores/recovery-receipts.ts`). The maintenance loop prunes receipts past `RECOVERY_RECEIPT_TTL_MS` = the shared retention horizon `RECOVERY_RETENTION_MS` (7 days, relay-protocol/limits.ts) + a 24h clock-skew grace. Safety requires BOTH sides to expire on the same horizon: the connector's `expirePendingFinished()` drops `pendingFinished` entries older than `RECOVERY_RETENTION_MS` (before every sync build and on every push), so an entry can never be re-delivered after its receipt is pruned — the naive-TTL duplicate scenario (hub persisted, ack lost, connector idle past the TTL, reconnect re-appends) is closed by the connector dropping the entry first. The grace absorbs delivery delay + wall-clock drift so a redelivery made just under the connector's expiry always still finds its receipt. Table stays bounded: one row per turn, pruned at retention + grace.
- Wrapper confirms: restored turns flow through `stateSnapshot()` / `/api/active-turns` with zero viewer-side changes.

### Ordering guarantees

- Connector sends `instance.state.sync` immediately at `onReady`, i.e. before any subsequent control events can be forwarded. A `turn-output` arriving at the hub in the microscopic pre-sync window is dropped by the existing "no buffer" rule and also preserved in the mirror that arrives with the sync — self-healing.
- Turn keyed by `(instanceId, sessionAlias)` exactly as today — one active turn per session, unchanged.

## Testing Decisions

- **state-mirror unit tests** (new, `packages/channel-relay`): accumulation across event kinds; text cap → `truncated`; tool-step and reasoning caps; offline-vs-online `turn-finished` routing into `finishedOffline`; FIFO eviction at 32 with oldest dropped; sync-payload build prunes dead aliases.
- **Hub unit/integration tests** (`packages/relay`): `turn-finished` without buffer + `text` → row persisted (empty-string text persists too); without `text` → no row + warn. `instance.state.sync` → turns/usage/commands visible in `stateSnapshot()` and `/api/active-turns` with original `startedAt`; malformed payload dropped; re-sent sync replaces the in-memory maps AND is idempotent for history (finishedOffline rows and backfilled prompts are deduped by the fingerprint set + prompt/reply pair matching — replace semantics only covers the in-memory state, not `messages.append`); two DIFFERENT turns with identical reply text are both kept; turn started+finished entirely offline recovers as an in+out pair; prompt persisted pre-outage is not duplicated; restored turn then receiving live `turn-output` + `turn-finished` persists one complete reply.
- **Connector tests**: `RelayChannel` wires `onReady`; sync emitted after auth; mirror cleared for turns finished while online.
- **Simulated restart**: drive hub runtime, run a turn, tear down the gateway/upstream, restart runtime in-process, verify history row + snapshot recovery end-to-end.
- Gates: `npm test` (typecheck + unit), per-package vitest suites, `npx tsc --noEmit` at root and each touched package.

## Out of Scope

- Full sequence-numbered durable event log / ack replay. The per-turn `recoveryId` ack (`instance.recovery.ack`) covers exactly the "did the finished-offline rows commit?" question; it is not a general event-log ordering protocol (reconsider only for daemon-crash scenarios).
- Web UI "recovered / may be incomplete" badges; the restored rows are plain transcript rows by design.
- Hub-side persistence of any in-flight turn state (SQLite writes stay at message boundaries only).
- Session list reconciliation — already handled by existing reconnect paths.
- Pruning `turn-started`'s prompt double-persist semantics — irrelevant now that no replay reuses it.

## Further Notes

- Backward compatibility matrix: old connector + new hub → history-gap fallback works whenever the daemon is new enough to send `text`, otherwise today's silent-drop behavior; new connector + old hub → the old hub must ignore the unknown message type (verified: the instance gateway forwards every `kind:"event"` envelope to `onEvent` regardless of `type`, and the hub's dispatch silently ignores unlisted types — no log-and-ignore shim needed). A pre-ack hub sends no `instance.recovery.ack`, so the new connector's FIFO entries linger until the 32-entry cap evicts them (bounded, no leak); the old hub's own pair-match dedup keeps re-sent finishedOffline entries from duplicating rows, so history stays clean.
- The mirror's `startedAt` is stamped when the connector first sees `turn-started`; across daemon restarts this is moot — a restarted daemon holds no running turns anyway (that class of restart is out of scope).
- **R3 (accepted loss)**: `finishedOffline` recovery persists flat text only — a turn that finished during the outage lands as a plain `out` row; its tool steps / reasoning / `parts` transcript are lost. Structured content is restored only for turns still RUNNING across the restart (via `turns`).
- **Unbounded array counts**: the sync payload is shape-validated per entry (with per-entry content caps: 256 KiB text, 16000 reasoning, 200 steps), but the number of entries per array (`turns` / `usage` / `commands` / `finishedOffline`) is not count-limited — payload size is bounded only by the ws frame. Count caps are a follow-up if connector misbehavior becomes a concern.
- **Dedup residual limitations**: for `recoveryId`-carrying entries (all new connectors) the SQLite receipt is exact — no content matching, no coincidences. The residual holes below apply only to LEGACY entries without a `recoveryId` (old connectors / the in-process fingerprint + recency fallback): (a) a prompt-less entry falls back to a bare text match, so a genuinely different prompt-less turn producing identical text within the last 5 rows after a double-restart could be skipped; (b) two turns with identical prompt AND identical reply within the recency window after a double-restart are indistinguishable to content-based dedup. Both require pathological content coincidences across a specific restart sequence with a pre-receipt connector; the `recoveryId` path (new connectors) eliminates them entirely.
- **Truncation marking**: a reply capped at `STATE_SYNC_TEXT_CAP` — whether recovered via `finishedOffline` or still RUNNING (the `turn.truncated` flag rides the sync into the hub's restored TurnAccumulator) — persists with `structured.truncated = true` so it is never mistaken for a complete reply, and `MessageList.vue` renders a "reply truncated" badge for such rows (a small "may be incomplete" indicator).
