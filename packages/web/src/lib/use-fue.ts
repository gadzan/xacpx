import { ref, type Ref } from "vue";

/** First-User-Experience primitive (borrowed from HAPI's `use-fue.ts`).
 *
 *  A per-feature, localStorage-backed onboarding state machine so existing users
 *  discover a new affordance without a permanent always-visible UI block. Three
 *  states: `unseen` (never engaged) → `engaging` (user just touched the affordance,
 *  show a one-time callout) → `acknowledged` (dismissed, never show again). There is
 *  NO auto-timeout by design — the user dismisses explicitly.
 *
 *  Call `useFue(featureId)` ONCE per affordance and pass `status` down to `FueDot`;
 *  separate `useFue` instances for the same id do not share reactive state. */
export type FueStatus = "unseen" | "engaging" | "acknowledged";

const STORAGE_PREFIX = "xacpx.fue.v1.";

function read(featureId: string): boolean {
  try {
    return localStorage.getItem(STORAGE_PREFIX + featureId) === "1";
  } catch {
    return false;
  }
}

function persist(featureId: string): void {
  try {
    localStorage.setItem(STORAGE_PREFIX + featureId, "1");
  } catch {
    /* private mode / storage disabled — degrade to in-memory only */
  }
}

export interface Fue {
  status: Ref<FueStatus>;
  /** The user touched the affordance: surface the callout (only from `unseen`). */
  engage(): void;
  /** The user dismissed the callout: never show it again. */
  dismiss(): void;
}

export function useFue(featureId: string): Fue {
  const status = ref<FueStatus>(read(featureId) ? "acknowledged" : "unseen");

  function engage(): void {
    if (status.value === "unseen") status.value = "engaging";
  }

  function dismiss(): void {
    status.value = "acknowledged";
    persist(featureId);
  }

  return { status, engage, dismiss };
}

/** Test/debug helper: forget a feature's acknowledgement. */
export function resetFue(featureId: string): void {
  try {
    localStorage.removeItem(STORAGE_PREFIX + featureId);
  } catch {
    /* ignore */
  }
}
