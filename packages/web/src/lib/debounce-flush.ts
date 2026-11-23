/** Trailing-edge debouncer with a synchronous flush, for hot persistence paths
 *  (drafts / tab state) that used to write sessionStorage on every keystroke.
 *
 *  Semantics contract: callers MUST pair `schedule()` with a `flush()` on
 *  `pagehide` (and component unmount) so a reload/close never loses the last
 *  few hundred milliseconds of input — the reload-restore features depend on it.
 *  `flush()` runs the callback only when a write is actually pending, so idle
 *  instances never clobber storage with stale state. */
export interface DebouncedFlush {
  /** (Re)start the trailing timer; the callback runs once, `delayMs` after the last call. */
  schedule(): void;
  /** Run a pending callback NOW (synchronously). No-op when nothing is pending. */
  flush(): void;
  /** Drop a pending callback without running it. */
  cancel(): void;
  /** Whether a callback is currently scheduled. */
  readonly pending: boolean;
}

export function createDebouncedFlush(fn: () => void, delayMs: number): DebouncedFlush {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    schedule(): void {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        fn();
      }, delayMs);
    },
    flush(): void {
      if (timer === null) return;
      clearTimeout(timer);
      timer = null;
      fn();
    },
    cancel(): void {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
    get pending(): boolean {
      return timer !== null;
    },
  };
}
