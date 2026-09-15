import { expect, test } from "bun:test";

import {
  createBotId,
  createConversationId,
  createConversationMessageId,
  createDomainId,
  createGroupTurnId,
  createRuntimeBindingId,
  createTopicId,
  DOMAIN_ID_PREFIX,
} from "../../../src/domain/ids";

test("createDomainId prefixes a UUID and never uses a display name", () => {
  const ids = [
    createBotId(),
    createConversationId(),
    createTopicId(),
    createConversationMessageId(),
    createGroupTurnId(),
    createRuntimeBindingId(),
  ];

  expect(ids[0]!.startsWith(`${DOMAIN_ID_PREFIX.bot}_`)).toBe(true);
  expect(ids[1]!.startsWith(`${DOMAIN_ID_PREFIX.conversation}_`)).toBe(true);
  expect(ids[2]!.startsWith(`${DOMAIN_ID_PREFIX.topic}_`)).toBe(true);
  expect(ids[3]!.startsWith(`${DOMAIN_ID_PREFIX.conversationMessage}_`)).toBe(true);
  expect(ids[4]!.startsWith(`${DOMAIN_ID_PREFIX.groupTurn}_`)).toBe(true);
  expect(ids[5]!.startsWith(`${DOMAIN_ID_PREFIX.runtimeBinding}_`)).toBe(true);
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
    seen.add(createGroupTurnId());
    seen.add(createRuntimeBindingId());
  }
  expect(seen.size).toBe(6000);
});
