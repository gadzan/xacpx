import { expect, test } from "bun:test";
import { ConversationError } from "../../../src/conversations/conversation-error";
import { ConversationRouterEngine } from "../../../src/conversations/conversation-router-engine";
import type { ConversationDispatcher } from "../../../src/conversations/conversation-dispatcher";
import type { ConversationRunService } from "../../../src/conversations/conversation-run-service";
import type { AcceptMemberInput, AcceptRequestResult } from "../../../src/conversations/conversation-store";
import { MAX_FORK_MESSAGES } from "../../../src/conversations/conversation-types";
import type { ConversationRecord, ConversationTopic } from "../../../src/conversations/conversation-types";
import type { SqliteConversationStore } from "../../../src/conversations/sqlite-conversation-store";
import type { AppState } from "../../../src/state/types";
import { harness, NOW, until, type ControlledRunner } from "./fixtures/concurrency-harness";

interface ForkHarness {
  accept: (
    conversationId: string,
    topicId: string,
    count?: number,
    proof?: boolean,
    requestId?: string,
    extra?: Partial<AcceptMemberInput>,
    memberIds?: string[],
    content?: string,
  ) => AcceptRequestResult;
  dispatcher: ConversationDispatcher;
  runner: ControlledRunner;
  service: ConversationRunService;
  store: SqliteConversationStore;
  state: AppState;
  group: (limit?: number, workspace?: string) => Promise<{
    group: ConversationRecord;
    topic: ConversationTopic;
    members: string[];
  }>;
}

async function settleRun(h: ForkHarness, conversationId: string, topicId: string, requestId: string, members = 3) {
  const start = h.runner.calls.length;
  const accepted = h.accept(conversationId, topicId, members, true, requestId);
  const drain = h.dispatcher.kick();
  for (let i = 0; i < members; i++) {
    await until(() => h.runner.calls.length > start + i);
    h.runner.finish(start + i);
  }
  await drain;
  return accepted;
}

function randomTopicId(): string {
  return `topic_${crypto.randomUUID()}`;
}

async function forkFixture() {
  const h: ForkHarness = await harness();
  const { group, topic } = await h.group();
  return { h, group, topic };
}

test("fork copies the settled snapshot with fresh seq and cleared provenance", async () => {
  const { h, group, topic } = await forkFixture();
  const accepted = await settleRun(h, group.id, topic.id, "run-a");
  const targetTopicId = randomTopicId();

  const forked = await h.service.forkGroupTopic({
    conversationId: group.id,
    sourceTopicId: topic.id,
    targetTopicId,
    requestId: "fork-a",
  });

  expect(forked.id).toBe(targetTopicId);
  expect(forked.forkedFrom).toMatchObject({
    requestId: "fork-a",
    sourceConversationId: group.id,
    sourceTopicId: topic.id,
    sourceRunId: accepted.run.id,
    copiedMessages: 4,
    omittedMessages: 0,
    rootTopicId: topic.id,
  });
  const copied = h.store.listMessages({ conversationId: group.id, topicId: targetTopicId, limit: 50 });
  expect(copied.map((message) => message.seq)).toEqual([1, 2, 3, 4]);
  expect(copied.map((message) => message.role)).toEqual(["human", "bot", "bot", "bot"]);
  expect(copied.every((message) => message.runId === undefined)).toBe(true);
  expect(copied.every((message) => message.memberTurnId === undefined)).toBe(true);
  expect(copied.every((message) => message.handoff === undefined && message.groupSay === undefined)).toBe(true);
  expect(copied.every((message) => message.forkedFromMessageId !== undefined)).toBe(true);
  const source = h.store.listMessages({ conversationId: group.id, topicId: topic.id, limit: 50 });
  expect(copied.map((message) => message.content)).toEqual(source.map((message) => message.content));
  expect(copied.map((message) => message.senderBotId)).toEqual(source.map((message) => message.senderBotId));
  expect(copied.map((message) => message.createdAt)).toEqual(source.map((message) => message.createdAt));
  expect(copied.map((message) => message.forkedFromMessageId)).toEqual(source.map((message) => message.id));
  expect(forked.executionTarget).toEqual(topic.executionTarget);
  h.store.close();
});

