import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

import { snapshotBotProfile } from "../../../src/bots/bot-types";
import { BotRuntimeManager } from "../../../src/bots/bot-runtime-manager";
import { BotService } from "../../../src/bots/bot-service";
import type { AppConfig } from "../../../src/config/types";
import { ConversationError } from "../../../src/conversations/conversation-error";
import {
  claimLeaseRenewalDelayMs,
  ConversationDispatcher,
  type LeaseScheduler,
} from "../../../src/conversations/conversation-dispatcher";
import { ConversationRunService } from "../../../src/conversations/conversation-run-service";
import type {
  ConversationTurnCancelInput,
  ConversationTurnCancelResult,
  ConversationTurnRunInput,
  ConversationTurnRunResult,
  ConversationTurnRunner,
} from "../../../src/conversations/conversation-turn-runner";
import { SqliteConversationStore } from "../../../src/conversations/sqlite-conversation-store";
import { AsyncMutex } from "../../../src/orchestration/async-mutex";
import { createStrictOwnedSessionRelease } from "../../../src/sessions/owned-session-release";
import { SessionService } from "../../../src/sessions/session-service";
import type { StateStore } from "../../../src/state/state-store";
import { createEmptyState, type AppState } from "../../../src/state/types";

const NOW = "2026-09-15T12:00:00.000Z";
const LEASE_MS = 30_000;
const HUMAN_INGRESS = {
  chatKey: "relay:acct",
  senderId: "acct",
  accountId: "acct",
  isOwner: true as const,
};

class ManualClock {
  ms = Date.parse(NOW);
  private tasks: Array<{ due: number; cb: () => void; cancelled: boolean; fired: boolean }> = [];

  date(): Date {
    return new Date(this.ms);
  }

  iso(): string {
    return this.date().toISOString();
  }

  readonly scheduler: LeaseScheduler = {
    schedule: (delayMs, callback) => {
      const task = { due: this.ms + delayMs, cb: callback, cancelled: false, fired: false };
      this.tasks.push(task);
      return { cancel: () => { task.cancelled = true; } };
    },
  };

  unfired(): number {
    return this.tasks.filter((task) => !task.cancelled && !task.fired).length;
  }

  elapse(ms: number): void {
    this.ms += ms;
  }

  async advance(ms: number): Promise<void> {
    const target = this.ms + ms;
    for (;;) {
      const next = this.tasks
        .filter((task) => !task.cancelled && !task.fired && task.due <= target)
        .sort((left, right) => left.due - right.due)[0];
      if (!next) break;
      this.ms = next.due;
      next.fired = true;
      next.cb();
      await Promise.resolve();
      await Promise.resolve();
    }
    this.ms = target;
  }
}

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
  const deadline = Date.now() + 1000;
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

class FakeRunner implements ConversationTurnRunner {
  runs: ConversationTurnRunInput[] = [];
  hang?: ReturnType<typeof deferred>;
  result: ConversationTurnRunResult = { status: "completed", text: "done" };
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
      return this.cancelled.has(input.promptRequestId) ? { status: "cancelled" } : this.result;
    } finally {
      if (this.inFlight === input) this.inFlight = undefined;
      settle();
    }
  }

  async cancel(input: ConversationTurnCancelInput): Promise<ConversationTurnCancelResult> {
    const running = this.inFlight;
    if (running) {
      this.cancelled.add(running.promptRequestId);
      this.hang?.resolve();
      await this.runDone;
    }
    return { outcome: "cancelled" };
  }
}

