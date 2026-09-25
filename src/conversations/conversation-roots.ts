import type { BotProfile } from "../bots/bot-types";
import { createDirectConversationId, createDirectTopicId } from "../domain/ids";
import type { ConversationRecord, ConversationTopic } from "./conversation-types";

export type ConversationRootKind = "group" | "persisted-direct" | "synthetic-direct" | "missing";

/**
 * Shared Conversation/Topic root classifier. Direct roots may be synthetic:
 * a live Bot's deterministic Direct conversation + default Topic ids are a
 * live root even with no persisted rows, and a surviving custom Direct Topic
 * row linked to that deterministic conversation is also a live
 * synthetic-direct root. A persisted Direct root additionally requires its
 * owning Bot to still exist (existence, not enabled): a quarantined/missing
 * Bot leaves durable work without executable authority. Used by load
 * reconcile and activation (authority, orphan sweep, ambiguity) so a
 * synthetic Direct root can never read as "missing" in one check and "live"
 * in another.
 */
export function classifyConversationRoot(
  conversations: Record<string, ConversationRecord | undefined>,
  topics: Record<string, ConversationTopic | undefined>,
  bots: Record<string, BotProfile | undefined> | readonly (BotProfile | undefined)[],
  conversationId: string,
  topicId: string,
): ConversationRootKind {
  const conversation = conversations[conversationId];
  const topic = topics[topicId];
  if (conversation?.kind === "group") {
    return topic && topic.conversationId === conversationId ? "group" : "missing";
  }
  if (conversation?.kind === "bot") {
    const botId = conversation.botIds[0];
    if (botId === undefined) {
      return "missing";
    }
    const bot = Array.isArray(bots) ? bots.find((entry) => entry?.id === botId) : (bots as Record<string, BotProfile | undefined>)[botId];
    if (!bot) {
      return "missing";
    }
    if (topic) {
      return topic.conversationId === conversationId ? "persisted-direct" : "missing";
    }
    return topicId === createDirectTopicId(botId) ? "persisted-direct" : "missing";
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