test("explicit boundary excludes a later accepted Run whose request seq is below the reply", async () => {
  const { h, group, topic } = await forkFixture();
  const first = h.accept(group.id, topic.id, 1, true, "run-a");
  const drain = h.dispatcher.kick();
  await until(() => h.runner.calls.length === 1);
  const queuedLater = h.accept(group.id, topic.id, 1, true, "run-b");
  h.runner.finish(0);
  await until(() => h.runner.calls.length === 2);
  h.runner.finish(1);
  await drain;

  const laterRequest = h.store.getMessage(queuedLater.run.requestMessageId)!;
  const firstReply = h.store.listMessages({ conversationId: group.id, topicId: topic.id, limit: 50 })
    .find((message) => message.runId === first.run.id && message.role === "bot")!;
  expect(laterRequest.seq).toBeLessThan(firstReply.seq);

  const targetTopicId = randomTopicId();
  await h.service.forkGroupTopic({
    conversationId: group.id,
    sourceTopicId: topic.id,
    targetTopicId,
    requestId: "fork-a",
    sourcePoint: { type: "run", runId: first.run.id },
  });
  const copied = h.store.listMessages({ conversationId: group.id, topicId: targetTopicId, limit: 50 });
  expect(copied.some((message) => message.forkedFromMessageId === laterRequest.id)).toBe(false);
  expect(copied.map((message) => message.content)).toEqual([
    h.store.getMessage(first.run.requestMessageId)!.content,
    firstReply.content,
  ]);
  h.store.close();
});

test("latest_stable uses durable accept order and skips unsettled Runs", async () => {
  const { h, group, topic } = await forkFixture();
  const first = await settleRun(h, group.id, topic.id, "run-a", 1);
  const second = await settleRun(h, group.id, topic.id, "run-b", 1);
  const queued = h.accept(group.id, topic.id, 1, true, "run-c");

  const forked = await h.service.forkGroupTopic({
    conversationId: group.id,
    sourceTopicId: topic.id,
    targetTopicId: randomTopicId(),
    requestId: "fork-a",
  });
  expect(forked.forkedFrom?.sourceRunId).toBe(second.run.id);
  const copied = h.store.listMessages({ conversationId: group.id, topicId: forked.id, limit: 50 });
  expect(copied.some((message) => message.forkedFromMessageId === h.store.getMessage(queued.run.requestMessageId)!.id)).toBe(false);
  expect(copied.some((message) => message.runId !== undefined)).toBe(false);
  expect(copied.length).toBeGreaterThanOrEqual(4);
  void first;
  h.store.close();
});

test("non-terminal-only source reports unsettled and empty source reports empty", async () => {
  const { h, group, topic } = await forkFixture();
  h.accept(group.id, topic.id, 1, true, "run-a");
  await expect(h.service.forkGroupTopic({
    conversationId: group.id,
    sourceTopicId: topic.id,
    targetTopicId: randomTopicId(),
    requestId: "fork-a",
  })).rejects.toMatchObject({ code: "topic_fork_source_unsettled" });

  const empty = await h.service.createGroupTopic(group.id, "Empty", { workspace: "backend", isolation: "shared-single-writer" });
  await expect(h.service.forkGroupTopic({
    conversationId: group.id,
    sourceTopicId: empty.id,
    targetTopicId: randomTopicId(),
    requestId: "fork-b",
  })).rejects.toMatchObject({ code: "topic_fork_empty" });
  h.store.close();
});

test("replay reuses the same fork and a different request or live target is refused", async () => {
  const { h, group, topic } = await forkFixture();
  await settleRun(h, group.id, topic.id, "run-a", 1);
  const targetTopicId = randomTopicId();
  const input = { conversationId: group.id, sourceTopicId: topic.id, targetTopicId, requestId: "fork-a" };
  const first = await h.service.forkGroupTopic(input);
  const count = h.store.topicMessageCount(group.id, targetTopicId);
  const replay = await h.service.forkGroupTopic(input);
  expect(replay.id).toBe(first.id);
  expect(h.store.topicMessageCount(group.id, targetTopicId)).toBe(count);
  await expect(h.service.forkGroupTopic({ ...input, requestId: "fork-b" }))
    .rejects.toMatchObject({ code: "topic_exists" });

  const polluted = await h.service.createGroupTopic(group.id, "Live", { workspace: "backend", isolation: "shared-single-writer" });
  h.accept(group.id, polluted.id, 1, true, "live-run");
  await expect(h.service.forkGroupTopic({
    conversationId: group.id,
    sourceTopicId: topic.id,
    targetTopicId: polluted.id,
    requestId: "fork-c",
  })).rejects.toMatchObject({ code: "topic_exists" });
  h.store.close();
});

