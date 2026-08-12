# Track 4 · Sub-project A — Terminal Stream Hardening (Design Spec)

> **兼容背景（非权威）**：output coalescing / slow-socket backpressure 对 legacy live-PTY
> 仍有效；RMUX backend 改用 per-attachment targeted stream + recovery resync，见
> [`2026-08-10-relay-web-rmux-terminal-design.md`](./2026-08-10-relay-web-rmux-terminal-design.md)。

Date: 2026-07-12
Branch: `feat/track4-terminal-stream-hardening`
Track: 2026-07 architecture audit → Track 4 (runtime robustness), block A of 3.

## Context

Track 4 is the runtime-robustness track from the 2026-07 full-repo audit. Unlike
Track 3 (equivalence-preserving refactors guaranteed by byte-identical golden
oracles), Track 4 **changes behaviour on purpose**, so the verification method
flips: characterization tests that assert the *new* behaviour, plus regression
guards that pin the old contracts which must survive.

Track 4 decomposes into three independent spec→plan→implement cycles:

- **A — Terminal stream hardening** (this spec): output coalescing + hub-side
  backpressure. No wire-format change.
- **B — Per-`(instance,session)` subscription routing**: protocol-layer change
  (relay-protocol + hub + connector + web). Deferred.
- **C — Interactive-turn watchdog**: policy-sensitive turn-lifecycle guard.
  Deferred.

Recommended order A → B → C; this spec covers **A only**.

### The two unbounded paths in the terminal stream today

End-to-end path (post Track-3):

```
PTY chunk
  → terminal-service.ts onData: appendToBuffer + events.emit(terminal-output{seq++})   [ONE EVENT PER CHUNK]
  → ControlEventBus
  → connector
  → hub server.ts:163 → WebGateway.broadcast(accountId, {kind:"control-event", ...})
  → web-gateway.ts:45-58: send to EVERY socket in byAccount   [NO bufferedAmount CHECK]
  → relay-web terminal store: writes data straight to xterm    [NO seq-gap detection]
```

1. **No output coalescing** — `src/control/terminal-service.ts:176-180` emits one
   `terminal-output` event per PTY `onData` chunk (`seq++` each). A noisy process
   (`yes`, `tail -f`, a build log) produces a firehose of tiny events across every
   downstream hop.
2. **No hub-side backpressure** — `packages/relay/src/gateway/web-gateway.ts:45-58`
   sends to every socket with only a `readyState` guard; a slow/stalled client's
   `ws` `bufferedAmount` grows unbounded → hub OOM. The web client
   (`packages/relay-web/src/stores/terminal.ts:54`) writes `data` straight to xterm
   in arrival order with **no seq-gap detection**, so a silently-skipped event
   would corrupt that terminal's screen with no recovery.

## Goal & non-goals

**Goal:** bound both unbounded paths with **zero wire-format change**.

In scope:
- Output coalescing: merge PTY output bursts into time-windowed `terminal-output`
  events in the core `terminal-service`.
- Hub-side backpressure: evict a slow socket by `bufferedAmount` in
  `WebGateway.broadcast`.

**Non-goals (explicitly deferred to B or later):**
- End-to-end PTY pause requiring a hub→connector→core back-channel signal.
- Any protocol / DTO / envelope change; `terminal-output` keeps its exact shape
  `{ type, terminalId, seq, data }`.
- Per-`(instance,session)` routing / subscription model.
- New `terminal.*` config keys — the three tuning constants stay module-level
  (config exposure is deferred YAGNI).
- Client-side seq-gap detection / resync path (that was the rejected backpressure
  alternative; the chosen close-and-reattach policy needs none).

## Design

### Component 1 — Output coalescing (core, `src/control/terminal-service.ts`)

Today `handle.onData` does `appendToBuffer(session, data)` + `emit(terminal-output)`
per chunk. Change: keep `appendToBuffer` **per chunk** (the 256 KB replay buffer
must still see every byte for `attach`), but **debounce the emit**.

