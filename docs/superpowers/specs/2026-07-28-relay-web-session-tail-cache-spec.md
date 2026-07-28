# Relay Web: localStorage Session Tail Cache for Instant First Screen

## Problem Statement

Switching sessions in Relay Web always starts from a blank transcript: `chat.select()` clears `messages`, then `loadHistory()` fetches `GET /api/instances/:id/sessions/:alias/messages?limit=100` and the user watches a 5-row skeleton until the network round-trip completes. The progressive tail-first mount from #201 made *rendering* long histories cheap, but the *waiting* is now dominated by fetch latency — every switch, every page reload, even for a session viewed seconds ago, because the store keeps no per-session message state (`messages` is a single flat ref for the selected session only).

The first screen only needs the transcript tail (MessageList mounts the last `INITIAL_ROWS = 30` rows first). That tail is small, immutable (persisted rows with stable monotonic `id`s are never edited), and already survives wholesale replacement without flicker thanks to stable `p${id}` keys — ideal conditions for stale-while-revalidate.

localStorage is long-lived but sessions are not: sessions get archived and removed (sometimes from other clients while the web is closed), and accounts can change on a shared browser. A cache without a deliberate eviction story becomes a garbage pile that can show ghost data for dead sessions.

## Solution

A client-only stale-while-revalidate tail cache. On session switch, synchronously seed `messages` from a localStorage entry holding the last ≤30 persisted rows of that session, rendering the first screen instantly (no skeleton). The existing `loadHistory()` runs unchanged and replaces the transcript wholesale when the authoritative page arrives; stable row ids make the replace an in-place patch. Cache entries are written back after every successful authoritative load and (debounced) after each finished turn.

Validity is enforced by construction (key = schema version + username + instanceId + sessionAlias) and by a three-layer eviction scheme: event-driven purge (archive / remove / logout), reconciliation against authoritative session lists as they arrive, and budget/TTL fallbacks (global LRU byte budget + max age) for anything events can't reach — e.g. sessions deleted from WeChat while the dashboard was closed.

No server or protocol changes; this is entirely `packages/relay-web`.

## User Stories

1. As a user switching between sessions, I want the previously seen transcript tail to appear instantly, so that switching feels immediate instead of showing a skeleton.
2. As a user reloading the dashboard, I want my selected session's tail to render before the network responds, so that cold starts feel warm.
3. As a user, I want the transcript to converge to the latest server rows right after the cached tail appears, so that I never act on stale history for long.
4. As a user who archives or deletes a session, I want its cache purged, so that ghost transcripts of dead sessions never reappear.
5. As a user on a shared machine, I want logout to clear all cached transcripts, so that the next login cannot read my history from localStorage.
6. As a user with many sessions over weeks, I want the cache to stay within a fixed byte budget and expire idle entries, so that localStorage never fills up or overflows quota.
7. As a maintainer, I want the cache module isolated behind a small interface, so that the chat store changes stay minimal and testable.

## Implementation Decisions

