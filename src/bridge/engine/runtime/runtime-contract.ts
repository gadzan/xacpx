/**
 * xacpx-owned narrow view of the acpx Runtime public contract (plan §11/§42).
 * NO acpx imports here — this file is the stable internal vocabulary; only
 * runtime-adapter.ts may import "acpx/runtime" and translate to these types.
 */

export type XacpxPermissionMode = "approve-all" | "approve-reads" | "deny-all";
export type XacpxNonInteractivePermissions = "deny" | "fail";

/**
 * One normalized ACP plan entry crossing the runtime boundary. The agent
 * re-sends the WHOLE list on each update, so consumers REPLACE rather than
 * append. An empty array is an explicit replacement that clears a
 * previously displayed plan.
 */
export type XacpxPlanEntry = {
  content: string;
  status: "pending" | "in_progress" | "completed";
  priority?: "high" | "medium" | "low";
};

/** Streamed runtime turn event, shaped for the bridge prompt.* mapping. */
export type XacpxRuntimeEvent =
  | {
      type: "text_delta";
      text: string;
      stream?: "output" | "thought";
      tag?: string;
      messageId?: string;
      /**
       * Producer-supplied routing hint (e.g. subagent / worker origin);
       * never use for auth or authorization boundaries.
       */
      meta?: {
        origin?: string;
        kind?: string;
        source?: string;
      };
    }
  | {
      type: "status";
      text: string;
      tag?: string;
      used?: number;
      size?: number;
      cost?: { amount?: number; currency?: string };
      breakdown?: UsageBreakdownLike;
      availableCommands?: Array<{ name: string; description?: string }>;
      /**
       * Populated on tag === "plan" when the acpx Runtime exposes structured
       * entries. Absent on older acpx versions that flatten plan to text —
       * never fabricated from the text.
       */
      entries?: XacpxPlanEntry[];
    }
  | {
      type: "tool_call";
      text: string;
      tag?: string;
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
  // acpx 0.15.1 carries opaque producer `_meta` on completed/cancelled turns.
  // xacpx maps it to narrow `meta` (never `_meta` — that name stays upstream).
  // Opaque routing/debug hint only: never auth/authorization/ownership proof,
  // same rule as text_delta.meta. Failed turns never fabricate meta.
  | { status: "completed"; stopReason?: string; meta?: Record<string, unknown> | null }
  | { status: "cancelled"; stopReason?: string; meta?: Record<string, unknown> | null }
  | { status: "failed"; error: { message: string; code?: string; detailCode?: string; retryable?: boolean } };

/**
 * xacpx-owned narrow view of an agent-accepted config option (plan B3).
 * Only the stable identity + current value cross the adapter boundary —
 * never the upstream SDK type.
 */
export interface XacpxConfigOptionState {
  id: string;
  currentValue?: string;
}

/** Agent-accepted config snapshot returned by setConfigOption. */
export interface XacpxConfigSnapshot {
  options: XacpxConfigOptionState[];
}

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
  const detailCode = (err as { detailCode?: unknown } | null)?.detailCode;
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
  // acpx 0.15.1 stable spawn failure (detailCode over message regex): the
  // ENOENT message contains "not found", which must NOT fall through to
  // RUNTIME_SESSION_MISSING below. Upstream attaches AGENT_SPAWN_ENOENT only
  // when the underlying cause is ENOENT — a bare AgentSpawnError (e.g. a
  // lifecycle admission rejection, a PID-less spawn) is NOT proof of a
  // missing executable and must not get install/PATH remediation.
  if (detailCode === "AGENT_SPAWN_ENOENT") {
    return { code: "RUNTIME_INIT_FAILED", message: `${message} (xacpx: agent executable missing — install it, fix PATH, or correct the agent command/argv)` };
  }
  if (name === "AgentSpawnError") {
    return { code: "RUNTIME_INIT_FAILED", message };
  }
  if (/not found|missing|no such session|unknown session/i.test(message) || codeText === "ACP_BACKEND_MISSING") {
    return { code: "RUNTIME_SESSION_MISSING", message };
  }
  if (/permission/i.test(message) || codeText === "PERMISSION_DENIED" || codeText === "RUNTIME_PERMISSION_DENIED") {
    return { code: "RUNTIME_PERMISSION_DENIED", message };
  }
  // acpx 0.15.1 incoming message ceiling (default 64 MiB). Upstream already
  // names ACPX_MAX_ACP_MESSAGE_BYTES in the message; xacpx appends the
  // operational half: the limit is read once at Runtime construction, so a
  // warm worker/queue owner must be recycled for a raised value to apply.
  // Match on stable detailCode first, message second (detailCode may not
  // survive the worker JSON protocol, but the message always does).
  if (detailCode === "ACP_MESSAGE_TOO_LARGE" || /ACPX_MAX_ACP_MESSAGE_BYTES/.test(message)) {
    return {
      code: "RUNTIME_TURN_FAILED",
      message: `${message} (xacpx: the limit is read at Runtime worker/queue-owner startup — raise ACPX_MAX_ACP_MESSAGE_BYTES and recycle the worker for it to apply; do not default it to 0)`,
    };
  }
   if (name === "AcpRuntimeError" || /runtime|init|backend/i.test(message) || codeText === "RUNTIME_INIT_FAILED") {
     return { code: "RUNTIME_INIT_FAILED", message };
   }
   return { code: "RUNTIME_TURN_FAILED", message };
}