test("a replay after new traffic in the fork still returns the same Topic", async () => {
  const { h, group, topic } = await forkFixture();
  await settleRun(h, group.id, topic.id, "run-a", 1);
  const input = {
    conversationId: group.id,
    sourceTopicId: topic.id,
    targetTopicId: randomTopicId(),
    requestId: "fork-a",
  };
  const forked = await h.service.forkGroupTopic(input);
  const copied = forked.forkedFrom!.copiedMessages;
  // Ordinary traffic in the fork is not a copied row: the replay guard compares
  // fork provenance, so a busy fork must still replay instead of failing.
  h.accept(group.id, forked.id, 1, true, "post-fork-message");
  expect(h.store.topicMessageCount(group.id, forked.id)).toBe(copied + 1);
  expect(h.store.topicForkMessageCount(forked.id)).toBe(copied);

  const replay = await h.service.forkGroupTopic(input);
  expect(replay.id).toBe(forked.id);
  expect(h.store.topicForkMessageCount(forked.id)).toBe(copied);
  h.store.close();
});

test("more than the cap copies only the newest window and reports omissions", async () => {
  const { h, group, topic } = await forkFixture();
  const limit = MAX_FORK_MESSAGES + 3;
  for (let i = 0; i < limit; i++) {
    const accepted = h.accept(group.id, topic.id, 1, true, `bulk-${i}`, undefined, undefined, `message-${i}`);
    h.store.cancelRun(accepted.run.id, NOW);
  }
  const forked = await h.service.forkGroupTopic({
    conversationId: group.id,
    sourceTopicId: topic.id,
    targetTopicId: randomTopicId(),
    requestId: "fork-a",
  });
  expect(forked.forkedFrom?.copiedMessages).toBe(MAX_FORK_MESSAGES);
  expect(forked.forkedFrom?.omittedMessages).toBe(3);
  const copied = h.store.listMessages({ conversationId: group.id, topicId: forked.id, limit: MAX_FORK_MESSAGES + 10 });
  expect(copied).toHaveLength(MAX_FORK_MESSAGES);
  expect(copied[0]?.content).toBe(`message-${limit - MAX_FORK_MESSAGES}`);
  expect(copied.at(-1)?.content).toBe(`message-${limit - 1}`);
  h.store.close();
});

test("fork-of-fork keeps the chain root and the source delete is independent", async () => {
  const { h, group, topic } = await forkFixture();
  await settleRun(h, group.id, topic.id, "run-a", 1);
  const first = await h.service.forkGroupTopic({
    conversationId: group.id,
    sourceTopicId: topic.id,
    targetTopicId: randomTopicId(),
    requestId: "fork-a",
  });
  const second = await h.service.forkGroupTopic({
    conversationId: group.id,
    sourceTopicId: first.id,
    targetTopicId: randomTopicId(),
    requestId: "fork-b",
  });
  expect(second.forkedFrom?.rootTopicId).toBe(topic.id);
  expect(second.forkedFrom?.copiedMessages).toBe(h.store.topicMessageCount(group.id, first.id));

  await h.service.teardownTopic(group.id, topic.id, { releaseBindings: true });
  const surviving = h.store.listMessages({ conversationId: group.id, topicId: second.id, limit: 50 });
  expect(surviving.length).toBe(second.forkedFrom!.copiedMessages);
  expect(h.state.conversation_topics[second.id]?.id).toBe(second.id);
  h.store.close();
});

