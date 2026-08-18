export type AgentMessagingErrorCode =
  | "TARGET_NOT_REACHABLE"
  | "TARGET_UNAVAILABLE"
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

export class AgentMessagingError extends Error {
  override readonly name = "AgentMessagingError";

  constructor(
    readonly code: AgentMessagingErrorCode,
    message: string,
  ) {
    super(message);
  }
}
