import { computed, onBeforeUnmount, onMounted, ref, type ComputedRef, type Ref } from "vue";

/**
 * One clock for every "how long did this take" label in the run detail.
 *
 * The member header and the run-level line both show a duration, and they must
 * agree: a live turn counts up from its start, a finished one freezes at its
 * recorded finish, and a historical attempt never grows a synthetic live timer
 * (it reports the outcome it actually had, or nothing).
 */
export interface DurationClock {
  startedAt?: string;
  finishedAt?: string;
  /** The caller's own activity rule — a member counts as active while
   *  running/dispatched, a run only while running. */
  active: boolean;
}

/** `m:ss`, or undefined when there is no honest interval to show. Pure. */
export function formatDurationClock(clock: DurationClock, now: number): string | undefined {
  if (!clock.startedAt) return undefined;
  if (!clock.finishedAt && !clock.active) return undefined;
  const start = Date.parse(clock.startedAt);
  const end = clock.finishedAt ? Date.parse(clock.finishedAt) : now;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined;
  const seconds = Math.floor((end - start) / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** A member turn's interval, or undefined while a historical attempt is selected. */
export function memberDurationClock(
  member: { startedAt?: string; finishedAt?: string; state: string; attempt?: number } | undefined,
  selectedAttempt: number | undefined,
): DurationClock | undefined {
  if (!member) return undefined;
  // A historical attempt keeps its recorded outcome; the live clock belongs to
  // the member's current attempt only.
  if (selectedAttempt !== undefined && selectedAttempt !== member.attempt) return undefined;
  return {
    startedAt: member.startedAt,
    finishedAt: member.finishedAt,
    active: member.state === "running" || member.state === "dispatched",
  };
}

/** A 1s wall clock owned by the calling component. */
export function useNow(): Ref<number> {
  const now = ref(Date.now());
  let timer: ReturnType<typeof setInterval> | undefined;
  onMounted(() => { timer = setInterval(() => { now.value = Date.now(); }, 1000); });
  onBeforeUnmount(() => clearInterval(timer));
  return now;
}

/** Reactive duration for one clock source; re-evaluates every second. */
export function useLiveDuration(source: () => DurationClock | undefined): ComputedRef<string | undefined> {
  const now = useNow();
  return computed(() => {
    const clock = source();
    return clock ? formatDurationClock(clock, now.value) : undefined;
  });
}
