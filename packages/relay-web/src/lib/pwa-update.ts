// A `registerType: "autoUpdate"` service worker silently activates + reloads the
// page once the browser DISCOVERS a new worker — but discovery only happens on
// navigation, on a manual reload, or via the browser's own ~24h check. A tab left
// open therefore keeps serving the old bundle indefinitely. These checks force the
// discovery: poll on an interval and whenever the tab becomes visible again, so an
// open dashboard picks up a deploy within ~1 minute (or instantly on tab focus) and
// autoUpdate reloads it.

/** Minimal shape we need from a ServiceWorkerRegistration — keeps this testable. */
export interface UpdatableRegistration {
  update: () => unknown;
}

/** Minimal slice of `document` we use — narrow so a fake is assignable in tests
 *  while the real `document` (a superset) still satisfies it. */
export interface VisibilityDoc {
  visibilityState: DocumentVisibilityState;
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
}

export interface SchedulePwaUpdateOptions {
  /** Poll interval in ms (default 60s). */
  intervalMs?: number;
  /** Injected for tests; defaults to the global document. */
  doc?: VisibilityDoc;
  /** Injected for tests; defaults to global setInterval/clearInterval. */
  setIntervalFn?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearIntervalFn?: (handle: ReturnType<typeof setInterval>) => void;
}

/**
 * Periodically ask the service worker registration to check for a new worker, and
 * also check the moment the tab regains visibility. Returns a teardown function that
 * stops the timer and removes the listener. No-ops (returns a no-op teardown) when no
 * registration is available, e.g. in browsers without service-worker support.
 */
export function schedulePwaUpdateChecks(
  registration: UpdatableRegistration | undefined,
  opts: SchedulePwaUpdateOptions = {},
): () => void {
  if (!registration) return () => {};

  const intervalMs = opts.intervalMs ?? 60_000;
  const doc = opts.doc ?? (typeof document !== "undefined" ? document : undefined);
  const setIntervalFn = opts.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms));
  const clearIntervalFn = opts.clearIntervalFn ?? ((h) => clearInterval(h));

  const check = () => {
    // update() rejects (e.g. offline) far more often than it throws; swallow both so
    // a failed poll never bubbles into an unhandled rejection.
    try {
      void Promise.resolve(registration.update()).catch(() => {});
    } catch {
      /* ignore */
    }
  };

  const timer = setIntervalFn(check, intervalMs);

  // The visibility listener is only attached when a document exists, so `doc` is
  // always defined inside the handler.
  if (!doc) return () => clearIntervalFn(timer);
  const visibleDoc = doc;
  const onVisible = () => {
    if (visibleDoc.visibilityState === "visible") check();
  };
  visibleDoc.addEventListener("visibilitychange", onVisible);

  return () => {
    clearIntervalFn(timer);
    visibleDoc.removeEventListener("visibilitychange", onVisible);
  };
}
