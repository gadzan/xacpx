import type { ConversationMessage, ConversationRun, ConversationTopic, MemberTurnRecord } from "./conversation-types";

/**
 * Product-level Conversation events. These are join identities for clients,
 * not a second copy of tool/thought/plan/usage/streaming turn parts.
 */
export type ConversationProductEvent =
  | { type: "bots-changed" }
  | { type: "conversations-changed" }
  | { type: "conversation-topic-changed"; topic: ConversationTopic }
  | { type: "conversation-message"; message: ConversationMessage }
  | { type: "conversation-run-changed"; run: ConversationRun }
  | { type: "member-turn-started"; run: ConversationRun; memberTurn: MemberTurnRecord }
  | { type: "member-turn-finished"; run: ConversationRun; memberTurn: MemberTurnRecord };

export type ConversationProductEventSink = (event: ConversationProductEvent) => void;

export function emitConversationProductEvent(
  sink: ConversationProductEventSink | undefined,
  event: ConversationProductEvent,
): void {
  if (!sink) {
    return;
  }
  try {
    sink(event);
  } catch {
    // Product projection must not affect accept/dispatch fencing.
  }
}