async function createHarness(clock: ManualClock) {
  const path = join(mkdtempSync(join(tmpdir(), "xacpx-lease-")), "conversation.sqlite");
  const store = await SqliteConversationStore.open(path);
  const state = createEmptyState();
  const stateStore = new MemoryStateStore();
  const stateMutex = new AsyncMutex();
  const config = createConfig();
  const sessions = new SessionService(config, stateStore, state, { now: () => clock.ms, stateMutex });
  const physical = {
    async deleteSession() {},
    async releaseLogicalSession() {},
  };
  const releaseOwnedSession = createStrictOwnedSessionRelease({ sessions, transport: physical });
  let n = 0;
  const ids = ["bot_reviewer", "bot_tester", "bot_extra"];
  const bots = new BotService(config, state, stateStore, {
    now: () => clock.date(),
    createId: () => ids[n++] ?? `bot_${n}`,
    stateMutex,
  });
  const runtime = new BotRuntimeManager(bots, sessions, state, stateStore, {
    now: () => clock.date(),
    stateMutex,
    releaseOwnedSession,
  });
  const runner = new FakeRunner();
  const dispatcher = new ConversationDispatcher(store, runtime, runner, sessions, {
    now: () => clock.date(),
    ownerId: "dispatcher-live",
    leaseMs: LEASE_MS,
    leaseScheduler: clock.scheduler,
  });
  const service = new ConversationRunService(store, bots, runtime, dispatcher, sessions, state, stateStore, {
    now: () => clock.date(),
    stateMutex,
    autoKick: false,
    releaseOwnedSession,
  });
  const reviewer = await bots.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  const tester = await bots.createBot({ name: "Tester", agent: "codex", workspace: "backend" });
  const extra = await bots.createBot({ name: "Extra", agent: "codex", workspace: "backend" });
  await service.activateAfterConsumerLock();
  expect(claimLeaseRenewalDelayMs(LEASE_MS)).toBe(10_000);
  expect(clock.unfired()).toBeGreaterThan(0);
  return { store, state, bots, runtime, runner, dispatcher, service, reviewer, tester, extra };
}

function snapshot() {
  return snapshotBotProfile({
    id: "bot_reviewer",
    name: "Reviewer",
    agent: "codex",
    workspace: "backend",
    enabled: true,
    profileRevision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  }, NOW);
}

async function startedClaim(
  store: SqliteConversationStore,
  conversationId: string,
  topicId: string,
  requestId: string,
  owner: string,
) {
  const accepted = store.acceptRequest({
    conversationId,
    topicId,
    requestId,
    botId: "bot_reviewer",
    content: requestId,
    profileSnapshot: snapshot(),
    now: NOW,
  });
  const claimed = store.claimNextDispatch({
    authorityEpoch: "epoch-a",
    now: NOW,
    owner,
    leaseExpiresAt: "2026-09-15T12:00:30.000Z",
  });
  if (!claimed) throw new Error("expected a claim");
  store.markExecutionStarted({
    dispatchId: claimed.dispatch.id,
    owner,
    generation: claimed.dispatch.generation,
    runId: accepted.run.id,
    memberTurnId: accepted.memberTurn.id,
    sessionAlias: "alias",
    logicalSessionId: "11111111-1111-4111-8111-111111111111",
    sourceTurnId: `sturn_${requestId}`,
    now: NOW,
  });
  return { accepted, claimed };
}

