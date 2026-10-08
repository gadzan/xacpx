import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

import { snapshotBotProfile } from "../../../src/bots/bot-types";
import { BotRuntimeManager } from "../../../src/bots/bot-runtime-manager";
import { BotService } from "../../../src/bots/bot-service";
import { BotError } from "../../../src/bots/bot-error";
import type { AppConfig } from "../../../src/config/types";
import { ConversationError } from "../../../src/conversations/conversation-error";
import { ConversationDispatcher } from "../../../src/conversations/conversation-dispatcher";
import { ConversationRunService } from "../../../src/conversations/conversation-run-service";
import type {
  ConversationTurnCancelInput,
  ConversationTurnCancelResult,
  ConversationTurnRunInput,
  ConversationTurnRunResult,
  ConversationTurnRunner,
} from "../../../src/conversations/conversation-turn-runner";
import { SqliteConversationStore } from "../../../src/conversations/sqlite-conversation-store";
import { createDirectConversationId, createDirectTopicId } from "../../../src/domain/ids";
import { AsyncMutex } from "../../../src/orchestration/async-mutex";
import { createStrictOwnedSessionRelease } from "../../../src/sessions/owned-session-release";
import { SessionService } from "../../../src/sessions/session-service";
import { StateStore } from "../../../src/state/state-store";
import { createEmptyState, type AppState } from "../../../src/state/types";
import { directDeleteDeclineIsCleanCancel } from "../../../packages/relay-web/src/lib/direct-delete-cancel";

const NOW = "2026-09-15T12:00:00.000Z";
const LATER = "2026-09-15T12:05:00.000Z";

