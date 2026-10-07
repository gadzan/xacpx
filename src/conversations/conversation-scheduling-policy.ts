import { ConversationError } from "./conversation-error";

export const MAX_CONCURRENT_MEMBER_TURNS = 64;

export function isMemberConcurrencyLimit(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value)
    && value >= 1 && value <= MAX_CONCURRENT_MEMBER_TURNS;
}

export interface TopicSchedulingOptions {
  maxConcurrentMemberTurns?: number;
}

export function memberConcurrencyLimit(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!isMemberConcurrencyLimit(value)) {
    throw new ConversationError("invalid_concurrency_limit", "maxConcurrentMemberTurns must be an integer from 1 through 64");
  }
  return value;
}
