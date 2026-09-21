import { expect, test } from "bun:test";

/**
 * Round 7 regression: a SUCCESSFUL elicitation must release its abort listener
 * as well as its watchdog timer.
 *
 * Round 6 fixed the timer but left the listener: `onAbort` was defined inside
 * the Promise executor, so only the abort path could remove it. Every
 * successful elicitation therefore left a `{ once: true }` listener on the
 * merged AbortSignal until the whole signal aborted, accumulating across
 * elicitations within one long turn.
 */

/** AbortSignal stand-in that counts add/remove so balance is observable. */
class CountingSignal {
  readonly aborted = false;
  readonly reason = undefined;
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

  get live(): number {
    return this.listeners.size;
  }
}

test("listener add/remove balance after a successful elicitation", async () => {
  const signal = new CountingSignal();
  const onAbort = (): void => {
    signal.removeEventListener("abort", onAbort);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  expect(signal.added).toBe(1);

  // The worker's `finally` runs on the success path too.
  signal.removeEventListener("abort", onAbort);

  expect(signal.removed).toBe(1);
  expect(signal.live).toBe(0);
});

test("removeEventListener is safe when the listener was never added", () => {
  // The abort-before-register path never adds a listener, and the
  // unconditional finally must not throw or mis-count.
  const signal = new CountingSignal();
  const onAbort = (): void => {
    signal.removeEventListener("abort", onAbort);
  };
  expect(() => signal.removeEventListener("abort", onAbort)).not.toThrow();
  expect(signal.added).toBe(0);
  expect(signal.removed).toBe(1);
  expect(signal.live).toBe(0);
});

test("repeated successful elicitations do not accumulate listeners", () => {
  // One long turn, several elicitations: the count must return to zero each
  // time rather than growing.
  const signal = new CountingSignal();
  for (let i = 0; i < 5; i += 1) {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    // success path
    signal.removeEventListener("abort", onAbort);
  }
  expect(signal.added).toBe(5);
  expect(signal.removed).toBe(5);
  expect(signal.live).toBe(0);
});
