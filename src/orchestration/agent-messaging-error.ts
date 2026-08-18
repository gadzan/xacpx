export type AgentMessagingErrorCode =
  | "TARGET_NOT_FOUND"
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
  | "DELIVERY_DENIED";

export const AGENT_MESSAGING_ERROR_CODES: ReadonlySet<string> = new Set([
  "TARGET_NOT_FOUND",
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
]);

export function isAgentMessagingErrorCode(
  code: unknown,
): code is AgentMessagingErrorCode {
  return typeof code === "string" && AGENT_MESSAGING_ERROR_CODES.has(code);
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
