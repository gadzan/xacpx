# Terminal Stream Hardening (Track 4 · A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound the two unbounded paths in terminal streaming — coalesce PTY output bursts into ~one-frame windows, and evict a slow web socket by `bufferedAmount` — with **zero wire-format change**.

**Architecture:** Two independent changes. (1) Core `terminal-service.ts` debounces its per-chunk `terminal-output` emit into a 16ms / 64KB coalescing window, flushing on window/size-cap/attach/exit/dispose; every byte still lands in the replay buffer, and `attach` flushes-then-snapshots so the client's `seq > lastSeq` reconciliation stays correct. (2) Hub `WebGateway.broadcast` terminates any socket whose `bufferedAmount` exceeds 4MB (self-healing via the existing re-attach path) instead of growing its send buffer without bound.

**Tech Stack:** TypeScript, Bun test runner, `node-pty` (PTY), `ws` (hub sockets). Core tests under `tests/unit/control/`, hub tests under `tests/unit/packages/relay/`, both run per-file by `scripts/run-tests.mjs` (never whole-dir — state-leak rule).

## Global Constraints

- **No wire-format / DTO / envelope change.** `terminal-output` keeps exactly `{ type, terminalId, seq, data }`.
- **No new `terminal.*` config keys.** The three tuning values are module-level constants: `COALESCE_MS = 16`, `COALESCE_MAX_BYTES = 64 * 1024`, `BACKPRESSURE_MAX = 4 * 1024 * 1024`.
- **Behaviour-changing work** → characterization tests assert the *new* behaviour; regression guards pin the surviving contracts (byte-complete replay buffer, strictly monotonic `seq`, `buffer` = output through `lastSeq`).
- Timers must be injectable (`deps.setTimer` / `deps.clearTimer`) and `unref`'d in production.
- Public interfaces unchanged: `TerminalService`, `WebGateway`, `WebSocketLike` (additive optional field only).
- Run tests per-file: `bun test <path>`. Typecheck: core `npx tsc --noEmit`; relay `npx tsc -p packages/relay/tsconfig.json --noEmit`.
- The implementer runs **no git**; the controller commits. (Steps show the intended commit message for the controller.)

---

### Task 1: Output coalescing in `terminal-service`

**Files:**
- Modify: `src/control/terminal-service.ts`
- Test: `tests/unit/control/terminal-service.test.ts`

**Interfaces:**
- Consumes: existing `ControlEventBus.emit`, injected `deps.setTimer`/`deps.clearTimer`.
- Produces: no signature change. `terminal-output` events are now **coalesced** (one per ≤16ms window or per 64KB burst) instead of one-per-chunk; `attach` emits a pending flush before returning; `seq` counts coalesced events.

This task both **adds** coalescing tests and **updates** existing tests that pinned the old per-chunk behaviour. Do the harness upgrade first (behaviour-preserving, keeps existing tests green), then write the new/updated tests as failing, then implement.

- [ ] **Step 1: Upgrade the fake-timer harness to a multi-timer model**

The existing `setupWithFakeTimer` (terminal-service.test.ts:151-178) has a single `pendingFn` slot and counts all `setTimer` calls. Coalescing arms a *second* timer per session (the 16ms flush) alongside the ~900000ms idle timer, so the harness must track multiple timers and distinguish them by `ms`. It also needs to capture emitted events for the coalescing assertions. Replace the whole `setupWithFakeTimer` function (lines 151-178) with:

```ts
function setupWithFakeTimer(opts?: { idle?: number; platform?: NodeJS.Platform }) {
  // Multiple timers can be live at once: the idle timer (idleTimeoutSeconds*1000,
  // i.e. >=1000ms) and the coalesce flush timer (COALESCE_MS = 16ms). Track them by
  // id and split on ms so a test can fire/inspect each kind independently.
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let timerId = 0;
  let idleSetCount = 0;
  const setTimer = (fn: () => void, ms: number): unknown => {
    const id = ++timerId;
    timers.set(id, { fn, ms });
    if (ms >= 1000) idleSetCount++; // idle timer only; the 16ms flush timer is excluded
    return id;
  };
  const clearTimer = (id: unknown) => { timers.delete(id as number); };
  const fireWhere = (pred: (ms: number) => boolean) => {
    for (const [id, t] of [...timers]) if (pred(t.ms)) { timers.delete(id); t.fn(); }
  };
  /** Fire the pending idle timer(s) (>=1000ms). */
  const tick = () => fireWhere((ms) => ms >= 1000);
  /** Fire the pending coalesce flush timer(s) (<1000ms). */
  const fireFlush = () => fireWhere((ms) => ms < 1000);
  /** True when an idle timer is pending. */
  const hasPending = () => [...timers.values()].some((t) => t.ms >= 1000);
  /** True when a coalesce flush timer is pending. */
  const hasFlushPending = () => [...timers.values()].some((t) => t.ms < 1000);

  const events = createControlEventBus();
  const captured: ControlEvent[] = [];
  events.subscribe((e) => captured.push(e));
  const pty = fakePty();
  const spawn = mock(() => pty);
  const svc = createTerminalService({
    events,
    idleTimeoutSeconds: () => opts?.idle ?? 900,
    spawn: spawn as never,
    platform: opts?.platform ?? "darwin",
    setTimer,
    clearTimer,
  });
  return { svc, pty, spawn, captured, tick, fireFlush, hasPending, hasFlushPending, getIdleSetCount: () => idleSetCount };
}
```

