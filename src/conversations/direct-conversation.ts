import {
  createDirectConversationId,
  createDirectTopicId,
} from "../domain/ids";
import type { AppState } from "../state/types";
import type { ConversationRecord, ConversationTopic } from "./conversation-types";

export function findDirectConversation(state: AppState, botId: string): ConversationRecord | undefined {
  return Object.values(state.conversations).find(
    (conversation) => conversation.kind === "bot" && conversation.botIds.length === 1 && conversation.botIds[0] === botId,
  );
}

export function planDirectConversation(
  state: AppState,
  input: {
    botId: string;
    title: string;
    now: string;
  },
): { conversation: ConversationRecord; topic: ConversationTopic } {
  const existing = findDirectConversation(state, input.botId);
  const conversation = existing ?? {
    id: createDirectConversationId(input.botId),
    kind: "bot" as const,
    title: input.title,
    botIds: [input.botId],
    createdAt: input.now,
    updatedAt: input.now,
  };
  const defaultTopicId = createDirectTopicId(input.botId);
  const existingTopic = state.conversation_topics[defaultTopicId];
  const topic = existingTopic && existingTopic.conversationId === conversation.id
    ? existingTopic
    : {
      id: defaultTopicId,
      conversationId: conversation.id,
      title: "Default",
      status: "active" as const,
      createdAt: input.now,
      updatedAt: input.now,
    };
  return { conversation, topic };
}
