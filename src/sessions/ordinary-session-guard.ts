import { ConversationError } from "../conversations/conversation-error";
import { isHiddenProductSessionOwner, type LogicalSessionOwner } from "../state/types";

/**
 * Ordinary / public Session addressability is owner metadata, never alias prefix.
 * Product-owned LogicalSessions stay reachable only through Conversation
 * execution/release seams (`promptImmediate` + correlation, request-id cancel,
 * `cancelQueuedItem` with the conversation seam, `releaseOwnedSession`).
 */
export function assertOrdinarySessionAddressable(owner?: LogicalSessionOwner): void {
  if (isHiddenProductSessionOwner(owner)) {
    throw new ConversationError(
      "hidden_session",
      "product-owned sessions are not addressable via ordinary Session APIs",
    );
  }
}
