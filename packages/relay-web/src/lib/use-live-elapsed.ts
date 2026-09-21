import { onBeforeUnmount, readonly, ref, watch } from "vue";

/**
 * Live elapsed timer for a tool step that is still running.
 *
 * `startedAt` is the connector's first-frame stamp (step-level). While the step
 * runs there is no connector `durationMs` yet, so the UI counts up locally; once
 * the step is terminal the connector-measured duration is authoritative and the
 * local clock stops, so nothing drifts after the turn ends and there is no
 * interval left running on history rows.
 *
 * Shared by `ToolStepCard` and the legacy `ToolCallPanel` — both surfaces must
 * agree on the format and the lifecycle, and a 1s interval per card row is not
 * something to maintain twice.
 */
export function useLiveElapsed(startedAt: () => number | undefined, running: () => boolean) {
  const nowMs = ref(Date.now());
  let timer: NodeJS.Timeout | undefined;

  const stop = (): void => {
    if (timer === undefined) return;
    clearInterval(timer);
    timer = undefined;
  };

  watch(
    running,
    (isRunning) => {
      stop();
      if (!isRunning) return;
      nowMs.value = Date.now();
      timer = setInterval(() => { nowMs.value = Date.now(); }, 1000);
    },
    { immediate: true },
  );

  onBeforeUnmount(stop);

  /** Elapsed ms, or undefined when there is nothing to count (no stamp, or the
   *  step already finished and the connector reported its duration). */
  const elapsedMs = (): number | undefined => {
    const from = startedAt();
    if (from === undefined) return undefined;
    return Math.max(0, nowMs.value - from);
  };

  return { elapsedMs, nowMs: readonly(nowMs) };
}

/** `400ms` / `3.1s` — the step-row duration format shared by both surfaces. */
export function formatStepDuration(ms: number | undefined): string {
  if (ms === undefined) return "";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

/**
 * Same clock for a surface that renders MANY steps (the legacy aggregate panel).
 * One interval for the whole list rather than one per row, running only while at
 * least one step is still running and stamped.
 */
export function useLiveElapsedClock(running: () => boolean) {
  const nowMs = ref(Date.now());
  let timer: NodeJS.Timeout | undefined;

  const stop = (): void => {
    if (timer === undefined) return;
    clearInterval(timer);
    timer = undefined;
  };

  watch(
    running,
    (on) => {
      stop();
      if (!on) return;
      nowMs.value = Date.now();
      timer = setInterval(() => { nowMs.value = Date.now(); }, 1000);
    },
    { immediate: true },
  );

  onBeforeUnmount(stop);

  return { nowMs };
}
