export const ACPX_QUEUE_MESSAGE_OVERFLOW_CODE = "ACPX_QUEUE_MESSAGE_OVERFLOW" as const;

const QUEUE_BUFFER_OVERFLOW_PATTERN = /Message buffer exceeded \d+ bytes/i;
const QUEUE_EVENT_TOO_LARGE_PATTERN = /\bQUEUE_EVENT_TOO_LARGE\b/i;
const QUEUE_MESSAGE_OVERFLOW_PATTERN = /\bQUEUE_MESSAGE_OVERFLOW\b/i;
const ACPX_QUEUE_OVERFLOW_CODE_PATTERN = /\bACPX_QUEUE_MESSAGE_OVERFLOW\b/i;
const MAX_CLEANUP_DIAGNOSTIC_LENGTH = 512;
export interface AcpxQueueCleanupResult {
  cancelAttempted: boolean;
  cancelSucceeded: boolean;
  ownerTerminationAttempted: boolean;
  ownerTerminationSucceeded: boolean;
  diagnostic?: string;
}

/**
 * Detects both the acpx 0.13 queue client's legacy string error and the typed
 * error emitted by a guarded queue owner. Prompt failures can be represented
 * as Error instances, PromptCommandError-like objects, or plain JSON payloads
 * after crossing the bridge, so inspect only the bounded diagnostic fields we
 * control instead of depending on one concrete error class.
 */
export function isAcpxQueueMessageOverflow(error: unknown): boolean {
  const seen = new Set<unknown>();
  const diagnostics: string[] = [];

  const visit = (value: unknown, depth: number): void => {
    if (value === null || value === undefined || depth > 2 || seen.has(value)) return;
    if (typeof value === "string") {
      diagnostics.push(value);
      return;
    }
    if (typeof value !== "object") return;
    seen.add(value);

    const record = value as Record<string, unknown>;
    // Field-sensitive: only trust transport diagnostics (message/code/stderr).
    // Do NOT scan raw stdout — it contains agent ACP session/update content
    // (agent_message_chunk) and can be polluted by the model discussing the
    // error code. A provider failure with agent stdout containing
    // QUEUE_MESSAGE_OVERFLOW must not trigger destructive cancel+terminate.
    for (const key of ["message", "code", "stderr"]) {
      const field = record[key];
      if (typeof field === "string") diagnostics.push(field);
    }
    visit(record.cause, depth + 1);
  };

  visit(error, 0);
  return diagnostics.some((text) =>
    text === ACPX_QUEUE_MESSAGE_OVERFLOW_CODE ||
    ACPX_QUEUE_OVERFLOW_CODE_PATTERN.test(text) ||
    QUEUE_BUFFER_OVERFLOW_PATTERN.test(text) ||
    QUEUE_EVENT_TOO_LARGE_PATTERN.test(text) ||
    QUEUE_MESSAGE_OVERFLOW_PATTERN.test(text),
  );
}

export class AcpxQueueOverflowError extends Error {
  readonly code = ACPX_QUEUE_MESSAGE_OVERFLOW_CODE;
  readonly cleanupDiagnostic?: string;
  readonly cleanup?: AcpxQueueCleanupResult;

  constructor(cleanup?: AcpxQueueCleanupResult | string) {
    const normalizedCleanup: AcpxQueueCleanupResult | undefined = typeof cleanup === "string"
      ? {
          cancelAttempted: false,
          cancelSucceeded: false,
          ownerTerminationAttempted: false,
          ownerTerminationSucceeded: false,
          diagnostic: cleanup,
        }
      : cleanup;
    const cleanupStatus = normalizedCleanup?.ownerTerminationSucceeded
      ? "The local agent queue was stopped to prevent the turn from continuing in the background."
      : normalizedCleanup?.cancelSucceeded
        ? "The running agent turn was cancelled, but local queue-owner termination was not confirmed."
        : "Cleanup of the running agent turn could not be confirmed.";
    const boundedDiagnostic = normalizedCleanup?.diagnostic
      ? normalizedCleanup.diagnostic.slice(0, MAX_CLEANUP_DIAGNOSTIC_LENGTH)
      : undefined;
    const baseMessage =
      `Agent emitted an oversized ACP event. ${cleanupStatus} ` +
      "The prompt was not retried automatically.";
    super(boundedDiagnostic ? `${baseMessage} Cleanup diagnostic: ${boundedDiagnostic}` : baseMessage);
    this.name = "AcpxQueueOverflowError";
    this.cleanupDiagnostic = boundedDiagnostic;
    this.cleanup = normalizedCleanup;
  }
}
