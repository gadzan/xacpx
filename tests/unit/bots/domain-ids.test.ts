import { expect, test } from "bun:test";

import {
  createBotId,
  createConversationId,
  createConversationMessageId,
  createConversationRunId,
  createDirectBindingId,
  createDirectConversationId,
  createDirectTopicId,
  createDomainId,
  createGroupTurnId,
  createMemberTurnId,
  createPendingDispatchId,
  createRuntimeBindingId,
  createScopedDirectBindingId,
  createTopicId,
  DOMAIN_ID_PREFIX,
} from "../../../src/domain/ids";

test("createDomainId prefixes a UUID and never uses a display name", () => {
  const ids = [
    createBotId(),
    createConversationId(),
    createTopicId(),
    createConversationMessageId(),
    createConversationRunId(),
    createMemberTurnId(),
    createPendingDispatchId(),
    createGroupTurnId(),
    createRuntimeBindingId(),
  ];

  expect(ids[0]!.startsWith(`${DOMAIN_ID_PREFIX.bot}_`)).toBe(true);
  expect(ids[1]!.startsWith(`${DOMAIN_ID_PREFIX.conversation}_`)).toBe(true);
  expect(ids[2]!.startsWith(`${DOMAIN_ID_PREFIX.topic}_`)).toBe(true);
  expect(ids[3]!.startsWith(`${DOMAIN_ID_PREFIX.conversationMessage}_`)).toBe(true);
  expect(ids[4]!.startsWith(`${DOMAIN_ID_PREFIX.conversationRun}_`)).toBe(true);
  expect(ids[5]!.startsWith(`${DOMAIN_ID_PREFIX.memberTurn}_`)).toBe(true);
  expect(ids[6]!.startsWith(`${DOMAIN_ID_PREFIX.pendingDispatch}_`)).toBe(true);
  expect(ids[7]!.startsWith(`${DOMAIN_ID_PREFIX.groupTurn}_`)).toBe(true);
  expect(ids[8]!.startsWith(`${DOMAIN_ID_PREFIX.runtimeBinding}_`)).toBe(true);
  expect(ids.join(" ").includes("Reviewer")).toBe(false);
});

test("injected createId is the only source of uniqueness", () => {
  let n = 0;
  const createId = () => {
    n += 1;
    return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  };

  expect(createDomainId("bot", createId)).toBe("bot_00000000-0000-4000-8000-000000000001");
  expect(createBotId(createId)).toBe("bot_00000000-0000-4000-8000-000000000002");
});

test("1000 generated ids do not collide", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 1000; i += 1) {
    seen.add(createBotId());
    seen.add(createConversationId());
    seen.add(createTopicId());
    seen.add(createConversationMessageId());
    seen.add(createConversationRunId());
    seen.add(createMemberTurnId());
    seen.add(createPendingDispatchId());
    seen.add(createGroupTurnId());
    seen.add(createRuntimeBindingId());
  }
  expect(seen.size).toBe(9000);
});

test("direct runtime ids are deterministic opaque prefixes of the Bot id", () => {
  const botId = "bot_reviewer";
  const conversationId = createDirectConversationId(botId);
  const topicId = createDirectTopicId(botId);
  const bindingId = createDirectBindingId(botId);
  expect(conversationId).toBe(createDirectConversationId(botId));
  expect(topicId).toBe(createDirectTopicId(botId));
  expect(bindingId).toBe(createDirectBindingId(botId));
  expect(conversationId.startsWith(`${DOMAIN_ID_PREFIX.conversation}_`)).toBe(true);
  expect(topicId.startsWith(`${DOMAIN_ID_PREFIX.topic}_`)).toBe(true);
  expect(bindingId.startsWith(`${DOMAIN_ID_PREFIX.runtimeBinding}_`)).toBe(true);
  expect(conversationId).not.toBe(botId);
  expect(new Set([conversationId, topicId, bindingId]).size).toBe(3);
  const scoped = createScopedDirectBindingId(conversationId, topicId, botId);
  expect(scoped).toBe(createScopedDirectBindingId(conversationId, topicId, botId));
  expect(scoped).not.toBe(bindingId);
  expect(scoped.startsWith(`${DOMAIN_ID_PREFIX.runtimeBinding}_`)).toBe(true);
});