test("scoped lease recovery never rewrites another conversation or topic", async () => {
  const store = await SqliteConversationStore.open(":memory:");
  const a1 = await startedClaim(store, "conv_a", "topic_a1", "req-a1", "owner-a");
  const a2 = await startedClaim(store, "conv_a", "topic_a2", "req-a2", "owner-a");
  const bee = store.acceptRequest({
    conversationId: "conv_b",
    topicId: "topic_b",
    requestId: "req-b",
    botId: "bot_reviewer",
    content: "b",
    profileSnapshot: snapshot(),
    now: NOW,
  });
  const claimedB = store.claimNextDispatch({
    authorityEpoch: "epoch-a",
    now: NOW,
    owner: "owner-b",
    leaseExpiresAt: "2026-09-15T12:00:30.000Z",
  });
  if (!claimedB) throw new Error("expected claim b");
  for (const id of [a1.claimed.dispatch.id, a2.claimed.dispatch.id, claimedB.dispatch.id]) {
    store.directWriteForTest("pending_dispatches", id, { lease_expires_at: "2026-09-15T12:00:01.000Z" });
  }
  const expired = "2026-09-15T12:00:02.000Z";
  const topicOnly = store.recoverExpiredClaims(expired, { conversationId: "conv_a", topicId: "topic_a1" });
  expect(topicOnly.map((entry) => entry.run.id)).toEqual([a1.accepted.run.id]);
  expect(store.getRun(a1.accepted.run.id)?.state).toBe("indeterminate");
  expect(store.getRun(a2.accepted.run.id)?.state).toBe("running");
  expect(store.getMemberTurn(a2.accepted.memberTurn.id)?.state).toBe("running");
  expect(store.getDispatchForMemberTurn(claimedB.dispatch.memberTurnId)?.state).toBe("claimed");
  expect(store.getMemberTurn(bee.memberTurn.id)?.origin).not.toBe("recovery");

  const conversationOnly = store.recoverExpiredClaims(expired, { conversationId: "conv_a" });
  expect(conversationOnly.map((entry) => entry.run.id)).toEqual([a2.accepted.run.id]);
  expect(store.getRun(a2.accepted.run.id)?.state).toBe("indeterminate");
  expect(store.getDispatchForMemberTurn(claimedB.dispatch.memberTurnId)?.generation).toBe(claimedB.dispatch.generation);

  const global = store.recoverExpiredClaims(expired);
  expect(global.map((entry) => entry.outcome)).toEqual(["requeued"]);
  expect(store.getMemberTurn(bee.memberTurn.id)?.origin).toBe("recovery");
  expect(store.getDispatchForMemberTurn(bee.memberTurn.id)?.generation).toBe(claimedB.dispatch.generation + 1);
  expect(store.getRun(a1.accepted.run.id)?.consumedMemberTurns).toBe(1);
  expect(store.getRun(a2.accepted.run.id)?.consumedMemberTurns).toBe(1);
  expect(store.recoverExpiredClaims(expired)).toEqual([]);
  expect(store.recoverExpiredClaims(expired, { conversationId: "conv_b" })).toEqual([]);
  expect(store.getRun(a1.accepted.run.id)?.consumedMemberTurns).toBe(1);

  expect(() => store.renewInFlightClaim({
    dispatchId: a1.claimed.dispatch.id,
    owner: "owner-a",
    generation: a1.claimed.dispatch.generation,
    now: expired,
    leaseExpiresAt: "2026-09-15T12:01:00.000Z",
  })).toThrow(ConversationError);
  expect(store.getDispatchForMemberTurn(a1.accepted.memberTurn.id)?.state).not.toBe("claimed");
  expect(() => store.markExecutionStarted({
    dispatchId: a1.claimed.dispatch.id,
    owner: "owner-a",
    generation: a1.claimed.dispatch.generation,
    runId: a1.accepted.run.id,
    memberTurnId: a1.accepted.memberTurn.id,
    sessionAlias: "alias",
    logicalSessionId: "11111111-1111-4111-8111-111111111111",
    sourceTurnId: "sturn_req-a1",
    now: expired,
  })).toThrow(ConversationError);
  expect(() => store.completeExecution({
    runId: a1.accepted.run.id,
    memberTurnId: a1.accepted.memberTurn.id,
    content: "forged",
    sourceTurn: { sessionAlias: "other-alias", turnId: "sturn_req-a1" },
    now: expired,
  })).toThrow(ConversationError);
  expect(store.listMessages({ conversationId: "conv_a", topicId: "topic_a1", limit: 10 }).map((message) => message.role)).toEqual(["human"]);
  expect(() => store.renewHeldClaim({
    dispatchId: claimedB.dispatch.id,
    owner: "owner-b",
    generation: claimedB.dispatch.generation,
    now: expired,
    leaseExpiresAt: "2026-09-15T12:01:00.000Z",
  })).toThrow(ConversationError);
  expect(store.getDispatchForMemberTurn(bee.memberTurn.id)?.generation).toBe(claimedB.dispatch.generation + 1);
  store.close();
  expect(() => store.renewInFlightClaim({
    dispatchId: a2.claimed.dispatch.id,
    owner: "owner-a",
    generation: a2.claimed.dispatch.generation,
    now: expired,
    leaseExpiresAt: "2026-09-15T12:01:00.000Z",
  })).toThrow(ConversationError);
});

