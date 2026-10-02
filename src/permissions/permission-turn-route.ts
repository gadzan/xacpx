import { isDirectConversationChatKey } from "../domain/ids";
import type { ChatRequestMetadata } from "../weixin/agent/interface";
import type { PermissionInteractionOrigin, TurnInteractionContext } from "./permission-types";

/**
 * Everything both interaction kinds need to address an exact turn.
 *
 * Permission and Elicitation differ ONLY in whether a Direct Conversation
 * isolation key may mint an interaction (permission: no; elicitation: yes, see
 * `resolveElicitationTurnRoute`). Sharing the resolver here keeps that the only
 * difference, instead of two copies drifting on which metadata fields are read.
 *
 * `acceptDirectConversationKeys` is a policy flag, not a routing capability: the
 * caller states whether the interaction kind permits product isolation keys, and
 * the resolver enforces it.
 */
export function resolveTurnInteractionRoute(input: {
  isolationChatKey: string;
  origin?: PermissionInteractionOrigin;
  metadata?: ChatRequestMetadata;
  accountId?: string;
  /** Set `false` to refuse Direct Conversation (`bot:`) keys, as permission does. */
  acceptDirectConversationKeys: boolean;
}): Omit<TurnInteractionContext, "interactionId"> | undefined {
  if (input.origin !== "human") {
    return undefined;
  }
  const chatKey = input.metadata?.permissionChatKey ?? input.isolationChatKey;
  if (!input.acceptDirectConversationKeys && isDirectConversationChatKey(chatKey)) {
    return undefined;
  }
  return {
    chatKey,
    origin: "human",
    ...(input.accountId !== undefined ? { accountId: input.accountId } : {}),
    ...(input.metadata?.senderId !== undefined ? { senderId: input.metadata.senderId } : {}),
    ...(input.metadata?.senderName !== undefined ? { senderName: input.metadata.senderName } : {}),
    ...(input.metadata?.isOwner !== undefined ? { isOwner: input.metadata.isOwner } : {}),
  };
}

/**
 * Resolve the permission broker route for a chat turn.
 *
 * Ordinary channel prompts use the isolation `chatKey` as the return route.
 * Direct Conversation keeps `bot:<conversation>:<topic>` as the TurnQueue
 * isolation key and must supply a separate trusted `permissionChatKey`.
 * Product isolation keys never mint a human permission interaction.
 */
export function resolvePermissionTurnRoute(input: {
  isolationChatKey: string;
  origin?: PermissionInteractionOrigin;
  metadata?: ChatRequestMetadata;
  accountId?: string;
}): Omit<TurnInteractionContext, "interactionId"> | undefined {
  return resolveTurnInteractionRoute({ ...input, acceptDirectConversationKeys: false });
}