- [ ] **Step 2: Adapt the existing idle tests to the renamed helper**

The only breaking rename is `getSetTimerCount` → `getIdleSetCount` in the "output does NOT reset the idle timer" test. In terminal-service.test.ts:180-197 replace the two `getSetTimerCount` references and update the destructure:

```ts
test("idle: PTY output (onData) does NOT reset the idle timer", () => {
  const { svc, pty, tick, getIdleSetCount } = setupWithFakeTimer();
  svc.create({ cwd: "/tmp/ws", cols: 80, rows: 24 });

  pty.emitData("line1\r\n");
  pty.emitData("line2\r\n");
  pty.emitData("line3\r\n");

  // The IDLE timer is armed exactly once (at create); output must not re-arm it.
  // (Output DOES arm a separate coalesce flush timer — excluded from this count.)
  expect(getIdleSetCount()).toBe(1);

  tick();
  expect((pty.kill as ReturnType<typeof mock>).mock.calls.length).toBe(1);
});
```

The other idle tests ("write() DOES reset", "resize() DOES reset", "output does not block kill") already use only `tick` / `hasPending` and stay as-is — `hasPending` now means "idle timer pending", which is exactly what they assert.

- [ ] **Step 3: Run the existing test file — still green (harness refactor is behaviour-preserving)**

Run: `bun test tests/unit/control/terminal-service.test.ts`
Expected: PASS (no production code changed yet; only the harness + one rename).

- [ ] **Step 4: Replace the per-chunk "monotonic seq" test with a coalesced version**

The old test at terminal-service.test.ts:53-63 uses real timers and expects one event per chunk — invalid under coalescing. Replace that whole `test(...)` block with:

```ts
test("coalesces multiple output chunks within a window into one terminal-output", () => {
  const { svc, pty, captured, fireFlush } = setupWithFakeTimer();
  const { terminalId } = svc.create({ cwd: "/tmp/ws", cols: 80, rows: 24 });
  pty.emitData("foo"); pty.emitData("bar"); pty.emitData("baz");
  // Still inside the coalesce window — nothing emitted yet.
  expect(captured.filter((e) => e.type === "terminal-output").length).toBe(0);
  fireFlush();
  const outs = captured.filter((e) => e.type === "terminal-output") as Extract<ControlEvent, { type: "terminal-output" }>[];
  expect(outs.length).toBe(1);
  expect(outs[0]).toEqual({ type: "terminal-output", terminalId, seq: 0, data: "foobarbaz" });
});

test("seq is monotonic across coalesced windows", () => {
  const { svc, pty, captured, fireFlush } = setupWithFakeTimer();
  svc.create({ cwd: "/tmp/ws", cols: 80, rows: 24 });
  pty.emitData("a"); fireFlush();
  pty.emitData("b"); fireFlush();
  const outs = captured.filter((e) => e.type === "terminal-output") as Extract<ControlEvent, { type: "terminal-output" }>[];
  expect(outs.map((o) => [o.seq, o.data])).toEqual([[0, "a"], [1, "b"]]);
});

test("a burst >= COALESCE_MAX_BYTES flushes immediately (no window wait)", () => {
  const { svc, pty, captured } = setupWithFakeTimer();
  svc.create({ cwd: "/tmp/ws", cols: 80, rows: 24 });
  const big = "x".repeat(64 * 1024); // 64KB of ascii == COALESCE_MAX_BYTES
  pty.emitData(big);
  const outs = captured.filter((e) => e.type === "terminal-output") as Extract<ControlEvent, { type: "terminal-output" }>[];
  expect(outs.length).toBe(1); // emitted synchronously, before any fireFlush()
  expect(outs[0]!.seq).toBe(0);
  expect(outs[0]!.data).toBe(big);
});

test("exit flushes pending output before emitting terminal-exit", () => {
  const { svc, pty, captured } = setupWithFakeTimer();
  const { terminalId } = svc.create({ cwd: "/tmp/ws", cols: 80, rows: 24 });
  pty.emitData("tail-end"); // armed in the window, not yet flushed
  pty.emitExit(0);
  const types = captured.map((e) => e.type);
  const outIdx = types.indexOf("terminal-output");
  const exitIdx = types.indexOf("terminal-exit");
  expect(outIdx).toBeGreaterThanOrEqual(0);
  expect(exitIdx).toBeGreaterThan(outIdx); // output strictly BEFORE exit
  expect(captured[outIdx]).toEqual({ type: "terminal-output", terminalId, seq: 0, data: "tail-end" });
});

test("disposeAll clears a pending flush timer (no stale flush after dispose)", () => {
  const { svc, pty, hasFlushPending } = setupWithFakeTimer();
  svc.create({ cwd: "/tmp/ws", cols: 80, rows: 24 });
  pty.emitData("pending"); // arms a flush timer
  expect(hasFlushPending()).toBe(true);
  svc.disposeAll();
  expect(hasFlushPending()).toBe(false);
});
```

