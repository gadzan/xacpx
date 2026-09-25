import type { BotProfile } from "../bots/bot-types";
import { createDirectConversationId, createDirectTopicId } from "../domain/ids";
import type { ConversationRecord, ConversationTopic } from "./conversation-types";

export type ConversationRootKind =
  | "group"
  | "persisted-direct"
  | "persisted-direct-no-authority"
  | "synthetic-direct"
  | "missing";

/**
 * Shared Conversation/Topic root classifier. Kind and execution authority
 * are separate dimensions:
 * - kind: group / persisted-direct (either authority variant) /
 *   synthetic-direct / missing. A persisted `bot` Conversation with a
 *   linked Topic row is a Direct-kind root even when its owning Bot is
 *   gone (quarantined/missing) — the rows still prove the kind.
 * - authority: only `persisted-direct` (owning Bot exists; existence, not
 *   enabled) plus `group` / `synthetic-direct` (live Bot by construction)
 *   can execute. `persisted-direct-no-authority` has Direct kind but no
 *   executor: durable work on it must fail activation closed, while
 *   cross-kind group-member evidence on it must still fail closed as a
 *   kind contradiction — never auto-release as a missing root.
 * Used by load reconcile and activation (authority, orphan sweep,
 * ambiguity) so a Direct root can never read as "missing" in one check
 * and "live" in another.
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
    if (topic) {
      if (topic.conversationId !== conversationId) {
        return "missing";
      }
      return bot ? "persisted-direct" : "persisted-direct-no-authority";
    }
    if (topicId !== createDirectTopicId(botId)) {
      return "missing";
    }
    return bot ? "persisted-direct" : "persisted-direct-no-authority";
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
