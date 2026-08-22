export type AgentMessagingErrorCode =
  | "TARGET_NOT_FOUND"
  | "TARGET_AMBIGUOUS"
  | "TARGET_NOT_REACHABLE"
  | "TARGET_UNAVAILABLE"
  | "TARGET_NODE_OFFLINE"
  | "ROUTE_UNAVAILABLE"
  | "TARGET_NOT_RUNNING"
  | "TARGET_NOT_STEERABLE"
  | "TARGET_NOT_INTERRUPTIBLE"
  | "MESSAGE_TOO_LARGE"
  | "MESSAGE_QUEUE_FULL"
  | "MESSAGE_RATE_LIMITED"
  | "SELF_MESSAGE_NOT_ALLOWED"
  | "DELIVERY_RACE"
  | "DELIVERY_TIMEOUT"
  | "DELIVERY_FAILED"
  | "DELIVERY_DENIED"
  | "REPLY_CONTEXT_UNAVAILABLE"
  | "REPLY_TARGET_MISMATCH"
  | "REPLY_NOT_SUPPORTED"
  | "CONVERSATION_LIMIT_REACHED"
  | "DUPLICATE_MESSAGE"
  | "COMPLETION_NOT_SUPPORTED";
export const AGENT_MESSAGING_ERROR_CODES: ReadonlySet<string> = new Set([
  "TARGET_NOT_FOUND",
  "TARGET_AMBIGUOUS",
  "TARGET_NOT_REACHABLE",
  "TARGET_UNAVAILABLE",
  "TARGET_NODE_OFFLINE",
  "ROUTE_UNAVAILABLE",
  "TARGET_NOT_RUNNING",
  "TARGET_NOT_STEERABLE",
  "TARGET_NOT_INTERRUPTIBLE",
  "MESSAGE_TOO_LARGE",
  "MESSAGE_QUEUE_FULL",
  "MESSAGE_RATE_LIMITED",
  "SELF_MESSAGE_NOT_ALLOWED",
  "DELIVERY_RACE",
  "DELIVERY_TIMEOUT",
  "DELIVERY_FAILED",
  "DELIVERY_DENIED",
  "REPLY_CONTEXT_UNAVAILABLE",
  "REPLY_TARGET_MISMATCH",
  "REPLY_NOT_SUPPORTED",
  "CONVERSATION_LIMIT_REACHED",
  "DUPLICATE_MESSAGE",
  "COMPLETION_NOT_SUPPORTED",
]);

export function isAgentMessagingErrorCode(
  code: unknown,
): code is AgentMessagingErrorCode {
  return typeof code === "string" && AGENT_MESSAGING_ERROR_CODES.has(code);
}

/**
 * Typed business failures — the target/hub definitively rejected the message and
 * retrying with the same messageId cannot change the outcome. These MUST NOT be
 * retried by the source route (the requirement is a bounded retry for AMBIGUOUS
 * network failures only).
 */
const NON_RETRYABLE_DELIVERY_CODES: ReadonlySet<AgentMessagingErrorCode> =
  new Set([
    "TARGET_NOT_FOUND",
    "TARGET_AMBIGUOUS",
    "TARGET_NOT_REACHABLE",
    "TARGET_UNAVAILABLE",
    "TARGET_NODE_OFFLINE",
    "ROUTE_UNAVAILABLE",
    "TARGET_NOT_RUNNING",
    "TARGET_NOT_STEERABLE",
    "TARGET_NOT_INTERRUPTIBLE",
    "MESSAGE_TOO_LARGE",
    "MESSAGE_QUEUE_FULL",
    "MESSAGE_RATE_LIMITED",
    "SELF_MESSAGE_NOT_ALLOWED",
    "DELIVERY_RACE",
    "DELIVERY_DENIED",
    "REPLY_CONTEXT_UNAVAILABLE",
    "REPLY_TARGET_MISMATCH",
    "REPLY_NOT_SUPPORTED",
    "CONVERSATION_LIMIT_REACHED",
    "DUPLICATE_MESSAGE",
    "COMPLETION_NOT_SUPPORTED",
  ]);

/**
 * True when the failure is an ambiguous network-level outcome (response lost,
 * timeout, transport offline, or an unclassified delivery failure) where the
 * target MAY have accepted the message — a same-messageId retry is safe because
 * the destination deduplicates. False for typed business failures.
 */
export function isAmbiguousDeliveryError(error: unknown): boolean {
  if (error instanceof AgentMessagingError) {
    return !NON_RETRYABLE_DELIVERY_CODES.has(error.code);
  }
  // The transport surface (RelayClient) rejects with `Error(<code>)` when the
  // hub answered with a typed business error — classify it identically so those
  // are never retried.
  if (error instanceof Error && isAgentMessagingErrorCode(error.message)) {
    return !NON_RETRYABLE_DELIVERY_CODES.has(
      error.message as AgentMessagingErrorCode,
    );
  }
  // `relay-offline` is DEFINITE, not ambiguous: RelayClient refused to send
  // because the socket was not ready — nothing left the process, so a same-id
  // retry can never have been injected. The default retry cadence (~450ms for
  // three attempts) also exhausts before the ~1s first reconnect, so retrying
  // cannot recover; fail fast instead and let the caller decide.
  if (error instanceof Error && error.message === "relay-offline") {
    return false;
  }
  // Raw transport errors (timeout, socket errors) are ambiguous.
  return true;
}

export class AgentMessagingError extends Error {
  override readonly name = "AgentMessagingError";

  constructor(
    readonly code: AgentMessagingErrorCode,
    message: string,
  ) {
    super(message);
  }
}