class MemoryStateStore implements Pick<StateStore, "save" | "saveNow"> {
  async save(): Promise<void> {}
  async saveNow(): Promise<void> {}
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

async function waitUntil(cond: () => boolean): Promise<void> {
  const deadline = Date.now() + 1500;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitUntil timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function createConfig(): AppConfig {
  return {
    transport: { type: "acpx-cli", command: "acpx", permissionMode: "approve-all", nonInteractivePermissions: "deny" },
    logging: { level: "info", maxSizeBytes: 1024, maxFiles: 2, retentionDays: 1, perf: { enabled: false } },
    channel: { type: "weixin", replyMode: "stream" },
    channels: [{ id: "weixin", type: "weixin", enabled: true }],
    plugins: [],
    agents: { codex: { driver: "codex" }, claude: { driver: "claude" } },
    workspaces: { backend: { cwd: "/tmp/backend" }, frontend: { cwd: "/tmp/frontend" } },
    orchestration: {
      maxPendingAgentRequestsPerCoordinator: 3,
      allowWorkerChainedRequests: false,
      allowedAgentRequestTargets: [],
      allowedAgentRequestRoles: [],
      progressHeartbeatSeconds: 30,
      maxParallelTasksPerAgent: 1,
    },
  };
}

function profile(id: string, name: string) {
  return snapshotBotProfile({
    id, name, agent: "codex", workspace: "backend", enabled: true,
    profileRevision: 1, createdAt: NOW, updatedAt: NOW,
  }, NOW);
}

class FakeRunner implements ConversationTurnRunner {
  runs: ConversationTurnRunInput[] = [];
  hang?: ReturnType<typeof deferred>;
  cancelOutcome: ConversationTurnCancelResult = { outcome: "cancelled" };
  failRelease = false;
  private readonly cancelled = new Set<string>();
  private inFlight?: ConversationTurnRunInput;
  private runDone?: Promise<void>;

  async run(input: ConversationTurnRunInput): Promise<ConversationTurnRunResult> {
    this.runs.push(input);
    this.inFlight = input;
    let settle!: () => void;
    this.runDone = new Promise<void>((resolve) => { settle = resolve; });
    try {
      if (this.hang) await this.hang.promise;
      if (this.cancelOutcome.outcome === "unknown") return { status: "failed", unknown: true, error: "provider result unknown" };
      return this.cancelled.has(input.promptRequestId) ? { status: "cancelled" } : { status: "completed", text: "done" };
    } finally {
      if (this.inFlight === input) this.inFlight = undefined;
      settle();
    }
  }

  async cancel(_input: ConversationTurnCancelInput): Promise<ConversationTurnCancelResult> {
    if (this.inFlight) {
      this.cancelled.add(this.inFlight.promptRequestId);
      this.hang?.resolve();
      await this.runDone;
    }
    return this.cancelOutcome;
  }
}

async function createHarness(
  runner = new FakeRunner(),
  physical: { deleteSession(): Promise<void>; releaseLogicalSession(): Promise<void> } = {
    async deleteSession() {},
    async releaseLogicalSession() {},
  },
  options: { afterTeardownMarkedDeleting?: () => Promise<void> } = {},
) {
  const path = join(mkdtempSync(join(tmpdir(), "xacpx-indeterminate-")), "conversation.sqlite");
  const store = await SqliteConversationStore.open(path);
  const state = createEmptyState();
  const stateStore = new MemoryStateStore();
  const stateMutex = new AsyncMutex();
  const config = createConfig();
  const sessions = new SessionService(config, stateStore, state, { now: () => Date.parse(NOW), stateMutex });
  const releaseOwnedSession = createStrictOwnedSessionRelease({ sessions, transport: physical });
  let n = 0;
  const ids = ["bot_reviewer", "bot_tester"];
  const bots = new BotService(config, state, stateStore, {
    now: () => new Date(NOW),
    createId: () => ids[n++] ?? `bot_${n}`,
    stateMutex,
  });
  const runtime = new BotRuntimeManager(bots, sessions, state, stateStore, {
    now: () => new Date(NOW),
    stateMutex,
    releaseOwnedSession,
  });
  const dispatcher = new ConversationDispatcher(store, runtime, runner, sessions, {
    now: () => new Date(NOW),
    ownerId: "dispatcher-live",
    leaseMs: 30_000,
  });
  const service = new ConversationRunService(store, bots, runtime, dispatcher, sessions, state, stateStore, {
    now: () => new Date(NOW),
    stateMutex,
    autoKick: false,
    releaseOwnedSession,
    afterTeardownMarkedDeleting: options.afterTeardownMarkedDeleting,
  });
  const reviewer = await bots.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  const tester = await bots.createBot({ name: "Tester", agent: "codex", workspace: "backend" });
  await service.activateAfterConsumerLock();
  return { path, store, state, stateStore, bots, runtime, runner, dispatcher, service, reviewer, tester, sessions };
}

test("an indeterminate member cancels unstarted siblings and leaves a started sibling runnable", async () => {
  const store = await SqliteConversationStore.open(":memory:");
  const accepted = store.acceptRequest({
    conversationId: "conv_g",
    topicId: "topic_g",
    requestId: "req-pair",
    botId: "bot_reviewer",
    content: "go",
    profileSnapshot: profile("bot_reviewer", "Reviewer"),
    members: [{ botId: "bot_tester", profileSnapshot: profile("bot_tester", "Tester") }],
    now: NOW,
  });
  const [turnA, turnB] = accepted.memberTurns;
  const claimA = store.claimNextDispatch({
    now: NOW, owner: "owner", leaseExpiresAt: LATER, authorityEpoch: "epoch",
  })!;
  store.markExecutionStarted({
    dispatchId: claimA.dispatch.id, owner: "owner", generation: claimA.dispatch.generation,
    runId: accepted.run.id, memberTurnId: turnA!.id,
    sessionAlias: "sess_a", logicalSessionId: "lsess_a", sourceTurnId: "sturn_a", now: NOW,
  });
  const sealed = store.completeCancel(accepted.run.id, turnA!.id, NOW, true, true, "sturn_a");
  expect(sealed.state).toBe("indeterminate");
  expect(sealed.completionReason).toBe("started_result_unknown");
  expect(store.getMemberTurn(turnA!.id)?.state).toBe("indeterminate");
  expect(store.getMemberTurn(turnB!.id)?.state).toBe("cancelled");
  expect(store.getMemberTurn(turnB!.id)?.startedAt).toBeUndefined();
  expect(store.getRun(accepted.run.id)?.consumedMemberTurns).toBe(1);
  expect(store.getDispatchForMemberTurn(turnB!.id)?.state).toBe("completed");

  const bothStarted = store.acceptRequest({
    conversationId: "conv_g",
    topicId: "topic_g2",
    requestId: "req-live",
    botId: "bot_reviewer",
    content: "together",
    profileSnapshot: profile("bot_reviewer", "Reviewer"),
    members: [{ botId: "bot_tester", profileSnapshot: profile("bot_tester", "Tester") }],
    now: NOW,
  });
  const [liveA, liveB] = bothStarted.memberTurns;
  for (const turn of [liveA!, liveB!]) {
    const claim = store.claimNextDispatch({
      now: NOW, owner: "owner", leaseExpiresAt: LATER, authorityEpoch: "epoch",
    })!;
    store.markExecutionStarted({
      dispatchId: claim.dispatch.id, owner: "owner", generation: claim.dispatch.generation,
      runId: bothStarted.run.id, memberTurnId: turn.id,
      sessionAlias: `sess_${turn.botId}`, logicalSessionId: `lsess_${turn.botId}`,
      sourceTurnId: `sturn_${turn.botId}`, now: NOW,
    });
  }
  store.completeCancel(bothStarted.run.id, liveA!.id, NOW, true, true, "sturn_bot_reviewer");
  expect(store.getRun(bothStarted.run.id)?.state).toBe("indeterminate");
  expect(store.getMemberTurn(liveB!.id)?.state).toBe("running");
  const proved = store.completeExecution({
    runId: bothStarted.run.id,
    memberTurnId: liveB!.id,
    botId: liveB!.botId,
    content: "sibling finished",
    sourceTurn: { sessionAlias: "sess_bot_tester", turnId: "sturn_bot_tester" },
    now: LATER,
  });
  expect(proved.memberTurn.state).toBe("completed");
  expect(proved.run.state).toBe("indeterminate");
  expect(proved.run.consumedMemberTurns).toBe(2);
  expect(store.listMessages({ conversationId: "conv_g", topicId: "topic_g2", limit: 10 })
    .some((message) => message.content === "sibling finished")).toBe(true);
  expect(() => store.completeExecution({
    runId: bothStarted.run.id,
    memberTurnId: liveB!.id,
    botId: liveB!.botId,
    content: "again",
    sourceTurn: { sessionAlias: "wrong", turnId: "sturn_bot_tester" },
    now: LATER,
  })).toThrow(ConversationError);
  store.close();
});

test("resolution keeps the unknown evidence, is idempotent, and then allows direct teardown", async () => {
  const harness = await createHarness();
  const conversationId = createDirectConversationId(harness.reviewer.id);
  const topicId = createDirectTopicId(harness.reviewer.id);
  const accepted = harness.store.acceptRequest({
    conversationId,
    topicId,
    requestId: "req-direct-unknown",
    botId: harness.reviewer.id,
    content: "hello",
    profileSnapshot: profile(harness.reviewer.id, "Reviewer"),
    now: NOW,
  });
  const claim = harness.store.claimNextDispatch({
    now: NOW, owner: "dispatcher-dead", leaseExpiresAt: LATER, authorityEpoch: "epoch",
  })!;
  harness.store.markExecutionStarted({
    dispatchId: claim.dispatch.id, owner: "dispatcher-dead", generation: claim.dispatch.generation,
    runId: accepted.run.id, memberTurnId: accepted.memberTurn.id,
    sessionAlias: "sess", logicalSessionId: "11111111-1111-4111-8111-111111111111",
    sourceTurnId: "sturn", now: NOW,
  });
  harness.store.directWriteForTest("pending_dispatches", claim.dispatch.id, { lease_expires_at: NOW });
  const recovered = harness.store.recoverExpiredClaims(LATER, { conversationId });
  expect(recovered.map((entry) => entry.outcome)).toEqual(["indeterminate"]);
  await expect(harness.service.teardownDirectConversation(harness.reviewer.id)).rejects.toMatchObject({
    code: "conversation_indeterminate",
    details: { deleting: false },
  });
  expect(harness.store.isConversationDeleting(conversationId)).toBe(false);
  expect(harness.state.conversations[conversationId]?.lifecycle).not.toBe("deleting");
  expect(harness.store.getRun(accepted.run.id)?.state).toBe("indeterminate");
  await expect(harness.bots.deleteBot(harness.reviewer.id)).rejects.toBeInstanceOf(BotError);

  expect(() => harness.service.resolveIndeterminateRun({
    runId: accepted.run.id, action: "accept-unknown", reason: "   ", actorAccountId: "acct",
  })).toThrow(ConversationError);
  expect(() => harness.service.resolveIndeterminateRun({
    runId: accepted.run.id, action: "accept-unknown", reason: "looked", actorAccountId: "bot:member",
  })).toThrow(ConversationError);
  const first = harness.service.resolveIndeterminateRun({
    runId: accepted.run.id, action: "accept-unknown", reason: "operator checked the workspace", actorAccountId: "acct", actorName: "Ada",
  });
  const again = harness.service.resolveIndeterminateRun({
    runId: accepted.run.id, action: "accept-unknown", reason: "different reason must not rewrite", actorAccountId: "other",
  });
  expect(again).toEqual(first);
  expect(harness.store.getRun(accepted.run.id)?.state).toBe("indeterminate");
  expect(harness.store.getMemberTurn(accepted.memberTurn.id)?.state).toBe("indeterminate");
  expect(first.members[0]?.state).toBe("indeterminate");

  expect(() => harness.store.completeExecution({
    runId: accepted.run.id, memberTurnId: accepted.memberTurn.id, botId: harness.reviewer.id,
    content: "late", sourceTurn: { sessionAlias: "other", turnId: "sturn" }, now: LATER,
  })).toThrow(ConversationError);
  const late = harness.store.completeExecution({
    runId: accepted.run.id, memberTurnId: accepted.memberTurn.id, botId: harness.reviewer.id,
    content: "late proof", sourceTurn: { sessionAlias: "sess", turnId: "sturn" }, now: LATER,
  });
  expect(late.memberTurn.state).toBe("completed");
  expect(late.run.state).toBe("indeterminate");
  expect(harness.store.getRunResolution(accepted.run.id)?.id).toBe(first.id);
  expect(harness.store.getRunResolution(accepted.run.id)?.reason).toBe("operator checked the workspace");

  await harness.service.teardownDirectConversation(harness.reviewer.id);
  expect(harness.store.getRun(accepted.run.id)).toBeUndefined();
  expect(harness.store.getRunResolution(accepted.run.id)).toBeUndefined();
  await harness.bots.deleteBot(harness.reviewer.id);
  expect(harness.bots.listBots().some((bot) => bot.id === harness.reviewer.id)).toBe(false);
  harness.store.close();
});

test("direct delete waits out a finished run, an extra topic, and a release failure retry", async () => {
  let failRelease = false;
  const runner = new FakeRunner();
  const harness = await createHarness(runner, {
    async deleteSession() {
      if (failRelease) throw new Error("disk busy");
    },
    async releaseLogicalSession() {},
  });
  const extra = await harness.service.createDirectTopic(harness.reviewer.id, "Notes");
  await harness.service.teardownDirectTopic(createDirectConversationId(harness.reviewer.id), extra.id);
  expect(harness.state.conversation_topics[extra.id]).toBeUndefined();
  expect(harness.state.conversation_topics[createDirectTopicId(harness.reviewer.id)]).toBeDefined();
  await expect(harness.service.teardownDirectTopic(
    createDirectConversationId(harness.reviewer.id),
    createDirectTopicId(harness.reviewer.id),
  )).rejects.toMatchObject({ code: "default_topic_permanent" });

  const hang = deferred();
  runner.hang = hang;
  const accepted = await harness.service.acceptDirectPrompt({
    botId: harness.reviewer.id,
    requestId: "req-live",
    content: "work",
  });
  void harness.dispatcher.kick();
  await waitUntil(() => runner.runs.length === 1);
  runner.cancelOutcome = { outcome: "unknown" };
  await expect(harness.service.teardownDirectConversation(harness.reviewer.id)).rejects.toMatchObject({
    code: "conversation_indeterminate",
  });
  expect(harness.store.isConversationDeleting(createDirectConversationId(harness.reviewer.id))).toBe(true);
  expect(harness.store.getRun(accepted.run.id)?.state).toBe("indeterminate");
  harness.service.resolveIndeterminateRun({
    runId: accepted.run.id, action: "accept-unknown", reason: "provider never returned", actorAccountId: "acct",
  });

  failRelease = true;
  await expect(harness.service.teardownDirectConversation(harness.reviewer.id)).rejects.toMatchObject({
    code: "session_release_failed",
  });
  expect(harness.bots.getBot(harness.reviewer.id).id).toBe(harness.reviewer.id);
  failRelease = false;
  await harness.service.teardownDirectConversation(harness.reviewer.id);
  await harness.bots.deleteBot(harness.reviewer.id);
  harness.store.close();
});

test("direct teardown of a group member keeps direct history", async () => {
  const harness = await createHarness();
  const accepted = await harness.service.acceptDirectPrompt({
    botId: harness.reviewer.id,
    requestId: "req-grouped",
    content: "keep me",
  });
  void harness.dispatcher.kick();
  await waitUntil(() => harness.store.getRun(accepted.run.id)?.state === "completed");
  const conversationId = createDirectConversationId(harness.reviewer.id);
  await harness.bots.createGroup({
    title: "Keep",
    botIds: [harness.reviewer.id, harness.tester.id],
  });
  await expect(harness.service.teardownDirectConversation(harness.reviewer.id)).rejects.toMatchObject({
    code: "bot_in_group",
  });
  expect(harness.store.isConversationDeleting(conversationId)).toBe(false);
  expect(harness.store.getRun(accepted.run.id)?.state).toBe("completed");
  expect(harness.state.conversations[conversationId]?.lifecycle).not.toBe("deleting");
  expect(harness.state.bots[harness.reviewer.id]).toBeDefined();
  await expect(harness.bots.deleteBot(harness.reviewer.id)).rejects.toMatchObject({ code: "bot_in_group" });
  harness.store.close();
});

test("topic appstate persist failure keeps sqlite rows, and a sqlite failure stays retryable", async () => {
  const harness = await createHarness();
  const conversationId = createDirectConversationId(harness.reviewer.id);
  const extra = await harness.service.createDirectTopic(harness.reviewer.id, "Notes");
  const accepted = await harness.service.acceptDirectPrompt({
    botId: harness.reviewer.id,
    requestId: "req-notes",
    content: "note",
    topicId: extra.id,
  });
  void harness.dispatcher.kick();
  await waitUntil(() => harness.store.getRun(accepted.run.id)?.state === "completed");

  let failPersist = true;
  harness.stateStore.saveNow = async (next) => {
    if (failPersist && !next.conversation_topics[extra.id]) {
      throw new Error("injected appstate persist failure");
    }
  };
  await expect(harness.service.teardownDirectTopic(conversationId, extra.id)).rejects.toThrow(
    "injected appstate persist failure",
  );
  expect(harness.store.getRun(accepted.run.id)?.state).toBe("completed");
  expect(harness.store.isTopicDeletingIn(conversationId, extra.id)).toBe(true);
  expect(harness.state.conversation_topics[extra.id]).toBeDefined();

  failPersist = false;
  let failSqlite = true;
  const original = harness.store.deleteTopicContent.bind(harness.store);
  harness.store.deleteTopicContent = (cid, tid) => {
    if (failSqlite) {
      failSqlite = false;
      throw new Error("injected sqlite topic delete failure");
    }
    original(cid, tid);
  };
  await expect(harness.service.teardownDirectTopic(conversationId, extra.id)).rejects.toThrow(
    "injected sqlite topic delete failure",
  );
  expect(harness.state.conversation_topics[extra.id]).toBeUndefined();
  expect(harness.store.getRun(accepted.run.id)?.state).toBe("completed");
  expect(harness.store.isTopicDeletingIn(conversationId, extra.id)).toBe(true);

  await harness.service.teardownDirectTopic(conversationId, extra.id);
  expect(harness.store.getRun(accepted.run.id)).toBeUndefined();
  expect(harness.store.isTopicDeletingIn(conversationId, extra.id)).toBe(false);
  expect(harness.state.conversation_topics[createDirectTopicId(harness.reviewer.id)]).toBeDefined();
  harness.store.close();
});

test("group topic appstate persist failure keeps the deleting barrier and retries", async () => {
  const harness = await createHarness();
  const group = await harness.bots.createGroup({
    title: "Squad",
    botIds: [harness.reviewer.id, harness.tester.id],
  });
  const topic = await harness.service.createGroupTopic(group.id, "Notes", {
    workspace: "backend",
    isolation: "shared-single-writer",
  });
  let contentDeletes = 0;
  const original = harness.store.deleteTopicContent.bind(harness.store);
  harness.store.deleteTopicContent = (conversationId, topicId) => {
    contentDeletes += 1;
    original(conversationId, topicId);
  };
  let fail = true;
  harness.stateStore.saveNow = async (next) => {
    if (fail && !next.conversation_topics[topic.id]) {
      throw new Error("injected appstate persist failure");
    }
  };
  await expect(harness.service.teardownGroupTopic(group.id, topic.id)).rejects.toThrow(
    "injected appstate persist failure",
  );
  expect(contentDeletes).toBe(0);
  expect(harness.store.isTopicDeletingIn(group.id, topic.id)).toBe(true);
  expect(harness.state.conversation_topics[topic.id]?.status).toBe("deleting");
  fail = false;
  await harness.service.teardownGroupTopic(group.id, topic.id);
  expect(harness.state.conversation_topics[topic.id]).toBeUndefined();
  expect(harness.store.isTopicDeletingIn(group.id, topic.id)).toBe(false);
  expect(contentDeletes).toBe(1);
  harness.store.close();
});

test("group membership writes during direct teardown leave the hidden session in place", async () => {
  let harness!: Awaited<ReturnType<typeof createHarness>>;
  harness = await createHarness(new FakeRunner(), {
    async deleteSession() {},
    async releaseLogicalSession() {},
  }, {
    afterTeardownMarkedDeleting: async () => {
      expect(Object.keys(harness.state.sessions).length).toBeGreaterThan(0);
      await expect(harness.bots.createGroup({
        title: "During delete",
        botIds: [harness.reviewer.id, harness.tester.id],
      })).rejects.toMatchObject({ code: "bot_direct_deleting" });
      const third = await harness.bots.createBot({ name: "Third", agent: "codex", workspace: "backend" });
      const group = await harness.bots.createGroup({
        title: "Others",
        botIds: [harness.tester.id, third.id],
      });
      await expect(harness.bots.updateGroup(group.id, {
        botIds: [harness.tester.id, third.id, harness.reviewer.id],
      })).rejects.toMatchObject({ code: "bot_direct_deleting" });
      expect(harness.bots.getGroup(group.id).botIds.includes(harness.reviewer.id)).toBe(false);
      expect(Object.keys(harness.state.sessions).length).toBeGreaterThan(0);
    },
  });
  const accepted = await harness.service.acceptDirectPrompt({
    botId: harness.reviewer.id,
    requestId: "req-session",
    content: "keep the session until delete commits",
  });
  void harness.dispatcher.kick();
  await waitUntil(() => harness.store.getRun(accepted.run.id)?.state === "completed");
  await harness.service.teardownDirectConversation(harness.reviewer.id);
  await harness.bots.deleteBot(harness.reviewer.id);
  expect(harness.bots.listBots().some((bot) => bot.id === harness.reviewer.id)).toBe(false);
  harness.store.close();
});

test("a run sealed indeterminate while teardown waits for the lifecycle gate does not enter deleting", async () => {
  const harness = await createHarness();
  const conversationId = createDirectConversationId(harness.reviewer.id);
  const topicId = createDirectTopicId(harness.reviewer.id);
  const accepted = harness.store.acceptRequest({
    conversationId,
    topicId,
    requestId: "req-race",
    botId: harness.reviewer.id,
    content: "still running at the precheck",
    profileSnapshot: profile(harness.reviewer.id, "Reviewer"),
    now: NOW,
  });
  const claim = harness.store.claimNextDispatch({
    now: NOW, owner: "dispatcher-dead", leaseExpiresAt: LATER, authorityEpoch: "epoch",
  })!;
  harness.store.markExecutionStarted({
    dispatchId: claim.dispatch.id, owner: "dispatcher-dead", generation: claim.dispatch.generation,
    runId: accepted.run.id, memberTurnId: accepted.memberTurn.id,
    sessionAlias: "sess", logicalSessionId: "11111111-1111-4111-8111-111111111111",
    sourceTurnId: "sturn", now: NOW,
  });
  expect(harness.store.getRun(accepted.run.id)?.state).toBe("running");
  const release = deferred();
  const holder = harness.bots.runLifecycle(harness.reviewer.id, () => release.promise);
  const teardown = harness.service.teardownDirectConversation(harness.reviewer.id);
  harness.store.directWriteForTest("pending_dispatches", claim.dispatch.id, { lease_expires_at: NOW });
  expect(harness.store.recoverExpiredClaims(LATER, { conversationId }).map((entry) => entry.outcome)).toEqual(["indeterminate"]);
  release.resolve();
  await holder;
  await expect(teardown).rejects.toMatchObject({
    code: "conversation_indeterminate",
    details: { deleting: false },
  });
  expect(harness.store.isConversationDeleting(conversationId)).toBe(false);
  const again = await harness.service.acceptDirectPrompt({
    botId: harness.reviewer.id,
    requestId: "req-after-decline",
    content: "conversation still accepts work",
  });
  expect(again.run.state).toBe("queued");
  harness.store.close();
});

test("a second delete after a post-barrier unknown result still reports the live barrier", async () => {
  const runner = new FakeRunner();
  const harness = await createHarness(runner);
  const conversationId = createDirectConversationId(harness.reviewer.id);
  const hang = deferred();
  runner.hang = hang;
  const accepted = await harness.service.acceptDirectPrompt({
    botId: harness.reviewer.id,
    requestId: "req-retry-delete",
    content: "work",
  });
  void harness.dispatcher.kick();
  await waitUntil(() => runner.runs.length === 1);
  runner.cancelOutcome = { outcome: "unknown" };
  await expect(harness.service.teardownDirectConversation(harness.reviewer.id)).rejects.toMatchObject({
    code: "conversation_indeterminate",
    details: { deleting: true, runIds: [accepted.run.id] },
  });
  expect(harness.store.isConversationDeleting(conversationId)).toBe(true);
  const second = await harness.service.teardownDirectConversation(harness.reviewer.id).then(
    () => { throw new Error("second teardown should fail"); },
    (error: unknown) => error,
  );
  expect(second).toMatchObject({
    code: "conversation_indeterminate",
    details: { deleting: true, runIds: [accepted.run.id] },
  });
  const details = (second as { details?: { deleting?: unknown } }).details;
  expect(directDeleteDeclineIsCleanCancel(details)).toBe(false);
  expect(harness.store.isConversationDeleting(conversationId)).toBe(true);
  await expect(harness.service.acceptDirectPrompt({
    botId: harness.reviewer.id,
    requestId: "req-blocked",
    content: "still deleting",
  })).rejects.toMatchObject({ code: "conversation_deleting" });
  harness.store.close();
});

test("createGroup between direct teardown and deleteBot cannot adopt the bot", async () => {
  const harness = await createHarness();
  const conversationId = createDirectConversationId(harness.reviewer.id);
  const accepted = await harness.service.acceptDirectPrompt({
    botId: harness.reviewer.id,
    requestId: "req-gap",
    content: "history",
  });
  void harness.dispatcher.kick();
  await waitUntil(() => harness.store.getRun(accepted.run.id)?.state === "completed");
  await harness.service.teardownDirectConversation(harness.reviewer.id);
  expect(harness.store.getRun(accepted.run.id)).toBeUndefined();
  expect(harness.store.isConversationDeleting(conversationId)).toBe(false);
  expect(harness.store.hasDirectBotDeleteIntent(harness.reviewer.id)).toBe(true);
  await expect(harness.bots.createGroup({
    title: "After teardown",
    botIds: [harness.reviewer.id, harness.tester.id],
  })).rejects.toMatchObject({ code: "bot_direct_deleting" });
  await expect(harness.service.acceptDirectPrompt({
    botId: harness.reviewer.id,
    requestId: "req-after-history",
    content: "must not start",
  })).rejects.toMatchObject({ code: "conversation_deleting" });
  expect(harness.bots.getBot(harness.reviewer.id).id).toBe(harness.reviewer.id);
  await harness.bots.deleteBot(harness.reviewer.id);
  expect(harness.bots.listBots().some((bot) => bot.id === harness.reviewer.id)).toBe(false);
  expect(harness.store.hasDirectBotDeleteIntent(harness.reviewer.id)).toBe(false);
  harness.store.close();
});

async function openDiskConversationStack(dir: string, sqlitePath: string, state: AppState, runner: FakeRunner) {
  const stateStore = new StateStore(join(dir, "state.json"));
  const store = await SqliteConversationStore.open(sqlitePath);
  const stateMutex = new AsyncMutex();
  const config = createConfig();
  const sessions = new SessionService(config, stateStore, state, { now: () => Date.parse(NOW), stateMutex });
  const releaseOwnedSession = createStrictOwnedSessionRelease({
    sessions,
    transport: { async deleteSession() {}, async releaseLogicalSession() {} },
  });
  let n = 0;
  const ids = ["bot_reviewer", "bot_tester"];
  const bots = new BotService(config, state, stateStore, {
    now: () => new Date(NOW),
    createId: () => ids[n++] ?? `bot_${n}`,
    stateMutex,
  });
  const runtime = new BotRuntimeManager(bots, sessions, state, stateStore, {
    now: () => new Date(NOW),
    stateMutex,
    releaseOwnedSession,
  });
  const dispatcher = new ConversationDispatcher(store, runtime, runner, sessions, {
    now: () => new Date(NOW),
    ownerId: "dispatcher-disk",
    leaseMs: 30_000,
  });
  const service = new ConversationRunService(store, bots, runtime, dispatcher, sessions, state, stateStore, {
    now: () => new Date(NOW),
    stateMutex,
    autoKick: false,
    releaseOwnedSession,
  });
  return { store, bots, dispatcher, service };
}

test("topic sqlite cleanup resumes from a reloaded state file and new services", async () => {
  const dir = mkdtempSync(join(tmpdir(), "xacpx-restart-"));
  const sqlitePath = join(dir, "conversation.sqlite");
  const runner = new FakeRunner();
  const firstState = createEmptyState();
  const first = await openDiskConversationStack(dir, sqlitePath, firstState, runner);
  const reviewer = await first.bots.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  await first.bots.createBot({ name: "Tester", agent: "codex", workspace: "backend" });
  await first.service.activateAfterConsumerLock();
  const conversationId = createDirectConversationId(reviewer.id);
  const extra = await first.service.createDirectTopic(reviewer.id, "Notes");
  const accepted = await first.service.acceptDirectPrompt({
    botId: reviewer.id,
    requestId: "req-restart",
    content: "note",
    topicId: extra.id,
  });
  void first.dispatcher.kick();
  await waitUntil(() => first.store.getRun(accepted.run.id)?.state === "completed");
  let failSqlite = true;
  const original = first.store.deleteTopicContent.bind(first.store);
  first.store.deleteTopicContent = (cid, tid) => {
    if (failSqlite) {
      failSqlite = false;
      throw new Error("injected sqlite topic delete failure");
    }
    original(cid, tid);
  };
  await expect(first.service.teardownDirectTopic(conversationId, extra.id)).rejects.toThrow(
    "injected sqlite topic delete failure",
  );
  expect(firstState.conversation_topics[extra.id]).toBeUndefined();
  expect(first.store.isTopicDeletingIn(conversationId, extra.id)).toBe(true);
  first.dispatcher.stop();
  first.store.close();

  const loaded = await new StateStore(join(dir, "state.json")).load();
  expect(loaded.bots[reviewer.id]?.name).toBe("Reviewer");
  expect(loaded.conversation_topics[extra.id]).toBeUndefined();
  expect(loaded.conversation_topics[createDirectTopicId(reviewer.id)]).toBeDefined();
  const second = await openDiskConversationStack(dir, sqlitePath, loaded, new FakeRunner());
  expect(second.bots.getBot(reviewer.id).name).toBe("Reviewer");
  await second.service.teardownDirectTopic(conversationId, extra.id);
  expect(second.store.getRun(accepted.run.id)).toBeUndefined();
  expect(second.store.isTopicDeletingIn(conversationId, extra.id)).toBe(false);
  expect(loaded.conversation_topics[createDirectTopicId(reviewer.id)]).toBeDefined();
  second.store.close();
});

test("shutdown does not nest the state mutex with direct teardown", async () => {
  const harness = await createHarness();
  const accepted = await harness.service.acceptDirectPrompt({
    botId: harness.tester.id,
    requestId: "req-shutdown",
    content: "bye",
  });
  void harness.dispatcher.kick();
  await waitUntil(() => harness.store.getRun(accepted.run.id)?.state === "completed");
  await Promise.all([
    harness.dispatcher.shutdown(),
    harness.service.teardownDirectConversation(harness.tester.id),
  ]);
  await harness.bots.deleteBot(harness.tester.id);
  harness.store.close();
});
