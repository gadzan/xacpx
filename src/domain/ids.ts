import { createHash, randomUUID } from "node:crypto";

export const DOMAIN_ID_PREFIX = {
  bot: "bot",
  conversation: "conversation",
  topic: "topic",
  conversationMessage: "cmsg",
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

export function createGroupTurnId(createId?: () => string): string {
  return createDomainId("groupTurn", createId);
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