test("fork copies no public-memory projections", async () => {
  const h = await harness({ publicMemoryMembers: (conversationId, topicId) => {
    const topic = h.state.conversation_topics[topicId];
    return topic?.conversationId === conversationId ? h.state.conversations[conversationId]?.botIds ?? [] : undefined;
  } });
  const { group, topic } = await h.group();
  await settleRun(h, group.id, topic.id, "run-a", 1);
  const sourceMemory = h.store.listPublicMemory({ botId: group.botIds[0]! }).length;
  const forked = await h.service.forkGroupTopic({
    conversationId: group.id,
    sourceTopicId: topic.id,
    targetTopicId: randomTopicId(),
    requestId: "fork-a",
  });
  expect(h.store.listPublicMemory({ botId: group.botIds[0]! }).length).toBe(sourceMemory);
  expect(h.store.listPublicMemory({ botId: group.botIds[0]!, limit: 50 })
    .some((entry) => entry.topicId === forked.id)).toBe(false);
  h.store.close();
});

test("an existing fork topic without copied rows fails closed", async () => {
  const { h, group, topic } = await forkFixture();
  await settleRun(h, group.id, topic.id, "run-a", 1);
  const targetTopicId = randomTopicId();
  h.state.conversation_topics[targetTopicId] = {
    id: targetTopicId,
    conversationId: group.id,
    title: "Broken",
    status: "active",
    forkedFrom: {
      requestId: "fork-a",
      sourceConversationId: group.id,
      sourceTopicId: topic.id,
      sourceTitle: topic.title,
      throughSeq: 1,
      rootTopicId: topic.id,
      copiedMessages: 2,
      omittedMessages: 0,
      createdAt: NOW,
    },
    createdAt: NOW,
    updatedAt: NOW,
  };
  await expect(h.service.forkGroupTopic({
    conversationId: group.id,
    sourceTopicId: topic.id,
    targetTopicId,
    requestId: "fork-a",
  })).rejects.toMatchObject({ code: "topic_fork_history_missing" });
  expect(h.state.conversation_topics[targetTopicId]?.id).toBe(targetTopicId);
  h.store.close();
});

test("a replay over a partially lost copy fails closed instead of returning the target", async () => {
  const { h, group, topic } = await forkFixture();
  await settleRun(h, group.id, topic.id, "run-a", 1);
  const input = {
    conversationId: group.id,
    sourceTopicId: topic.id,
    targetTopicId: randomTopicId(),
    requestId: "fork-a",
  };
  const forked = await h.service.forkGroupTopic(input);
  const copied = h.store.listMessages({ conversationId: group.id, topicId: forked.id, limit: 50 });
  expect(copied.length).toBe(forked.forkedFrom!.copiedMessages);
  // The row survives but loses its fork provenance, so the target still looks
  // populated while one copied message is unaccounted for. A count-only
  // "is it nonzero" replay check would hand this damaged target back.
  h.store.directWriteForTest("messages", copied[0]!.id, { forked_from_message_id: null });
  expect(h.store.topicForkMessageCount(forked.id)).toBe(forked.forkedFrom!.copiedMessages - 1);
  await expect(h.service.forkGroupTopic(input)).rejects.toMatchObject({ code: "topic_fork_history_missing" });
  expect(h.state.conversation_topics[forked.id]?.id).toBe(forked.id);
  h.store.close();
});

test("orphan copied rows without a Topic record fail closed instead of being adopted", async () => {
  const { h, group, topic } = await forkFixture();
  await settleRun(h, group.id, topic.id, "run-a", 1);
  const targetTopicId = randomTopicId();
  h.store.copyTopicForkMessages({
    conversationId: group.id,
    boundaryRunId: h.store.listRuns(group.id, topic.id)[0]!.id,
    sourceTopicId: topic.id,
    targetTopicId,
    throughSeq: 100,
    limit: MAX_FORK_MESSAGES,
  });
  expect(h.state.conversation_topics[targetTopicId]).toBeUndefined();
  // The source advances before the retry: adopting the stale rows under the
  // new boundary would silently drop the newer history and misstate provenance.
  await settleRun(h, group.id, topic.id, "run-b", 1);
  await expect(h.service.forkGroupTopic({
    conversationId: group.id,
    sourceTopicId: topic.id,
    targetTopicId,
    requestId: "fork-a",
  })).rejects.toMatchObject({ code: "topic_fork_history_missing" });
  expect(h.state.conversation_topics[targetTopicId]).toBeUndefined();
  h.store.close();
});

