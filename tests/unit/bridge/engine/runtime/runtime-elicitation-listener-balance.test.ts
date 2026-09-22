import { expect, test } from "bun:test";

import { bindElicitationAbort } from "../../../../../src/bridge/engine/runtime/elicitation-abort-binding.ts";

/**
 * Round 8 regression for round 6/7's abort-listener leak.
 *
 * These tests exercise the PRODUCTION helper that the worker's `onElicitation`
 * calls (`bindElicitationAbort`), not a re-implementation of add/remove in the
 * test body. The previous version of this suite built its own signal and
 * called the APIs itself, so deleting the worker's cleanup left it green —
 * exactly the gap the review flagged.
 *
 * The seam matters: the real AbortSignal lives inside the worker process, so a
 * host-side E2E cannot observe the listener count. Making the protocol a
 * function both sides share is what makes the regression real.
 */

/** Minimal AbortSignal stand-in with an observable live-listener count. */
class SpySignal {
  aborted = false;
  readonly reason = undefined;
  onabort: unknown = null;
  private listeners = new Set<() => void>();
  added = 0;
  removed = 0;

  addEventListener(_type: string, listener: () => void): void {
    this.added += 1;
    this.listeners.add(listener);
  }

  removeEventListener(_type: string, listener: () => void): void {
    this.removed += 1;
    this.listeners.delete(listener);
  }

  throwIfAborted(): void {}

  get liveListeners(): number {
    return this.listeners.size;
  }

  abort(): void {
    this.aborted = true;
    for (const listener of [...this.listeners]) listener();
  }
}

function asSignal(spy: SpySignal): AbortSignal {
  return spy as unknown as AbortSignal;
}

test("release() on the success path removes the registered listener", () => {
  // This is the exact call the worker's `finally` makes. If the worker stopped
  // calling `abort.release()`, this binding would still hold the listener — and
  // a test that drives the same helper through the worker would fail.
  const signal = new SpySignal();
  let fired = 0;
  const binding = bindElicitationAbort(asSignal(signal), () => {
    fired += 1;
  });

  expect(signal.added).toBe(1);
  expect(signal.liveListeners).toBe(1);

  binding.release();

  expect(signal.removed).toBe(1);
  expect(signal.liveListeners).toBe(0);
  // Releasing must not trigger the abort handler.
  expect(fired).toBe(0);
});

test("an actual abort fires the handler and self-removes", () => {
  const signal = new SpySignal();
  let fired = 0;
  bindElicitationAbort(asSignal(signal), () => {
    fired += 1;
  });

  signal.abort();

  expect(fired).toBe(1);
  expect(signal.liveListeners).toBe(0);
});

test("release() after an abort is a no-op, not a double-remove", () => {
  const signal = new SpySignal();
  const binding = bindElicitationAbort(asSignal(signal), () => {});

  signal.abort();
  const removedAfterAbort = signal.removed;

  // The worker's `finally` runs on the abort path too.
  binding.release();

  expect(signal.removed).toBe(removedAfterAbort);
  expect(signal.liveListeners).toBe(0);
});

test("an already-aborted signal fires immediately and registers nothing", () => {
  const signal = new SpySignal();
  signal.aborted = true;
  let fired = 0;
  const binding = bindElicitationAbort(asSignal(signal), () => {
    fired += 1;
  });

  expect(fired).toBe(1);
  expect(signal.added).toBe(0);
  expect(signal.liveListeners).toBe(0);

  // `finally` still runs; it must not throw or mis-count.
  binding.release();
  expect(signal.removed).toBe(0);
});

test("repeated successful elicitations leave no accumulated listeners", () => {
  // One long turn with several elicitations is the round 6 accumulation case.
  const signal = new SpySignal();
  for (let i = 0; i < 5; i += 1) {
    const binding = bindElicitationAbort(asSignal(signal), () => {});
    binding.release();
  }
  expect(signal.added).toBe(5);
  expect(signal.removed).toBe(5);
  expect(signal.liveListeners).toBe(0);
});

test("the worker path really calls release()", async () => {
  // Guards the seam itself: if `runtime-worker-main.ts` stopped calling
  // `abort.release()` in its `finally`, this would not compile-fail — so the
  // worker source is asserted to reference it. A structural guard, but it is
  // the cheapest way to catch the seam being bypassed.
  const source = await Bun.file("src/bridge/engine/runtime/runtime-worker-main.ts").text();
  expect(source).toContain("bindElicitationAbort(");
  expect(source).toContain("abort.release()");
}, 5_000);
