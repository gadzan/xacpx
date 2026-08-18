export type SessionMessageMode = "auto" | "steer" | "queue" | "interrupt";

export type MessageInjectionErrorCode =
  | "TARGET_NOT_RUNNING"
  | "TARGET_NOT_STEERABLE"
  | "TARGET_NOT_INTERRUPTIBLE"
  | "DELIVERY_RACE"
  | "DELIVERY_TIMEOUT"
  | "DELIVERY_FAILED";

const MESSAGE_INJECTION_ERROR_CODES = new Set<MessageInjectionErrorCode>([
  "TARGET_NOT_RUNNING",
  "TARGET_NOT_STEERABLE",
  "TARGET_NOT_INTERRUPTIBLE",
  "DELIVERY_RACE",
  "DELIVERY_TIMEOUT",
  "DELIVERY_FAILED",
]);

export class MessageInjectionError extends Error {
  override readonly name = "MessageInjectionError";

  constructor(
    readonly code: MessageInjectionErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export function isMessageInjectionErrorCode(
  value: unknown,
): value is MessageInjectionErrorCode {
  return (
    typeof value === "string" &&
    MESSAGE_INJECTION_ERROR_CODES.has(value as MessageInjectionErrorCode)
  );
}

export interface SessionMessageInput {
  text: string;
  messageId: string;
  mode: SessionMessageMode;
}

export interface SessionMessageReceipt {
  status: "injected" | "queued";
  modeUsed: "steer" | "queue" | "interrupt" | "prompt";
  targetState?: "idle" | "running";
}