test("a deleting source or target refuses the fork", async () => {
  const { h, group, topic } = await forkFixture();
  await settleRun(h, group.id, topic.id, "run-a", 1);
  h.store.markTopicDeleting(topic.id, group.id, NOW);
  await expect(h.service.forkGroupTopic({
    conversationId: group.id,
    sourceTopicId: topic.id,
    targetTopicId: randomTopicId(),
    requestId: "fork-a",
  })).rejects.toMatchObject({ code: "conversation_deleting" });
  h.store.close();
});

test("a deleting fork target is not returned on replay", async () => {
  const { h, group, topic } = await forkFixture();
  await settleRun(h, group.id, topic.id, "run-a", 1);
  const targetTopicId = randomTopicId();
  await h.service.forkGroupTopic({
    conversationId: group.id,
    sourceTopicId: topic.id,
    targetTopicId,
    requestId: "fork-a",
  });
  h.store.markTopicDeleting(targetTopicId, group.id, NOW);
  await expect(h.service.forkGroupTopic({
    conversationId: group.id,
    sourceTopicId: topic.id,
    targetTopicId,
    requestId: "fork-a",
  })).rejects.toMatchObject({ code: "topic_deleting" });
  h.store.close();
});

test("a malformed target id is an invalid payload", async () => {
  const { h, group, topic } = await forkFixture();
  await settleRun(h, group.id, topic.id, "run-a", 1);
  await expect(h.service.forkGroupTopic({
    conversationId: group.id,
    sourceTopicId: topic.id,
    targetTopicId: "topic_peer_deadbeef",
    requestId: "fork-a",
  })).rejects.toMatchObject({ code: "invalid-payload" });
  await expect(h.service.forkGroupTopic({
    conversationId: group.id,
    sourceTopicId: topic.id,
    targetTopicId: randomTopicId(),
    requestId: "",
  })).rejects.toBeInstanceOf(ConversationError);
  h.store.close();
});

test("the first fork run's prompt and Router input see the copied history", async () => {
  const { h, group, topic } = await forkFixture();
  await settleRun(h, group.id, topic.id, "run-a", 1);
  const forked = await h.service.forkGroupTopic({
    conversationId: group.id,
    sourceTopicId: topic.id,
    targetTopicId: randomTopicId(),
    requestId: "fork-a",
  });
  const sourceContents = h.store.listMessages({ conversationId: group.id, topicId: forked.id, limit: 50 })
    .map((message) => message.content);

  const accepted = h.accept(group.id, forked.id, 1, true, "fork-run");
  const start = h.runner.calls.length;
  const drain = h.dispatcher.kick();
  await until(() => h.runner.calls.length > start);
  const prompt = h.runner.calls[start]!.text;
  for (const content of sourceContents) {
    expect(prompt).toContain(content);
  }

  h.runner.finish(start);
  await drain;

  const engine = new ConversationRouterEngine(undefined, {
    store: h.store,
    readGroup: (id) => h.state.conversations[id],
    readTopic: (_id, topicId) => h.state.conversation_topics[topicId],
    readBot: (id) => h.state.bots[id],
    runLifecycleAll: async (_botIds, critical) => critical(),
    now: () => new Date(NOW),
  });
  const input = engine.buildRoutingInput(h.store.getRun(accepted.run.id)!);
  for (const content of sourceContents) {
    expect(input.publicTranscript.map((entry) => entry.content)).toContain(content);
  }
  expect(input.publicTranscript.length).toBeLessThanOrEqual(200);
  h.store.close();
});