Per-session coalescing state (added to the existing `Session` interface):
- `pending: string` — output accumulated since the last emit.
- `flushTimer: unknown` — the armed coalesce timer (or null).

On `onData(data)`:
1. `appendToBuffer(session, data)` — unchanged; every byte still lands in the
   replay buffer.
2. Append `data` to `session.pending`.
3. If `Buffer.byteLength(session.pending, "utf8") >= COALESCE_MAX_BYTES`, **flush
   immediately** (don't sit on a large burst / add latency).
4. Else, if no `flushTimer` is armed, arm `setTimer(flush, COALESCE_MS)`
   (`unref`'d, via the existing injectable `deps.setTimer` / `deps.clearTimer`).

`flush(session, terminalId)`:
- If `session.pending` is empty, just disarm and return.
- Emit exactly one `terminal-output{ terminalId, seq: session.seq++, data: pending }`.
- Clear `session.pending = ""`, clear + null `flushTimer`.
- Wrapped so a throwing consumer cannot strand the timer (the timer is disarmed
  before the emit, so a throw leaves clean state and no double-arm).

Flush triggers: (a) timer fires; (b) `pending` ≥ `COALESCE_MAX_BYTES`;
(c) **`onExit` flushes pending *before* emitting `terminal-exit`** (ordering
contract — the final output must not arrive after / be lost to the exit event).
`disposeAll` is **NOT** a flush trigger: it is a hard teardown (daemon shutdown)
that clears both timers and kills every PTY — any coalesced-but-unflushed `pending`
is intentionally dropped rather than emitted into a bus that is closing at the same
moment. It only guarantees no armed timer survives.

Preserved contracts:
- Every byte still lands in `buffer` → `attach` replay stays byte-complete.
- `seq` stays strictly monotonic; it now counts coalesced events, not chunks.
- **`attach` must flush pending before snapshotting `buffer`/`lastSeq`.** The
  client (`TerminalTab.vue:258-281`) reconciles by seq: it queues live events
  during the attach RPC, replays `res.buffer`, then applies only queued events
  with `seq > res.lastSeq` (and the live handler drops `seq <= lastSeq`). The
  invariant it relies on is **`buffer` = output through `lastSeq`; any live event
  with `seq > lastSeq` is genuinely new**. Without a flush, `attach` would return
  a `buffer` containing un-emitted `pending` bytes while `lastSeq = seq-1` has not
  covered them, so the later pending-flush event (`seq > lastSeq`) would
  double-render. Flushing first assigns the pending bytes `seq = N`, sets
  `lastSeq = N`, and the client's `seq > lastSeq` filter then correctly drops that
  same flush event (which it queued during the RPC). Verified correct for other
  already-attached clients too: the flush event is the first time they see those
  bytes, so they render them exactly once.
- Idle timer semantics unchanged (still reset only by input, never by output —
  coalescing does not touch `resetIdle`). `attach` still counts as activity
  (`resetIdle`), unchanged.

### Component 2 — Hub-side backpressure (`packages/relay/src/gateway/web-gateway.ts`)

In `broadcast`, before `socket.send(data)`, guard on `bufferedAmount`:
- If `typeof socket.bufferedAmount === "number" && socket.bufferedAmount > BACKPRESSURE_MAX`:
  - `socket.terminate?.()` that one socket (bounded-memory eviction), log
    `relay.web.backpressure_evict` with `{ accountId, bufferedAmount }`, and skip
    the send. Do **not** touch the other sockets (one slow dashboard must not
    starve the rest — mirrors the existing dead-socket guard rationale).
  - The socket's existing `on("close")` handler removes it from `byAccount`;
    `terminate()` triggers that close, so no separate bookkeeping is added. (If a
    given `WebSocketLike` test double has no `terminate`, fall through to skip.)
- A missing / `undefined` `bufferedAmount` is treated as under-threshold (no-op),
  so existing behaviour is unchanged wherever the property is absent (test doubles,
  older mocks).

The evicted client reconnects and re-attaches through the existing
`control.terminal.attach` path, replaying the ≤256 KB buffer + `lastSeq`. Bounded
memory, self-healing, zero protocol change. Cost: a brief visible reconnect blip,
scoped to the one slow client.

### Data flow after A

```
PTY chunk
  → appendToBuffer (per byte)  +  pending (accumulate)
  → flush on [16ms window | 64KB cap | attach | exit]  →  ONE terminal-output{seq++}
    (disposeAll is teardown: clears timers, drops pending — not a flush)
  → connector → hub → broadcast(bufferedAmount > 4MB ? terminate+skip : send)
  → web
```

Fewer/bigger events on every hop; slow sockets self-evict instead of growing the
hub's send buffer without bound.

### Constants (module-level, not config)

| Constant | Value | Rationale |
|---|---|---|
| `COALESCE_MS` | `16` | ~one frame; below human perception for echo/output latency. |
| `COALESCE_MAX_BYTES` | `64 * 1024` | Flush a large burst early instead of adding latency; well under the 256 KB replay cap. |
| `BACKPRESSURE_MAX` | `4 * 1024 * 1024` | Catches a genuine stall; a healthy client drains to ~0, so no false-positive on transient bursts. |

## Verification (behaviour-changing → characterization + regression guards)

Test files (all under `tests/unit/`, run per-file by the root bun runner
`scripts/run-tests.mjs` — never whole-dir, per the state-leak rule):
- `tests/unit/control/terminal-service.test.ts` (extend; coalescing).
- `tests/unit/packages/relay/gateway/web-gateway.test.ts` (extend the existing
  gateway test; backpressure).

**Coalescing** (fake timers via injected `setTimer`/`clearTimer`):
- N chunks within one window → **exactly one** `terminal-output`, `data` = the
  concatenation in order, `seq` monotonic.
- Advancing the timer flushes the pending window.
- A burst ≥ `COALESCE_MAX_BYTES` flushes **immediately** (before the timer),
  emitting its own event.
- `onExit` flushes pending **before** `terminal-exit` (assert event order).
- **`attach` flushes pending first**: with un-flushed pending output, `attach`
  emits exactly one coalesced `terminal-output` (seq = N) *before* returning, and
  the returned `lastSeq === N` so the emitted flush event is not `> lastSeq`
  (the client would drop it) — i.e. no double-render. Buffer is byte-complete.
- Regression guard: after a coalesced sequence with no pending, `attach` returns a
  byte-complete buffer and `lastSeq === seq - 1`.
- Regression guard: `disposeAll` clears the flush timer (no dangling handle).

**Backpressure** (fake `WebSocketLike` with settable `bufferedAmount`):
- `bufferedAmount > BACKPRESSURE_MAX` ⇒ `terminate()` called, `send` NOT called,
  socket removed from the account set.
- `bufferedAmount` under threshold ⇒ normal `send`, no `terminate`.
- One slow socket over threshold does not prevent the healthy sockets in the same
  account from receiving the event.
- `bufferedAmount === undefined` ⇒ unchanged (send as before).

## Risk & rollout

- Coalescing adds ≤16ms first-byte latency to terminal output — imperceptible for
  a terminal; interactive echo still feels instant.
- Backpressure only fires for a genuinely stalled socket (4 MB queued); the blast
  radius is that single client, which self-heals via re-attach.
- No wire-format change ⇒ no connector/hub/web version coupling; core and hub can
  ship independently.

## Out of scope / follow-ups

- **B**: end-to-end PTY pause (`handle.pause()`) driven by a hub→connector→core
  backpressure signal; per-`(instance,session)` subscription routing.
- **C**: interactive-turn watchdog (policy-sensitive).
- Possible future: expose `COALESCE_MS` / `BACKPRESSURE_MAX` as `terminal.*`
  config if ops ever need to tune or disable them.
