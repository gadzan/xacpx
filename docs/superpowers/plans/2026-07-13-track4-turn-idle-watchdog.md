# Interactive-Turn Idle Watchdog (Track 4 · C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Post-implementation note (PR #159 review):** the abort-reason sentinel this plan
> calls `TURN_IDLE_TIMEOUT` was renamed to **`TURN_IDLE_TIMEOUT_REASON`** during review
> (it names an abort *reason*, not a duration). The shipped code and the design spec use
> the new name; the code snippets below retain the original name as a historical record.

**Goal:** Abort an interactive turn that produces no agent activity for `turnIdleTimeoutSeconds` (default 600, 0=off), cooperatively and surfaced distinctly as a timeout — so a wedged turn no longer holds its `inFlight` slot forever.

**Architecture:** A per-turn inactivity timer in `TurnQueue` (which owns `inFlight` + the `AbortController`), armed at submit, reset on each agent activity, cleared on settle. The activity signal is a callback threaded `TurnQueue.submit → runTurn → SessionTurnRunner.run(onActivity)`, invoked on every agent event. On expiry the watchdog does `controller.abort(TURN_IDLE_TIMEOUT)`; the runner reads `signal.reason` to emit `turn-finished { ok:false, errorMessage }` (distinct from a user Stop's `cancelled`) — no protocol change. Uniform across all in-flight turns.

**Tech Stack:** TypeScript, Bun test runner (`bun test <file>`, per-file). Core only — no packages, no protocol, no web.

## Global Constraints

- **No protocol / DTO / web change.** The timeout is surfaced via the existing `turn-finished { ok, errorMessage, cancelled? }` fields.
- **`turnIdleTimeoutMs` deps are OPTIONAL** on both `TurnQueueDeps` and `ControlServiceDeps` — absent ⇒ watchdog disabled. This keeps the many existing `control-service-*` / `turn-queue` tests that construct these deps working unchanged (they don't opt in). Only `main.ts` supplies the real accessor.
- **`0` (or non-positive) disables** the watchdog (no timer armed). Distinct from the terminal resolver, where `0` falls back to a default.
- Default threshold **600s**. Config key `transport.turnIdleTimeoutSeconds`.
- Timers injectable via `TurnQueueDeps.setTimer`/`clearTimer` (default `setTimeout`/`clearTimeout`, `unref`'d in production), mirroring `terminal-service`.
- `TurnQueue` stays **session-free**: the activity signal is a plain callback, never the event bus or session keys.
- Watchdog abort uses the `TURN_IDLE_TIMEOUT` sentinel (from `turn-support.ts`) as the `abort(reason)` argument; the runner distinguishes it via `signal.reason`.
- The implementer runs **no git**; the controller commits.

---

### Task 1: Config — `transport.turnIdleTimeoutSeconds` + resolver

**Files:**
- Modify: `src/config/types.ts`
- Test: `tests/unit/config/transport-config.test.ts` (create if absent; else extend)

**Interfaces:**
- Produces: `TransportConfig.turnIdleTimeoutSeconds?: number`; `turnIdleTimeoutSeconds(config: AppConfig): number` (600 default, `0` = disabled). Task 3 consumes the resolver in `main.ts`.

- [ ] **Step 1: Write the failing resolver test**

Create `tests/unit/config/transport-config.test.ts` (mirror the style of `terminal-config.test.ts`):

```ts
import { expect, test } from "bun:test";
import { turnIdleTimeoutSeconds } from "../../../src/config/types";
import type { AppConfig } from "../../../src/config/types";

const base = { transport: { permissionMode: "approve-all", nonInteractivePermissions: "deny" } } as unknown as AppConfig;

test("turnIdleTimeoutSeconds defaults to 600 when unset", () => {
  expect(turnIdleTimeoutSeconds(base)).toBe(600);
});
test("turnIdleTimeoutSeconds returns the configured positive value", () => {
  const c = { transport: { ...base.transport, turnIdleTimeoutSeconds: 300 } } as unknown as AppConfig;
  expect(turnIdleTimeoutSeconds(c)).toBe(300);
});
test("turnIdleTimeoutSeconds treats 0 as disabled (returns 0, NOT the default)", () => {
  const c = { transport: { ...base.transport, turnIdleTimeoutSeconds: 0 } } as unknown as AppConfig;
  expect(turnIdleTimeoutSeconds(c)).toBe(0);
});
test("turnIdleTimeoutSeconds falls back to 600 for a negative value", () => {
  const c = { transport: { ...base.transport, turnIdleTimeoutSeconds: -5 } } as unknown as AppConfig;
  expect(turnIdleTimeoutSeconds(c)).toBe(600);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test tests/unit/config/transport-config.test.ts`
Expected: FAIL — `turnIdleTimeoutSeconds` is not exported.

- [ ] **Step 3: Add the config field**

In `src/config/types.ts`, add to `interface TransportConfig` (next to `queueOwnerTtlSeconds`):

```ts
  /**
   * Inactivity watchdog: abort a turn that produces NO agent activity (no streamed
   * output/tool/thought/usage event) for this many seconds, reclaiming its in-flight
   * slot. Reset on every agent event, so long but actively-working turns are unaffected.
   * `0` disables the watchdog. Defaults to 600 (10 min).
   */
  turnIdleTimeoutSeconds?: number;
```

- [ ] **Step 4: Add the resolver**

In `src/config/types.ts`, next to `terminalIdleTimeoutSeconds`, add:

```ts
export function turnIdleTimeoutSeconds(config: AppConfig): number {
  const v = config.transport?.turnIdleTimeoutSeconds;
  // NB: unlike terminalIdleTimeoutSeconds, 0 is a valid "disabled" value (>= 0), not a
  // fall-through to the default — only a negative/absent value uses the 600 default.
  return typeof v === "number" && v >= 0 ? v : 600;
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `bun test tests/unit/config/transport-config.test.ts`
Expected: PASS (all four cases).

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit** (controller performs git)

```
feat(config): add transport.turnIdleTimeoutSeconds (turn idle watchdog)

New optional config + turnIdleTimeoutSeconds(config) resolver: default 600s,
0 disables (distinct from terminalIdleTimeoutSeconds where 0 falls back).
Consumed by the Track 4·C turn watchdog. Track 4·C (1/3).
```

---

### Task 2: Runner — activity signal + timeout surfacing

**Files:**
- Modify: `src/control/turn-support.ts` (add the `TURN_IDLE_TIMEOUT` sentinel)
- Modify: `src/control/session-turn-runner.ts`
- Test: `tests/unit/control/session-turn-runner.test.ts` (create — no runner unit test exists today)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `TURN_IDLE_TIMEOUT` (exported sentinel); `SessionTurnRunner.run(req, signal, onActivity?)`. Task 3 passes `TURN_IDLE_TIMEOUT` to `controller.abort` and threads `onActivity`.

- [ ] **Step 1: Write the failing runner tests**

Create `tests/unit/control/session-turn-runner.test.ts`:

```ts
import { expect, test } from "bun:test";
import { SessionTurnRunner } from "../../../src/control/session-turn-runner";
import { TURN_IDLE_TIMEOUT } from "../../../src/control/turn-support";
import { createControlEventBus, type ControlEvent } from "../../../src/control/control-event-bus";

// Minimal deps: a fake agent whose chat() invokes the streaming callbacks we want to
// observe, then resolves; sessions/uploadStore stubbed just enough for run() to proceed.
function makeRunner(chat: (opts: any) => Promise<{ text?: string }>) {
  const events = createControlEventBus();
  const captured: ControlEvent[] = [];
  events.subscribe((e) => captured.push(e));
  const runner = new SessionTurnRunner({
    agent: { chat },
    sessions: {
      resolveAliasForChat: async (_c: string, a: string) => a,
      getSession: async () => ({ transportSession: "t", replyMode: "stream" }),
      useSession: async () => {},
    },
    events,
    uploadStore: { root: "/tmp/uploads" },
  } as never);
  return { runner, captured };
}

const REQ = { chatKey: "c", sessionAlias: "s", text: "hi", senderId: "u" };

test("onActivity is invoked on each agent event", async () => {
  let calls = 0;
  const { runner } = makeRunner(async (opts) => {
    await opts.reply("chunk");
    opts.onThought("t");
    opts.onToolEvent({ id: "x" });
    return { text: "done" };
  });
  await runner.run(REQ as never, new AbortController().signal, () => { calls++; });
  expect(calls).toBeGreaterThanOrEqual(3);
});

test("a TURN_IDLE_TIMEOUT abort surfaces as ok:false + timeout errorMessage, NOT cancelled", async () => {
  const controller = new AbortController();
  const { runner, captured } = makeRunner(async () => {
    controller.abort(TURN_IDLE_TIMEOUT); // simulate the watchdog firing mid-chat
    throw new Error("aborted");           // the transport throws on abort
  });
  await runner.run(REQ as never, controller.signal);
  const fin = captured.find((e) => e.type === "turn-finished") as Extract<ControlEvent, { type: "turn-finished" }>;
  expect(fin.ok).toBe(false);
  expect(fin.errorMessage).toBe("Turn timed out due to inactivity");
  expect("cancelled" in fin).toBe(false); // distinct from a user Stop
});

test("a plain user-Stop abort still surfaces as cancelled:true", async () => {
  const controller = new AbortController();
  const { runner, captured } = makeRunner(async () => {
    controller.abort(); // user Stop — no reason
    throw new Error("aborted");
  });
  await runner.run(REQ as never, controller.signal);
  const fin = captured.find((e) => e.type === "turn-finished") as Extract<ControlEvent, { type: "turn-finished" }>;
  expect(fin.ok).toBe(false);
  expect(fin.cancelled).toBe(true);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/unit/control/session-turn-runner.test.ts`
Expected: FAIL — `TURN_IDLE_TIMEOUT` not exported; `run` ignores `onActivity`; the timeout branch doesn't exist (a `TURN_IDLE_TIMEOUT` abort currently yields `cancelled:true`).

- [ ] **Step 3: Add the sentinel to `turn-support.ts`**

In `src/control/turn-support.ts`, add near the other exported constants:

```ts
// Abort reason a turn's watchdog uses (via controller.abort(TURN_IDLE_TIMEOUT)) to mark
// an inactivity-timeout abort, so SessionTurnRunner can surface it distinctly from a user
// Stop (which aborts with no reason). Read via signal.reason in the runner's catch.
export const TURN_IDLE_TIMEOUT = Symbol("turn-idle-timeout");
```

- [ ] **Step 4: Add the `onActivity` param + calls in `session-turn-runner.ts`**

Import the sentinel (add to the existing `./turn-support` import):

```ts
import { toErrorMessage, buildControlMetadata, TURN_IDLE_TIMEOUT } from "./turn-support";
```

Change the method signature (`session-turn-runner.ts:50`):

```ts
  async run(req: TurnRequest, signal: AbortSignal, onActivity?: () => void): Promise<TurnResult> {
```

In the `agent.chat` call, add `onActivity?.()` as the first statement of each streaming callback. The callbacks become:

```ts
        reply: async (chunk) => {
          onActivity?.();
          emitChunk(chunk);
        },
        onToolEvent: (event) => {
          onActivity?.();
          this.deps.events.emit({ type: "tool-event", chatKey: req.chatKey, sessionAlias: req.sessionAlias, event });
        },
        onThought: (chunk) => {
          onActivity?.();
          this.deps.events.emit({ type: "turn-thought", chatKey: req.chatKey, sessionAlias: req.sessionAlias, chunk });
        },
        onUsage: (usage) => {
          onActivity?.();
          this.deps.events.emit({
            type: "turn-usage", chatKey: req.chatKey, sessionAlias: req.sessionAlias,
            used: usage.used, size: usage.size,
            ...(usage.cost ? { cost: usage.cost } : {}),
            ...(usage.breakdown ? { breakdown: usage.breakdown } : {}),
          });
        },
        onPlan: (entries) => {
          onActivity?.();
          this.deps.events.emit({ type: "plan", chatKey: req.chatKey, sessionAlias: req.sessionAlias, entries });
        },
        onCommands: (commands) => {
          onActivity?.();
          this.deps.events.emit({ type: "agent-commands", chatKey: req.chatKey, sessionAlias: req.sessionAlias, commands });
        },
```

(Preserve the exact existing emit payloads — only the leading `onActivity?.()` is added to each. Match the current bodies when editing.)

- [ ] **Step 5: Surface the timeout distinctly in the `catch`**

Replace the `catch (error)` block's error-message + turn-finished emit (`session-turn-runner.ts:213-222`) with:

```ts
    } catch (error) {
      // A watchdog inactivity-timeout abort (controller.abort(TURN_IDLE_TIMEOUT)) surfaces
      // as an error with a fixed timeout message and is NOT flagged `cancelled` — that keeps
      // it distinct from a user Stop (which aborts with no reason → cancelled:true).
      const timedOut = signal.reason === TURN_IDLE_TIMEOUT;
      const errorMessage = timedOut ? "Turn timed out due to inactivity" : toErrorMessage(error);
      this.deps.events.emit({
        type: "turn-finished",
        chatKey: req.chatKey,
        sessionAlias: req.sessionAlias,
        ok: false,
        errorMessage,
        ...(!timedOut && signal.aborted ? { cancelled: true } : {}),
      });
      return {
        ok: false,
        errorMessage,
        ...(internalAlias && priorTransportSession
          ? { postTurnDetection: { internalAlias, priorTransportSession } }
          : {}),
      };
    }
```

- [ ] **Step 6: Run to verify it passes**

Run: `bun test tests/unit/control/session-turn-runner.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. (`run`'s new param is optional, so existing 2-arg callers still typecheck.)

- [ ] **Step 8: Commit** (controller performs git)

```
feat(control): runner activity signal + distinct turn-timeout surfacing

SessionTurnRunner.run gains an optional onActivity callback invoked on every
agent event (reply/tool/thought/usage/plan/commands). Its catch reads
signal.reason: a TURN_IDLE_TIMEOUT abort (new sentinel in turn-support)
surfaces as turn-finished {ok:false, errorMessage:"Turn timed out due to
inactivity"} without cancelled; a plain Stop is unchanged. Track 4·C (2/3).
```

---

### Task 3: TurnQueue watchdog + wiring

**Files:**
- Modify: `src/control/turn-queue.ts`
- Modify: `src/control/control-service.ts`
- Modify: `src/main.ts`
- Test: `tests/unit/control/turn-queue.test.ts`

**Interfaces:**
- Consumes: Task 1 `turnIdleTimeoutSeconds`; Task 2 `TURN_IDLE_TIMEOUT` + `SessionTurnRunner.run(…, onActivity)`.
- Produces: the end-to-end watchdog. `TurnQueueDeps` gains optional `turnIdleTimeoutMs`/`setTimer`/`clearTimer` and its `runTurn` gains an `onActivity` param; `ControlServiceDeps` gains optional `turnIdleTimeoutMs`; `main.ts` wires it from config.

- [ ] **Step 1: Extend the test harness + write the failing watchdog tests**

In `tests/unit/control/turn-queue.test.ts`, extend `makeQueue` to inject fake timers + the idle timeout and to expose the turn's `AbortSignal` and a way to fire the idle timer. Replace `makeQueue` with:

```ts
function makeQueue(overrides?: Partial<TurnQueueDeps>) {
  const started: string[] = [];
  const pending: Array<{ req: TurnRequest; resolve: (r: TurnResult) => void; signal: AbortSignal; onActivity?: () => void }> = [];
  // Single-slot fake idle timer (the watchdog arms at most one live timer per turn),
  // with call counters so a reset (clear old + arm new) is observable.
  let idleFn: (() => void) | null = null;
  let setCount = 0;
  let clearCount = 0;
  const setTimer = (fn: () => void, _ms: number): unknown => { idleFn = fn; setCount++; return 1; };
  const clearTimer = (_id: unknown) => { idleFn = null; clearCount++; };
  const queue = new TurnQueue({
    runTurn: (req: TurnRequest, signal: AbortSignal, onActivity?: () => void) => {
      started.push(req.text);
      return new Promise<TurnResult>((resolve) => pending.push({ req, resolve, signal, onActivity }));
    },
    emitQueueUpdated: () => {},
    detectSessionsChanged: async () => {},
    setTimer,
    clearTimer,
    ...overrides,
  });
  return {
    queue,
    started,
    resolveNext: (r: TurnResult = { ok: true }) => pending.shift()?.resolve(r),
    pendingCount: () => pending.length,
    pendingReqs: () => pending.map((p) => p.req),
    head: () => pending[0],
    fireIdle: () => { const fn = idleFn; idleFn = null; fn?.(); },
    idleArmed: () => idleFn !== null,
    setCount: () => setCount,
    clearCount: () => clearCount,
  };
}
```

Then add the watchdog tests (using the `TURN_IDLE_TIMEOUT` import):

```ts
import { TURN_IDLE_TIMEOUT } from "../../../src/control/turn-support";

test("watchdog: a turn silent past the idle timeout is aborted with TURN_IDLE_TIMEOUT", async () => {
  const q = makeQueue({ turnIdleTimeoutMs: () => 1000 });
  void q.queue.submit({ ...BASE, text: "A", queueable: true });
  const h = q.head()!;
  expect(q.idleArmed()).toBe(true);     // armed at submit
  q.fireIdle();                          // no activity → watchdog fires
  expect(h.signal.aborted).toBe(true);
  expect(h.signal.reason).toBe(TURN_IDLE_TIMEOUT);
});

test("watchdog: onActivity resets the timer (clears the old, arms a new one)", async () => {
  const q = makeQueue({ turnIdleTimeoutMs: () => 1000 });
  void q.queue.submit({ ...BASE, text: "A", queueable: true });
  const h = q.head()!;
  expect(q.setCount()).toBe(1);          // armed once at submit
  expect(q.clearCount()).toBe(0);
  h.onActivity!();                        // agent activity → clear old + arm new
  expect(q.clearCount()).toBe(1);
  expect(q.setCount()).toBe(2);
  expect(q.idleArmed()).toBe(true);
  expect(h.signal.aborted).toBe(false);  // not aborted — the deadline was pushed out
});

test("watchdog: turnIdleTimeoutMs 0 disables it (no timer armed)", async () => {
  const q = makeQueue({ turnIdleTimeoutMs: () => 0 });
  void q.queue.submit({ ...BASE, text: "A", queueable: true });
  expect(q.idleArmed()).toBe(false);
});

test("watchdog: the idle timer is cleared when the turn settles normally", async () => {
  const q = makeQueue({ turnIdleTimeoutMs: () => 1000 });
  void q.queue.submit({ ...BASE, text: "A", queueable: true });
  expect(q.idleArmed()).toBe(true);
  q.resolveNext({ ok: true });           // turn finishes
  await tick();
  expect(q.idleArmed()).toBe(false);     // no dangling timer
});

test("watchdog: absent turnIdleTimeoutMs dep = disabled (no timer, backward-compat)", async () => {
  const q = makeQueue();                 // no turnIdleTimeoutMs override
  void q.queue.submit({ ...BASE, text: "A", queueable: true });
  expect(q.idleArmed()).toBe(false);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test tests/unit/control/turn-queue.test.ts`
Expected: FAIL — no watchdog: `idleArmed()` is never true, `signal.reason` is undefined; the existing tests still pass.

- [ ] **Step 3: Extend `TurnQueueDeps` in `turn-queue.ts`**

Add the imports (extend the existing `./turn-support` import to include `TURN_IDLE_TIMEOUT`):

```ts
import {
  turnKey,
  raceWithTimeout,
  CANCEL_DRAIN_TIMEOUT_MS,
  QUEUE_PREVIEW_MAX,
  TURN_IDLE_TIMEOUT,
  type QueuedPrompt,
} from "./turn-support";
```

Extend `TurnQueueDeps` (add the three optional members; extend `runTurn`'s signature):

```ts
export interface TurnQueueDeps {
  // Runs the per-turn execution body (SessionTurnRunner.run in production). `onActivity` is
  // invoked by the runner on every agent event; TurnQueue uses it to reset the idle watchdog.
  runTurn(req: TurnRequest, signal: AbortSignal, onActivity: () => void): Promise<TurnResult>;
  emitQueueUpdated(chatKey: string, sessionAlias: string, items: QueuedItemSnapshot[]): void;
  detectSessionsChanged(detection: NonNullable<TurnResult["postTurnDetection"]>): Promise<void>;
  // Inactivity watchdog threshold in ms; <= 0 (or absent) disables it. Read per-submit.
  turnIdleTimeoutMs?: () => number;
  // Injectable timers (default setTimeout/clearTimeout), for deterministic tests.
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
}
```

- [ ] **Step 4: Resolve the timer primitives in the constructor**

In `class TurnQueue`, add resolved timer fields + init them in the constructor:

```ts
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (id: unknown) => void;

  constructor(private readonly deps: TurnQueueDeps) {
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
  }
```

(If a `constructor` does not yet exist on `TurnQueue`, add this one; the class currently declares `constructor(private readonly deps: TurnQueueDeps) {}` — replace its empty body with the above.)

- [ ] **Step 5: Arm/reset/clear the watchdog in `submit`**

In `submit`, immediately AFTER `this.inFlight.set(key, { controller, settled });` (and after the `if (params.drained) { this.draining.delete(key); }` block), add the watchdog setup:

```ts
    // Inactivity watchdog: abort a turn that produces no agent activity for turnIdleTimeoutMs.
    // Armed here (covers the silent cold-start / agent-init window), reset on each onActivity,
    // cleared in the finally when the turn settles. `<= 0`/absent disables it.
    const idleMs = this.deps.turnIdleTimeoutMs?.() ?? 0;
    let idleTimer: unknown;
    const armIdle = () => {
      if (idleMs <= 0) return;
      idleTimer = this.setTimer(() => controller.abort(TURN_IDLE_TIMEOUT), idleMs);
      const t = idleTimer as { unref?: () => void };
      if (typeof t.unref === "function") t.unref();
    };
    const onActivity = () => {
      if (idleMs <= 0) return;
      if (idleTimer) this.clearTimer(idleTimer);
      armIdle();
    };
    armIdle();
```

Change the `runTurn` call (currently `await this.deps.runTurn({...}, controller.signal)`) to pass `onActivity` as the third argument:

```ts
      result = await this.deps.runTurn(
        {
          chatKey: params.chatKey,
          sessionAlias: params.sessionAlias,
          text: params.text,
          senderId: params.senderId,
          ...(params.isOwner !== undefined ? { isOwner: params.isOwner } : {}),
          ...(params.accountId !== undefined ? { accountId: params.accountId } : {}),
          ...(params.turnStarted ? { turnStarted: params.turnStarted } : {}),
          ...(params.media !== undefined ? { media: params.media } : {}),
        },
        controller.signal,
        onActivity,
      );
```

In the `finally` block (before `resolveSettled()`), clear the idle timer:

```ts
      if (idleTimer) this.clearTimer(idleTimer);
```

(Place this at the top of the existing `finally`, alongside the existing draining/detection logic — it must run on every settle path, normal or aborted.)

- [ ] **Step 6: Run the turn-queue tests to verify they pass**

Run: `bun test tests/unit/control/turn-queue.test.ts`
Expected: PASS — the new watchdog tests plus every pre-existing concurrency/queue test (the watchdog only adds an abort trigger; the gate logic is untouched).

- [ ] **Step 7: Wire `onActivity` + `turnIdleTimeoutMs` through `ControlService`**

In `src/control/control-service.ts`:

Add the optional dep to `ControlServiceDeps` (near `terminalEnabled`/`filesWriteEnabled`):

```ts
  // Inactivity watchdog threshold in ms for in-flight turns; absent ⇒ disabled. Wired in
  // main.ts from transport.turnIdleTimeoutSeconds. Optional so existing tests need no change.
  turnIdleTimeoutMs?: () => number;
```

In the `TurnQueue` construction (`control-service.ts:176`), thread `onActivity` through `runTurn` and pass the threshold:

```ts
    this.turnQueue = new TurnQueue({
      runTurn: (req, signal, onActivity) => this.runner.run(req, signal, onActivity),
      ...(this.deps.turnIdleTimeoutMs ? { turnIdleTimeoutMs: this.deps.turnIdleTimeoutMs } : {}),
      emitQueueUpdated: (chatKey, sessionAlias, items) =>
        this.deps.events.emit({ type: "queue-updated", chatKey, sessionAlias, items }),
      detectSessionsChanged: async (detection) => {
        try {
          const after = await this.deps.sessions.getSession(detection.internalAlias);
          if (after && after.transportSession !== detection.priorTransportSession) {
            this.deps.events.emit({ type: "sessions-changed" });
          }
        } catch {
          /* best-effort: no refresh on detection failure */
        }
      },
    });
```

- [ ] **Step 8: Wire the config accessor in `main.ts`**

In `src/main.ts`, extend the existing `./config/types` import (line 17) to add `turnIdleTimeoutSeconds`:

```ts
import { terminalEnabled, terminalIdleTimeoutSeconds, terminalShell, filesWriteEnabled, turnIdleTimeoutSeconds } from "./config/types";
```

In the `new ControlService({ ... })` deps object (near `terminalEnabled: () => terminalEnabled(config)`, ~line 856), add:

```ts
    turnIdleTimeoutMs: () => turnIdleTimeoutSeconds(config) * 1000,
```

- [ ] **Step 9: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 10: Run the control test suite for regressions**

Run each per-file (never whole-dir — state-leak rule):
```
bun test tests/unit/control/turn-queue.test.ts
bun test tests/unit/control/session-turn-runner.test.ts
bun test tests/unit/control/control-service-prompt.test.ts
bun test tests/unit/control/control-service-queue.test.ts
bun test tests/unit/control/control-service-scheduled.test.ts
```
Expected: all pass (existing control-service tests don't supply `turnIdleTimeoutMs`, so the watchdog is disabled for them — no behaviour change).

- [ ] **Step 11: Commit** (controller performs git)

```
feat(control): interactive-turn inactivity watchdog in TurnQueue

TurnQueue arms a per-turn idle timer (from optional turnIdleTimeoutMs dep;
injectable timers), reset via the onActivity callback threaded to the runner,
cleared on settle. On expiry it aborts with TURN_IDLE_TIMEOUT so the runner
surfaces a distinct timeout. Wired end-to-end: control-service threads
onActivity + the threshold; main.ts supplies it from
transport.turnIdleTimeoutSeconds. Optional dep ⇒ existing tests unaffected.
Track 4·C (3/3).
```

---

## Self-Review

**Spec coverage:**
- Config `transport.turnIdleTimeoutSeconds` + resolver (600 default, 0=disabled) → Task 1. ✔
- Inactivity model, armed-at-submit, reset-on-activity, cleared-on-settle → Task 3 Step 5. ✔
- Activity signal threaded `submit → runTurn → run(onActivity)`, called on every agent event → Task 2 Step 4 + Task 3 Steps 5,7. ✔
- Abort with `TURN_IDLE_TIMEOUT` sentinel; runner surfaces `ok:false`+message, not `cancelled`; user Stop still `cancelled` → Task 2 Steps 3,5. ✔
- No protocol/DTO/web change (reuses `turn-finished` fields) → no task touches protocol/web. ✔
- Uniform scope (all turns via `TurnQueue.submit`); optional deps ⇒ existing tests unchanged → Task 3 (submit is the single path; optional `turnIdleTimeoutMs`). ✔
- Injectable timers, `unref`'d → Task 3 Steps 4,5. ✔
- `TurnQueue` stays session-free (callback, not event bus) → Task 3 (onActivity is a plain closure). ✔

**Placeholder scan:** none — every code step carries complete code; every run step names command + expected outcome.

**Type consistency:** `TURN_IDLE_TIMEOUT` defined (T2 S3) before use (T2 S5 runner, T3 S3/S5 queue); `run(req, signal, onActivity?)` signature (T2 S4) matches the `runTurn` call (T3 S5) and the control-service wiring `(req, signal, onActivity) => this.runner.run(req, signal, onActivity)` (T3 S7); `turnIdleTimeoutMs?: () => number` identical on `TurnQueueDeps` (T3 S3), `ControlServiceDeps` (T3 S7), and the main.ts accessor `() => turnIdleTimeoutSeconds(config)*1000` (T3 S8); `turnIdleTimeoutSeconds(config)` resolver (T1 S4) consumed in main.ts (T3 S8); `setTimer`/`clearTimer` resolved in the constructor (T3 S4) and used in `armIdle`/`onActivity`/`finally` (T3 S5).
