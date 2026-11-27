import { expect, test } from "bun:test";

import { toConversationMessage } from "../../../src/control/conversation-control-dtos";
import type { ConversationMessage } from "../../../src/conversations/conversation-types";

function systemMessage(extra?: Partial<ConversationMessage>): ConversationMessage {
  return {
    id: "m-1",
    conversationId: "c-1",
    topicId: "t-1",
    seq: 1,
    role: "system",
    content: "receipt",
    createdAt: new Date(0).toISOString(),
    ...extra,
  } as ConversationMessage;
}

test("toConversationMessage keeps dispatchedSession (copied, not aliased)", () => {
  const dto = toConversationMessage(
    systemMessage({
      dispatchedSession: {
        sessionAlias: "backend-fix",
        displayName: "Backend Fix",
        agent: "codex",
        workspace: "/tmp/backend",
        taskPreview: "do work",
      },
    }),
  );
  expect(dto.dispatchedSession).toEqual({
    sessionAlias: "backend-fix",
    displayName: "Backend Fix",
    agent: "codex",
    workspace: "/tmp/backend",
    taskPreview: "do work",
  });
});

test("toConversationMessage omits dispatchedSession when absent", () => {
  const dto = toConversationMessage(systemMessage());
  expect("dispatchedSession" in dto).toBe(false);
});

test("toConversationMessage keeps a human role free of dispatchedSession", () => {
  const dto = toConversationMessage(
    systemMessage({ role: "human", dispatchedSession: undefined }),
  );
  expect("dispatchedSession" in dto).toBe(false);
});