- [ ] **Step 5: Update the two attach tests that assumed per-chunk seq**

At terminal-service.test.ts:93-100, `attach` now flushes pending first, so the two synchronously-emitted chunks coalesce into **one** event (seq 0) and `lastSeq` is 0. Replace that test, and add the flush-before-snapshot assertion:

```ts
test("attach returns buffered output + lastSeq for a live terminal (coalesced)", () => {
  const { svc, pty } = setupWithFakeTimer();
  const { terminalId } = svc.create({ cwd: "/tmp/ws", cols: 80, rows: 24 });
  pty.emitData("hello\n");
  pty.emitData("world\n"); // both pending; attach flushes them as ONE event (seq 0)
  const res = svc.attach(terminalId);
  expect(res).toEqual({ ok: true, buffer: "hello\nworld\n", lastSeq: 0 });
});

test("attach flushes pending first so lastSeq covers the buffer (no double-render)", () => {
  const { svc, pty, captured } = setupWithFakeTimer();
  const { terminalId } = svc.create({ cwd: "/tmp/ws", cols: 80, rows: 24 });
  pty.emitData("live-"); pty.emitData("bytes"); // pending, window not fired
  const res = svc.attach(terminalId);
  // attach emitted exactly one coalesced event at seq 0...
  const outs = captured.filter((e) => e.type === "terminal-output") as Extract<ControlEvent, { type: "terminal-output" }>[];
  expect(outs.length).toBe(1);
  expect(outs[0]).toEqual({ type: "terminal-output", terminalId, seq: 0, data: "live-bytes" });
  // ...and lastSeq === that seq, so the client's `seq > lastSeq` filter drops the flush
  // event it queued during the attach RPC — the bytes render once (from the buffer), not twice.
  expect(res).toEqual({ ok: true, buffer: "live-bytes", lastSeq: 0 });
});
```

The remaining attach tests ("no output yet returns lastSeq -1" at :102, "ok:false after close" at :108, "ring buffer trims" at :116) stay unchanged — with no pending, `attach`'s flush is a no-op; the ring-buffer test only inspects `buffer`. Convert the "no output yet" and "ok:false after close" and "ring buffer trims" tests' `setup()` call to `setupWithFakeTimer()` **only if** they currently use `setup()` and you need deterministic timing — but they don't depend on flush timing, so leave them on `setup()` (real timers). No change required there.

- [ ] **Step 6: Run the test file to verify the new/updated tests FAIL**

Run: `bun test tests/unit/control/terminal-service.test.ts`
Expected: FAIL — the coalescing tests fail (e.g. "expected 0 terminal-output before fireFlush" but the current code emits one per chunk immediately; `attach` returns `lastSeq: 1` not `0`).

- [ ] **Step 7: Add the coalescing constants**

In `src/control/terminal-service.ts`, immediately after the existing `const MAX_BUFFER_BYTES = 256 * 1024;` (line 125), add:

```ts
// Output coalescing: accumulate PTY output into ~one-frame windows and emit a single
// terminal-output per window instead of one per chunk. A noisy process (yes, tail -f,
// a build log) otherwise produces a firehose of tiny events across every downstream hop.
const COALESCE_MS = 16;
// Flush a large burst immediately rather than sit on it and add latency. Well under the
// 256KB replay cap so a single window never dominates the buffer.
const COALESCE_MAX_BYTES = 64 * 1024;
```

- [ ] **Step 8: Add the coalescing fields to the Session interface**

Replace the `interface Session` line (terminal-service.ts:123) with:

```ts
interface Session { handle: PtyHandle; seq: number; idleTimer: unknown; buffer: string; bufBytes: number; pending: string; flushTimer: unknown }
```

- [ ] **Step 9: Add the `flushOutput` helper inside `createTerminalService`**

Immediately after the `resetIdle` closure (ends at terminal-service.ts:167), add:

```ts
  // Emit the coalesced output window as a single terminal-output event. Disarms the
  // window timer FIRST so a throwing consumer cannot strand it (state stays clean:
  // pending cleared, timer null). No-op when nothing is pending. Callers: the window
  // timer, the size-cap in onData, attach (flush-before-snapshot), and onExit.
  const flushOutput = (terminalId: string) => {
    const s = sessions.get(terminalId);
    if (!s) return;
    if (s.flushTimer) { clearTimer(s.flushTimer); s.flushTimer = null; }
    if (s.pending.length === 0) return;
    const data = s.pending;
    s.pending = "";
    deps.events.emit({ type: "terminal-output", terminalId, seq: s.seq++, data });
  };
```

- [ ] **Step 10: Initialise the new Session fields in `create`**

Replace the session-construction line (terminal-service.ts:174) with:

```ts
      const session: Session = { handle, seq: 0, idleTimer: null, buffer: "", bufBytes: 0, pending: "", flushTimer: null };
```

- [ ] **Step 11: Rewrite the `onData` handler to coalesce**

Replace the `handle.onData(...)` block (terminal-service.ts:176-180) with:

```ts
      handle.onData((data) => {
        // NOTE: resetIdle is intentionally NOT called here (output ≠ user interaction).
        appendToBuffer(session, data); // every byte still lands in the replay buffer
        // Coalesce: accumulate and emit one event per window instead of per chunk.
        session.pending += data;
        if (Buffer.byteLength(session.pending, "utf8") >= COALESCE_MAX_BYTES) {
          flushOutput(terminalId); // large burst: flush now, don't add window latency
          return;
        }
        if (!session.flushTimer) {
          session.flushTimer = setTimer(() => flushOutput(terminalId), COALESCE_MS);
          const t = session.flushTimer as { unref?: () => void };
          if (typeof t.unref === "function") t.unref();
        }
      });
```

- [ ] **Step 12: Flush pending before `terminal-exit` in `onExit`**

Replace the `handle.onExit(...)` block (terminal-service.ts:181-185) with:

```ts
      handle.onExit(({ exitCode }) => {
        flushOutput(terminalId); // emit any coalesced-but-unflushed output BEFORE the exit event
        if (session.idleTimer) clearTimer(session.idleTimer);
        sessions.delete(terminalId);
        deps.events.emit({ type: "terminal-exit", terminalId, code: exitCode });
      });
```

- [ ] **Step 13: Flush pending before snapshotting in `attach`**

Replace the `attach(terminalId)` method body (terminal-service.ts:189-194) with:

```ts
    attach(terminalId) {
      const s = sessions.get(terminalId);
      if (!s) return { ok: false };
      // Assign the pending bytes a seq BEFORE snapshotting buffer/lastSeq, so the
      // returned lastSeq covers the whole buffer. The client queues live events during
      // the attach RPC and applies only those with seq > lastSeq, so this flush event
      // (seq === returned lastSeq) is correctly dropped — the bytes render once.
      flushOutput(terminalId);
      resetIdle(terminalId); // reattaching counts as activity
      return { ok: true, buffer: s.buffer, lastSeq: s.seq - 1 };
    },
```

- [ ] **Step 14: Clear the flush timer in `disposeAll`**

Replace the `disposeAll()` method body (terminal-service.ts:212-218) with:

```ts
    disposeAll() {
      for (const s of sessions.values()) {
        if (s.idleTimer) clearTimer(s.idleTimer);
        if (s.flushTimer) clearTimer(s.flushTimer);
        try { s.handle.kill(); } catch { /* ignore */ }
      }
      sessions.clear();
    },
```

- [ ] **Step 15: Run the test file to verify all tests pass**

