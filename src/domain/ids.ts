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
