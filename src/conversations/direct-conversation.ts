import {
  createDirectConversationId,
  createDirectTopicId,
} from "../domain/ids";
import type { BotProfile } from "../bots/bot-types";
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
    /** Durable Bot (or already-persisted Conversation) timestamps — never read-time `now`. */
    createdAt: string;
    updatedAt?: string;
  },
): { conversation: ConversationRecord; topic: ConversationTopic } {
  const existing = findDirectConversation(state, input.botId);
  const createdAt = input.createdAt;
  const conversationUpdatedAt = input.updatedAt ?? input.createdAt;
  const conversation = existing ?? {
    id: createDirectConversationId(input.botId),
    kind: "bot" as const,
    title: input.title,
    botIds: [input.botId],
    createdAt,
    updatedAt: conversationUpdatedAt,
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
      createdAt,
      // Default Topic identity is independent of Bot rename. Until a Topic
      // mutation API exists, synthetic updatedAt equals createdAt.
      updatedAt: createdAt,
    };
  return { conversation, topic };
}

/**
 * Direct Conversation public presentation is the current owning Bot projection.
 * Identity (id, botIds, default Topic id) stays on the durable Conversation
 * domain; title/createdAt/updatedAt do not freeze at first materialization.
 */
export function presentDirectConversation(
  conversation: ConversationRecord,
  bot: Pick<BotProfile, "name" | "createdAt" | "updatedAt">,
): ConversationRecord {
  if (conversation.kind !== "bot") {
    return conversation;
  }
  return {
    ...conversation,
    title: bot.name,
    createdAt: bot.createdAt,
    updatedAt: bot.updatedAt,
  };
}

/**
 * Default Topic identity is independent of Bot rename. createdAt is Bot
 * creation; updatedAt is the last real Topic mutation (synthetic equals createdAt).
 */
export function presentDefaultDirectTopic(
  topic: ConversationTopic,
  bot: Pick<BotProfile, "id" | "createdAt">,
): ConversationTopic {
  if (topic.id !== createDirectTopicId(bot.id)) {
    return topic;
  }
  return {
    ...topic,
    createdAt: bot.createdAt,
  };
}
