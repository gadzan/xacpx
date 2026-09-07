/**
 * xacpx-owned narrow view of the acpx Runtime public contract (plan §11/§42).
 * NO acpx imports here — this file is the stable internal vocabulary; only
 * runtime-adapter.ts may import "acpx/runtime" and translate to these types.
 */

export type XacpxPermissionMode = "approve-all" | "approve-reads" | "deny-all";
export type XacpxNonInteractivePermissions = "deny" | "fail";

/** Streamed runtime turn event, shaped for the bridge prompt.* mapping. */
export type XacpxRuntimeEvent =
  | { type: "text_delta"; text: string; stream?: "output" | "thought" }
  | {
      type: "status";
      text: string;
      tag?: string;
      used?: number;
      size?: number;
      cost?: { amount?: number; currency?: string };
      breakdown?: UsageBreakdownLike;
      availableCommands?: Array<{ name: string; description?: string }>;
    }
  | {
      type: "tool_call";
      text: string;
      toolCallId?: string;
      status?: string;
      title?: string;
      kind?: string;
      locations?: unknown;
      rawInput?: unknown;
      rawOutput?: unknown;
      content?: unknown;
    };
export interface UsageBreakdownLike {
  inputTokens?: number;
  outputTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  thoughtTokens?: number;
  totalTokens?: number;
}

export type XacpxTurnResult =
  | { status: "completed"; stopReason?: string }
  | { status: "cancelled"; stopReason?: string }
  | { status: "failed"; error: { message: string; code?: string; detailCode?: string; retryable?: boolean } };

export interface XacpxTurnHandle {
  requestId: string;
  promptStarted: Promise<void>;
  events: AsyncIterable<XacpxRuntimeEvent>;
  result: Promise<XacpxTurnResult>;
  /** Aborts the in-flight turn; resolves when cancellation is delivered. */
  cancel(): Promise<void>;
}

export interface XacpxRuntimeSessionHandle {
  sessionKey: string;
  runtimeSessionName: string;
  acpxRecordId?: string;
  agentSessionId?: string;
}

/** Stable xacpx-internal error codes — never expose upstream detailCodes. */
export type RuntimeBridgeErrorCode =
  | "RUNTIME_SESSION_MISSING"
  | "RUNTIME_INIT_FAILED"
  | "RUNTIME_TURN_FAILED"
  | "RUNTIME_TURN_CANCELLED"
  | "RUNTIME_PERMISSION_DENIED"
  | "RUNTIME_PERMISSION_BUSY"
  | "RUNTIME_WORKER_CRASHED"
  | "RUNTIME_WORKER_POISONED_INIT"
  | "RUNTIME_WORKER_TEARDOWN_PENDING"
  | "RUNTIME_QUEUE_OVERFLOW"
  | "RUNTIME_ENGINE_UNSUPPORTED";

export function mapRuntimeError(err: unknown): { code: RuntimeBridgeErrorCode; message: string } {
  const message = err instanceof Error ? err.message : String(err);
  const rawCode = (err as { code?: unknown } | null)?.code;
  const name = (err as { name?: string } | null)?.name ?? "";
  const codeText = typeof rawCode === "string" ? rawCode : "";
  // Poisoned-init is an explicit worker signal — never let the message
  // regexes below reclassify it.
  if (codeText === "RUNTIME_WORKER_POISONED_INIT") {
    return { code: "RUNTIME_WORKER_POISONED_INIT", message };
  }
  if (codeText === "RUNTIME_TURN_CANCELLED" || /cancel/i.test(message) || /cancel/i.test(codeText)) {
    return { code: "RUNTIME_TURN_CANCELLED", message };
  }
  if (/not found|missing|no such session|unknown session/i.test(message) || codeText === "ACP_BACKEND_MISSING") {
    return { code: "RUNTIME_SESSION_MISSING", message };
  }
  if (/permission/i.test(message) || codeText === "PERMISSION_DENIED" || codeText === "RUNTIME_PERMISSION_DENIED") {
    return { code: "RUNTIME_PERMISSION_DENIED", message };
  }
  if (name === "AcpRuntimeError" || /runtime|init|backend/i.test(message) || codeText === "RUNTIME_INIT_FAILED") {
    return { code: "RUNTIME_INIT_FAILED", message };
  }
  return { code: "RUNTIME_TURN_FAILED", message };
}