test("live renewal keeps a Direct turn and a capped Topic turn leased across 30s", async () => {
  const clock = new ManualClock();
  const harness = await createHarness(clock);
  const hang = deferred();
  harness.runner.hang = hang;
  try {
    const direct = await harness.service.acceptDirectPrompt({
      botId: harness.reviewer.id,
      requestId: "req-direct-long",
      content: "hold",
    });
    const group = await harness.bots.createGroup({ title: "Team", botIds: [harness.reviewer.id, harness.tester.id] });
    const busy = await harness.service.createGroupTopic(group.id, "Busy", {
      workspace: "backend",
      isolation: "shared-single-writer",
    }, { maxConcurrentMemberTurns: 2 });
    const idle = await harness.service.createGroupTopic(group.id, "Idle", {
      workspace: "backend",
      isolation: "shared",
    });
    void harness.dispatcher.kick();
    await waitUntil(() => harness.runner.runs.length === 1);
    const directDispatch = harness.store.getDispatchForRun(direct.run.id)!;
    expect(harness.runtime.topicConcurrencyLimits()[direct.run.topicId]).toBeUndefined();
    await clock.advance(LEASE_MS + 1_000);
    const renewedDirect = harness.store.getDispatchForRun(direct.run.id)!;
    expect(renewedDirect.state).toBe("claimed");
    expect(renewedDirect.generation).toBe(directDispatch.generation);
    expect(renewedDirect.owner).toBe("dispatcher-live");
    expect(renewedDirect.leaseExpiresAt! > clock.iso()).toBe(true);
    expect(harness.store.getRun(direct.run.id)?.state).toBe("running");
    expect(harness.store.getMemberTurn(direct.memberTurn.id)?.state).toBe("running");

    hang.resolve();
    await waitUntil(() => harness.store.getRun(direct.run.id)?.state === "completed");
    const groupHang = deferred();
    harness.runner.hang = groupHang;
    const accepted = await harness.service.acceptGroupPrompt({
      conversationId: group.id,
      topicId: busy.id,
      requestId: "req-group-long",
      text: "both",
      target: { mode: "members", botIds: [harness.reviewer.id, harness.tester.id] },
      humanIngress: HUMAN_INGRESS,
    });
    void harness.dispatcher.kick();
    await waitUntil(() => harness.runner.runs.length === 2);
    const before = harness.store.listMemberTurns(accepted.run.id).map((turn) => ({
      id: turn.id,
      state: turn.state,
      origin: turn.origin,
      generation: harness.store.getDispatchForMemberTurn(turn.id)?.generation,
      owner: harness.store.getDispatchForMemberTurn(turn.id)?.owner,
    }));
    await clock.advance(LEASE_MS + 1_000);
    for (const turn of before) {
      const dispatch = harness.store.getDispatchForMemberTurn(turn.id)!;
      const member = harness.store.getMemberTurn(turn.id)!;
      expect(dispatch.state).toBe("claimed");
      expect(dispatch.generation).toBe(turn.generation);
      expect(dispatch.owner).toBe(turn.owner);
      expect(dispatch.leaseExpiresAt! > clock.iso()).toBe(true);
      expect(member.state).toBe(turn.state);
      expect(member.origin).toBe(turn.origin);
    }
    expect(harness.store.getRun(accepted.run.id)?.state).toBe("running");
    expect(harness.runner.runs).toHaveLength(2);

    clock.elapse(LEASE_MS + 1_000);
    await harness.service.teardownGroupTopic(group.id, idle.id);
    expect(harness.state.conversation_topics[idle.id]).toBeUndefined();
    expect(harness.store.getRun(accepted.run.id)?.state).toBe("running");
    for (const turn of before) {
      expect(harness.store.getDispatchForMemberTurn(turn.id)?.generation).toBe(turn.generation);
      expect(harness.store.getMemberTurn(turn.id)?.state).toBe(turn.state);
      expect(harness.store.getMemberTurn(turn.id)?.origin).toBe(turn.origin);
    }
    expect(harness.runner.runs).toHaveLength(2);

    const unrelated = await harness.service.acceptDirectPrompt({
      botId: harness.extra.id,
      requestId: "req-extra",
      content: "quiet",
    });
    await harness.service.teardownDirectConversation(harness.extra.id);
    expect(harness.store.getRun(accepted.run.id)?.state).toBe("running");
    expect(harness.store.getRun(unrelated.run.id)?.state).not.toBe("running");
    expect(harness.bots.getBot(harness.extra.id).id).toBe(harness.extra.id);

    const cancel = harness.service.cancelRun(accepted.run.id);
    await harness.dispatcher.flushOwnedClaimLeases();
    const teardownIdleSibling = Promise.resolve();
    groupHang.resolve();
    await Promise.all([cancel, teardownIdleSibling]);
    expect(harness.runner.runs).toHaveLength(2);
    expect(harness.store.getRun(accepted.run.id)?.state).not.toBe("indeterminate");
    for (const turn of harness.store.listMemberTurns(accepted.run.id)) {
      expect(harness.store.getDispatchForMemberTurn(turn.id)?.state).not.toBe("claimed");
    }
  } finally {
    hang.resolve();
    await harness.dispatcher.shutdown().catch(() => undefined);
    harness.store.close();
  }
});

