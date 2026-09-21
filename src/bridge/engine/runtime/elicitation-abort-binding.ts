/**
 * Abort-listener protocol for one pending elicitation.
 *
 * Extracted from the worker's `onElicitation` so the listener lifecycle is
 * testable on its own. Round 6 left the registration inside a Promise executor
 * and only removed the listener on the abort path, so every successful
 * elicitation leaked a `{ once: true }` listener for the rest of the turn;
 * round 7 hoisted it out. That class of bug is invisible to a test that
 * re-implements add/remove in its own body — it needs a seam that the
 * PRODUCTION path actually calls.
 */

export interface ElicitationAbortBinding {
  /** The listener, safe to pass to add/removeEventListener. */
  readonly listener: () => void;
  /**
   * Release the listener unconditionally. MUST be called from the `finally` of
   * the awaiting code so the success path releases it too. Idempotent and safe
   * when registration never happened (signal already aborted).
   */
  release(): void;
}

/**
 * Bind `onAbort` to `signal` and return the release handle.
 *
 * When the signal is already aborted, `onAbort` fires immediately and nothing
 * is registered, so `release()` is a no-op — that keeps the `finally` free of
 * branching.
 */
export function bindElicitationAbort(
  signal: AbortSignal,
  onAbort: () => void,
): ElicitationAbortBinding {
  let registered = false;
  const listener = (): void => {
    signal.removeEventListener("abort", listener);
    registered = false;
    onAbort();
  };
  if (signal.aborted) {
    onAbort();
  } else {
    signal.addEventListener("abort", listener, { once: true });
    registered = true;
  }
  return {
    listener,
    release(): void {
      if (!registered) return;
      registered = false;
      signal.removeEventListener("abort", listener);
    },
  };
}
