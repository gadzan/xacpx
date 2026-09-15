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
  const topic = Object.values(state.conversation_topics).find(
    (candidate) => candidate.conversationId === conversation.id && candidate.status === "active",
  ) ?? Object.values(state.conversation_topics).find(
    (candidate) => candidate.conversationId === conversation.id,
  ) ?? {
    id: createDirectTopicId(input.botId),
    conversationId: conversation.id,
    title: "Default",
    status: "active" as const,
    createdAt: input.now,
    updatedAt: input.now,
  };
  return { conversation, topic };
}