test("teardown of an unrelated topic does not seal a live turn whose lease clock has elapsed", async () => {
  const clock = new ManualClock();
  const harness = await createHarness(clock);
  const hang = deferred();
  harness.runner.hang = hang;
  try {
    const group = await harness.bots.createGroup({ title: "Team", botIds: [harness.reviewer.id, harness.tester.id] });
    const busy = await harness.service.createGroupTopic(group.id, "Busy", {
      workspace: "backend",
      isolation: "shared",
    });
    const other = await harness.service.createGroupTopic(group.id, "Other", {
      workspace: "backend",
      isolation: "shared",
    });
    const accepted = await harness.service.acceptGroupPrompt({
      conversationId: group.id,
      topicId: busy.id,
      requestId: "req-topic-protected",
      text: "stay",
      target: { mode: "members", botIds: [harness.reviewer.id] },
      humanIngress: HUMAN_INGRESS,
    });
    void harness.dispatcher.kick();
    await waitUntil(() => harness.runner.runs.length === 1);
    const direct = await harness.service.acceptDirectPrompt({
      botId: harness.extra.id,
      requestId: "req-direct-protected",
      content: "stay",
    });
    const generation = harness.store.getDispatchForRun(accepted.run.id)?.generation;
    const directGeneration = harness.store.getDispatchForRun(direct.run.id)?.generation;
    expect(harness.store.getRun(direct.run.id)?.state).toBe("queued");
    clock.elapse(LEASE_MS + 1_000);
    await harness.service.teardownGroupTopic(group.id, other.id);
    expect(harness.store.getRun(accepted.run.id)?.state).toBe("running");
    expect(harness.store.getRun(direct.run.id)?.state).toBe("queued");
    expect(harness.store.getDispatchForRun(accepted.run.id)?.generation).toBe(generation);
    expect(harness.store.getDispatchForRun(accepted.run.id)?.state).toBe("claimed");
    expect(harness.store.getDispatchForRun(accepted.run.id)?.leaseExpiresAt! > clock.iso()).toBe(true);
    expect(harness.store.getMemberTurn(accepted.memberTurn.id)?.state).toBe("running");
    expect(harness.runner.runs).toHaveLength(1);

    await harness.service.teardownDirectConversation(harness.extra.id);
    expect(harness.store.getRun(accepted.run.id)?.state).toBe("running");
    expect(harness.store.getDispatchForRun(accepted.run.id)?.generation).toBe(generation);
    expect(harness.store.getRun(direct.run.id)).toBeUndefined();
    expect(directGeneration).toBeDefined();
  } finally {
    hang.resolve();
    await harness.dispatcher.shutdown().catch(() => undefined);
    harness.store.close();
  }
});

