import type { BotProfile } from "../bots/bot-types";
import { createDirectConversationId, createDirectTopicId } from "../domain/ids";
import type { ConversationRecord, ConversationTopic } from "./conversation-types";

export type ConversationRootKind = "group" | "persisted-direct" | "synthetic-direct" | "missing";

/**
 * Shared Conversation/Topic root classifier. Direct roots may be synthetic:
 * a live Bot's deterministic Direct conversation + default Topic ids are a
 * live root even with no persisted rows, and a surviving custom Direct Topic
 * row linked to that deterministic conversation is also a live
 * synthetic-direct root. Anything else needs persisted rows of the right
 * kind. Used by load reconcile and activation (authority, orphan sweep,
 * ambiguity) so a synthetic Direct root can never read as "missing" in one
 * check and "live" in another.
 */
export function classifyConversationRoot(
  conversations: Record<string, ConversationRecord | undefined>,
  topics: Record<string, ConversationTopic | undefined>,
  bots: Record<string, BotProfile | undefined> | readonly BotProfile[],
  conversationId: string,
  topicId: string,
): ConversationRootKind {
  const conversation = conversations[conversationId];
  const topic = topics[topicId];
  if (conversation?.kind === "group") {
    return topic && topic.conversationId === conversationId ? "group" : "missing";
  }
  if (conversation?.kind === "bot") {
    if (topic) {
      return topic.conversationId === conversationId ? "persisted-direct" : "missing";
    }
    const botId = conversation.botIds[0];
    return botId !== undefined && topicId === createDirectTopicId(botId) ? "persisted-direct" : "missing";
  }
  const botList = Array.isArray(bots) ? bots : Object.values(bots);
  const owner = botList.find((bot) => bot !== undefined && createDirectConversationId(bot.id) === conversationId);
  if (owner && topicId === createDirectTopicId(owner.id)) {
    return "synthetic-direct";
  }
  if (owner && topic) {
    return topic.conversationId === conversationId ? "synthetic-direct" : "missing";
  }
  return "missing";
}
