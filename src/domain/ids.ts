import { randomUUID } from "node:crypto";

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
