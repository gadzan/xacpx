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
import type { StateStore } from "../../../src/state/state-store";
import { createEmptyState } from "../../../src/state/types";

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

async function createHarness(runner = new FakeRunner(), physical: { deleteSession(): Promise<void>; releaseLogicalSession(): Promise<void> } = {
  async deleteSession() {},
  async releaseLogicalSession() {},
}) {
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
  });
  const reviewer = await bots.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  const tester = await bots.createBot({ name: "Tester", agent: "codex", workspace: "backend" });
  await service.activateAfterConsumerLock();
  return { path, store, state, bots, runner, dispatcher, service, reviewer, tester, sessions };
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
  });
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