Run: `bun test tests/unit/control/terminal-service.test.ts`
Expected: PASS (all coalescing + regression + idle tests green).

- [ ] **Step 16: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 17: Commit** (controller performs git)

```
feat(control): coalesce terminal output into ~one-frame windows

Debounce terminal-service's per-chunk terminal-output emit into a 16ms /
64KB coalescing window (flush on window/size-cap/attach/exit/dispose).
attach flushes pending before snapshotting so the client's seq>lastSeq
reconciliation stays correct (no double-render). Every byte still lands in
the replay buffer; seq stays monotonic. Track 4 · A (1/2).
```

---

### Task 2: Hub-side backpressure in `WebGateway`

**Files:**
- Modify: `packages/relay/src/gateway/web-gateway.ts`
- Test: `tests/unit/packages/relay/gateway/web-gateway.test.ts`

**Interfaces:**
- Consumes: existing `WebGateway.broadcast`, `WebSocketLike`, `RelayLogger` (`debug`/`info`/`error` only — no `warn`).
- Produces: `WebSocketLike` gains an optional `bufferedAmount?: number`; `broadcast` now terminates + skips any socket over `BACKPRESSURE_MAX`.

- [ ] **Step 1: Add the backpressure tests (extend the FakeSocket)**

At the top of `tests/unit/packages/relay/gateway/web-gateway.test.ts`, extend `FakeSocket` (lines 6-12) to carry `bufferedAmount` and a `terminate` that fires the close listeners (real `ws.terminate()` triggers a `close`, which the gateway's close handler uses to drop the socket). **Do NOT add a default `readyState`** — the existing "sockets without readyState still receive" test relies on `FakeSocket` having none, and the backpressure guard is skipped when `readyState` is undefined (the `typeof === "number"` check), so the backpressure tests work without it:

```ts
class FakeSocket {
  sent: string[] = [];
  closeListeners: (() => void)[] = [];
  bufferedAmount = 0;
  terminated = false;
  send(data: string) { this.sent.push(data); }
  terminate() { this.terminated = true; this.close(); } // real ws: terminate -> close -> drop
  on(event: string, listener: () => void) { if (event === "close") this.closeListeners.push(listener); return this; }
  close() { this.closeListeners.forEach((l) => l()); }
}
```

Note: tests that need an explicit `readyState` (the existing L69-83 test) already cast to `FakeSocket & { readyState: number }` and assign it — that pattern is unaffected.

Then append these tests at the end of the file:

```ts
const BACKPRESSURE_MAX = 4 * 1024 * 1024;

test("a socket over the bufferedAmount threshold is terminated and skipped, not sent", () => {
  const logs: Array<[string, string, Record<string, unknown> | undefined]> = [];
  const gw = new WebGateway({ logger: { debug: () => {}, info: (e, m, c) => logs.push([e, m, c]), error: () => {} } });
  const slow = new FakeSocket();
  slow.bufferedAmount = BACKPRESSURE_MAX + 1;
  gw.register("a1", slow as never);
  gw.broadcast("a1", evt(true));
  expect(slow.sent.length).toBe(0);
  expect(slow.terminated).toBe(true);
  // the terminate-triggered close dropped it from the account set: a second broadcast is a no-op
  slow.bufferedAmount = 0;
  gw.broadcast("a1", evt(false));
  expect(slow.sent.length).toBe(0);
  expect(logs.some(([e]) => e === "relay.web.backpressure_evict")).toBe(true);
});

test("a socket at/under the threshold receives normally", () => {
  const gw = new WebGateway();
  const ok = new FakeSocket();
  ok.bufferedAmount = BACKPRESSURE_MAX; // exactly at the cap is NOT over it
  gw.register("a1", ok as never);
  gw.broadcast("a1", evt(true));
  expect(ok.sent.length).toBe(1);
  expect(ok.terminated).toBe(false);
});

test("one slow socket does not starve the healthy sockets in the same account", () => {
  const gw = new WebGateway();
  const slow = new FakeSocket(); slow.bufferedAmount = BACKPRESSURE_MAX + 1;
  const good = new FakeSocket();
  gw.register("a1", slow as never); // slow first, so its eviction must not skip `good`
  gw.register("a1", good as never);
  gw.broadcast("a1", evt(true));
  expect(slow.sent.length).toBe(0);
  expect(slow.terminated).toBe(true);
  expect(good.sent.length).toBe(1);
});
```

The existing "sockets without readyState still receive" test (lines 69-83) already covers the `bufferedAmount === undefined` path implicitly via `FakeSocket`'s default `bufferedAmount = 0`; no separate undefined-case test is needed since 0 is under threshold and behaves identically.

- [ ] **Step 2: Run the gateway test file to verify the new tests FAIL**

Run: `bun test tests/unit/packages/relay/gateway/web-gateway.test.ts`
Expected: FAIL — `slow.terminated` is `false` and `slow.sent.length` is `1` (no backpressure yet).

- [ ] **Step 3: Add `bufferedAmount` to `WebSocketLike`**

In `packages/relay/src/gateway/web-gateway.ts`, add to the `WebSocketLike` interface (after the `readyState?: number;` line, ~line 15):

```ts
  /** Optional (real `ws` sockets have it): bytes queued but not yet flushed to the OS. */
  bufferedAmount?: number;
```

- [ ] **Step 4: Add the `BACKPRESSURE_MAX` constant**

In the same file, next to the existing `const WS_OPEN = 1;` (line 7), add:

```ts
/** Terminate a web socket whose send buffer exceeds this — a genuinely stalled client.
 *  A healthy client drains to ~0, so this never false-positives on transient bursts. The
 *  evicted client reconnects and re-attaches, replaying the bounded terminal scrollback. */
const BACKPRESSURE_MAX = 4 * 1024 * 1024;
```

- [ ] **Step 5: Add the backpressure guard in `broadcast`**

In `broadcast` (web-gateway.ts:45-58), insert the guard **after** the `readyState` check and **before** `socket.send(data)`:

```ts
    for (const socket of set) {
      // One dead/throwing socket must not starve the remaining dashboards.
      if (typeof socket.readyState === "number" && socket.readyState !== WS_OPEN) continue;
      // Backpressure: a stalled client's send buffer grows without bound. Evict it (it
      // reconnects and re-attaches, replaying the bounded scrollback) rather than OOM the hub.
      if (typeof socket.bufferedAmount === "number" && socket.bufferedAmount > BACKPRESSURE_MAX) {
        this.options.logger?.info("relay.web.backpressure_evict", "evicting slow web client", { accountId, bufferedAmount: socket.bufferedAmount });
        try { socket.terminate?.(); } catch { /* already gone */ }
        continue;
      }
      try {
        socket.send(data);
      } catch (err) {
        this.options.logger?.error("relay.web.broadcast_failed", "broadcast send failed", { error: String(err) });
      }
    }
```

- [ ] **Step 6: Run the gateway test file to verify all tests pass**

Run: `bun test tests/unit/packages/relay/gateway/web-gateway.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck the relay package**

Run: `npx tsc -p packages/relay/tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 8: Commit** (controller performs git)

```
feat(relay): evict slow web sockets by bufferedAmount (backpressure)

WebGateway.broadcast terminates any socket whose bufferedAmount exceeds
4MB instead of growing its send buffer without bound; the evicted client
reconnects and re-attaches, replaying the bounded scrollback. One slow
dashboard no longer starves the others or OOMs the hub. Track 4 · A (2/2).
```

---

## Self-Review

**Spec coverage:**
- Coalescing (window/size-cap/exit/dispose flush, byte-complete buffer, monotonic seq) → Task 1 Steps 4-15. ✔
- `attach` flush-before-snapshot (the seq-reconciliation correctness fix) → Task 1 Steps 5, 13. ✔
- Hub-side `bufferedAmount` backpressure (terminate + skip, one-slow-doesn't-starve, undefined = under) → Task 2. ✔
- Constants `COALESCE_MS=16`, `COALESCE_MAX_BYTES=64*1024`, `BACKPRESSURE_MAX=4*1024*1024`, module-level, no config keys → Task 1 Step 7, Task 2 Step 4. ✔
- No wire-format change → both tasks are additive to internal emit/broadcast; `terminal-output` DTO untouched. ✔
- Non-goals (PTY pause / back-channel / per-session routing / client resync) → not present in any task. ✔

**Placeholder scan:** none — every code step carries complete code; every run step names the command and expected outcome.

**Type consistency:** `flushOutput` defined (Step 9) before use (Steps 11-13); `Session` fields `pending`/`flushTimer` added (Step 8) before use; harness helpers `fireFlush`/`hasFlushPending`/`getIdleSetCount`/`captured` defined (Step 1) before use (Steps 2, 4, 5); `bufferedAmount` added to `WebSocketLike` (Task 2 Step 3) before use (Step 5); `BACKPRESSURE_MAX` value identical in test (Task 2 Step 1) and source (Step 4).
