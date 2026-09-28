import { createHash, randomUUID } from "node:crypto";

export const DOMAIN_ID_PREFIX = {
  bot: "bot",
  conversation: "conversation",
  topic: "topic",
  conversationMessage: "cmsg",
  conversationRun: "run",
  memberTurn: "mturn",
  pendingDispatch: "pdsp",
  sourceTurn: "sturn",
  groupTurn: "gturn",
  runtimeBinding: "bind",
} as const;

export type DomainIdKind = keyof typeof DOMAIN_ID_PREFIX;

export function createDomainId(
  kind: DomainIdKind,
  createId: () => string = randomUUID,
): string {
  return `${DOMAIN_ID_PREFIX[kind]}_${createId()}`;
}

export function createBotId(createId?: () => string): string {
  return createDomainId("bot", createId);
}

export function createConversationId(createId?: () => string): string {
  return createDomainId("conversation", createId);
}

export function createTopicId(createId?: () => string): string {
  return createDomainId("topic", createId);
}

export function createConversationMessageId(createId?: () => string): string {
  return createDomainId("conversationMessage", createId);
}

export function createConversationRunId(createId?: () => string): string {
  return createDomainId("conversationRun", createId);
}

export function createMemberTurnId(createId?: () => string): string {
  return createDomainId("memberTurn", createId);
}

export function createPendingDispatchId(createId?: () => string): string {
  return createDomainId("pendingDispatch", createId);
}

export function createSourceTurnId(createId?: () => string): string {
  return createDomainId("sourceTurn", createId);
}

export function createRuntimeBindingId(createId?: () => string): string {
  return createDomainId("runtimeBinding", createId);
}

function digestOpaque(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 32);
}

export function createDirectConversationId(botId: string): string {
  return `${DOMAIN_ID_PREFIX.conversation}_${digestOpaque(["bot-direct", "conversation", botId])}`;
}

export function createDirectTopicId(botId: string): string {
  return `${DOMAIN_ID_PREFIX.topic}_${digestOpaque(["bot-direct", "topic", botId])}`;
}

export function createDirectBindingId(botId: string): string {
  return `${DOMAIN_ID_PREFIX.runtimeBinding}_${digestOpaque(["bot-direct", "binding", botId])}`;
}

/** PR3+ scoped identity: conversationId × topicId × botId. */
export function createScopedDirectBindingId(
  conversationId: string,
  topicId: string,
  botId: string,
): string {
  return `${DOMAIN_ID_PREFIX.runtimeBinding}_${digestOpaque([
    "bot-direct",
    "binding",
    conversationId,
    topicId,
    botId,
  ])}`;
}

/** PR6 scoped group-member identity: same triple, different domain separator
 *  so a direct and a group binding for the same triple never collide. */
export function createScopedGroupMemberBindingId(
  conversationId: string,
  topicId: string,
  botId: string,
): string {
  return `${DOMAIN_ID_PREFIX.runtimeBinding}_${digestOpaque([
    "group-member",
    "binding",
    conversationId,
    topicId,
    botId,
  ])}`;
}

export function directConversationChatKey(conversationId: string, topicId: string): string {
  return `bot:${conversationId}:${topicId}`;
}

/**
 * Inverse of {@link directConversationChatKey}.
 *
 * Returns undefined for a key that merely CHATs with the `bot:` prefix but does
 * not carry both halves, so a caller cannot mint a route from `bot:garbage`.
 * A chatKey prefix is not enough to identify a turn: the conversation and topic
 * are what scope it, and a route built from a prefix-only key could be satisfied
 * by any turn in any topic.
 */
export function parseDirectConversationChatKey(
  chatKey: string,
): { conversationId: string; topicId: string } | undefined {
  if (!isDirectConversationChatKey(chatKey)) return undefined;
  const rest = chatKey.slice("bot:".length);
  const separator = rest.indexOf(":");
  if (separator <= 0 || separator === rest.length - 1) return undefined;
  const conversationId = rest.slice(0, separator);
  const topicId = rest.slice(separator + 1);
  // No further segments: `bot:c:t:extra` is not a key this project mints.
  if (topicId.includes(":")) return undefined;
  if (!conversationId || !topicId) return undefined;
  return { conversationId, topicId };
}

/** Product TurnQueue isolation key, not a human permission return route. */
export function isDirectConversationChatKey(chatKey: string): boolean {
  return chatKey.startsWith("bot:");
}

export function ownedDirectSessionAlias(bindingId: string): string {
  return `brt_${bindingId}`;
}

/** Group-member owned session alias. Same brt_ family as direct (hidden by
 *  owner metadata, never by prefix), but namespaced so a direct and a member
 *  session for the same binding id can never share an alias. */
export function ownedGroupMemberSessionAlias(bindingId: string): string {
  return `brt_group_${bindingId}`;
}

/**
 * Whether an alias is a Direct Conversation product session alias.
 *
 * Kept beside the minter so the two cannot drift: a prefix that this predicate
 * accepts but the minter would not produce (or the reverse) would silently break
 * the join between a Conversation binding and its session.
 *
 * Deliberately NOT exported as "is this a hidden alias": the product may add
 * other hidden alias shapes later, and the callers here need to know precisely
 * one thing — "is this alias already in its final internal form", which is a
 * question about naming, not about visibility.
 */
export function isProductOwnedSessionAlias(alias: string): boolean {
  return alias.startsWith("brt_") && alias.length > "brt_".length;
}