test("a claim with no live owner still recovers, and shutdown stops the old owner from renewing", async () => {
  const clock = new ManualClock();
  const harness = await createHarness(clock);
  const orphan = await startedClaim(harness.store, "conv_orphan", "topic_orphan", "req-orphan", "dispatcher-dead");
  harness.store.directWriteForTest("pending_dispatches", orphan.claimed.dispatch.id, {
    lease_expires_at: "2026-09-15T11:00:00.000Z",
  });
  const recovered = harness.store.recoverExpiredClaims(clock.iso(), { conversationId: "conv_orphan" });
  expect(recovered.map((entry) => entry.outcome)).toEqual(["indeterminate"]);
  expect(harness.store.getRun(orphan.accepted.run.id)?.state).toBe("indeterminate");

  const hang = deferred();
  harness.runner.hang = hang;
  try {
    const direct = await harness.service.acceptDirectPrompt({
      botId: harness.reviewer.id,
      requestId: "req-shutdown-lease",
      content: "hold",
    });
    void harness.dispatcher.kick();
    await waitUntil(() => harness.runner.runs.length === 1);
    const dispatch = harness.store.getDispatchForRun(direct.run.id)!;
    expect(clock.unfired()).toBeGreaterThan(0);
    const stopping = harness.dispatcher.shutdown();
    expect(clock.unfired()).toBe(0);
    hang.resolve();
    await stopping;
    await clock.advance(LEASE_MS);
    expect(() => harness.store.renewInFlightClaim({
      dispatchId: dispatch.id,
      owner: "dispatcher-live",
      generation: dispatch.generation,
      now: clock.iso(),
      leaseExpiresAt: "2026-09-15T13:00:00.000Z",
    })).toThrow(ConversationError);
    expect(harness.store.getDispatchForRun(direct.run.id)?.state).not.toBe("claimed");
    expect(harness.runner.runs).toHaveLength(1);

    const handoff = await startedClaim(harness.store, "conv_handoff", "topic_handoff", "req-handoff", "dispatcher-live");
    harness.store.convergePreviousOwnerClaims("dispatcher-next", clock.iso());
    expect(harness.store.getRun(handoff.accepted.run.id)?.state).toBe("indeterminate");
    expect(() => harness.store.renewInFlightClaim({
      dispatchId: handoff.claimed.dispatch.id,
      owner: "dispatcher-live",
      generation: handoff.claimed.dispatch.generation,
      now: clock.iso(),
      leaseExpiresAt: "2026-09-15T13:00:00.000Z",
    })).toThrow(ConversationError);
    expect(harness.store.getDispatchForMemberTurn(handoff.accepted.memberTurn.id)?.state).not.toBe("claimed");
    expect(harness.runner.runs).toHaveLength(1);
  } finally {
    hang.resolve();
    harness.store.close();
  }
});

test("a closed store does not renew and does not surface an unhandled rejection", async () => {
  const clock = new ManualClock();
  const harness = await createHarness(clock);
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => { unhandled.push(error); };
  process.on("unhandledRejection", onUnhandled);
  const hang = deferred();
  harness.runner.hang = hang;
  let drainResult: Promise<unknown> = Promise.resolve();
  try {
    await harness.service.acceptDirectPrompt({
      botId: harness.reviewer.id,
      requestId: "req-closed-store",
      content: "hold",
    });
    const drain = harness.dispatcher.kick();
    drainResult = drain.then(() => undefined, (error: unknown) => error);
    await waitUntil(() => harness.runner.runs.length === 1);
    harness.store.close();
    await clock.advance(LEASE_MS);
    await expect(harness.dispatcher.flushOwnedClaimLeases()).rejects.toBeInstanceOf(ConversationError);
    hang.resolve();
    await drainResult;
    await Promise.resolve();
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    hang.resolve();
  }
});
