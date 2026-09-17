import { isDirectConversationChatKey } from "../domain/ids";
import type { ChatRequestMetadata } from "../weixin/agent/interface";
import type { PermissionInteractionOrigin, TurnInteractionContext } from "./permission-types";

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
  if (input.origin !== "human") {
    return undefined;
  }
  const chatKey = input.metadata?.permissionChatKey ?? input.isolationChatKey;
  if (isDirectConversationChatKey(chatKey)) {
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
