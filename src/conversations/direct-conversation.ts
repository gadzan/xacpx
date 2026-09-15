import {
  createConversationId,
  createTopicId,
} from "../domain/ids";
import type { AppState } from "../state/types";
import type { ConversationRecord, ConversationTopic } from "./conversation-types";

export function findDirectConversation(state: AppState, botId: string): ConversationRecord | undefined {
  return Object.values(state.conversations).find(
    (conversation) => conversation.kind === "bot" && conversation.botIds.length === 1 && conversation.botIds[0] === botId,
  );
}

export function ensureDirectConversation(
  state: AppState,
  input: {
    botId: string;
    title: string;
    now: string;
    createConversationId?: () => string;
    createTopicId?: () => string;
  },
): { conversation: ConversationRecord; topic: ConversationTopic } {
  const existing = findDirectConversation(state, input.botId);
  if (existing) {
    const topic = Object.values(state.conversation_topics).find(
      (candidate) => candidate.conversationId === existing.id && candidate.status === "active",
    ) ?? Object.values(state.conversation_topics).find(
      (candidate) => candidate.conversationId === existing.id,
    );
    if (topic) {
      return { conversation: existing, topic };
    }
    const createdTopic: ConversationTopic = {
      id: input.createTopicId?.() ?? createTopicId(),
      conversationId: existing.id,
      title: "Default",
      status: "active",
      createdAt: input.now,
      updatedAt: input.now,
    };
    state.conversation_topics[createdTopic.id] = createdTopic;
    return { conversation: existing, topic: createdTopic };
  }

  const conversation: ConversationRecord = {
    id: input.createConversationId?.() ?? createConversationId(),
    kind: "bot",
    title: input.title,
    botIds: [input.botId],
    createdAt: input.now,
    updatedAt: input.now,
  };
  const topic: ConversationTopic = {
    id: input.createTopicId?.() ?? createTopicId(),
    conversationId: conversation.id,
    title: "Default",
    status: "active",
    createdAt: input.now,
    updatedAt: input.now,
  };
  state.conversations[conversation.id] = conversation;
  state.conversation_topics[topic.id] = topic;
  return { conversation, topic };
}
