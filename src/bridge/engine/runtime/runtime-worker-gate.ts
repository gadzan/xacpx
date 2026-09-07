/**
 * Worker-side dispatch admission gate (round 30 Blocking 4 / Medium).
 *
 * EOF orphan convergence can only prove "tree is empty" for descendants that
 * EXIST at snapshot time. If a business RPC that spawns/mutates the owner
 * tree (ensure) is still in flight while convergence runs, a verified empty
 * snapshot proves nothing about the adapter the RPC is about to create — the
 * worker would exit and orphan it.
 *
 * The gate therefore owns two lifecycle rules:
 *   1. ADMISSION: once closed (shutdown ACK or stdin EOF), no NEW dispatch
 *      enters the worker.
 *   2. QUIESCENCE: convergence waits until every in-flight dispatch settled,
 *      so the descendant set is stable before the first snapshot. If an
 *      operation cannot settle, the worker stays alive and retrying — being
 *      a live owner is never the lesser evil over a false "verified".
 */
export interface DispatchGate {
  /** True while new dispatches may enter. */
  admit(): boolean;
  /** Track an in-flight dispatch. */
  track<T>(dispatch: Promise<T>): Promise<T>;
  /** Close admission and resolve when every in-flight dispatch settled. */
  close(): Promise<void>;
  /** Number of in-flight dispatches (diagnostics/tests). */
  readonly inFlightCount: number;
}

export function createDispatchGate(): DispatchGate {
  const inFlight = new Set<Promise<unknown>>();
  let open = true;
  return {
    admit: () => open,
    track: <T>(dispatch: Promise<T>): Promise<T> => {
      const settled = dispatch.catch(() => {});
      inFlight.add(settled);
      void settled.finally(() => inFlight.delete(settled));
      return dispatch;
    },
    close: async (): Promise<void> => {
      open = false;
      while (inFlight.size > 0) {
        await Promise.allSettled([...inFlight]);
      }
    },
    get inFlightCount(): number {
      return inFlight.size;
    },
  };
}
