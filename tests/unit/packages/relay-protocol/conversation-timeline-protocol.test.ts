import { expect, test } from "bun:test";

import {
  MSG,
  RELAY_CAPABILITIES,
  parseControlPayload,
  type ConversationMessageDto,
  type ConversationTimelineDto,
  type MemberTurnSummaryDto,
} from "../../../../packages/relay-protocol/src/index";

const message: ConversationMessageDto = {
  id: "message_1",
  conversationId: "conversation_1",
  topicId: "topic_1",
  seq: 1,
  role: "bot",
  content: "hello",
  createdAt: "2026-11-07T00:00:00.000Z",
};

const memberTurn: MemberTurnSummaryDto = {
  id: "member_1",
  runId: "run_1",
  conversationId: "conversation_1",
  topicId: "topic_1",
  botId: "bot_1",
  batch: 1,
  attempt: 1,
  origin: "roundtable",
  state: "completed",
  createdAt: "2026-11-07T00:00:00.000Z",
  speechOutcome: "pass",
};

test("the timeline RPC and capability keep their wire names", () => {
  expect(MSG.conversationTimeline).toBe("control.conversation.timeline");
  expect(RELAY_CAPABILITIES.conversationTimelineV1).toBe("conversations.timeline.v1");
  // The legacy transcript RPC is untouched: old clients keep working.
  expect(MSG.conversationHistory).toBe("control.conversation.history");
});

test("the timeline validator accepts cursor pages and rejects direction mixed with a cursor", () => {
  expect(parseControlPayload(MSG.conversationTimeline, {
    conversationId: "conversation_1",
    topicId: "topic_1",
    limit: 50,
    afterSeq: 10,
  })).toMatchObject({ conversationId: "conversation_1", afterSeq: 10 });

  expect(parseControlPayload(MSG.conversationTimeline, {
    conversationId: "conversation_1",
    topicId: "topic_1",
    direction: "newest-first",
  })).toMatchObject({ direction: "newest-first" });

  // Same rule as history: `direction` is initial-page-only.
  expect(parseControlPayload(MSG.conversationTimeline, {
    conversationId: "conversation_1",
    topicId: "topic_1",
    direction: "newest-first",
    beforeSeq: 10,
  })).toBeNull();

  for (const invalid of [
    null,
    {},
    { conversationId: "conversation_1" },
    { conversationId: "conversation_1", topicId: "topic_1", afterSeq: "10" },
    { conversationId: "conversation_1", topicId: "topic_1", direction: "sideways" },
  ]) {
    expect(parseControlPayload(MSG.conversationTimeline, invalid)).toBeNull();
  }
});

test("a legacy history payload still validates unchanged", () => {
  expect(parseControlPayload(MSG.conversationHistory, {
    conversationId: "conversation_1",
    topicId: "topic_1",
    limit: 20,
  })).toMatchObject({ conversationId: "conversation_1", limit: 20 });
});

test("the timeline DTO carries all three entry kinds and optional ownership", () => {
  const timeline: ConversationTimelineDto = {
    conversationId: "conversation_1",
    topicId: "topic_1",
    entries: [
      { kind: "message", key: "message:message_1", anchorSeq: 1, message, memberTurnId: "member_1", runId: "run_1", ownership: "exact" },
      { kind: "message", key: "message:message_2", anchorSeq: 2, message: { ...message, id: "message_2", seq: 2 }, ownership: "unresolved" },
      { kind: "activity", key: "activity:member_2", anchorSeq: 3, runId: "run_1", memberTurn, live: true },
      { kind: "notice", key: "notice:run_1:empty", anchorSeq: 4, tone: "empty", runId: "run_1", text: "No member added to this discussion." },
    ],
    activeRound: {
      runId: "run_1",
      roundIndex: 1,
      rounds: 2,
      speakerCount: 3,
      spoken: 1,
      passed: 1,
      activeMemberTurnId: "member_3",
      state: "running",
    },
    oldestSeq: 1,
    newestSeq: 4,
    hasMoreBefore: false,
    hasMoreAfter: true,
  };
  expect(timeline.entries).toHaveLength(4);
  expect(timeline.activeRound?.passed).toBe(1);
  // `memberTurnId` on a message and `ownership` are additive: a legacy message
  // DTO without them still satisfies the type and the wire.
  const legacy: ConversationMessageDto = { ...message };
  expect(legacy.memberTurnId).toBeUndefined();
});
