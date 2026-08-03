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

No sequence/ack event log (layer 3) is required for the common case — the connector's mirror subsumes it, because events "lost" in transit to a down hub are still present in the connector's local mirror and ride along in the sync snapshot.

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
     *  the outage too, so its answer never shows as an orphan in history. */
    finishedOffline: Array<{ sessionAlias: string; ok: boolean; errorMessage?: string; cancelled?: boolean; text?: string; prompt?: string }>;
  }
  ```

### Daemon (`src/control/`)

- `control-event-bus.ts` + `session-turn-runner.ts`: the `turn-finished` emits gain `text` — success path passes `response.text`; failure paths omit it (`errorMessage` already covers). Existing consumers (WeChat channel etc.) tolerate additive fields by construction.

### Connector (`packages/channel-relay`)

- **New module `src/state-mirror.ts`** — subscribes to the same ControlEvent stream the forwarder uses (`subscribeControlEvents`), maintaining per-`sessionAlias`:
  - an active-turn accumulator mirroring hub semantics — append on `turn-output` / `tool-event` / `turn-thought`, created on `turn-started` (with its `startedAt` timestamped **locally at receipt**, so the sync preserves original start time);
  - last-known `turn-usage` / `agent-commands` (replace-latest);
  - on `turn-finished`: if the hub link is currently ready, drop the accumulator (the hub got the live stream and will persist normally); if not, move `{…info, text-self, prompt}` onto a bounded `finishedOffline` FIFO (`prompt` retained so the hub can backfill the `in` row for turns that started during the outage).
- **Caps** (mirror and exceed hub discipline):
  - `MIRROR_TEXT_CAP = 256 * 1024` per turn — hub's own text accumulator is uncapped today; the mirror is deliberately stricter. Over cap: stop appending, set `truncated: true`.
  - tool steps: `MAX_TOOL_STEPS = 200`, reasoning: `REASONING_CAP = 16000` (same values as `server.ts`).
  - `finishedOffline`: FIFO max 32 entries; beyond that, evict oldest and log a warning — accepted loss, hub assumed-down is not the design precondition.
- **Send path**: `RelayChannel.start()` finally wires the existing `onReady` — builds the sync payload, prunes dead aliases against `control.listSessions()` (sessions removed while offline don't ship ghost state), sends `instance.state.sync`, clears `finishedOffline` only when the `ws` flush callback CONFIRMS the frame left the socket (the completion callback fires on flush or error). An errored/not-ready send keeps the FIFO; the next reconnect re-sends, and the hub's dedup below covers the delivered-but-unconfirmed race. First connect sends whatever is present (usually empty) — harmless and keeps one code path.

### Hub (`packages/relay/src/server.ts`)

- `turn-finished` fallback (closed independently of the sync work): when no buffer exists, if `event.text` is present persist `messages.append(..., "out", event.text)`; otherwise keep not writing a row (never fabricate empty transcript entries) but log a warn. This single change seals the history gap even for connectors too old to send sync.
- `instance.state.sync` handler (in the same instance-gateway dispatch as `instanceEvent`):
  - validate payload shape defensively (drop malformed, same posture as `validControlEvent`);
  - **replace** `turnBuffers` / `sessionUsage` / `sessionCommands` entries for this instance with the payload's content (rebuild buffer objects into the same `TurnAccumulator` shape so existing `turn-output` appends and `turn-finished` flush work unchanged); restore each turn's `startedAt` from the payload so the HUD shows true elapsed time;
  - for each `finishedOffline` entry, append the out row (`text`, or `errorMessage` for `ok:false`), mirroring existing flush semantics; **skip** when a turn with the same alias is already present in the sync's `turns` (shouldn't happen, defends against weird ordering), and **dedupe** re-sent syncs via a recent-row check (`messages.listBySession(accountId, instanceId, alias, { limit: 5 })`, matched on exact `in`-row prompt / `out`-row final-or-error text) — the connector legitimately re-sends after an unconfirmed flush, so blind appends would duplicate rows. Recency (last 5) is precise enough: a recovered prompt/answer is always among the newest rows of its session at sync time;
  - **prompt backfill**: for both restored `turns` and `finishedOffline` entries carrying `prompt`, append the `in` row (before any out row) unless the recency check already finds it — a turn that started during the outage recovers as an in+out pair instead of an orphan answer. No queueItemId promote interplay: dedupe means the row is simply skipped when it already exists;
  - no broadcast of synthesized `turn-started` events: web learns everything through the existing `state-snapshot` on its own reconnect/subscribe. (Note: any web client that somehow stayed connected through the hub restart is impossible — the restart killed hub-side sockets.)
- Wrapper confirms: restored turns flow through `stateSnapshot()` / `/api/active-turns` with zero viewer-side changes.

### Ordering guarantees

- Connector sends `instance.state.sync` immediately at `onReady`, i.e. before any subsequent control events can be forwarded. A `turn-output` arriving at the hub in the microscopic pre-sync window is dropped by the existing "no buffer" rule and also preserved in the mirror that arrives with the sync — self-healing.
- Turn keyed by `(instanceId, sessionAlias)` exactly as today — one active turn per session, unchanged.

## Testing Decisions

- **state-mirror unit tests** (new, `packages/channel-relay`): accumulation across event kinds; text cap → `truncated`; tool-step and reasoning caps; offline-vs-online `turn-finished` routing into `finishedOffline`; FIFO eviction at 32 with oldest dropped; sync-payload build prunes dead aliases.
- **Hub unit/integration tests** (`packages/relay`): `turn-finished` without buffer + `text` → row persisted; without `text` → no row + warn. `instance.state.sync` → turns/usage/commands visible in `stateSnapshot()` and `/api/active-turns` with original `startedAt`; malformed payload dropped; re-sent sync replaces the in-memory maps AND is idempotent for history (finishedOffline rows and backfilled prompts are deduped by recent-row matching — replace semantics only covers the in-memory state, not `messages.append`); turn started+finished entirely offline recovers as an in+out pair; prompt persisted pre-outage is not duplicated; restored turn then receiving live `turn-output` + `turn-finished` persists one complete reply.
- **Connector tests**: `RelayChannel` wires `onReady`; sync emitted after auth; mirror cleared for turns finished while online.
- **Simulated restart**: drive hub runtime, run a turn, tear down the gateway/upstream, restart runtime in-process, verify history row + snapshot recovery end-to-end.
- Gates: `npm test` (typecheck + unit), per-package vitest suites, `npx tsc --noEmit` at root and each touched package.

## Out of Scope

- Sequence-numbered durable event log / ack replay (the connector mirror makes this unnecessary for hub restarts — reconsider only for daemon-crash scenarios).
- Web UI "recovered / may be incomplete" badges; the restored rows are plain transcript rows by design.
- Hub-side persistence of any in-flight turn state (SQLite writes stay at message boundaries only).
- Session list reconciliation — already handled by existing reconnect paths.
- Pruning `turn-started`'s prompt double-persist semantics — irrelevant now that no replay reuses it.

## Further Notes

- Backward compatibility matrix: old connector + new hub → history-gap fallback works whenever the daemon is new enough to send `text`, otherwise today's silent-drop behavior; new connector + old hub → the old hub must ignore the unknown message type (verified: the instance gateway forwards every `kind:"event"` envelope to `onEvent` regardless of `type`, and the hub's dispatch silently ignores unlisted types — no log-and-ignore shim needed).
- The mirror's `startedAt` is stamped when the connector first sees `turn-started`; across daemon restarts this is moot — a restarted daemon holds no running turns anyway (that class of restart is out of scope).
- **R3 (accepted loss)**: `finishedOffline` recovery persists flat text only — a turn that finished during the outage lands as a plain `out` row; its tool steps / reasoning / `parts` transcript are lost. Structured content is restored only for turns still RUNNING across the restart (via `turns`).
- **Unbounded array counts**: the sync payload is shape-validated per entry (with per-entry content caps: 256 KiB text, 16000 reasoning, 200 steps), but the number of entries per array (`turns` / `usage` / `commands` / `finishedOffline`) is not count-limited — payload size is bounded only by the ws frame. Count caps are a follow-up if connector misbehavior becomes a concern.
- **Recency-window limitation**: the hub-side dedup/backfill check matches exact text against the last 5 rows of a session. A re-sent sync delayed long enough for 5+ new rows to interleave could re-append a duplicate; the mirror's FIFO (max 32) and immediate `onReady` resend make this window practically unreachable.
