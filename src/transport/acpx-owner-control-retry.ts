import { isAcpxQueueOwnerShuttingDownError } from "./acpx-command-builder";

export interface AcpxCommandOutcome {
  code: number;
  stdout: string;
  stderr: string;
}

const OWNER_SHUTDOWN_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000];

/**
 * Run an acpx owner-IPC control command (cancel, sessions close, set-mode, set),
 * retrying only while the queue owner is shutting down.
 *
 * acpx 0.19.x keeps the owner lease alive while the owner process exits its idle
 * TTL, and rejects control requests landing in that window with a retryable
 * QUEUE_OWNER_CLOSED. 0.16 answered the same window with a no-op. A rejected
 * request was never delivered, so re-running it after the owner is gone is
 * safe and lets acpx answer from the persisted record ("nothing to cancel", an
 * already-closed record, an applied set).
 *
 * Only a failed attempt whose output matches the owner-shutdown error is
 * retried: a successful command can mention the race on stderr, and re-running
 * a delivered `set` would double-apply it. Anything else, including an
 * owner-shutdown error that outlives the retries, returns as-is so the caller
 * still fails honestly.
 */
export async function runAcpxControlCommand(
  run: () => Promise<AcpxCommandOutcome>,
): Promise<AcpxCommandOutcome> {
  let outcome = await run();
  for (const delayMs of OWNER_SHUTDOWN_RETRY_DELAYS_MS) {
    if (outcome.code === 0 || !isAcpxQueueOwnerShuttingDownError(outcome.stderr, outcome.stdout)) {
      return outcome;
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, delayMs);
    await promise;
    outcome = await run();
  }
  return outcome;
}
