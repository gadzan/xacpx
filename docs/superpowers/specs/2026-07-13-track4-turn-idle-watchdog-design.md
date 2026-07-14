# Track 4 · C — Interactive-Turn Inactivity Watchdog (Design Spec)

Date: 2026-07-13
Branch: `feat/track4-turn-idle-watchdog` (independent, branched from `origin/main` — no overlap with A/#157 or B/#158)
Track: 2026-07 architecture audit → Track 4 (runtime robustness), block C of 3 (final).

## Context

Track 4 · C is the policy-sensitive block the S3 audit deliberately deferred.
Like A/B it is **behaviour-changing on purpose**, so verification is
characterization tests for the new behaviour + regression guards for the
contracts that must survive.

### The gap

A turn runs through `TurnQueue.submit` (`src/control/turn-queue.ts`), which holds
its `AbortController` + `inFlight` slot for the session key until the turn settles.
The only things that abort a turn today:
- a user **Stop** → `cancelTurn` → `controller.abort()` (`turn-queue.ts:264-271`);
- an external **`abortSignal`** linked in `submit` (`turn-queue.ts:144-147`).

Only `runScheduledTurn` passes an `abortSignal` (the scheduler's per-dispatch
wall-clock cap, `control-service.ts:481`). The **interactive** path
`ControlService.prompt` (`control-service.ts:456-467`) passes **no** `abortSignal`
— so an interactive turn whose agent hangs (e.g. an adapter `initialize` that never
resolves, a stalled transport) is aborted by **nothing**. Its `inFlight` slot is
held forever, wedging every queued and future prompt for that session.

### Two existing timeout models

- Scheduled turns: a **hard wall-clock cap** (`scheduled-scheduler.ts:150-172`
  `dispatchWithTimeout`: `setTimeout` → reject + `controller.abort()`).
- Terminal PTYs: an **inactivity idle timer** (`terminal-service.ts:159-167`
  `resetIdle`, reset by user input, injectable `setTimer`/`clearTimer`).

The runner (`SessionTurnRunner.run`) emits an event on every agent activity
(`reply`/`onToolEvent`/`onThought`/`onUsage`/`onPlan`/`onCommands`,
`session-turn-runner.ts:150-195`) — a natural "still alive" signal.

## Policy decisions (approved)

1. **Model: inactivity watchdog** (reset on agent activity), not a wall-clock cap —
   so long-but-actively-working agentic turns run freely; only genuinely silent
   (wedged) turns are killed.
2. **Default 600s (10 min) of total silence**, **configurable**, `0` disables.
3. **On expiry: cooperative abort + distinct "timed out" surfacing** — abort the
   controller (same path as a Stop), and surface the timeout distinctly from a user
   cancel.
4. Surfacing reuses existing `turn-finished` fields (**no protocol/DTO change**).
5. **Uniform scope**: applied to all in-flight turns in `TurnQueue` (interactive,
   scheduled, drained-queue head), not interactive-only.

## Design

### Where it lives — `TurnQueue`

`TurnQueue` owns `inFlight` + the `AbortController`, so it owns the watchdog: a
**per-turn idle timer**, armed in `submit` right after `inFlight.set`, reset on
activity, cleared in the `finally` when the turn settles.

New `TurnQueueDeps`:
- `turnIdleTimeoutMs: () => number` — the threshold in ms; `0` (or non-positive)
  disables the watchdog (no timer armed).
- `setTimer?: (fn, ms) => unknown` / `clearTimer?: (id) => void` — injectable
  timer primitives, defaulting to `setTimeout`/`clearTimeout`, `unref`'d in
  production (mirrors `terminal-service`).

`TurnQueue` stays **session-free** (the Track-3 invariant): the activity signal
arrives as a plain callback, never via the event bus or session keys.

### Activity signal — thread `onActivity` through `runTurn`

Extend the `TurnQueueDeps.runTurn` seam:
`runTurn(req, signal) → runTurn(req, signal, onActivity)`.

`SessionTurnRunner.run(req, signal)` gains a third param `onActivity?: () => void`
and calls it on every agent event — inside the `agent.chat` callbacks
`reply`/`onToolEvent`/`onThought`/`onUsage`/`onPlan`/`onCommands`. Each call resets
the idle timer.

The timer is **armed at submit** (not at first event), so the silent
cold-start / agent-init window is itself covered — a hang during `initialize`
before any event is exactly a wedge the watchdog must catch. `turn-started` (the
first thing the runner emits) may also touch `onActivity`, but arming at submit is
what makes the pre-first-event window safe.

### The watchdog lifecycle in `submit`

After `this.inFlight.set(key, {controller, settled})`:
- If `turnIdleTimeoutMs() > 0`, arm `idleTimer = setTimer(() => controller.abort(TURN_IDLE_TIMEOUT_REASON), ms)` (`unref`'d).
- Define `onActivity = () => { if (idleTimer) { clearTimer(idleTimer); idleTimer = setTimer(sameAbortFn, ms); } }` — reset on activity.
- Pass `onActivity` into `runTurn(...)`.
- In the `finally` (turn settled), `clearTimer(idleTimer)` so a completed/aborted
  turn leaves no dangling handle.

Per-activity reset (`clearTimer` + `setTimer` on each `onActivity`) mirrors
`terminal-service`'s `resetIdle`. A high-frequency streaming turn resets the timer
often, but the ops are cheap and this keeps tests deterministic with injected timers
(no injectable wall-clock needed, unlike a `lastActivityAt`-timestamp approach).

`TURN_IDLE_TIMEOUT_REASON` is a module-level sentinel exported from `turn-support.ts`
(e.g. `export const TURN_IDLE_TIMEOUT_REASON = Symbol("turn-idle-timeout")`), passed as the
`AbortController.abort(reason)` argument so the runner can distinguish a watchdog
abort from a user Stop via `signal.reason`.

### On expiry — distinct surfacing (no protocol change)

The runner's `catch` (around `session-turn-runner.ts:213-230`) currently emits
`turn-finished { ok:false, errorMessage, ...(signal.aborted ? {cancelled:true} : {}) }`.
Change the `cancelled` derivation to read `signal.reason`:
- `signal.reason === TURN_IDLE_TIMEOUT_REASON` → emit
  `turn-finished { ok:false, errorMessage: "Turn timed out after <N>s of inactivity" }`
  **without** `cancelled` — the web renders it as an error with a clear timeout
  message, distinct from a user Stop.
- else if `signal.aborted` → `cancelled:true` (a user Stop — unchanged).

Reuses `ok`/`errorMessage`, which `turn-finished` already carries for failed turns,
so no `ControlEventDto`/relay-protocol change and no web change beyond what already
renders `errorMessage`. The web `chat` store maps `turn-finished`: `cancelled` →
"cancelled", else `ok:false` → "error" with the message — so a watchdog timeout
shows as an error carrying the timeout text.

The runner emits a **fixed** message — `"Turn timed out due to inactivity"` — on
`signal.reason === TURN_IDLE_TIMEOUT_REASON`. The concrete threshold N is a config/log
detail, not required in the user-facing string, so the runner stays free of any
config dependency (it only reads `signal.reason`). TurnQueue, which owns the
threshold, logs the concrete N when it fires the abort — via an injected
`onIdleTimeout({ chatKey, sessionAlias, idleMs })` seam (kept as a callback to
preserve TurnQueue's session-free, timer-injected DI style; the real sink is the
app logger, wired in `main.ts` as `control.turn.idle_timeout`). The seam is invoked
at the fire site, immediately before `controller.abort`, so the reclaim is
observable even though the abort itself carries no config.

### Config

Add `transport.turnIdleTimeoutSeconds?: number` to `TransportConfig`
(`src/config/types.ts`), co-located with the other turn/transport timeouts
(`sessionInitTimeoutMs`, `queueOwnerTtlSeconds`). Default **600**; `0` disables.

A resolver `turnIdleTimeoutSeconds(config): number` mirrors the existing
`terminalIdleTimeoutSeconds` helper (`config/types.ts:143-146`) **with one
deliberate difference**: the terminal helper treats `v > 0` (so a configured `0`
falls back to its 900 default), but here `0` must mean **disabled**. So:
`return typeof v === "number" && v >= 0 ? v : 600` — a configured `0` returns `0`
(watchdog off), a negative/absent value returns the 600 default.
`ControlService` reads it and wires
`TurnQueueDeps.turnIdleTimeoutMs: () => turnIdleTimeoutSeconds(config) * 1000`.

### Data flow (unchanged happy path)

```
submit → inFlight.set → arm idle timer (if enabled)
  → runTurn(req, signal, onActivity)
      → runner emits turn-started / streams events → each event calls onActivity → resets timer
  → [no activity for N s] → timer fires → controller.abort(TURN_IDLE_TIMEOUT_REASON)
      → agent.chat throws (aborted) → runner catch: reason===TURN_IDLE_TIMEOUT_REASON
          → turn-finished { ok:false, errorMessage:<timeout> }
  → finally: clearTimer; settled resolves; advanceQueue frees/drains the slot
```

## Verification (behaviour-changing → characterization + regression guards)

Test files:
- `tests/unit/control/turn-queue.test.ts` (extend — the existing TurnQueue harness constructs `TurnQueue` directly with a stub `runTurn`; add watchdog arm/reset/expiry, disabled, timer cleared on settle, drained head re-arms).
- `tests/unit/control/session-turn-runner.test.ts` (**NEW** — no runner unit test exists today; the runner is only exercised via `control-service-*`/golden. Add a focused unit test constructing `SessionTurnRunner` with stub deps: `onActivity` called on each agent event; `signal.reason === TURN_IDLE_TIMEOUT_REASON` → `turn-finished { ok:false, errorMessage }`, no `cancelled`; a plain aborted signal (user Stop) still → `cancelled:true`; happy-path unchanged).
- Config resolver test alongside the existing config-type resolver tests (`tests/unit/config/*` — the `0`=disabled vs default-600 boundary).

**TurnQueue (fake timers):**
- A turn with no `onActivity` for the threshold → `controller.abort` fires with
  `TURN_IDLE_TIMEOUT_REASON`; the `inFlight` slot releases and a queued item drains.
- `onActivity()` before the threshold defers the abort; repeated activity keeps the
  turn alive past multiple thresholds (no abort).
- `turnIdleTimeoutMs() === 0` → no timer armed; a silent turn runs unbounded (no abort).
- The idle timer is cleared when the turn settles normally (no dangling handle);
  the drained head turn arms its **own** fresh watchdog.
- `onIdleTimeout` fires exactly once with the concrete threshold
  (`{ chatKey, sessionAlias, idleMs }`) at the moment the watchdog reclaims a turn.
- These lifecycle guards are mutation-live: disabling the drained-head watchdog, or
  letting only the first `onActivity` reset the deadline, each reddens exactly its
  own test.
- Regression: the existing concurrency/queue/draining invariants (busy gate,
  drain hand-off, cancel) are unaffected — the watchdog only adds an abort trigger.

**SessionTurnRunner:**
- `onActivity` is invoked on each of `reply`/`onToolEvent`/`onThought`/`onUsage`/`onPlan`/`onCommands`.
- On abort with `signal.reason === TURN_IDLE_TIMEOUT_REASON` → `turn-finished { ok:false, errorMessage:<timeout> }`, **no** `cancelled`.
- On abort without that reason (user Stop) → `turn-finished { ..., cancelled:true }` (regression, unchanged).
- Happy-path turn-finished (ok:true) unchanged.

**Config:**
- Resolver returns 600 by default, the configured value when set, and treats `0`
  as disabled (returns 0).

## Risk & rollout

- Default 600s is generous — a legitimately silent long tool call (build/test run)
  under 10 min never trips it; genuine wedges are reclaimed within ~10 min.
- `0` fully disables (operators who want the old unbounded behaviour set it).
- No protocol/DTO change; core-only. The watchdog only *adds* an abort trigger to
  the existing cooperative-cancel machinery, so a wedged turn now unwinds through
  the same settled/drain path a Stop already uses.
- Uniform scope means a scheduled turn may be aborted by whichever of its dispatch
  cap or the idle watchdog fires first — both are cooperative aborts, no conflict.
- The watchdog is a **cooperative** abort — the same mechanism as a user Stop — so its
  headline case (an adapter `initialize` that never resolves) is only reclaimed if the
  transport honors `abortSignal` during cold-start; where a user Stop cannot interrupt
  a wedged turn on some adapter, neither will the watchdog (a pre-existing transport
  limitation, not introduced here).

## Out of scope / follow-ups

- Per-agent or per-session override of the threshold (single global config for now).
- A hard absolute ceiling in addition to the idle watchdog (rejected as
  over-engineered for this pass).
- Surfacing a dedicated `timedOut` DTO flag (rejected — `ok:false`+`errorMessage`
  suffices without a protocol change).