- **New module `packages/relay-web/src/lib/session-tail-cache.ts`** exposing `read(user, instanceId, alias)`, `write(user, instanceId, alias, rows)`, `drop(user, instanceId, alias)`, `dropAll()`, `reconcile(user, instanceId, aliveAliases)`. All storage access wrapped in try/catch per repo convention (storage may be blocked).
- **Keys**: per-entry `xacpx.chat.tail.v1.<username>.<instanceId>.<alias>` plus one index key `xacpx.chat.tail-index.v1` recording `{ key, lastAccess, bytes }` for LRU/TTL bookkeeping — per-entry keys keep reads/writes proportional to one session, never the whole cache. `username` (the only client-side identity; auth is a server cookie) partitions accounts by construction. Schema changes bump the `.v1` suffix; old keys are swept lazily by prefix.
- **Entry contents**: the last ≤30 rows (`INITIAL_ROWS`) with `id !== undefined` (optimistic rows excluded), stripped to pure `MessageRecordDto` fields (no client-only `failed`/`status`). `structured` is kept intact — dropping it would flash text-only rows and then jump when tool cards arrive. If an entry exceeds the per-entry budget (256 KB serialized), trim oldest rows instead of stripping fields; if a single row exceeds it, skip caching that session.
- **Budgets**: global 4 MB across entries; evict least-recently-accessed entries beyond budget on write. On `QuotaExceededError`, evict LRU and retry once, then give up silently (cache is an optimization, never an error source).
- **Seeding (`chat.select()`)**: after the existing reset, synchronously `read()`; on hit, set `messages` from cached rows via the existing `rawStructured` (markRaw) path. `messages.length > 0` already suppresses the skeleton. No dimming/"cached" badge — convergence is near-immediate and in-place.
- **Convergence**: `loadHistory()` is unchanged — full replace on arrival, existing staleness guards (`historyRequestSequence`, `transcriptRevision`) still apply. One addition: a cache-seeded transcript grows from ≤30 to up-to-100 rows on replace without a `0 → >30` transition, so the #201 progressive-mount arming must also trigger on that replace (mount the new older rows tail-first) to avoid paying a 70-component synchronous mount.
- **Write-back**: after each successful `loadHistory()` (tail slice of authoritative rows) and after `flushTurn` on `turn-finished`, debounced via the existing `lib/debounce-flush.ts` so bursty turns don't hammer `JSON.stringify`.
- **Event-driven purge**: `instances.archiveSession` / `removeSession` call `drop()`; `auth.logout()` calls `dropAll()` (today logout clears nothing in storage — this is the first cleanup hook).
- **Reconciliation**: whenever `loadSessions(instanceId)` lands (sessions load lazily per instance, incl. on `sessions-changed` events), call `reconcile()` with that instance's live unarchived aliases and drop the rest. This covers archive/remove performed from other clients while the web was closed, per instance, as truth arrives.
- **Fallbacks**: TTL 7 days since `lastAccess` (checked lazily on read/write), so entries for instances the user never expands again still die.
- **`loadHistory()` failure**: keep showing the cached tail (better than blank) — the existing error toast already signals the failure; retry paths are unchanged.

## Testing Decisions

- Cache module unit tests (Vitest): read/write round-trip, per-entry trim, LRU eviction under the global budget, TTL expiry, quota-exceeded retry-then-give-up, `reconcile` dropping dead/archived aliases, version-prefix sweep, blocked-storage no-throw.
- Chat store tests: `select()` seeds from cache and suppresses the skeleton; authoritative replace converges and re-arms progressive mount; optimistic rows never cached; write-back happens after `loadHistory` and `turn-finished` (debounced); cross-account key isolation.
- Store integration tests: archive/remove purge, logout `dropAll`, `sessions-changed` reconciliation.
- Full gates: `bun run test:web`, `npm run test:unit`, `npx tsc --noEmit`, `vue-tsc --noEmit` in relay-web.
- Manual: switch between two long sessions and reload the page with DevTools network throttled — tail appears instantly, then converges; archive a session from WeChat while the web is closed and confirm its cache dies on next reconcile.

## Out of Scope

- Proactively caching non-selected sessions or full transcripts (only the selected session's tail, written on load/turn boundaries).
- Caching plans, usage, queues, agent commands, or live-turn state — transcript rows only.
- Encrypting cached history at rest (logout purge + per-username keys are the mitigation).
- Service-worker/offline support and cross-tab cache coordination beyond localStorage's natural sharing.
- Server or protocol changes (none required).

## Further Notes

- Builds on #201 (progressive tail-first mount, `markRaw` structured, stable `p${id}` row keys) — those mechanics are what make wholesale replace of a cache-seeded transcript flicker-free.
- Worst-case row weight is bounded by connector caps (`TEXT_CAP` 8K / `DIFF_CAP` 4K per string, ≤200 steps) with the hub's 32 K-per-string deep cap as backstop; the 256 KB per-entry budget assumes typical rows are far smaller and heavy outliers just shorten the cached tail.
- There is no `__APP_VERSION__` build constant in relay-web; versioning stays with the `.v1` key-suffix convention already used by sessionStorage caches (`xacpx.center-tabs.v1` etc.).
