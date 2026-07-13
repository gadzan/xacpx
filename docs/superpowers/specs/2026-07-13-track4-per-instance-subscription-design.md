# Track 4 · B — Per-instance Subscription Routing (Design Spec)

Date: 2026-07-13
Branch: `feat/track4-per-instance-subscription` (stacked on `feat/track4-terminal-stream-hardening` / A / PR #157)
Track: 2026-07 architecture audit → Track 4 (runtime robustness), block B of 3.

## Context

Track 4 · B is the protocol-layer block of the runtime-robustness track. Like A,
it is **behaviour-changing on purpose**, so verification is characterization tests
for the new behaviour + regression guards for the contracts that must survive.

### The amplification problem

The hub fans every `WebServerEvent` to **all** of an account's sockets; the web
filters client-side. End-to-end:

```
core control-event → connector → hub server.ts:163
  → WebGateway.broadcast(accountId, { kind:"control-event", instanceId, event })
  → web-gateway.ts: send to EVERY socket in byAccount   ← no per-instance scoping
  → relay-web: ONE /ws socket; DashboardView.vue:234-238 fans every event to all stores
```

So a busy instance's streaming chunks (`turn-output`/`turn-thought`/`tool-event`)
are delivered to every tab of the account — including tabs viewing a **different
instance**. On a multi-tenant hub (one account controlling many instances) this is
pure waste: cross-instance amplification × concurrent sessions × tabs.

There is **no subscription mechanism today**: `WebClientMessage` is only
`terminal-input`/`terminal-resize`/`terminal-close` (`web-dtos.ts:238-241`); the web
receives everything and filters.

### Why per-instance (not per-session)

The web's `chat` store relies on receiving **all** sessions' events, for two
things beyond the active view:
- **Background unread/attention badges**: `unread` is set on `turn-finished` for a
  non-viewed session (`chat.ts:362-367`); "working" comes from `turn-started`
  building `liveTurns` (`chat.ts:298+`).
- **Instant-switch pre-buffering**: `turn-output`/`tool-event`/`turn-thought` build
  `liveTurns` for **every** session key, so switching to a background session
  renders its in-progress turn immediately.

Pure per-**session** routing would break both, requiring a rework of the web's
attention/pre-buffer model (deferred). **Per-instance** routing keeps every
active-instance event flowing exactly as today — badges, pre-buffering, terminals
all unchanged — while cutting the cross-instance firehose. The connector→hub link
is already per-instance and events already carry `instanceId`, so **the connector
needs no change**.

Decision (approved): **per-instance** granularity; within-instance per-session
routing is out of scope (a possible follow-up "B2").

## Goal & non-goals

**Goal:** scope the hub→web `control-event` stream to the instance(s) a socket is
viewing, with a backward-compatible protocol addition and no change to server
event shapes.

In scope:
- A client→hub `subscribe` message declaring the socket's viewed instance set.
- A per-socket subscription registry in `WebGateway` + subscription-scoped
  `control-event` broadcast.
- The web sending `subscribe` on connect/reconnect/instance-switch, plus a
  refetch-on-switch to self-heal any staleness.

**Non-goals (deferred / out of scope):**
- Within-instance per-`(instance,session)` routing (would rework the web's
  attention/pre-buffer model).
- Any change to the web's badge/attention/pre-buffer/terminal store logic.
- Any connector change.
- Any `WebServerEvent` / `ControlEventDto` shape change.
- Routing `instance-status` / `notice` (they stay account-wide — the global
  instance list needs them regardless of the active instance).

## Design

### 1. Protocol — `relay-protocol/src/web-dtos.ts`

Add one variant to `WebClientMessage` and to `parseWebClientMessage`:

```ts
{ kind: "subscribe"; instanceIds: string[] }
```

- Full-set **replace** (idempotent): each `subscribe` supersedes the socket's prior
  set. Not a delta.
- Validation in `parseWebClientMessage`: `kind === "subscribe"` requires
  `Array.isArray(c.instanceIds)` and every element a `string`.
- The existing `terminal-*` parsing (which requires `instanceId`/`terminalId`
  strings) must **not** be applied to `subscribe` — restructure the parser so the
  `instanceId`/`terminalId` string checks gate only the terminal variants.
- No `WebServerEvent` change.

### 2. Hub — `WebGateway` (`packages/relay/src/gateway/web-gateway.ts`)

- Per-socket subscription registry: `private readonly subscriptions = new Map<WebSocketLike, Set<string>>()`.
  - **Absent from the map = "all"** — the default for a freshly `register`ed socket
    and for any client that never sends `subscribe`. This makes the change
    backward-compatible and closes the connect→first-subscribe race (no events
    dropped in that window).
- `setSubscription(socket, instanceIds: string[]): void` — `this.subscriptions.set(socket, new Set(instanceIds))`.
- `register`'s existing `on("close")` handler also deletes the socket from
  `subscriptions` (no leak).
- `broadcast(accountId, event)` routing:
  - `event.kind === "instance-status" || event.kind === "notice"` → deliver to
    **all** account sockets (current behaviour, unchanged).
  - `event.kind === "control-event"` → deliver only to sockets whose subscription
    is **absent** (all) OR whose set **has** `event.instanceId`.
  - The A `bufferedAmount` backpressure guard and the `readyState` guard stay
    per-socket in the loop and run for whichever sockets are selected.

Factor the per-socket send (readyState guard + backpressure guard + try/send) so
the subscription filter is a single readable predicate before it, not duplicated.

**No ownership gate on `subscribe`:** `broadcast` already iterates only the
event-owner account's socket set; a socket belongs to exactly one account.
Subscribing to a foreign `instanceId` only adds a string that never matches this
account's events → the socket receives *less*, never more. No cross-account leak is
possible, so no authorization check is required on `subscribe`.

### 3. Hub inbound — `web-inbound.ts` + `server.ts`

- `handleWebClientMessage` gains the `socket` and a `gateway.setSubscription`
  capability. On `msg.kind === "subscribe"` → `deps.gateway.setSubscription(socket, msg.instanceIds)`
  and return (hub-local; **not** forwarded to the connector). The `terminal-*`
  branches are unchanged (still `getOwned` gate + `gateway.sendEvent`).
  - The `subscribe` branch runs **before** the `getOwned` ownership gate (that gate
    guards connector-forwarded terminal actions; `subscribe` is hub-local and
    inherently safe per above).
- `server.ts:324` — the `ws.on("message", ...)` handler passes `ws` into
  `handleWebClientMessage` so the subscribe can bind to that specific socket, and
  includes `setSubscription` in the deps object.

### 4. Web — `relay-web`

Seams (verified): the single socket is created in `api/events.ts`
`connectEvents(onEvent, onStatus?)`; `onStatus(true)` fires on the initial open
**and every reconnect** (`socket.onopen`). The active instance is `chat.instanceId`
(the chat store's selected instance). The real self-heal on switch is
`InstanceTree`'s `onSelect` handler, which calls `chat.loadHistory()` (the
persisted transcript for the newly-viewed session), **plus** the newly-added
`chat.loadActiveTurns()` on the instance-change watch below (the global in-flight
snapshot, which re-seeds any live turn + "working" dots that were dropped for this
socket while it was subscribed elsewhere). There is no separate
`loadSessions`/`loadFor` watch that serves as the self-heal.

- `api/events.ts`: add `sendSubscribe(instanceIds: string[])` mirroring
  `sendWebClientMessage` (encode a `subscribe` `WebClientMessage` on the active
  socket; no-op if the socket is not OPEN).
- In `DashboardView.vue`:
  - Pass an `onStatus` to `connectEvents` (or extend the existing one) that, on
    `online === true`, calls `sendSubscribe(chat.instanceId ? [chat.instanceId] : [])`
    — re-subscribes after every (re)connect.
  - Add a `watch(() => chat.instanceId)` that calls the same `sendSubscribe(...)`
    **and**, when an instance is selected, `chat.loadActiveTurns()` — so switching
    instances both re-scopes the socket and re-seeds any in-flight turn that
    streamed while unsubscribed.
- Before an instance is selected, `chat.instanceId` is empty → `sendSubscribe([])`,
  so the socket gets only `instance-status`/`notice` until the user selects an
  instance. Pre-selection data loads over RPC, not the socket, so nothing is lost.

### Routing rule (approved: the simple rule)

All `control-event`s are subscription-scoped; only `instance-status` / `notice`
stay account-wide. Consequence: a **non-viewed** instance's `sessions-changed` /
per-session `unread` do not update live; they refresh when the user switches to
that instance (covered by the refetch-on-switch above). This keeps the hub routing
to a single predicate (no per-event-type classification) and the staleness
self-heals. (Considered and rejected: keeping the three rare instance-global
control-events — `sessions-changed`/`workspaces-changed`/`orchestration-changed` —
account-wide, which would preserve cross-instance sidebar freshness at the cost of
an event-type classification the hub must maintain as new events are added.)

## Verification (behaviour-changing → characterization + regression guards)

Test files (all under `tests/unit/`, run per-file by `scripts/run-tests.mjs`;
relay-web tests run under `vitest`, not bun):
- `tests/unit/packages/relay-protocol/web-dtos.test.ts` (extend) — `subscribe` parse.
- `tests/unit/packages/relay/gateway/web-gateway.test.ts` (extend) — subscription routing.
- `tests/unit/packages/relay/` web-inbound coverage (extend or add) — subscribe → setSubscription; terminal-* unchanged.
- `packages/relay-web/src/__tests__/` (extend, vitest) — sendSubscribe on open/switch.

**Protocol:**
- `parseWebClientMessage` round-trips `{ kind:"subscribe", instanceIds:["a","b"] }`.
- Rejects `subscribe` with non-array / non-string-element `instanceIds`.
- `terminal-input`/`resize`/`close` parsing unchanged (regression).

**WebGateway:**
- A socket that never subscribed receives all `control-event`s (backward-compat).
- After `setSubscription(sock,["A"])`, `sock` receives a `control-event` for
  instance A but **not** one for instance B.
- `instance-status` and `notice` reach the socket regardless of subscription.
- `setSubscription(sock,[])` → no `control-event`s, but still `instance-status`/`notice`.
- `setSubscription` replaces (subscribe `["A"]` then `["B"]` → only B).
- Socket close removes its subscription entry (no leak; a fresh socket at the same
  identity would default to "all").
- The A backpressure guard still evicts an over-threshold subscribed socket.

**web-inbound:**
- A `subscribe` frame calls `setSubscription(socket, instanceIds)` and is **not**
  forwarded to the connector (`gateway.sendEvent` not called for it).
- `terminal-*` frames still hit the `getOwned` gate + `gateway.sendEvent`.

**Web:**
- `subscribe([activeInstanceId])` is sent on socket open and on active-instance
  change; re-sent on reconnect.

## Risk & rollout

- **Backward-compatible:** the hub defaults an un-subscribed socket to "all", so an
  old web bundle (no `subscribe`) behaves exactly as today; the hub can ship before
  the web.
- **Documented behaviour change:** non-viewed instances' control-events (session
  list refresh, per-session unread) go stale until the user switches to them;
  `instance-status`/`notice` keep the instance list's online/notice state fresh.
  This also affects cross-instance **in-flight turn buffering**: a turn streaming
  on a non-viewed instance is no longer pre-buffered live — it is re-seeded from
  the global active-turns snapshot (`chat.loadActiveTurns()`) when the user
  switches to that instance, not streamed incrementally while unsubscribed. More
  importantly, a turn that **finishes** on a non-viewed instance while
  unsubscribed produces **no unread dot**: its `turn-finished` event is dropped
  by the subscription filter, and the active-turns snapshot only seeds in-flight
  (not-yet-finished) turns, so that unread affordance is missed entirely — not
  merely delayed — until the session is next opened directly.
- **Composes with A:** the subscription filter sits in front of A's per-socket
  `bufferedAmount` backpressure + `readyState` guards in the same `broadcast` loop.

## Out of scope / follow-ups

- **B2 (possible):** within-instance per-`(instance,session)` routing for the heavy
  streams, which requires reworking the web's background attention/pre-buffer model
  (two-tier light-vs-heavy event routing).
- **C:** interactive-turn watchdog (policy-sensitive).
