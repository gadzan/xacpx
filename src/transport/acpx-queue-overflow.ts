export const ACPX_QUEUE_MESSAGE_OVERFLOW_CODE = "ACPX_QUEUE_MESSAGE_OVERFLOW" as const;

const QUEUE_BUFFER_OVERFLOW_PATTERN = /Message buffer exceeded \d+ bytes/i;
const QUEUE_EVENT_TOO_LARGE_PATTERN = /\bQUEUE_EVENT_TOO_LARGE\b/i;
const QUEUE_MESSAGE_OVERFLOW_PATTERN = /\bQUEUE_MESSAGE_OVERFLOW\b/i;
const MAX_CLEANUP_DIAGNOSTIC_LENGTH = 512;

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
    for (const key of ["message", "code", "stdout", "stderr"]) {
      const field = record[key];
      if (typeof field === "string") diagnostics.push(field);
    }
    visit(record.cause, depth + 1);
  };

  visit(error, 0);
  return diagnostics.some((text) =>
    QUEUE_BUFFER_OVERFLOW_PATTERN.test(text) ||
    QUEUE_EVENT_TOO_LARGE_PATTERN.test(text) ||
    QUEUE_MESSAGE_OVERFLOW_PATTERN.test(text));
}

export class AcpxQueueOverflowError extends Error {
  readonly code = ACPX_QUEUE_MESSAGE_OVERFLOW_CODE;
  readonly cleanupDiagnostic?: string;

  constructor(cleanupDiagnostic?: string) {
    const baseMessage =
      "Agent emitted an oversized ACP event. The local agent queue was stopped " +
      "to prevent the turn from continuing in the background. The prompt was " +
      "not retried automatically.";
    const boundedDiagnostic = cleanupDiagnostic
      ? cleanupDiagnostic.slice(0, MAX_CLEANUP_DIAGNOSTIC_LENGTH)
      : undefined;
    super(boundedDiagnostic ? `${baseMessage} Cleanup diagnostic: ${boundedDiagnostic}` : baseMessage);
    this.name = "AcpxQueueOverflowError";
    this.cleanupDiagnostic = boundedDiagnostic;
  }
}
