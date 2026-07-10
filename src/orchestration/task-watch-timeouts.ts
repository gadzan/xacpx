export const DEFAULT_TASK_WATCH_TIMEOUT_MS = 60_000;
export const MAX_TASK_WATCH_TIMEOUT_MS = 20 * 60_000;
export const DEFAULT_TASK_WATCH_POLL_INTERVAL_MS = 1_000;
export const MAX_TASK_WATCH_POLL_INTERVAL_MS = 10_000;
export const TASK_WATCH_RPC_TIMEOUT_PADDING_MS = 5_000;

// An invalid timeout collapses to 0 (an immediate single-shot watch), never to
// the 60s default, so a bad value cannot silently turn into a long-poll for
// direct callers of OrchestrationService.watchTask.
export function clampWatchTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TASK_WATCH_TIMEOUT_MS;
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.min(Math.floor(value), MAX_TASK_WATCH_TIMEOUT_MS);
}

export function clampWatchPollInterval(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TASK_WATCH_POLL_INTERVAL_MS;
  if (!Number.isFinite(value) || value < 1) return DEFAULT_TASK_WATCH_POLL_INTERVAL_MS;
  return Math.min(value, MAX_TASK_WATCH_POLL_INTERVAL_MS);
}
