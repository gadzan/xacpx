import { ConversationError } from "../conversations/conversation-error";
import { isHiddenProductSessionOwner, type LogicalSessionOwner } from "../state/types";

/**
 * Ordinary / public Session addressability is owner metadata, never alias prefix.
 * Product-owned LogicalSessions stay reachable only through the core-private
 * ConversationExecutionPort (`promptImmediate` + store-derived correlation,
 * request-id cancel, `cancelQueuedConversationItem`, `releaseOwnedSession`).
 */
export function assertOrdinarySessionAddressable(owner?: LogicalSessionOwner): void {
  if (isHiddenProductSessionOwner(owner)) {
    throw new ConversationError(
      "hidden_session",
      "product-owned sessions are not addressable via ordinary Session APIs",
    );
  }
}