test("a message boundary cuts at that row's seq and records the source message", async () => {
  const { h, group, topic } = await forkFixture();
  await settleRun(h, group.id, topic.id, "run-a", 1);
  const second = await settleRun(h, group.id, topic.id, "run-b", 1);
  const boundary = h.store.getMessage(second.run.requestMessageId)!;

  const forked = await h.service.forkGroupTopic({
    conversationId: group.id,
    sourceTopicId: topic.id,
    targetTopicId: randomTopicId(),
    requestId: "fork-a",
    sourcePoint: { type: "message", messageId: boundary.id },
  });

  expect(forked.forkedFrom).toMatchObject({
    requestId: "fork-a",
    sourceMessageId: boundary.id,
    throughSeq: boundary.seq,
    copiedMessages: 3,
    omittedMessages: 0,
  });
  // A message boundary is not a Run boundary: the reply that follows the
  // boundary row and the whole later Run must stay out of the copy.
  expect(forked.forkedFrom?.sourceRunId).toBeUndefined();
  const copied = h.store.listMessages({ conversationId: group.id, topicId: forked.id, limit: 50 });
  expect(copied.map((message) => message.forkedFromMessageId)).toEqual(
    h.store.listMessages({ conversationId: group.id, topicId: topic.id, limit: 50 })
      .filter((message) => message.seq <= boundary.seq)
      .map((message) => message.id),
  );
  expect(copied.map((message) => message.seq)).toEqual([1, 2, 3]);
  h.store.close();
});

test("a message boundary inside a later Run keeps the earlier Runs' rows", async () => {
  const { h, group, topic } = await forkFixture();
  const first = await settleRun(h, group.id, topic.id, "run-a", 1);
  await settleRun(h, group.id, topic.id, "run-b", 1);
  const source = h.store.listMessages({ conversationId: group.id, topicId: topic.id, limit: 50 });
  const boundary = source[source.length - 1]!;
  expect(boundary.role).toBe("bot");
  const firstRunRow = source.find((message) => message.runId === first.run.id && message.role === "bot")!;

  const forked = await h.service.forkGroupTopic({
    conversationId: group.id,
    sourceTopicId: topic.id,
    targetTopicId: randomTopicId(),
    requestId: "fork-a",
    sourcePoint: { type: "message", messageId: boundary.id },
  });

  const copied = h.store.listMessages({ conversationId: group.id, topicId: forked.id, limit: 50 });
  expect(copied).toHaveLength(source.length);
  // A `boundaryRunId` filter would have dropped this earlier Run's reply.
  expect(copied.map((message) => message.forkedFromMessageId)).toContain(firstRunRow.id);
  expect(forked.forkedFrom?.throughSeq).toBe(boundary.seq);
  h.store.close();
});

test("a message boundary excludes a Run queued after it", async () => {
  const { h, group, topic } = await forkFixture();
  const settled = await settleRun(h, group.id, topic.id, "run-a", 1);
  const queued = h.accept(group.id, topic.id, 1, true, "run-b");
  const boundary = h.store.listMessages({ conversationId: group.id, topicId: topic.id, limit: 50 })
    .filter((message) => message.runId === settled.run.id)
    .at(-1)!;
  expect(h.store.getMessage(queued.run.requestMessageId)!.seq).toBeGreaterThan(boundary.seq);

  const forked = await h.service.forkGroupTopic({
    conversationId: group.id,
    sourceTopicId: topic.id,
    targetTopicId: randomTopicId(),
    requestId: "fork-a",
    sourcePoint: { type: "message", messageId: boundary.id },
  });
  const start = h.runner.calls.length;
  const drain = h.dispatcher.kick();
  await until(() => h.runner.calls.length > start);
  h.runner.finish(start);
  await drain;

  const copied = h.store.listMessages({ conversationId: group.id, topicId: forked.id, limit: 50 });
  expect(copied.map((message) => message.forkedFromMessageId)).not.toContain(queued.run.requestMessageId);
  expect(copied).toHaveLength(2);
  h.store.close();
});

test("a message boundary refuses a message from another Topic or an unknown id", async () => {
  const { h, group, topic } = await forkFixture();
  await settleRun(h, group.id, topic.id, "run-a", 1);
  const other = await h.service.createGroupTopic(group.id, "Other", { workspace: "backend", isolation: "shared-single-writer" });
  const foreign = await settleRun(h, group.id, other.id, "run-other", 1);
  const foreignRequest = h.store.getMessage(foreign.run.requestMessageId)!;

  for (const messageId of [foreignRequest.id, "message_unknown"]) {
    await expect(h.service.forkGroupTopic({
      conversationId: group.id,
      sourceTopicId: topic.id,
      targetTopicId: randomTopicId(),
      requestId: `fork-${messageId}`,
      sourcePoint: { type: "message", messageId },
    })).rejects.toMatchObject({ code: "topic_not_found" });
  }
  h.store.close();
});
