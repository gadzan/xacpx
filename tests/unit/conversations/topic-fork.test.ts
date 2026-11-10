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
