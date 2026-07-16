/**
 * Shared time bounds for one-shot acpx subprocess commands.
 *
 * Session-scoped requests run through a serial per-session scheduler (a `tail`
 * promise chain), so a single command that never settles wedges every later
 * request for that session forever. These constants bound the non-prompt
 * ("management") commands so a stuck acpx rejects — and unblocks the lane —
 * instead of deadlocking it. Streaming prompts are intentionally NOT bounded
 * by a total-duration timeout: long agent turns are legitimate.
 */

/**
 * Default timeout for one-shot management commands (sessions show/close,
 * cancel, set-mode, set model, status, history). These normally finish in
 * well under a second; 30s only trips when acpx itself is hung.
 */
export const DEFAULT_MANAGEMENT_COMMAND_TIMEOUT_MS = 30_000;

/**
 * Default timeout for session initialization (sessions new / ensure / resume).
 * Mirrors the long-standing `sessionInitTimeoutMs ?? 120_000` default used by
 * both transports (agent cold start, adapter download, auth handshake).
 */
export const DEFAULT_SESSION_INIT_TIMEOUT_MS = 120_000;

/**
 * Grace added on top of the subprocess-side timeout for the bridge client's
 * per-request timeout, so the subprocess-side timeout (which carries the
 * better error message and kills the hung process tree) always fires first
 * and the client-side timeout is only a backstop for lost/undecodable
 * responses.
 */
export const BRIDGE_REQUEST_TIMEOUT_GRACE_MS = 15_000;

const COMMAND_OUTPUT_TAIL_CHARS = 2_000;

/** Stable diagnostic stages shared by both acpx transports. */
export type AcpxCommandStage =
  | "has-session"
  | "session-history"
  | "read-session-record"
  | "set-mode"
  | "set-model"
  | "get-session-model"
  | "cancel"
  | "remove-session";

/** Timeout from a one-shot acpx command, with bounded diagnostics safe to retain. */
export class CommandTimeoutError extends Error {
  readonly stage?: AcpxCommandStage;
  readonly stdoutTail?: string;
  readonly stderrTail?: string;

  constructor(
    readonly timeoutMs: number,
    readonly command: string,
    detail: { stage?: AcpxCommandStage; stdout?: string; stderr?: string } = {},
  ) {
    const stdoutTail = captureOutputTail(detail.stdout);
    const stderrTail = captureOutputTail(detail.stderr);
    const output = [
      stdoutTail ? `stdout tail: ${stdoutTail}` : "",
      stderrTail ? `stderr tail: ${stderrTail}` : "",
    ].filter(Boolean).join("; ");
    super(
      `acpx command timed out${detail.stage ? ` during ${detail.stage}` : ""} after ${formatTimeout(timeoutMs)}: ${command}`
      + (output ? `; ${output}` : ""),
    );
    this.name = "CommandTimeoutError";
    this.stage = detail.stage;
    this.stdoutTail = stdoutTail;
    this.stderrTail = stderrTail;
  }
}

function formatTimeout(timeoutMs: number): string {
  return timeoutMs >= 1_000 ? `${timeoutMs / 1_000}s` : `${timeoutMs}ms`;
}

function captureOutputTail(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  return normalized.slice(-COMMAND_OUTPUT_TAIL_CHARS);
}

/** Structured identity check used before state-changing timeout reconciliation. */
export function isCommandTimeoutError(error: unknown): boolean {
  return error instanceof CommandTimeoutError;
}
