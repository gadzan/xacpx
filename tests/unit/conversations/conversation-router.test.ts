import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

import { BotService } from "../../../src/bots/bot-service";
import { BotError } from "../../../src/bots/bot-error";
import { BotRuntimeManager } from "../../../src/bots/bot-runtime-manager";
import type { BotProfile } from "../../../src/bots/bot-types";
import type { AppConfig } from "../../../src/config/types";
import { ConversationError } from "../../../src/conversations/conversation-error";
import { ConversationDispatcher, type ConversationDispatcherHooks } from "../../../src/conversations/conversation-dispatcher";
import { ConversationRouterEngine } from "../../../src/conversations/conversation-router-engine";
import { boundRoutingInput } from "../../../src/conversations/conversation-router-budget";
import {
  bindRouter,
  gateRoutingDecision,
} from "../../../src/conversations/conversation-router-gate";
import {
  isRouterCapabilityRestricted,
  UNRESTRICTED_ROUTER_CAPABILITY,
  parseRoutingDecision,
  RoutingDecisionError,
  type ConversationRouter,
  type RouterCapabilityRestriction,
  type RoutingDecision,
  type RoutingInput,
  MAX_ROUTER_INPUT_CHARACTERS,
} from "../../../src/conversations/conversation-router-types";
import { ConversationRunService } from "../../../src/conversations/conversation-run-service";
import { ControlConversationTurnRunner } from "../../../src/conversations/conversation-turn-runner";
import type {
  ConversationTurnRunInput,
  ConversationTurnRunResult,
  ConversationTurnCancelResult,
  ConversationTurnRunner,
} from "../../../src/conversations/conversation-turn-runner";
import type { ApplyRoutingDecisionInput, RoutingAssignmentInput } from "../../../src/conversations/conversation-store";
import type { ConversationRun } from "../../../src/conversations/conversation-types";
import { SqliteConversationStore } from "../../../src/conversations/sqlite-conversation-store";
import { createSqlDriver } from "../../../src/conversations/sql-driver";
import { toConversationRun, toMemberTurnSummary } from "../../../src/control/conversation-control-dtos";
import type { ControlPromptResult } from "../../../src/control/control-service";
import { validControlEvent } from "@ganglion/xacpx-relay-protocol";
import { snapshotGroupMemberProfile } from "../../../src/bots/bot-types";
import { AsyncMutex } from "../../../src/orchestration/async-mutex";
import { SessionService } from "../../../src/sessions/session-service";
import { createStrictOwnedSessionRelease } from "../../../src/sessions/owned-session-release";
import { parseState, type StateStore } from "../../../src/state/state-store";
import { createEmptyState, type AppState } from "../../../src/state/types";

const NOW = "2026-09-15T12:00:00.000Z";

const BOT_ID = "bot_reviewer";
const TESTER_ID = "bot_tester";
const BUILDER_ID = "bot_builder";

test("queued automatic Runs route in request order and never bypass an explicit Topic owner", async () => {
  const router = new RecordingRouter([{ type: "complete", reason: "automatic finished" }]);
  const harness = await createHarness({ router, autoKick: false });
  const { group, topic } = await createGroup(harness);
  const first = await harness.service.acceptGroupPrompt({ conversationId: group.id, topicId: topic.id, requestId: "explicit-owner", text: "first", target: { botId: BOT_ID } });
  const second = await acceptAutomatic(harness, group.id, topic.id, "automatic-waiter");
  expect(router.inputs).toHaveLength(0);
  expect(harness.store.getRun(second.run.id)?.state).toBe("queued");
  await harness.dispatcher.kick(); await harness.service.awaitRouting();
  expect(harness.store.getRun(first.run.id)?.state).toBe("completed");
  expect(harness.store.getRun(second.run.id)?.state).toBe("completed");
  expect(router.inputs).toHaveLength(1);
  harness.store.close();
});

test("a queued zero-member automatic request cannot be overtaken by an explicit dispatch", async () => {
  const harness = await createHarness({ router: new RecordingRouter([{ type: "need-human", question: "scope?" }]), autoKick: false });
  const { group, topic } = await createGroup(harness);
  const first = harness.store.acceptRequest({ conversationId: group.id, topicId: topic.id, requestId: "unrouted", botId: BOT_ID, content: "first", mode: "automatic", members: [], profileSnapshot: snapshotGroupMemberProfile(harness.bots.getBot(BOT_ID), topic.executionTarget!, NOW), now: NOW });
  const second = await harness.service.acceptGroupPrompt({ conversationId: group.id, topicId: topic.id, requestId: "explicit-later", text: "second", target: { botId: BOT_ID } });
  await harness.dispatcher.kick();
  expect(harness.runner.runs).toEqual([]);
  await harness.service.routeAutomaticRun(first.run.id, false);
  await harness.service.cancelRun(first.run.id);
  expect(harness.store.getRun(second.run.id)?.state).toBe("completed");
  harness.store.close();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("routing did not drain within 1s")), 1_000);
    })]);
  } finally { clearTimeout(timer); }
}

test("a non-cooperative Router times out durably and releases its Topic successor", async () => {
  const entered = deferred<void>();
  const answer = deferred<RoutingDecision>();
  let calls = 0;
  let signal: AbortSignal | undefined;
  const harness = await createHarness({ autoKick: false, decisionTimeoutMs: 30,
    router: { capabilityRestriction: RESTRICTED, async decide(_input, options) {
      if (++calls > 1) return { type: "complete", reason: "successor" };
      signal = options?.signal; entered.resolve(); return answer.promise;
    } },
  });
  const { group, topic } = await createGroup(harness);
  const first = await harness.service.acceptGroupPrompt({ conversationId: group.id, topicId: topic.id,
    requestId: "hung-timeout", text: "review", target: { mode: "automatic" } });
  await entered.promise;
  const next = await harness.service.acceptGroupPrompt({ conversationId: group.id, topicId: topic.id,
    requestId: "after-timeout", text: "next", target: { mode: "automatic" } });
  try {
    await bounded(harness.service.awaitRouting());
    expect(signal?.aborted).toBe(true);
    expect(harness.store.getRun(first.run.id)).toMatchObject({ state: "failed", routingState: "done", completionReason: "router_timeout" });
    expect(harness.store.getRun(next.run.id)).toMatchObject({ state: "completed", completionReason: "successor" });
    answer.resolve({ type: "complete", reason: "late" });
    await Promise.resolve(); await Promise.resolve();
    expect(harness.store.getRun(first.run.id)?.completionReason).toBe("router_timeout");
  } finally {
    answer.resolve({ type: "complete", reason: "cleanup" });
    await harness.service.awaitRouting(); harness.store.close();
  }
});

for (const operation of ["cancel", "shutdown"] as const) {
  test(`hung Router ${operation} drains without adapter cooperation and ignores late output`, async () => {
    const entered = deferred<void>();
    const answer = deferred<RoutingDecision>();
    let signal: AbortSignal | undefined;
    const harness = await createHarness({ autoKick: false, router: { capabilityRestriction: RESTRICTED,
      async decide(_input, options) { signal = options?.signal; entered.resolve(); return answer.promise; },
    } });
    const { group, topic } = await createGroup(harness);
    const accepted = await harness.service.acceptGroupPrompt({ conversationId: group.id, topicId: topic.id,
      requestId: `hung-${operation}`, text: "review", target: { mode: "automatic" } });
    await entered.promise;
    const action = operation === "cancel" ? harness.service.cancelRun(accepted.run.id) : harness.service.shutdown();
    try {
      await bounded(action.then(() => harness.service.awaitRouting()));
      expect(signal?.aborted).toBe(true);
      answer.resolve({ type: "dispatch", mode: "single", assignments: [
        { id: "late", botId: BOT_ID, task: "late work", triggerMessageIds: [] },
      ] });
      await Promise.resolve(); await Promise.resolve();
      const reopened = await SqliteConversationStore.open(harness.path);
      expect(reopened.getRun(accepted.run.id)).toMatchObject(operation === "cancel"
        ? { state: "cancelled", routingState: "done" }
        : { state: "running", routingState: "routing" });
      if (operation === "shutdown") {
        expect(reopened.getRun(accepted.run.id)?.completionReason).toBeUndefined();
        expect(reopened.getRun(accepted.run.id)?.finishedAt).toBeUndefined();
        expect(reopened.automaticRunsAwaitingRouting().map(({ run }) => run.id)).toContain(accepted.run.id);
      }
      expect(reopened.listMemberTurns(accepted.run.id)).toEqual([]);
      reopened.close();
    } finally {
      answer.resolve({ type: "complete", reason: "cleanup" }); await action;
      await harness.service.awaitRouting(); if (operation === "cancel") harness.store.close();
    }
  });
}

for (const operation of ["cancel", "shutdown"] as const) {
  test(`routing ${operation} drains while the selected Bot lifecycle gate is held`, async () => {
    const commitEntered = deferred<void>();
    const gateHeld = deferred<void>();
    const releaseGate = deferred<void>();
    const harness = await createHarness({ autoKick: false,
      beforeRoutingCommitGatesAcquired: () => commitEntered.resolve(),
      router: new RecordingRouter([{ type: "dispatch", mode: "single", assignments: [
        { id: "selected", botId: TESTER_ID, task: "test", triggerMessageIds: [] },
      ] }]),
    });
    const { group, topic } = await createGroup(harness);
    const holding = harness.bots.runLifecycle(TESTER_ID, async () => {
      gateHeld.resolve(); await releaseGate.promise;
    });
    await gateHeld.promise;
    const accepted = await harness.service.acceptGroupPrompt({ conversationId: group.id, topicId: topic.id,
      requestId: `held-gate-${operation}`, text: "review", target: { mode: "automatic" } });
    await commitEntered.promise;
    try {
      await bounded(operation === "shutdown" ? harness.service.shutdown() : harness.service.cancelRun(accepted.run.id));
      await bounded(harness.service.awaitRouting());
      // A detached acquisition must be sealed before touching a closed store.
      releaseGate.resolve(); await holding;
      await Promise.resolve(); await Promise.resolve();
      const reopened = await SqliteConversationStore.open(harness.path);
      try {
        expect(reopened.getRun(accepted.run.id)).toMatchObject(operation === "shutdown"
          ? { state: "running", routingState: "routing" }
          : { state: "cancelled", routingState: "done" });
        expect(reopened.listMemberTurns(accepted.run.id)).toEqual([]);
        expect(reopened.listRoutingDecisions(accepted.run.id)).toEqual([]);
      } finally { reopened.close(); }
    } finally {
      releaseGate.resolve(); await holding;
      if (operation === "cancel") harness.store.close();
    }
  });
}

test("an adapter error cannot impersonate the service shutdown abort reason", async () => {
  const harness = await createHarness({ autoKick: false,
    router: new RecordingRouter([new ConversationError("router_shutdown", "adapter error")]),
  });
  const { group, topic } = await createGroup(harness);
  const accepted = await acceptAutomatic(harness, group.id, topic.id, "shutdown-error-spoof");
  expect(harness.store.getRun(accepted.run.id)).toMatchObject({ state: "failed", routingState: "done", completionReason: "router-execution-failed" });
  harness.store.close();
});

test("shutdown abort settlement does not start queued execution in another Topic", async () => {
  const entered = deferred<void>();
  const answer = deferred<RoutingDecision>();
  const harness = await createHarness({ autoKick: true, router: { capabilityRestriction: RESTRICTED,
    async decide() { entered.resolve(); return answer.promise; },
  } });
  const { group, topic } = await createGroup(harness);
  await harness.service.activateAfterConsumerLock();
  await harness.service.acceptGroupPrompt({ conversationId: group.id, topicId: topic.id,
    requestId: "shutdown-owner", text: "review", target: { mode: "automatic" } });
  await entered.promise;
  const otherTopic = await harness.service.createGroupTopic(group.id, "Later", {
    workspace: "backend", isolation: "shared-single-writer",
  });
  const queued = harness.store.acceptRequest({ conversationId: group.id, topicId: otherTopic.id,
    requestId: "shutdown-queued", botId: BOT_ID, content: "later", mode: "explicit",
    profileSnapshot: snapshotGroupMemberProfile(harness.bots.getBot(BOT_ID), otherTopic.executionTarget!, NOW), now: NOW });
  await bounded(harness.service.shutdown());
  expect(harness.runner.runs).toEqual([]);
  answer.resolve({ type: "complete", reason: "late" });
  const reopened = await SqliteConversationStore.open(harness.path);
  expect(reopened.getRun(queued.run.id)?.state).toBe("queued");
  reopened.close();
});

test("shutdown stops new dispatch when an already active member settles", async () => {
  const routingEntered = deferred<void>();
  const routingAnswer = deferred<RoutingDecision>();
  const runnerEntered = deferred<void>();
  const runnerAnswer = deferred<ConversationTurnRunResult>();
  const harness = await createHarness({ autoKick: false, router: { capabilityRestriction: RESTRICTED,
    async decide() { routingEntered.resolve(); return routingAnswer.promise; },
  } });
  const { group, topic } = await createGroup(harness);
  const activeTopic = await harness.service.createGroupTopic(group.id, "Active", { workspace: "backend", isolation: "shared-single-writer" });
  const queuedTopic = await harness.service.createGroupTopic(group.id, "Queued", { workspace: "backend", isolation: "shared-single-writer" });
  harness.runner.run = async (input) => {
    harness.runner.runs.push(input);
    if (harness.runner.runs.length === 1) { runnerEntered.resolve(); return runnerAnswer.promise; }
    return { status: "completed", text: "unexpected successor" };
  };
  const active = await harness.service.acceptGroupPrompt({ conversationId: group.id, topicId: activeTopic.id,
    requestId: "shutdown-active", text: "active", target: { botId: TESTER_ID } });
  const drain = harness.dispatcher.kick();
  await runnerEntered.promise;
  const routing = await harness.service.acceptGroupPrompt({ conversationId: group.id, topicId: topic.id,
    requestId: "shutdown-routing", text: "routing", target: { mode: "automatic" } });
  await routingEntered.promise;
  const queued = await harness.service.acceptGroupPrompt({ conversationId: group.id, topicId: queuedTopic.id,
    requestId: "shutdown-successor", text: "queued", target: { botId: BUILDER_ID } });
  const shutdown = harness.service.shutdown();
  runnerAnswer.resolve({ status: "completed", text: "settled active" });
  await bounded(shutdown); await drain;
  routingAnswer.resolve({ type: "complete", reason: "late" });
  expect(harness.runner.runs).toHaveLength(1);
  const reopened = await SqliteConversationStore.open(harness.path);
  try {
    expect(reopened.getRun(active.run.id)?.state).toBe("completed");
    expect(reopened.getRun(routing.run.id)).toMatchObject({ state: "running", routingState: "routing" });
    expect(reopened.getRun(queued.run.id)?.state).toBe("queued");
    expect(reopened.listMemberTurns(queued.run.id)[0]?.startedAt).toBeUndefined();
  } finally { reopened.close(); }
});

test("cancel aborts routing before waiting for a queued successor's execution", async () => {
  const entered = deferred<void>();
  const answer = deferred<RoutingDecision>();
  const successorStarted = deferred<void>();
  const successorResult = deferred<ConversationTurnRunResult>();
  let signal: AbortSignal | undefined;
  const harness = await createHarness({ autoKick: true, router: { capabilityRestriction: RESTRICTED,
    async decide(_input, options) { signal = options?.signal; entered.resolve(); return answer.promise; },
  } });
  const { group, topic } = await createGroup(harness);
  await harness.service.activateAfterConsumerLock();
  const first = await harness.service.acceptGroupPrompt({ conversationId: group.id, topicId: topic.id,
    requestId: "cancel-before-wake", text: "review", target: { mode: "automatic" } });
  await entered.promise;
  harness.runner.run = async (input) => {
    harness.runner.runs.push(input); successorStarted.resolve(); return successorResult.promise;
  };
  await harness.service.acceptGroupPrompt({ conversationId: group.id, topicId: topic.id,
    requestId: "queued-after-cancel", text: "next", target: { botId: TESTER_ID } });
  const cancelling = harness.service.cancelRun(first.run.id);
  try {
    await bounded(successorStarted.promise);
    expect(signal?.aborted).toBe(true);
    await bounded(harness.service.awaitRouting());
    expect(harness.store.getRun(first.run.id)?.state).toBe("cancelled");
  } finally {
    successorResult.resolve({ status: "completed", text: "done" });
    answer.resolve({ type: "complete", reason: "late" });
    await cancelling; await harness.service.awaitRouting(); harness.store.close();
  }
});

for (const status of ["completed", "failed"] as const) {
  test(`natural ${status} while physical cancel waits cannot start another automatic batch`, async () => {
    const entered = deferred<void>();
    const result = deferred<ConversationTurnRunResult>();
    const cancelEntered = deferred<void>();
    const cancelResult = deferred<ConversationTurnCancelResult>();
    const router = new RecordingRouter([
      { type: "dispatch", mode: "single", assignments: [{ id: "before-cancel", botId: BOT_ID, task: "first", triggerMessageIds: [] }] },
      { type: "dispatch", mode: "single", assignments: [{ id: "after-cancel", botId: TESTER_ID, task: "must not start", triggerMessageIds: [] }] },
    ]);
    const harness = await createHarness({ autoKick: true, router });
    const { group, topic } = await createGroup(harness);
    harness.runner.run = async (input) => {
      harness.runner.runs.push(input);
      if (harness.runner.runs.length === 1) { entered.resolve(); return result.promise; }
      return { status: "completed", text: "unexpected new execution" };
    };
    harness.runner.cancel = async () => { cancelEntered.resolve(); return cancelResult.promise; };
    await harness.service.activateAfterConsumerLock();
    const accepted = await acceptAutomatic(harness, group.id, topic.id, `natural-${status}-during-cancel`);
    const drain = harness.dispatcher.kick();
    await entered.promise;
    const cancellation = harness.service.cancelRun(accepted.run.id);
    await cancelEntered.promise;
    expect(harness.store.getRun(accepted.run.id)?.completionReason).toBe("cancelled");
    result.resolve(status === "completed" ? { status, text: "natural result" } : { status, error: "natural failure" });
    try {
      await bounded(drain); await bounded(harness.service.awaitRouting());
      expect(harness.runner.runs).toHaveLength(1);
      expect(router.inputs).toHaveLength(1);
      expect(harness.store.listMemberTurns(accepted.run.id)).toHaveLength(1);
      expect(harness.store.getRun(accepted.run.id)).toMatchObject({ state: status, routingState: "done", activeBatch: 1, consumedMemberTurns: 1 });
    } finally {
      cancelResult.resolve(status === "completed" ? { outcome: "completed", text: "natural result" } : { outcome: "failed", error: "natural failure" });
      await cancellation; await drain; await harness.service.awaitRouting(); harness.store.close();
    }
  });
}

test("the real Control runner cannot admit work while its untracked cancellation settles", async () => {
  const started = deferred<void>();
  const resumeStart = deferred<void>();
  const provider = deferred<ControlPromptResult>();
  let admissions = 0;
  const executionRunner = new ControlConversationTurnRunner({
    async promptImmediate() { admissions++; return provider.promise; },
    cancelTurnForPromptRequest() { return false; },
    cancelQueuedConversationItem() { return { cancelled: false }; },
  });
  const router = new RecordingRouter([{ type: "dispatch", mode: "single", assignments: [
    { id: "first", botId: BOT_ID, task: "must not start after Stop", triggerMessageIds: [] },
  ] }]);
  const harness = await createHarness({ autoKick: false, executionRunner, router,
    hooks: { async afterExecutionStart() { started.resolve(); await resumeStart.promise; } },
  });
  const { group, topic } = await createGroup(harness);
  const accepted = await acceptAutomatic(harness, group.id, topic.id, "real-cancel-before-provider");
  const drain = harness.dispatcher.kick();
  await started.promise;
  const cancellation = harness.service.cancelRun(accepted.run.id);
  // The production runner has no tracked execution yet. Its async unknown
  // outcome competes with the dispatcher's newly released continuation.
  resumeStart.resolve();
  try {
    await bounded(cancellation); await bounded(drain); await bounded(harness.service.awaitRouting());
    expect(admissions).toBe(0);
    expect(router.inputs).toHaveLength(1);
    expect(harness.store.getRun(accepted.run.id)).toMatchObject({ state: "indeterminate", routingState: "done" });
  } finally {
    provider.resolve({ ok: true, text: "cleanup proof" });
    await cancellation; await drain; await harness.service.awaitRouting(); harness.store.close();
  }
});

test("durable cancel intent prevents first provider admission after the execution-start hook", async () => {
  const started = deferred<void>();
  const resumeStart = deferred<void>();
  const cancelEntered = deferred<void>();
  const finishCancel = deferred<ConversationTurnCancelResult>();
  const harness = await createHarness({ autoKick: false,
    router: new RecordingRouter([{ type: "dispatch", mode: "single", assignments: [
      { id: "first", botId: BOT_ID, task: "must not start after Stop", triggerMessageIds: [] },
    ] }]), hooks: { async afterExecutionStart() { started.resolve(); await resumeStart.promise; } },
  });
  const { group, topic } = await createGroup(harness);
  harness.runner.cancel = async () => { cancelEntered.resolve(); return finishCancel.promise; };
  const accepted = await acceptAutomatic(harness, group.id, topic.id, "cancel-before-provider");
  const drain = harness.dispatcher.kick();
  await started.promise;
  const cancellation = harness.service.cancelRun(accepted.run.id);
  await cancelEntered.promise;
  resumeStart.resolve();
  try {
    await bounded(drain);
    expect(harness.runner.runs).toEqual([]);
    expect(harness.store.getRun(accepted.run.id)).toMatchObject({ state: "running", completionReason: "cancelled" });
  } finally {
    finishCancel.resolve({ outcome: "cancelled" });
    await cancellation; await harness.service.awaitRouting();
    expect(harness.store.getRun(accepted.run.id)).toMatchObject({ state: "cancelled", routingState: "done" });
    harness.store.close();
  }
});

for (const phase of ["started orphan", "cancel evidence", "late evidence"] as const) {
  test(`activation settles durable cancel intent with ${phase} before advancing its Topic`, async () => {
    const harness = await createHarness({ autoKick: false, router: new RecordingRouter([
      { type: "dispatch", mode: "single", assignments: [{ id: "first", botId: BOT_ID, task: "first", triggerMessageIds: [] }] },
    ]) });
    const { group, topic } = await createGroup(harness);
    const accepted = await acceptAutomatic(harness, group.id, topic.id, `cancel-recovery-${phase}`);
    const claim = harness.store.claimNextDispatch({ owner: "dead-owner", authorityEpoch: "old",
      now: NOW, leaseExpiresAt: "2026-09-15T12:05:00.000Z" })!;
    const started = harness.store.markExecutionStarted({ dispatchId: claim.dispatch.id, owner: "dead-owner",
      generation: claim.dispatch.generation, runId: accepted.run.id, memberTurnId: claim.memberTurn.id,
      sessionAlias: "old-provider", logicalSessionId: "old-session", sourceTurnId: "old-source", now: NOW });
    const cancellation = harness.store.cancelRun(accepted.run.id, NOW);
    expect(cancellation.activeMembers.map(({ id }) => id)).toEqual([started.id]);
    const sourceTurn = { sessionAlias: "old-provider", turnId: "old-source" };
    if (phase === "cancel evidence") {
      harness.store.settleCancelBatch({ runId: accepted.run.id, now: NOW, deferRunAggregate: true,
        outcomes: [{ memberTurnId: started.id, outcome: "completed", content: "proven result", sourceTurn }] });
    } else if (phase === "late evidence") {
      harness.store.reconcileLateResult({ runId: accepted.run.id, memberTurnId: started.id, outcome: "completed",
        content: "proven result", sourceTurn, now: NOW });
    }
    expect(harness.store.getRun(accepted.run.id)).toMatchObject({ state: "running", completionReason: "cancelled" });
    expect(harness.store.automaticRunsAwaitingRouting()).toEqual([]);
    expect(() => harness.store.markRoutingState(accepted.run.id, "routing", NOW)).toThrow(/cancel intent/);
    const dispatch: Extract<RoutingDecision, { type: "dispatch" }> = { type: "dispatch", mode: "single",
      assignments: [{ id: "forbidden", botId: TESTER_ID, task: "must not start", triggerMessageIds: [accepted.message.id] }] };
    for (const decision of [harness.withSnapshots(dispatch, topic.executionTarget!),
      { type: "complete" as const, reason: "must not complete" }, { type: "need-human" as const, question: "must not park" }]) {
      expect(() => harness.store.applyRoutingDecision({ runId: accepted.run.id, routingGeneration: 1,
        requestMessageId: accepted.message.id, decision, now: NOW })).toThrow(/cancel intent/);
    }
    expect(harness.store.failRun(accepted.run.id, "router_timeout", "failed", NOW, 1).state).toBe("running");
    const successor = await harness.service.acceptGroupPrompt({ conversationId: group.id, topicId: topic.id,
      requestId: `after-cancel-recovery-${phase}`, text: "successor", target: { mode: "automatic" } });
    harness.store.close();
    const reopened = await SqliteConversationStore.open(harness.path);
    const router = new RecordingRouter([{ type: "complete", reason: "successor finished" }]);
    const runner = new FakeRunner();
    const dispatcher = new ConversationDispatcher(reopened, harness.runtime, runner, harness.sessions, { now: harness.nowFn, ownerId: "new-owner" });
    const engine = new ConversationRouterEngine(bindRouter(router), { store: reopened,
      readGroup: (id) => harness.state.conversations[id], readTopic: (_id, id) => harness.state.conversation_topics[id],
      readBot: (id) => harness.bots.getBot(id), runLifecycleAll: (ids, critical) => harness.bots.runLifecycleAll(ids, critical), now: harness.nowFn });
    const service = new ConversationRunService(reopened, harness.bots, harness.runtime, dispatcher, harness.sessions,
      harness.state, harness.stateStore, { now: harness.nowFn, autoKick: false, routerEngine: engine });
    dispatcher.setAutomaticRoutingHandler((id) => service.trackAutomaticRouting(id));
    try {
      await bounded(service.activateAfterConsumerLock()); await service.awaitRouting();
      expect(reopened.getRun(accepted.run.id)).toMatchObject({ state: phase === "started orphan" ? "indeterminate" : "completed",
        routingState: "done", consumedMemberTurns: 1 });
      expect(reopened.getRun(successor.run.id)).toMatchObject({ state: "completed", completionReason: "successor finished" });
      expect(router.inputs.map(({ runId }) => runId)).toEqual([successor.run.id]);
      expect(runner.runs).toEqual([]);
    } finally { await service.shutdown(); }
  });
}

for (const phase of ["routing-input", "decision-commit", "dispatcher", "before-start"] as const) {
  test(`missing completed assignment result rejects at ${phase} before successor execution`, async () => {
    const answer = deferred<RoutingDecision>();
    const entered = deferred<void>();
    let calls = 0;
    let corrupt!: () => Promise<void>;
    let startHooks = 0;
    const harness = await createHarness({ autoKick: false, hooks: { async beforeExecutionStart() {
      startHooks++;
      if (phase === "before-start") await corrupt();
    } }, router: { capabilityRestriction: RESTRICTED, async decide() {
      if (++calls === 1) return { type: "dispatch", mode: "single", assignments: [
        { id: "A", botId: BOT_ID, task: "review", triggerMessageIds: [] },
      ] };
      entered.resolve(); return answer.promise;
    } } });
    const { group, topic } = await createGroup(harness);
    const accepted = await acceptAutomatic(harness, group.id, topic.id, `missing-result-${phase}`);
    const prior = harness.store.listMemberTurns(accepted.run.id)[0]!;
    harness.store.directWriteForTest("member_turns", prior.id, { source_turn_id: "source_A" });
    harness.store.completeExecution({ runId: accepted.run.id, memberTurnId: prior.id, content: "RESULT A",
      sourceTurn: { sessionAlias: "test", turnId: "source_A" }, now: NOW });
    const result = harness.store.getMemberResult(harness.store.getMemberTurn(prior.id)!)!;
    corrupt = async () => {
      if (phase === "routing-input" || phase === "before-start") {
        const db = await createSqlDriver(harness.path);
        try { db.run("DELETE FROM messages WHERE id = ?", [result.id]); }
        finally { db.close(); }
      } else {
        harness.store.directWriteForTest("messages", result.id, {
          source_turn_json: phase === "dispatcher" ? "invalid JSON" : "{}",
        });
      }
    };
    const successor: RoutingDecision = { type: "dispatch", mode: "sequential", assignments: [
      { id: "B", botId: TESTER_ID, task: "apply fix", triggerMessageIds: [], dependsOn: ["A"] },
    ] };
    if (phase === "routing-input") await corrupt();
    const routing = harness.service.routeAutomaticRun(accepted.run.id, false);
    if (phase !== "routing-input") {
      await entered.promise;
      if (phase === "decision-commit") await corrupt();
      answer.resolve(successor);
    } else answer.resolve(successor);
    await routing;
    if (phase === "dispatcher") await corrupt();
    if (phase === "dispatcher" || phase === "before-start") await harness.dispatcher.kick();
    expect(harness.runner.runs).toEqual([]);
    expect(startHooks).toBe(phase === "before-start" ? 1 : 0);
    if (phase === "dispatcher" || phase === "before-start") {
      const second = harness.store.listMemberTurns(accepted.run.id)[1]!;
      expect(second.state).toBe("failed");
      expect(second.failureReason).toBe("member_result_missing");
      expect(second.startedAt).toBeUndefined();
    } else {
      expect(harness.store.getRun(accepted.run.id)).toMatchObject({ state: "failed", routingState: "done", completionReason: "member_result_missing" });
      expect(harness.store.listMemberTurns(accepted.run.id)).toHaveLength(1);
      expect(calls).toBe(phase === "routing-input" ? 1 : 2);
    }
    await harness.service.awaitRouting();
    expect(harness.store.getRun(accepted.run.id)).toMatchObject({ state: "failed", routingState: "done", completionReason: "member_result_missing" });
    harness.store.close();
  });
}

test("a valid empty public result remains successful dependency evidence", async () => {
  const harness = await createHarness({ autoKick: false, router: new RecordingRouter([
    { type: "dispatch", mode: "single", assignments: [{ id: "A", botId: BOT_ID, task: "review", triggerMessageIds: [] }] },
    { type: "dispatch", mode: "sequential", assignments: [{ id: "B", botId: TESTER_ID, task: "apply fix", dependsOn: ["A"], triggerMessageIds: [] }] },
    { type: "complete", reason: "done" },
  ]) });
  const { group, topic } = await createGroup(harness);
  harness.runner.result = { status: "completed", text: "" };
  const accepted = await acceptAutomatic(harness, group.id, topic.id, "empty-result");
  await harness.dispatcher.kick(); await harness.service.awaitRouting();
  expect(harness.router!.inputs[1]!.completedAssignments[0]!.result).toBe("");
  await harness.dispatcher.kick(); await harness.service.awaitRouting();
  expect(harness.runner.runs).toHaveLength(2);
  expect(harness.runner.runs[1]!.text).toContain("Task:\napply fix");
  expect(harness.store.getRun(accepted.run.id)?.state).toBe("completed");
  harness.store.close();
});

test("timeout failure cannot settle a newer routing generation", async () => {
  const entered = deferred<void>();
  const answer = deferred<RoutingDecision>();
  const harness = await createHarness({ autoKick: false, decisionTimeoutMs: 30,
    router: { capabilityRestriction: RESTRICTED, async decide() { entered.resolve(); return answer.promise; } },
  });
  const { group, topic } = await createGroup(harness);
  const accepted = await harness.service.acceptGroupPrompt({ conversationId: group.id, topicId: topic.id,
    requestId: "timeout-fence", text: "go", target: { mode: "automatic" } });
  await entered.promise;
  const newer = harness.store.markRoutingState(accepted.run.id, "routing", NOW);
  const decision: Extract<RoutingDecision, { type: "dispatch" }> = { type: "dispatch", mode: "single",
    assignments: [{ id: "new", botId: TESTER_ID, task: "new work", triggerMessageIds: [newer.requestMessageId] }] };
  harness.store.applyRoutingDecision({ runId: newer.id, routingGeneration: newer.routingGeneration!, now: NOW,
    requestMessageId: newer.requestMessageId, decision: harness.withSnapshots(decision, topic.executionTarget!) });
  await bounded(harness.service.awaitRouting());
  expect(harness.store.getRun(newer.id)).toMatchObject({ state: "running", routingState: "dispatching", routingGeneration: newer.routingGeneration });
  answer.resolve({ type: "complete", reason: "late" });
  harness.store.close();
});

const boundedAssignment = { id: "A", botId: BOT_ID, task: "review", triggerMessageIds: [] };
for (const [label, assignment] of [
  ["long assignment id", { ...boundedAssignment, id: "a".repeat(129) }],
  ["long Bot id", { ...boundedAssignment, botId: "b".repeat(129) }],
  ["many dependencies", { ...boundedAssignment, dependsOn: Array.from({ length: 65 }, (_, i) => `a${i}`) }],
  ["many triggers", { ...boundedAssignment, triggerMessageIds: Array.from({ length: 65 }, (_, i) => `m${i}`) }],
  ["long dependency", { ...boundedAssignment, dependsOn: ["d".repeat(129)] }],
  ["long trigger", { ...boundedAssignment, triggerMessageIds: ["m".repeat(129)] }],
  ["duplicate dependency", { ...boundedAssignment, dependsOn: ["x", "x"] }],
  ["duplicate trigger", { ...boundedAssignment, triggerMessageIds: ["m", "m"] }],
] as const) {
  test(`strict Router bounds reject ${label}`, () => {
    expect(() => parseRoutingDecision({ type: "dispatch", mode: "sequential", assignments: [assignment] })).toThrow(RoutingDecisionError);
  });
}

test("Router input truncation is deterministic, disclosed and bounded across request, transcript and results", async () => {
  const harness = await createHarness({ autoKick: false, router: new RecordingRouter() });
  const { group, topic } = await createGroup(harness);
  await acceptAutomatic(harness, group.id, topic.id, "budget-base");
  const base = harness.router!.inputs[0]!;
  const original: RoutingInput = { ...base, request: "Q".repeat(100_000),
    publicTranscript: Array.from({ length: 200 }, (_, i) => ({ id: `m${i}`, seq: 200 - i, role: "bot", content: "T".repeat(3_000) })),
    completedAssignments: Array.from({ length: 24 }, (_, i) => ({ id: `a${i}`, botId: BOT_ID, task: "review",
      dependsOn: [], triggerMessageIds: [], outcome: "completed", result: "R".repeat(5_000), attempt: 1, batch: i + 1 })),
  };
  const input = boundRoutingInput(original);
  expect(input.request.length).toBe(16_000);
  expect(input.requestTruncated).toBe(true);
  expect(input.publicTranscript.reduce((sum, row) => sum + row.content.length, 0)).toBe(32_000);
  expect(input.completedAssignments.reduce((sum, row) => sum + row.result!.length, 0)).toBe(32_000);
  expect(input.publicTranscript[0]!.contextTruncated).toBe(true);
  expect(input.completedAssignments[23]!.contextTruncated).toBe(true);
  expect(JSON.stringify(input).length).toBeLessThanOrEqual(MAX_ROUTER_INPUT_CHARACTERS);
  expect(boundRoutingInput(original)).toEqual(input);
  expect(original.request.length).toBe(100_000);
  expect(original.completedAssignments[23]!.result!.length).toBe(5_000);
  harness.store.close();
});

for (const order of ["ascending", "descending", "mixed"] as const) {
  test(`transcript character budget prioritizes newest seq and preserves ${order} input order`, async () => {
    const harness = await createHarness({ autoKick: false, router: new RecordingRouter() });
    const { group, topic } = await createGroup(harness);
    await acceptAutomatic(harness, group.id, topic.id, `transcript-budget-${order}`);
    const rows: RoutingInput["publicTranscript"] = Array.from({ length: 200 }, (_, i) => ({
      id: `message-${301 + i}`, seq: 301 + i, role: "bot", content: `context-${301 + i}:`.padEnd(3_000, "T"),
    }));
    const transcript = order === "descending" ? rows.toReversed()
      : order === "mixed" ? [...rows.slice(0, 100), ...rows.slice(100).toReversed()] : rows;
    const original: RoutingInput = { ...harness.router!.inputs[0]!, publicTranscript: transcript };
    const before = structuredClone(original);
    const input = boundRoutingInput(original);
    expect(input.publicTranscript.map(({ seq }) => seq)).toEqual(transcript.map(({ seq }) => seq));
    expect(input.publicTranscript.filter(({ content }) => content.length > 0).map(({ seq }) => seq).toSorted((a, b) => a - b))
      .toEqual(Array.from({ length: 16 }, (_, i) => 485 + i));
    expect(input.publicTranscript.find(({ seq }) => seq === 500)?.content).toBe(rows[199]!.content.slice(0, 2_000));
    expect(input.publicTranscript.find(({ seq }) => seq === 301)?.content).toBe("");
    expect(input.publicTranscript.every(({ contextTruncated }) => contextTruncated === true)).toBe(true);
    expect(input.publicTranscript.reduce((sum, row) => sum + row.content.length, 0)).toBe(32_000);
    expect(JSON.stringify(input).length).toBeLessThanOrEqual(MAX_ROUTER_INPUT_CHARACTERS);
    expect(original).toEqual(before);
    harness.store.close();
  });
}

test("a large Group exposes a bounded enabled-first candidate snapshot without rejecting admission", async () => {
  const harness = await createHarness({ autoKick: false, router: new RecordingRouter() });
  const ids = [BOT_ID];
  for (let i = 1; i < 300; i++) {
    const id = `bot_candidate_${i}`;
    harness.state.bots[id] = { ...harness.bots.getBot(BOT_ID), id, enabled: i % 3 !== 0 };
    ids.push(id);
  }
  const group = await harness.bots.createGroup({ title: "Large team", botIds: ids });
  const topic = await harness.service.createGroupTopic(group.id, "Budget", { workspace: "backend", isolation: "shared-single-writer" });
  const accepted = await acceptAutomatic(harness, group.id, topic.id, "metadata-budget");
  const input = harness.router!.inputs[0]!;
  expect(input.memberMetadata).toHaveLength(128);
  expect(input.omittedMemberCount).toBe(172);
  expect(input.memberMetadata.every((member) => member.enabled)).toBe(true);
  expect(input.memberMetadata.map((member) => member.botId)).toEqual(ids.filter((id) => harness.bots.getBot(id).enabled).slice(0, 128));
  expect(harness.store.getRun(accepted.run.id)?.state).toBe("completed");
  harness.store.close();
});

test("oversized fixed Router input fails durably before calling the adapter", async () => {
  const harness = await createHarness({ autoKick: false, router: new RecordingRouter() });
  const { group, topic } = await createGroup(harness);
  harness.state.bots[BOT_ID]!.model = "m".repeat(MAX_ROUTER_INPUT_CHARACTERS + 1);
  const accepted = await acceptAutomatic(harness, group.id, topic.id, "oversized-fixed-input");
  expect(harness.router!.inputs).toEqual([]);
  expect(harness.store.getRun(accepted.run.id)).toMatchObject({ state: "failed", completionReason: "router_input_too_large" });
  harness.store.close();
});

/** The ONLY pre-execution router capability proof PR8 accepts. Everything
 *  except exactly this shape must fail closed. */
const RESTRICTED: RouterCapabilityRestriction = {
  toolsDisabled: true,
  filesystemDisabled: true,
  terminalDisabled: true,
  permissionInteractionDisabled: true,
  messagingDisabled: true,
  orchestrationDisabled: true,
  structuredOutputOnly: true,
};

function seedBots(state: AppState): void {
  for (const [id, name] of [[TESTER_ID, "Tester"], [BUILDER_ID, "Builder"]] as const) {
    state.bots[id] = {
      id, name, agent: "codex", workspace: "backend",
      enabled: true, profileRevision: 1, createdAt: NOW, updatedAt: NOW,
    };
  }
}

class MemoryStateStore implements Pick<StateStore, "save" | "saveNow"> {
  public saved: AppState[] = [];
  async save(state: AppState): Promise<void> { this.saved.push(structuredClone(state)); }
  async saveNow(state: AppState): Promise<void> { this.saved.push(structuredClone(state)); }
}

function createConfig(): AppConfig {
  return {
    transport: { type: "acpx-cli", command: "acpx", permissionMode: "approve-all", nonInteractivePermissions: "deny" },
    logging: { level: "info", maxSizeBytes: 1024, maxFiles: 2, retentionDays: 1, perf: { enabled: false } },
    channel: { type: "weixin", replyMode: "stream" },
    channels: [{ id: "weixin", type: "weixin", enabled: true }],
    plugins: [],
    agents: { codex: { driver: "codex" }, claude: { driver: "claude" } },
    workspaces: { backend: { cwd: "/tmp/backend" } },
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
  public runs: ConversationTurnRunInput[] = [];
  public result: ConversationTurnRunResult = { status: "completed", text: "done" };
  async run(input: ConversationTurnRunInput): Promise<ConversationTurnRunResult> {
    this.runs.push(input);
    return this.result;
  }
  async cancel(): Promise<ConversationTurnCancelResult> {
    return { outcome: "cancelled" as const };
  }
}

interface Harness {
  path: string;
  store: SqliteConversationStore;
  state: AppState;
  stateStore: MemoryStateStore;
  sessions: SessionService;
  bots: BotService;
  runtime: BotRuntimeManager;
  runner: FakeRunner;
  dispatcher: ConversationDispatcher;
  service: ConversationRunService;
  nowFn: () => Date;
  events: Array<{ type: string; run?: { id: string; state: string } }>;
  /** The configured RecordingRouter, when one was supplied. */
  router?: RecordingRouter;
  /** Test seam: build the same RoutingInput the engine builds for a Run. */
  engineInput(runId: ConversationRun["id"]): RoutingInput;
  /** Test seam: attach live member snapshots the way the engine does. */
  withSnapshots(
    decision: Extract<RoutingDecision, { type: "dispatch" }>,
    target: { workspace: string; cwd?: string; isolation: "shared" | "shared-single-writer" | "worktree-per-member" },
  ): Extract<ApplyRoutingDecisionInput["decision"], { type: "dispatch" }>;
}

async function createHarness(options: {
  router?: ConversationRouter | undefined;
  autoKick?: boolean;
  beforeGroupAcceptGatesAcquired?: () => Promise<void>;
  beforeRoutingCommitGatesAcquired?: () => void;
  decisionTimeoutMs?: number;
  hooks?: ConversationDispatcherHooks;
  executionRunner?: ConversationTurnRunner;
} = {}): Promise<Harness> {
  const path = join(mkdtempSync(join(tmpdir(), "xacpx-router-")), "conversation.sqlite");
  const store = await SqliteConversationStore.open(path);
  const state = createEmptyState();
  const stateStore = new MemoryStateStore();
  const stateMutex = new AsyncMutex();
  const config = createConfig();
  const sessions = new SessionService(config, stateStore, state, { now: () => Date.parse(NOW), stateMutex });
  const physical = {
    async deleteSession() { /* no-op */ },
    async releaseLogicalSession() { /* no-op */ },
  };
  const releaseOwnedSession = createStrictOwnedSessionRelease({ sessions, transport: physical });
  const bots = new BotService(config, state, stateStore, {
    now: () => new Date(NOW),
    createId: () => BOT_ID,
    stateMutex,
  });
  const runtime = new BotRuntimeManager(bots, sessions, state, stateStore, {
    now: () => new Date(NOW),
    stateMutex,
    releaseOwnedSession,
  });
  const runner = new FakeRunner();
  const events: Harness["events"] = [];
  const dispatcher = new ConversationDispatcher(store, runtime, options.executionRunner ?? runner, sessions, {
    now: () => new Date(NOW),
    ownerId: "dispatcher-a",
    hooks: options.hooks,
    onProductEvent: (event) => {
      events.push({ type: event.type, run: "run" in event ? { id: event.run.id, state: event.run.state } : undefined });
    },
  });
  const routerEngine = options.router
    ? new ConversationRouterEngine(bindRouter(options.router), {
      store,
      readGroup: (conversationId) => state.conversations[conversationId],
      readTopic: (conversationId, topicId) => {
        const topic = state.conversation_topics[topicId];
        return topic?.conversationId === conversationId ? topic : undefined;
      },
      readBot: (botId) => bots.getBot(botId),
      runLifecycleAll: (botIds, critical) => {
        options.beforeRoutingCommitGatesAcquired?.();
        return bots.runLifecycleAll(botIds, critical);
      },
      now: () => new Date(NOW),
      decisionTimeoutMs: options.decisionTimeoutMs,
    })
    : undefined;
  const service = new ConversationRunService(store, bots, runtime, dispatcher, sessions, state, stateStore, {
    now: () => new Date(NOW),
    stateMutex,
    autoKick: options.autoKick ?? true,
    beforeGroupAcceptGatesAcquired: options.beforeGroupAcceptGatesAcquired,
    releaseOwnedSession,
    onProductEvent: (event) => {
      events.push({ type: event.type, run: "run" in event ? { id: event.run.id, state: event.run.state } : undefined });
    },
    ...(routerEngine ? { routerEngine } : {}),
  });
  dispatcher.setAutomaticRoutingHandler((runId) => {
    service.trackAutomaticRouting(runId);
  });
  await bots.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  seedBots(state);
  const engine = routerEngine;
  return {
    path, store, state, stateStore, sessions, bots, runtime, runner, dispatcher, service,
    nowFn: () => new Date(NOW), events,
    ...(options.router instanceof RecordingRouter ? { router: options.router } : {}),
    engineInput(runId) {
      const run = store.getRun(runId);
      if (!run) {
        throw new Error(`run "${runId}" not found`);
      }
      if (!engine) {
        throw new Error("no router engine configured");
      }
      return engine.buildRoutingInput(run);
    },
    withSnapshots(decision, target) {
      const now = new Date(NOW).toISOString();
      return {
        type: "dispatch",
        mode: decision.mode,
        assignments: decision.assignments.map((assignment) => ({
          id: assignment.id,
          botId: assignment.botId,
          task: assignment.task,
          ...(assignment.expectedOutput !== undefined ? { expectedOutput: assignment.expectedOutput } : {}),
          ...(assignment.dependsOn !== undefined ? { dependsOn: assignment.dependsOn } : {}),
          triggerMessageIds: assignment.triggerMessageIds,
          profileSnapshot: snapshotGroupMemberProfile(
            state.bots[assignment.botId] ?? { ...state.bots[BOT_ID]!, id: assignment.botId },
            target,
            now,
          ),
        })),
      };
    },
  };
}

/** A scripted Router: returns decisions in order and records every input. */
class RecordingRouter implements ConversationRouter {
  readonly capabilityRestriction = RESTRICTED;
  public inputs: RoutingInput[] = [];
  public decisions: Array<RoutingDecision | Error | unknown> = [];
  constructor(decisions: Array<RoutingDecision | Error | unknown> = []) {
    this.decisions = decisions;
  }
  async decide(input: RoutingInput): Promise<RoutingDecision> {
    this.inputs.push(structuredClone(input));
    const next = this.decisions.shift();
    if (next === undefined) {
      return { type: "complete", reason: "no-more-scripted-decisions" };
    }
    if (next instanceof Error) {
      throw next;
    }
    return next as RoutingDecision;
  }
}

test("a final pre-start rejection routes its failed assignment and releases the next Topic Run", async () => {
  const router = new RecordingRouter([
    { type: "dispatch", mode: "single", assignments: [{ id: "A", botId: BOT_ID, task: "review", triggerMessageIds: [] }] },
    { type: "complete", reason: "handled pre-start failure" },
    { type: "complete", reason: "successor finished" },
  ]);
  const harness = await createHarness({ autoKick: false, router });
  const { group, topic } = await createGroup(harness);
  const first = await acceptAutomatic(harness, group.id, topic.id, "pre-start-owner");
  const next = await acceptAutomatic(harness, group.id, topic.id, "pre-start-successor");
  expect(router.inputs).toHaveLength(1);
  // Agent edits are legal before the first runtime binding materializes.
  await harness.bots.updateBot(BOT_ID, { agent: "claude" });
  await harness.dispatcher.kick(); await harness.service.awaitRouting();
  const member = harness.store.listMemberTurns(first.run.id)[0]!;
  expect(member).toMatchObject({ state: "failed", failureReason: "runtime_revision_mismatch" });
  expect(member.startedAt).toBeUndefined();
  expect(harness.runner.runs).toEqual([]);
  expect(router.inputs[1]?.completedAssignments[0]).toMatchObject({ id: "A", outcome: "failed", failureReason: "runtime_revision_mismatch" });
  expect(harness.store.getRun(first.run.id)).toMatchObject({ state: "completed", completionReason: "handled pre-start failure" });
  expect(harness.store.getRun(next.run.id)).toMatchObject({ state: "completed", completionReason: "successor finished" });
  harness.store.close();
});

for (const recovery of ["pre-start retry", "expired claim"] as const) {
  for (const outcome of ["completed", "blocked", "missing task"] as const) {
    test(`automatic ${recovery} preserves assignment and permission semantics for ${outcome}`, async () => {
      let failOnce = true;
      const harness = await createHarness({ autoKick: false,
        router: new RecordingRouter([
          { type: "dispatch", mode: "single", assignments: [{ id: "A", botId: BOT_ID,
            task: "RECOVERED ASSIGNMENT", expectedOutput: "RECOVERED OUTPUT", triggerMessageIds: [] }] },
          { type: "complete", reason: "handled recovered assignment" },
        ]),
        ...(recovery === "pre-start retry" ? { hooks: { failRuntimeMaterialize() {
          if (failOnce) { failOnce = false; return new Error("transient materialization failure"); }
        } } } : {}),
      });
      const { group, topic } = await createGroup(harness);
      const accepted = await acceptAutomatic(harness, group.id, topic.id, `recovery-${recovery}-${outcome}`);
      if (recovery === "pre-start retry") {
        await harness.dispatcher.kick();
      } else {
        const claim = harness.store.claimNextDispatch({ owner: "dead-dispatcher", authorityEpoch: "expired",
          now: "2026-09-15T11:59:00.000Z", leaseExpiresAt: "2026-09-15T11:59:30.000Z" });
        expect(claim).toBeDefined();
        harness.store.recoverExpiredClaims(NOW);
      }
      const recovered = harness.store.listMemberTurns(accepted.run.id)[0]!;
      expect(recovered.origin).toBe("recovery");
      expect(recovered.task).toBe("RECOVERED ASSIGNMENT");
      const dispatch = harness.store.listDispatchesForRun(accepted.run.id)[0]!;
      expect(dispatch.authorityEpoch).toBeUndefined();
      expect(dispatch.humanIngress).toBeUndefined();
      if (outcome === "blocked") {
        harness.runner.result = { status: "failed", error: "typed permission denied", blockedReason: "human-authority-unknown" };
      } else if (outcome === "missing task") {
        harness.store.directWriteForTest("member_turns", recovered.id, { task: null });
      }
      await harness.dispatcher.kick(); await harness.service.awaitRouting();
      const member = harness.store.getMemberTurn(recovered.id)!;
      if (outcome === "missing task") {
        expect(member).toMatchObject({ state: "failed", failureReason: "missing_assignment_task" });
        expect(member.startedAt).toBeUndefined();
        expect(harness.runner.runs).toEqual([]);
      } else {
        expect(harness.runner.runs).toHaveLength(1);
        const call = harness.runner.runs[0]!;
        expect(call.text).toContain("Task:\nRECOVERED ASSIGNMENT");
        expect(call.text).toContain("Expected output:\nRECOVERED OUTPUT");
        expect(call.executionOrigin).toBe("orchestration");
        expect(call.permissionRoute).toBeUndefined();
        expect(member.state).toBe(outcome === "completed" ? "completed" : "failed");
      }
      harness.store.close();
      const reopened = await SqliteConversationStore.open(harness.path);
      try {
        const durable = reopened.getMemberTurn(recovered.id)!;
        expect(durable.origin).toBe("recovery");
        expect(toMemberTurnSummary(durable).blockedReason).toBe(outcome === "blocked" ? "human-authority-unknown" : undefined);
        expect(reopened.getRun(accepted.run.id)?.state).toBe("completed");
      } finally { reopened.close(); }
    });
  }
}

async function createGroup(harness: Harness) {
  const group = await harness.bots.createGroup({
    title: "Team",
    botIds: [BOT_ID, TESTER_ID, BUILDER_ID],
  });
  const topic = await harness.service.createGroupTopic(group.id, "Sprint", {
    workspace: "backend",
    isolation: "shared-single-writer",
  });
  return { group, topic };
}

/** Accept an automatic Run through the real service accept path, settling the
 *  first routing decision deterministically before returning. */
async function acceptAutomatic(harness: Harness, conversationId: string, topicId: string, requestId: string) {
  const accepted = await harness.service.acceptGroupPrompt({
    conversationId,
    topicId,
    requestId,
    text: "ship the change",
    target: { mode: "automatic" },
    humanIngress: {
      chatKey: "relay:acct",
      senderId: "acct",
      accountId: "acct",
      isOwner: true,
      chatType: "group",
    },
  });
  await harness.service.awaitRouting();
  return accepted;
}

// ---------------------------------------------------------------------------
// §11.2 / §12.1 — Decision schema validation (§22 "malformed schema rejected")
// ---------------------------------------------------------------------------

test("malformed router decision schema is rejected with a machine-readable code", () => {
  const malformed: unknown[] = [
    null,
    "complete",
    {},
    { type: "none" },
    { type: "dispatch" },
    { type: "dispatch", mode: "sometimes", assignments: [] },
    { type: "dispatch", mode: "single", assignments: [] },
    { type: "dispatch", mode: "single", assignments: [{ id: "a", botId: BOT_ID }] },
    { type: "dispatch", mode: "single", assignments: [{ id: "a", botId: BOT_ID, task: "" }] },
    { type: "dispatch", mode: "single", assignments: [{ id: "", botId: BOT_ID, task: "t", triggerMessageIds: [] }] },
    { type: "dispatch", mode: "single", assignments: [{ id: "a", botId: BOT_ID, task: "t", triggerMessageIds: "x" }] },
    { type: "dispatch", mode: "single", assignments: [{ id: "a", botId: BOT_ID, task: "t", triggerMessageIds: [1] }] },
    { type: "dispatch", mode: "single", assignments: [{ id: "a", botId: BOT_ID, task: "t", dependsOn: "b", triggerMessageIds: [] }] },
    { type: "need-human" },
    { type: "need-human", question: "" },
    { type: "complete" },
    { type: "complete", reason: "" },
    { type: "complete", reason: "ok", synthesisBotId: "" },
    { type: "complete", reason: 5 },
  ];
  for (const value of malformed) {
    expect(() => parseRoutingDecision(value)).toThrow(RoutingDecisionError);
  }
  // Self-dependency is structurally valid but a DOMAIN cycle: the gate — not
  // the parser — must reject it.
  expect(parseRoutingDecision({ type: "dispatch", mode: "sequential", assignments: [{ id: "a", botId: BOT_ID, task: "t", dependsOn: ["a"], triggerMessageIds: [] }] }))
    .toMatchObject({ type: "dispatch" });
});

test("router decision never implements an ambiguous none", () => {
  expect(() => parseRoutingDecision({ type: "none" })).toThrow(/not one of dispatch \| need-human \| complete/);
});

test("valid router decision shapes parse without defaulting fields", () => {
  expect(parseRoutingDecision({ type: "complete", reason: "done" }))
    .toEqual({ type: "complete", reason: "done" });
  expect(parseRoutingDecision({ type: "need-human", question: "which branch?" }))
    .toEqual({ type: "need-human", question: "which branch?" });
  const dispatch = parseRoutingDecision({
    type: "dispatch",
    mode: "single",
    assignments: [{ id: "a1", botId: BOT_ID, task: "review", expectedOutput: "notes", triggerMessageIds: ["cmsg_1"] }],
  });
  expect(dispatch).toEqual({
    type: "dispatch",
    mode: "single",
    assignments: [{
      id: "a1",
      botId: BOT_ID,
      task: "review",
      expectedOutput: "notes",
      triggerMessageIds: ["cmsg_1"],
    }],
  });
});

// ---------------------------------------------------------------------------
// §12.2 / §11.3 — Capability boundary (fail closed BEFORE execution)
// ---------------------------------------------------------------------------

test("an adapter that cannot prove the restriction is not a router", () => {
  expect(isRouterCapabilityRestricted(RESTRICTED)).toBe(true);
  expect(isRouterCapabilityRestricted(UNRESTRICTED_ROUTER_CAPABILITY)).toBe(false);
  for (const key of Object.keys(RESTRICTED) as Array<keyof RouterCapabilityRestriction>) {
    // Any single unproven restriction keeps automatic mode unsupported: the
    // boundary is all-or-nothing, never "mostly restricted".
    expect(isRouterCapabilityRestricted({ ...RESTRICTED, [key]: false })).toBe(false);
    expect(isRouterCapabilityRestricted({ ...RESTRICTED, [key]: undefined as never })).toBe(false);
  }
  expect(isRouterCapabilityRestricted(undefined)).toBe(false);
  expect(bindRouter({ decide: async () => ({ type: "complete", reason: "x" }) })).toBeUndefined();
  expect(bindRouter(undefined)).toBeUndefined();
});

test("unsupported adapter configuration disables automatic mode at accept", async () => {
  const harness = await createHarness();
  const { group, topic } = await createGroup(harness);
  // A Router object that CANNOT prove its restriction before execution is not
  // bindable, so `bindRouter` returns undefined and the engine is absent.
  const permissiveRouter = {
    capabilityRestriction: UNRESTRICTED_ROUTER_CAPABILITY,
    decide: async () => ({ type: "complete" as const, reason: "unreachable" }),
  };
  expect(bindRouter(permissiveRouter)).toBeUndefined();
  // With no usable Router configured, automatic must fail closed — never
  // accept a Run the Router could not legally decide.
  await expect(acceptAutomatic(harness, group.id, topic.id, "req-unsupported"))
    .rejects.toMatchObject({ code: "automatic_unsupported" });
  expect(harness.store.listRuns(group.id, topic.id)).toHaveLength(0);
  harness.store.close();
});

test("automatic run without a configured router fails closed even after accept", async () => {
  const harness = await createHarness();
  const { group, topic } = await createGroup(harness);
  // Accept directly at the store with the automatic reservation, then route
  // with no Router wired: the Run must fail, never hang nonterminal.
  const botA = harness.bots.getBot(BOT_ID);
  const target = topic.executionTarget!;
  const accepted = harness.store.acceptRequest({
    conversationId: group.id,
    topicId: topic.id,
    requestId: "req-no-router",
    botId: botA.id,
    content: "ship",
    profileSnapshot: snapshotGroupMemberProfile(botA, target, NOW),
    mode: "automatic",
    members: [],
    now: NOW,
  });
  expect(accepted.memberTurns).toHaveLength(0);
  expect(accepted.run.routingState).toBe("queued");
  await harness.service.routeAutomaticRun(accepted.run.id, false);
  const failed = harness.store.getRun(accepted.run.id)!;
  expect(failed.state).toBe("failed");
  expect(failed.completionReason).toBe("automatic_unsupported");
  harness.store.close();
});

// ---------------------------------------------------------------------------
// §11.1 — RoutingInput boundary: public-only, no Direct/private/other-Topic
// ---------------------------------------------------------------------------

test("router input contains no direct, private, or other-topic state", async () => {
  const harness = await createHarness({ router: new RecordingRouter([{ type: "complete", reason: "done" }]) });
  const { group, topic } = await createGroup(harness);
  const botA = harness.bots.getBot(BOT_ID);
  const botB = harness.bots.getBot(TESTER_ID);
  const target = topic.executionTarget!;

  // (a) Direct Conversation history for the SAME bots — must never reach the Router.
  await harness.service.acceptDirectPrompt({ botId: BOT_ID, requestId: "req-direct-1", content: "DIRECT SECRET" });
  await harness.service.acceptDirectPrompt({ botId: TESTER_ID, requestId: "req-direct-2", content: "DIRECT TESTER SECRET" });
  // (b) A second Group conversation with overlapping bots.
  const otherGroup = await harness.bots.createGroup({ title: "Other", botIds: [BOT_ID, TESTER_ID] });
  const otherTopic = await harness.service.createGroupTopic(otherGroup.id, "OtherTopic", {
    workspace: "backend", isolation: "shared-single-writer",
  });
  await harness.service.acceptGroupPrompt({
    conversationId: otherGroup.id, topicId: otherTopic.id, requestId: "req-other-group",
    text: "OTHER GROUP SECRET", target: { mode: "members", botIds: [BOT_ID] },
  });
  // (c) A second Topic in the SAME group.
  const siblingTopic = await harness.service.createGroupTopic(group.id, "Sibling", {
    workspace: "backend", isolation: "shared-single-writer",
  });
  await harness.service.acceptGroupPrompt({
    conversationId: group.id, topicId: siblingTopic.id, requestId: "req-sibling-topic",
    text: "SIBLING TOPIC SECRET", target: { mode: "members", botIds: [BOT_ID] },
  });

  const router = harness.router;
  await acceptAutomatic(harness, group.id, topic.id, "req-auto-input");
  expect(router).toBeDefined();
  const input = router!.inputs[0]!;
  // The Router sees only THIS Topic's public context and its own request.
  const serialized = JSON.stringify(input);
  expect(serialized).not.toContain("DIRECT SECRET");
  expect(serialized).not.toContain("DIRECT TESTER SECRET");
  expect(serialized).not.toContain("OTHER GROUP SECRET");
  expect(serialized).not.toContain("SIBLING TOPIC SECRET");
  expect(input.request).toBe("ship the change");
  expect(input.conversationId).toBe(group.id);
  expect(input.topicId).toBe(topic.id);
  // Membership metadata is opaque ids + durable profile fields only.
  expect(input.memberMetadata.map((member) => member.botId).sort())
    .toEqual([BOT_ID, BUILDER_ID, TESTER_ID].sort());
  expect(input.memberMetadata.every((member) => member.enabled === true)).toBe(true);
  // No instructions / no session aliases / no hidden history in the payload.
  expect(serialized).not.toContain("brt_");
  expect(serialized).not.toContain("instructions");
  expect(serialized).not.toContain("logicalSessionId");
  expect(input.executionTarget.isolation).toBe("shared-single-writer");
  harness.store.close();
});

test("router input is rebuilt from durable state on every decide call (no hidden router history)", async () => {
  const router = new RecordingRouter([
    { type: "dispatch", mode: "single", assignments: [{ id: "a1", botId: BOT_ID, task: "review", triggerMessageIds: [] }] },
    { type: "complete", reason: "done" },
  ]);
  const harness = await createHarness({ router, autoKick: false });
  const { group, topic } = await createGroup(harness);
  const accepted = await acceptAutomatic(harness, group.id, topic.id, "req-stateless");
  expect(harness.store.getRun(accepted.run.id)!.routingState).toBe("dispatching");
  // Let the dispatcher execute the dispatched batch; the batch-settle hook
  // then routes again, and the Router's second decision completes the Run.
  await harness.dispatcher.kick();
  await harness.service.awaitRouting();
  const run = harness.store.getRun(accepted.run.id)!;
  expect(run.state).toBe("completed");
  expect(run.routingState).toBe("done");
  expect(harness.store.listMemberTurns(run.id).map((turn) => turn.origin)).toEqual(["router"]);
  // Second decision must see the completed assignment from DURABLE rows.
  expect(router.inputs).toHaveLength(2);
  expect(router.inputs[1]!.completedAssignments).toHaveLength(1);
  expect(router.inputs[1]!.completedAssignments[0]!.id).toBe("a1");
  expect(router.inputs[1]!.completedAssignments[0]!.outcome).toBe("completed");
  harness.store.close();
});

test("sequential assignment input exposes the prior public result to the router", async () => {
  const router = new RecordingRouter([
    { type: "dispatch", mode: "single", assignments: [{ id: "a1", botId: BOT_ID, task: "review", triggerMessageIds: [] }] },
    { type: "dispatch", mode: "single", assignments: [{ id: "a2", botId: BUILDER_ID, task: "fix", triggerMessageIds: [] }] },
    { type: "complete", reason: "done" },
  ]);
  const harness = await createHarness({ router });
  harness.runner.result = { status: "completed", text: "PUBLIC REVIEW RESULT" };
  const { group, topic } = await createGroup(harness);
  await acceptAutomatic(harness, group.id, topic.id, "req-seq-result");
  await harness.dispatcher.kick();
  await harness.service.awaitRouting();
  await harness.dispatcher.kick();
  await harness.service.awaitRouting();
  expect(router.inputs).toHaveLength(3);
  const second = router.inputs[1]!;
  expect(second.completedAssignments).toHaveLength(1);
  expect(second.completedAssignments[0]!.result).toBe("PUBLIC REVIEW RESULT");
  harness.store.close();
});

// ---------------------------------------------------------------------------
// §11.4 — Automatic Run durable state machine + restart determinism
// ---------------------------------------------------------------------------

test("automatic run terminal states are durable and reopen deterministically", async () => {
  const router = new RecordingRouter([{ type: "complete", reason: "work-complete" }]);
  const harness = await createHarness({ router });
  const { group, topic } = await createGroup(harness);
  const accepted = await acceptAutomatic(harness, group.id, topic.id, "req-terminal");
  const completed = harness.store.getRun(accepted.run.id)!;
  expect(completed.state).toBe("completed");
  expect(completed.completionReason).toBe("work-complete");
  expect(completed.routingState).toBe("done");
  expect(completed.finishedAt).toBeDefined();

  // Reopen: the terminal outcome survives verbatim (no re-route, no kick).
  harness.store.close();
  const reopened = await SqliteConversationStore.open(harness.path);
  const reloaded = reopened.getRun(accepted.run.id)!;
  expect(reloaded.state).toBe("completed");
  expect(reloaded.completionReason).toBe("work-complete");
  expect(reloaded.routingState).toBe("done");
  expect(reopened.listRoutingDecisions(accepted.run.id)).toEqual([
    {
      runId: accepted.run.id,
      decisionType: "complete",
      reason: "work-complete",
      assignmentIds: [],
      at: expect.any(String),
    },
  ]);
  // A routed-terminal Run is never routed again.
  expect(() => reopened.markRoutingState(accepted.run.id, "routing", NOW)).toThrow(/routing is sealed/);
  reopened.close();
});

test("need-human persists a durable waiting-human run", async () => {
  const router = new RecordingRouter([{ type: "need-human", question: "which branch ships?" }]);
  const harness = await createHarness({ router });
  const { group, topic } = await createGroup(harness);
  const accepted = await acceptAutomatic(harness, group.id, topic.id, "req-need-human");
  const run = harness.store.getRun(accepted.run.id)!;
  expect(run.state).toBe("waiting-human");
  expect(run.completionReason).toBe("needs-input");
  expect(run.routingState).toBe("done");
  // Durable, not in-memory: the question and the terminal state both survive reopen.
  harness.store.close();
  const reopened = await SqliteConversationStore.open(harness.path);
  expect(reopened.getRun(accepted.run.id)!.state).toBe("waiting-human");
  const decisions = reopened.listRoutingDecisions(accepted.run.id);
  expect(decisions[0]!.decisionType).toBe("need-human");
  expect(decisions[0]!.question).toBe("which branch ships?");
  reopened.close();
});

test("crash at the routing boundary re-routes deterministically on restart", async () => {
  // The durable routing marker moves `queued → routing → dispatching` inside
  // the store. A crash while `routing` (Router asked, no durable batch yet)
  // must re-ask from `queued`, never half-apply a decision.
  const router = new RecordingRouter([
    { type: "dispatch", mode: "single", assignments: [{ id: "a1", botId: BOT_ID, task: "review", triggerMessageIds: [] }] },
  ]);
  const harness = await createHarness({ router });
  const { group, topic } = await createGroup(harness);
  const botA = harness.bots.getBot(BOT_ID);
  const accepted = harness.store.acceptRequest({
    conversationId: group.id, topicId: topic.id, requestId: "req-route-crash",
    botId: botA.id, content: "go",
    profileSnapshot: snapshotGroupMemberProfile(botA, topic.executionTarget!, NOW),
    mode: "automatic", members: [], now: NOW,
  });
  expect(accepted.memberTurns).toHaveLength(0);
  expect(accepted.run.routingState).toBe("queued");
  // Route explicitly (no fire-and-forget) so the assertion sees the durable
  // outcome of the decision, exactly as a restarting consumer would.
  await harness.service.routeAutomaticRun(accepted.run.id, false);
  const dispatchState = harness.store.getRun(accepted.run.id)!;
  expect(dispatchState.routingState).toBe("dispatching");
  const turns = harness.store.listMemberTurns(accepted.run.id);
  expect(turns).toHaveLength(1);
  expect(turns[0]!.origin).toBe("router");
  const dispatches = harness.store.listDispatchesForRun(accepted.run.id);
  expect(dispatches).toHaveLength(1);
  expect(dispatches[0]!.state).toBe("pending");

  // Reopen the store: the durable marker alone drives the next decision, and
  // `dispatching` blocks a second batch until the current one is terminal.
  harness.store.close();
  const reopened = await SqliteConversationStore.open(harness.path);
  const reloaded = reopened.getRun(accepted.run.id)!;
  expect(reloaded.routingState).toBe("dispatching");
  expect(reopened.listMemberTurns(accepted.run.id)).toHaveLength(1);
  // The active batch blocks a second dispatch, deterministically, from durable
  // rows alone — no process memory involved.
  const botB = harness.bots.getBot(TESTER_ID);
  const secondAssignment: RoutingAssignmentInput = {
    id: "a2",
    botId: TESTER_ID,
    task: "test",
    triggerMessageIds: [reloaded.requestMessageId],
    profileSnapshot: snapshotGroupMemberProfile(botB, topic.executionTarget!, NOW),
  };
  expect(() => reopened.applyRoutingDecision({
    runId: accepted.run.id, now: NOW,
    routingGeneration: reloaded.routingGeneration!,
    decision: { type: "dispatch", mode: "single", assignments: [secondAssignment] },
    requestMessageId: reloaded.requestMessageId,
  })).toThrow(/routing ownership changed|unsettled members/);
  expect(reopened.listRoutingDecisions(accepted.run.id)).toHaveLength(1);
  reopened.close();
});

test("budget exhaustion is an explicit completion reason, never a loop guard", async () => {
  const router = new RecordingRouter([
    { type: "dispatch", mode: "single", assignments: [{ id: "a1", botId: BOT_ID, task: "t1", triggerMessageIds: [] }] },
    { type: "dispatch", mode: "single", assignments: [{ id: "a2", botId: TESTER_ID, task: "t2", triggerMessageIds: [] }] },
  ]);
  const harness = await createHarness({ router });
  const { group, topic } = await createGroup(harness);
  // Budget exactly 2: the second dispatch must be refused as budget-exhausted
  // rather than silently truncating to one member.
  const accepted = harness.store.acceptRequest({
    conversationId: group.id,
    topicId: topic.id,
    requestId: "req-budget",
    botId: harness.bots.getBot(BOT_ID).id,
    content: "go",
    profileSnapshot: snapshotGroupMemberProfile(harness.bots.getBot(BOT_ID), topic.executionTarget!, NOW),
    mode: "automatic",
    members: [{ botId: TESTER_ID, profileSnapshot: snapshotGroupMemberProfile(harness.bots.getBot(TESTER_ID), topic.executionTarget!, NOW) }],
    maxMemberTurns: 2,
    now: NOW,
  });
  expect(accepted.run.maxMemberTurns).toBe(2);
  await harness.dispatcher.kick();
  // First batch consumed both turns; the next decision cannot dispatch.
  await harness.service.routeAutomaticRun(accepted.run.id, false);
  const run = harness.store.getRun(accepted.run.id)!;
  expect(run.state).toBe("failed");
  expect(run.completionReason).toBe("budget-exhausted");
  expect(run.finishedAt).toBeDefined();
  harness.store.close();
});

// ---------------------------------------------------------------------------
// §12.1 domain validation — unknown/non-member bot, budget, dependency edges
// ---------------------------------------------------------------------------

function baseInput(overrides: Partial<RoutingInput> = {}): RoutingInput {
  return {
    runId: "run_1",
    conversationId: "conversation_1",
    topicId: "topic_1",
    request: "ship",
    requestMessageId: "cmsg_1",
    publicTranscript: [],
    memberMetadata: [
      { botId: BOT_ID, name: "Reviewer", agent: "codex", workspace: "backend", enabled: true },
      { botId: TESTER_ID, name: "Tester", agent: "codex", workspace: "backend", enabled: false },
    ],
    runState: {
      runId: "run_1",
      conversationId: "conversation_1",
      topicId: "topic_1",
      mode: "automatic",
      generation: 1,
      maxMemberTurns: 24,
      consumedMemberTurns: 0,
      failedBotIds: [],
    },
    completedAssignments: [],
    remainingBudget: 24,
    executionTarget: { workspace: "backend", isolation: "shared-single-writer" },
    ...overrides,
  };
}

test("router decision naming an unknown or non-member bot is rejected", () => {
  const gate = gateRoutingDecision({
    type: "dispatch",
    mode: "single",
    assignments: [{ id: "a", botId: "bot_ghost", task: "t", triggerMessageIds: ["cmsg_1"] }],
  }, baseInput());
  expect(gate).toEqual({ kind: "rejected", code: "router_unknown_member", message: expect.any(String) });
});

test("router decision naming a disabled member is rejected", () => {
  const gate = gateRoutingDecision({
    type: "dispatch",
    mode: "single",
    assignments: [{ id: "a", botId: TESTER_ID, task: "t", triggerMessageIds: ["cmsg_1"] }],
  }, baseInput());
  expect(gate).toEqual({ kind: "rejected", code: "router_member_unavailable", message: expect.any(String) });
});

test("router decision exceeding the remaining budget is rejected", () => {
  const gate = gateRoutingDecision({
    type: "dispatch",
    mode: "parallel",
    assignments: [
      { id: "a", botId: BOT_ID, task: "t", triggerMessageIds: ["cmsg_1"] },
      { id: "b", botId: TESTER_ID, task: "t", triggerMessageIds: ["cmsg_1"] },
    ],
  }, baseInput({
    memberMetadata: [
      { botId: BOT_ID, name: "Reviewer", agent: "codex", workspace: "backend", enabled: true },
      { botId: TESTER_ID, name: "Tester", agent: "codex", workspace: "backend", enabled: true },
    ],
    remainingBudget: 1,
  }));
  expect(gate).toEqual({ kind: "rejected", code: "router_budget_exhausted", message: expect.any(String) });
});

test("illegal assignment dependencies, cycles, modes and duplicates are rejected", () => {
  const members = [
    { botId: BOT_ID, name: "Reviewer", agent: "codex", workspace: "backend", enabled: true },
    { botId: TESTER_ID, name: "Tester", agent: "codex", workspace: "backend", enabled: true },
    { botId: BUILDER_ID, name: "Builder", agent: "codex", workspace: "backend", enabled: true },
  ];
  const input = baseInput({ memberMetadata: members });
  // Unknown dependency target.
  expect(gateRoutingDecision({
    type: "dispatch", mode: "sequential",
    assignments: [{ id: "a", botId: BOT_ID, task: "t", triggerMessageIds: ["cmsg_1"], dependsOn: ["ghost"] }],
  }, input)).toEqual({ kind: "rejected", code: "router_assignment_dependency_unknown", message: expect.any(String) });
  // Dependencies on a non-sequential batch.
  expect(gateRoutingDecision({
    type: "dispatch", mode: "parallel",
    assignments: [
      { id: "a", botId: BOT_ID, task: "t", triggerMessageIds: ["cmsg_1"], dependsOn: ["b"] },
      { id: "b", botId: TESTER_ID, task: "t", triggerMessageIds: ["cmsg_1"] },
    ],
  }, input)).toEqual({ kind: "rejected", code: "router_assignment_dependency_mode", message: expect.any(String) });
  // Duplicate assignment id.
  expect(gateRoutingDecision({
    type: "dispatch", mode: "parallel",
    assignments: [
      { id: "a", botId: BOT_ID, task: "t", triggerMessageIds: ["cmsg_1"] },
      { id: "a", botId: TESTER_ID, task: "t", triggerMessageIds: ["cmsg_1"] },
    ],
  }, input)).toEqual({ kind: "rejected", code: "router_assignment_duplicate", message: expect.any(String) });
  // Same Bot twice in one batch.
  expect(gateRoutingDecision({
    type: "dispatch", mode: "parallel",
    assignments: [
      { id: "a", botId: BOT_ID, task: "t", triggerMessageIds: ["cmsg_1"] },
      { id: "b", botId: BOT_ID, task: "t", triggerMessageIds: ["cmsg_1"] },
    ],
  }, input)).toEqual({ kind: "rejected", code: "router_assignment_duplicate_member", message: expect.any(String) });
  // Cyclic dependency graph inside the decision.
  expect(gateRoutingDecision({
    type: "dispatch", mode: "sequential",
    assignments: [
      { id: "a", botId: BOT_ID, task: "t", triggerMessageIds: ["cmsg_1"], dependsOn: ["b"] },
      { id: "b", botId: TESTER_ID, task: "t", triggerMessageIds: ["cmsg_1"], dependsOn: ["a"] },
    ],
  }, input)).toEqual({ kind: "rejected", code: "router_assignment_dependency_cycle", message: expect.any(String) });
  // single with 2 assignments / parallel with 1.
  expect(gateRoutingDecision({
    type: "dispatch", mode: "single",
    assignments: [
      { id: "a", botId: BOT_ID, task: "t", triggerMessageIds: ["cmsg_1"] },
      { id: "b", botId: TESTER_ID, task: "t", triggerMessageIds: ["cmsg_1"] },
    ],
  }, input)).toEqual({ kind: "rejected", code: "router_assignment_mode", message: expect.any(String) });
  expect(gateRoutingDecision({
    type: "dispatch", mode: "parallel",
    assignments: [{ id: "a", botId: BOT_ID, task: "t", triggerMessageIds: ["cmsg_1"] }],
  }, input)).toEqual({ kind: "rejected", code: "router_assignment_mode", message: expect.any(String) });
});

test("a clean router decision passes the gate", () => {
  const gate = gateRoutingDecision({
    type: "dispatch", mode: "sequential",
    assignments: [
      { id: "a", botId: BOT_ID, task: "review", expectedOutput: "notes", triggerMessageIds: ["cmsg_1"] },
      { id: "b", botId: TESTER_ID, task: "fix", triggerMessageIds: ["cmsg_1"], dependsOn: ["a"] },
    ],
  }, baseInput({
    memberMetadata: [
      { botId: BOT_ID, name: "Reviewer", agent: "codex", workspace: "backend", enabled: true },
      { botId: TESTER_ID, name: "Tester", agent: "codex", workspace: "backend", enabled: true },
    ],
    completedAssignments: [{ id: "seed", botId: BOT_ID, task: "", dependsOn: [], triggerMessageIds: [], outcome: "completed", attempt: 1, batch: 1 }],
  }));
  expect(gate.kind).toBe("decision");
});

// ---------------------------------------------------------------------------
// §11.5 / acceptance 10 — completion semantics
// ---------------------------------------------------------------------------

test("explicit runs never route and never call the router", async () => {
  const router = new RecordingRouter([{ type: "dispatch", mode: "single", assignments: [{ id: "a", botId: BUILDER_ID, task: "steal", triggerMessageIds: [] }] }]);
  const harness = await createHarness({ router });
  const { group, topic } = await createGroup(harness);
  const accepted = await harness.service.acceptGroupPrompt({
    conversationId: group.id, topicId: topic.id, requestId: "req-explicit",
    text: "review it", target: { mode: "members", botIds: [BOT_ID, TESTER_ID] },
    humanIngress: { chatKey: "relay:acct", senderId: "acct", isOwner: true, chatType: "group" },
  });
  expect(accepted.run.mode).toBe("explicit");
  expect(accepted.run.routingState).toBeUndefined();
  await harness.dispatcher.kick();
  // Explicit Run terminal after selected members terminal; Router never asked.
  expect(router.inputs).toHaveLength(0);
  expect(harness.store.getRun(accepted.run.id)!.state).toBe("completed");
  // Routing an explicit Run is refused, not silently ignored.
  expect(() => harness.store.markRoutingState(accepted.run.id, "routing", NOW))
    .toThrow(/is explicit, not automatic/);
  expect(harness.store.listRoutingDecisions(accepted.run.id)).toHaveLength(0);
  harness.store.close();
});

test("automatic completes by planned work then a router complete, without leftover work", async () => {
  const router = new RecordingRouter([
    { type: "dispatch", mode: "parallel", assignments: [
      { id: "a", botId: BOT_ID, task: "review", triggerMessageIds: [] },
      { id: "b", botId: TESTER_ID, task: "test", triggerMessageIds: [] },
    ] },
    { type: "complete", reason: "plan-completed" },
  ]);
  const harness = await createHarness({ router });
  const { group, topic } = await createGroup(harness);
  const accepted = await acceptAutomatic(harness, group.id, topic.id, "req-parallel");
  await harness.dispatcher.kick();
  await harness.service.awaitRouting();
  const members = harness.store.listMemberTurns(accepted.run.id);
  expect(members.map((turn) => turn.assignmentId)).toEqual(["a", "b"]);
  expect(members.map((turn) => turn.origin)).toEqual(["router", "router"]);
  expect(harness.store.getRun(accepted.run.id)!.state).toBe("completed");
  harness.store.close();
});

// ---------------------------------------------------------------------------
// §11.6 / acceptance 11 — provenance: no human permission authority
// ---------------------------------------------------------------------------

test("router-selected member turns carry orchestration provenance only", async () => {
  const router = new RecordingRouter([
    { type: "dispatch", mode: "single", assignments: [{ id: "a1", botId: BOT_ID, task: "review", triggerMessageIds: [] }] },
    { type: "complete", reason: "done" },
  ]);
  const harness = await createHarness({ router });
  const { group, topic } = await createGroup(harness);
  // The accept carries real human ingress — yet automatic work must NOT
  // inherit it, and the Router decision must not mint human authority.
  await acceptAutomatic(harness, group.id, topic.id, "req-provenance");
  await harness.dispatcher.kick();
  await harness.service.awaitRouting();
  for (const run of harness.runner.runs) {
    expect(run.executionOrigin).toBe("orchestration");
    expect(run.permissionRoute).toBeUndefined();
  }
  const turn = harness.store.listMemberTurns(harness.store.getRun(harness.store.listRuns(group.id, topic.id)[0]!.id)!.id)[0]!;
  expect(turn.origin).toBe("router");
  const dispatch = harness.store.getDispatchForMemberTurn(turn.id)!;
  // The accepted human ingress was for the REQUEST only; the dispatch row for
  // automatic work carries no authority epoch and no permission route.
  expect(dispatch.authorityEpoch).toBeFalsy();
  expect(dispatch.humanIngress).toBeFalsy();
  harness.store.close();
});

// ---------------------------------------------------------------------------
test("explicit Group execution retains its original prompt without an assignment envelope", async () => {
  const harness = await createHarness({ autoKick: false });
  const { group, topic } = await createGroup(harness);
  await harness.service.acceptGroupPrompt({ conversationId: group.id, topicId: topic.id,
    requestId: "explicit-input", text: "EXPLICIT HUMAN WORK", target: { botId: BOT_ID } });
  await harness.dispatcher.kick();
  const text = harness.runner.runs[0]!.text;
  expect(text.endsWith("EXPLICIT HUMAN WORK")).toBe(true);
  expect(text).not.toContain("Group assignment:");
  expect(text).not.toContain("Public Group context:");
  harness.store.close();
});

test("automatic admission retries when its probed carrier is disabled before acquisition", async () => {
  let harness!: Harness;
  let acquisitions = 0;
  const router = new RecordingRouter([{ type: "need-human", question: "scope?" }]);
  harness = await createHarness({ router, autoKick: false, beforeGroupAcceptGatesAcquired: async () => {
    if (++acquisitions === 1) await harness.bots.updateBot(BOT_ID, { enabled: false });
  } });
  const { group, topic } = await createGroup(harness);
  const accepted = await acceptAutomatic(harness, group.id, topic.id, "changed-carrier");
  expect(acquisitions).toBe(2);
  expect(accepted.run.profileSnapshot.presentation.name).toBe(harness.bots.getBot(TESTER_ID).name);
  expect(accepted.memberTurns).toEqual([]);
  expect(router.inputs[0]!.memberMetadata.find((member) => member.botId === BOT_ID)?.enabled).toBe(false);
  harness.store.close();
});

test("a corrupt router assignment without a task fails before runner execution", async () => {
  const harness = await createHarness({ autoKick: false, router: new RecordingRouter([
    { type: "dispatch", mode: "single", assignments: [
      { id: "review", botId: BOT_ID, task: "review", triggerMessageIds: [] },
    ] },
  ]) });
  const { group, topic } = await createGroup(harness);
  const accepted = await acceptAutomatic(harness, group.id, topic.id, "corrupt-task");
  const turn = harness.store.listMemberTurns(accepted.run.id)[0]!;
  harness.store.directWriteForTest("member_turns", turn.id, { task: null });
  await harness.dispatcher.kick();
  await harness.service.awaitRouting();
  expect(harness.runner.runs).toEqual([]);
  const failed = harness.store.getMemberTurn(turn.id)!;
  expect(failed.state).toBe("failed");
  expect(failed.failureReason).toBe("missing_assignment_task");
  expect(failed.startedAt).toBeUndefined();
  harness.store.close();
});

for (const concurrentEnable of [false, true]) {
  test(`automatic admission routes one member of 65 enabled Bots (${concurrentEnable ? "concurrent enable" : "static"})`, async () => {
    let harness!: Harness;
    let enabled = false;
    const router = new RecordingRouter([
      { type: "dispatch", mode: "single", assignments: [
        { id: "review", botId: "bot_large_64", task: "review only", triggerMessageIds: [] },
      ] }, { type: "complete", reason: "reviewed" },
    ]);
    harness = await createHarness({ router, autoKick: false,
      beforeGroupAcceptGatesAcquired: async () => {
        if (concurrentEnable && !enabled) {
          enabled = true;
          await harness.bots.updateBot("bot_large_64", { enabled: true });
        }
      },
    });
    const ids = [BOT_ID];
    for (let i = 1; i < 65; i++) {
      const id = `bot_large_${i}`;
      harness.state.bots[id] = { ...harness.bots.getBot(BOT_ID), id,
        enabled: !concurrentEnable || i !== 64 };
      ids.push(id);
    }
    const group = await harness.bots.createGroup({ title: "Large team", botIds: ids });
    const topic = await harness.service.createGroupTopic(group.id, "Review", {
      workspace: "backend", isolation: "shared-single-writer",
    });
    const accepted = await harness.service.acceptGroupPrompt({ conversationId: group.id, topicId: topic.id,
      requestId: "large-team", text: "review", target: { mode: "automatic" } });
    expect(accepted.memberTurns).toEqual([]);
    expect(accepted.run.maxMemberTurns).toBe(24);
    await harness.service.awaitRouting();
    expect(router.inputs[0]!.memberMetadata).toHaveLength(65);
    expect(router.inputs[0]!.memberMetadata.every((member) => member.enabled)).toBe(true);
    expect(harness.store.listMemberTurns(accepted.run.id).map((turn) => turn.botId)).toEqual(["bot_large_64"]);
    await harness.dispatcher.kick();
    await harness.service.awaitRouting();
    expect(harness.runner.runs).toHaveLength(1);
    expect(harness.store.getRun(accepted.run.id)?.state).toBe("completed");
    harness.store.close();
  });
}

// §13.1 — parallel batch uses one identical frozen public snapshot
// ---------------------------------------------------------------------------

test("parallel batch members receive the identical frozen public snapshot", async () => {
  const router = new RecordingRouter([
    { type: "dispatch", mode: "parallel", assignments: [
      { id: "a", botId: BOT_ID, task: "review the diff", expectedOutput: "review findings", triggerMessageIds: [] },
      { id: "b", botId: TESTER_ID, task: "run the tests", expectedOutput: "test report", triggerMessageIds: [] },
    ] },
    { type: "complete", reason: "done" },
  ]);
  const harness = await createHarness({ router, autoKick: false });
  const { group, topic } = await createGroup(harness);
  await acceptAutomatic(harness, group.id, topic.id, "req-frozen");
  const run = harness.store.getRun(harness.store.listRuns(group.id, topic.id)[0]!.id)!;
  // Same boundary for both: the request seq. Nothing from a sibling's result.
  for (const turn of harness.store.listMemberTurns(run.id)) {
    expect(turn.triggerMessageIds.length).toBeGreaterThan(0);
    expect(turn.triggerMessageIds).toContain(run.requestMessageId);
  }
  // Execute both: the public snapshot each member reads is byte-identical.
  // (The persona header differs by design — it names the member Bot; the
  // shared PUBLIC transcript below it must not.)
  const inbound = await harness.dispatcher.kick()
    .then(() => harness.runner.runs);
  expect(inbound.length).toBe(2);
  const transcriptOf = (text: string) => text.split("Public Group context:\n")[1];
  expect(transcriptOf(inbound[0]!.text)).toBeDefined();
  for (const call of inbound) {
    expect(transcriptOf(call.text)).toBe(transcriptOf(inbound[0]!.text));
  }
  // "done" is the FakeRunner result text; it must never appear in an input,
  // which would mean a sibling's completion leaked into this member's view.
  for (const call of inbound) {
    expect(call.text).not.toContain("done");
  }
  const review = inbound.find((call) => call.botId === BOT_ID)!.text;
  const tests = inbound.find((call) => call.botId === TESTER_ID)!.text;
  expect(review).toContain("Task:\nreview the diff");
  expect(review).toContain("Expected output:\nreview findings");
  expect(review).not.toContain("run the tests");
  expect(review).not.toContain("test report");
  expect(tests).toContain("Task:\nrun the tests");
  expect(tests).toContain("Expected output:\ntest report");
  expect(tests).not.toContain("review the diff");
  expect(tests).not.toContain("review findings");
  harness.store.close();
});

test("sequential dependency fence blocks the successor until its dependency terminals", async () => {
  const router = new RecordingRouter([
    { type: "dispatch", mode: "sequential", assignments: [
      { id: "a", botId: BOT_ID, task: "review", triggerMessageIds: [] },
      { id: "b", botId: TESTER_ID, task: "fix", triggerMessageIds: [], dependsOn: ["a"] },
    ] },
    { type: "complete", reason: "done" },
  ]);
  const harness = await createHarness({ router, autoKick: false });
  const { group, topic } = await createGroup(harness);
  harness.runner.result = { status: "completed", text: "SEQ RESULT FROM A" };
  await acceptAutomatic(harness, group.id, topic.id, "req-seq");
  const run = harness.store.getRun(harness.store.listRuns(group.id, topic.id)[0]!.id)!;
  const turns = harness.store.listMemberTurns(run.id);
  expect(turns.map((turn) => turn.assignmentId)).toEqual(["a", "b"]);
  // The successor is claimable only through its dependency; the store fence
  // refuses it while `a` is still non-terminal.
  expect(harness.store.claimNextDispatch({
    now: NOW, owner: "dispatcher-a", leaseExpiresAt: "2026-09-15T12:05:00.000Z", authorityEpoch: "epoch-a",
  })?.memberTurn.assignmentId).toBe("a");
  // With `a` claimed but not started, the drain must NOT admit `b`.
  const afterClaim = harness.store.claimNextDispatch({
    now: NOW, owner: "dispatcher-a", leaseExpiresAt: "2026-09-15T12:05:00.000Z", authorityEpoch: "epoch-a",
  });
  expect(afterClaim?.memberTurn.assignmentId).not.toBe("b");
  // Terminal the dependency: `b` becomes claimable.
  harness.store.completeExecution({
    runId: run.id, memberTurnId: turns[0]!.id, botId: turns[0]!.botId,
    content: "SEQ RESULT FROM A", sourceTurn: { sessionAlias: "sess_a", turnId: "sturn_a" }, now: NOW,
  });
  const successor = harness.store.claimNextDispatch({
    now: NOW, owner: "dispatcher-a", leaseExpiresAt: "2026-09-15T12:05:00.000Z", authorityEpoch: "epoch-a",
  });
  expect(successor?.memberTurn.assignmentId).toBe("b");
  // The successor's trigger boundary extends past the request, so its input
  // includes the dependency's public result — verified through the prompt the
  // dispatcher composes for it (execute() below).
  harness.store.close();
});

test("sequential assignment sees the earlier public result in its transcript", async () => {
  const router = new RecordingRouter([
    { type: "dispatch", mode: "sequential", assignments: [
      { id: "a", botId: BOT_ID, task: "review", triggerMessageIds: [] },
      { id: "b", botId: TESTER_ID, task: "fix", triggerMessageIds: [], dependsOn: ["a"] },
    ] },
    { type: "complete", reason: "done" },
  ]);
  const harness = await createHarness({ router });
  const { group, topic } = await createGroup(harness);
  harness.runner.result = { status: "completed", text: "SEQ RESULT FROM A" };
  await acceptAutomatic(harness, group.id, topic.id, "req-seq-result");
  await harness.dispatcher.kick();
  const run = harness.store.getRun(harness.store.listRuns(group.id, topic.id)[0]!.id)!;
  const turns = harness.store.listMemberTurns(run.id);
  expect(turns.map((turn) => turn.assignmentId)).toEqual(["a", "b"]);
  // Step 1 ran; step 2 became claimable only after it terminal, so its prompt
  // carries the earlier public result.
  expect(turns[1]!.state).toBe("completed");
  const secondPrompt = harness.runner.runs.find((call) => call.memberTurnId === turns[1]!.id)!.text;
  expect(secondPrompt).toContain("SEQ RESULT FROM A");
  expect(secondPrompt).toContain("Task:\nfix");
  expect(secondPrompt).not.toContain("Task:\nreview");
  harness.store.close();
});

// ---------------------------------------------------------------------------
// §13.2 — filesystem policy constrains requested parallelism
// ---------------------------------------------------------------------------

test("router-requested parallel work serializes when filesystem policy demands it", async () => {
  const router = new RecordingRouter([
    { type: "dispatch", mode: "parallel", assignments: [
      { id: "a", botId: BOT_ID, task: "review", triggerMessageIds: [] },
      { id: "b", botId: TESTER_ID, task: "test", triggerMessageIds: [] },
    ] },
    { type: "complete", reason: "done" },
  ]);
  const harness = await createHarness({ router });
  const { group, topic } = await createGroup(harness);
  await acceptAutomatic(harness, group.id, topic.id, "req-serialize");
  const run = harness.store.getRun(harness.store.listRuns(group.id, topic.id)[0]!.id)!;
  const [turnA, turnB] = harness.store.listMemberTurns(run.id);
  // No member turn may declare a proven read-only capability: automatic work
  // carries no enforceable proof, so it takes the writer slot.
  expect(turnA!.effect).toBeUndefined();
  expect(turnB!.effect).toBeUndefined();
  // The durable dispatch rows are both pending; the writer-slot gate in the
  // dispatcher (not the Router's "parallel") decides actual overlap.
  const dispatches = harness.store.listDispatchesForRun(run.id);
  expect(dispatches).toHaveLength(2);
  expect(dispatches.every((dispatch) => dispatch.state === "pending")).toBe(true);
  harness.store.close();
});

// ---------------------------------------------------------------------------
// §14.3 / acceptance 17 — cancel stops new routing
// ---------------------------------------------------------------------------

test("cancelled automatic run never dispatches again and stays sealed", async () => {
  const router = new RecordingRouter([
    { type: "dispatch", mode: "single", assignments: [{ id: "a1", botId: BOT_ID, task: "review", triggerMessageIds: [] }] },
    { type: "complete", reason: "unreachable" },
  ]);
  const harness = await createHarness({ router, autoKick: false });
  const { group, topic } = await createGroup(harness);
  const accepted = await acceptAutomatic(harness, group.id, topic.id, "req-cancel");
  const runId = accepted.run.id;
  expect(harness.store.getRun(runId)!.state).toBe("running");
  expect(harness.store.getRun(runId)!.routingState).toBe("dispatching");
  await harness.service.cancelRun(runId);
  const cancelled = harness.store.getRun(runId)!;
  expect(cancelled.state).toBe("cancelled");
  // The next decision is dropped: no new dispatch, no resurrect.
  const outcome = await new ConversationRouterEngine(bindRouter(router)!, {
    store: harness.store,
    readGroup: (conversationId) => harness.state.conversations[conversationId],
    readTopic: (conversationId, topicId) => harness.state.conversation_topics[topicId],
    readBot: (botId) => harness.state.bots[botId],
    runLifecycleAll: (botIds, critical) => harness.bots.runLifecycleAll(botIds, critical),
    now: () => new Date(NOW),
  }).route(runId);
  expect(outcome.outcome).toBe("skipped");
  expect(outcome.reason).toBe("run_cancelled");
  expect(harness.store.listMemberTurns(runId)).toHaveLength(1);
  expect(harness.store.listDispatchesForRun(runId).every((d) => d.state !== "pending")).toBe(true);
  harness.store.close();
});

test("late router decision after a sealed indeterminate run is a no-op", async () => {
  const router = new RecordingRouter([
    { type: "dispatch", mode: "single", assignments: [{ id: "a1", botId: BOT_ID, task: "review", triggerMessageIds: [] }] },
    { type: "complete", reason: "unreachable" },
  ]);
  const harness = await createHarness({ router });
  const { group, topic } = await createGroup(harness);
  await acceptAutomatic(harness, group.id, topic.id, "req-sealed");
  const run = harness.store.getRun(harness.store.listRuns(group.id, topic.id)[0]!.id)!;
  const turn = harness.store.listMemberTurns(run.id)[0]!;
  // Seal it as indeterminate the way the dispatcher does for started work
  // whose outcome is unknown (no blind retry, no new Router dispatch).
  const sealed = harness.store.failExecution({
    runId: run.id,
    memberTurnId: turn.id,
    now: NOW,
    reason: "started_result_unknown",
    terminalState: "indeterminate",
  });
  expect(sealed.state).toBe("indeterminate");
  const outcome = await new ConversationRouterEngine(bindRouter(router)!, {
    store: harness.store,
    readGroup: (conversationId) => harness.state.conversations[conversationId],
    readTopic: (conversationId, topicId) => harness.state.conversation_topics[topicId],
    readBot: (botId) => harness.state.bots[botId],
    now: () => new Date(NOW),
    runLifecycleAll: (botIds, critical) => harness.bots.runLifecycleAll(botIds, critical),
  }).route(run.id);
  expect(outcome.outcome).toBe("skipped");
  expect(router.inputs).toHaveLength(1);
  expect(harness.store.getRun(run.id)!.state).toBe("indeterminate");
  expect(harness.store.listMemberTurns(run.id)).toHaveLength(1);
  expect(harness.store.getMemberTurn(turn.id)!.state).toBe("indeterminate");
  harness.store.close();
});

// ---------------------------------------------------------------------------
// Acceptance 19 — malformed/unsafe decision fails closed before members
// ---------------------------------------------------------------------------

test("malformed router decision fails the run before any durable member turn", async () => {
  const router = new RecordingRouter([{ type: "dispatch", mode: "parallel", assignments: [{ id: "a", botId: "bot_ghost", task: "t", triggerMessageIds: [] }] }]);
  const harness = await createHarness({ router });
  const { group, topic } = await createGroup(harness);
  const accepted = await acceptAutomatic(harness, group.id, topic.id, "req-malformed");
  const run = harness.store.getRun(accepted.run.id)!;
  expect(run.state).toBe("failed");
  expect(run.completionReason).toBe("router_unknown_member");
  expect(run.finishedAt).toBeDefined();
  expect(harness.store.listMemberTurns(run.id)).toHaveLength(0);
  expect(harness.store.listDispatchesForRun(run.id)).toHaveLength(0);
  expect(harness.runner.runs).toHaveLength(0);
  // A run event reached the product projection so Web/Relay can show it.
  expect(harness.events.some((event) => event.type === "conversation-run-changed")).toBe(true);
  harness.store.close();
});

test("router assignment triggerMessageIds must reference this topic's public rows", async () => {
  const router = new RecordingRouter([
    { type: "dispatch", mode: "single", assignments: [{ id: "a", botId: BOT_ID, task: "t", triggerMessageIds: ["cmsg_from_another_topic"] }] },
  ]);
  const harness = await createHarness({ router });
  const { group, topic } = await createGroup(harness);
  // A public row that exists but belongs to ANOTHER topic.
  const otherTopic = await harness.service.createGroupTopic(group.id, "Other", {
    workspace: "backend", isolation: "shared-single-writer",
  });
  await harness.service.acceptGroupPrompt({
    conversationId: group.id, topicId: otherTopic.id, requestId: "req-other-topic-msg",
    text: "other", target: { mode: "members", botIds: [BOT_ID] },
  });
  // Accept commits (idempotency stays honest) and the routing decision fails
  // the Run durably, before any MemberTurn exists.
  const accepted = await acceptAutomatic(harness, group.id, topic.id, "req-trigger-scope");
  const run = harness.store.getRun(accepted.run.id)!;
  expect(run.state).toBe("failed");
  expect(run.completionReason).toBe("routing_message_not_found");
  expect(harness.store.listMemberTurns(run.id)).toHaveLength(0);
  expect(harness.store.listDispatchesForRun(run.id)).toHaveLength(0);
  harness.store.close();
});

test("router failure records durable run failure instead of spinning", async () => {
  const router = new RecordingRouter([new Error("router transport failed")]);
  const harness = await createHarness({ router });
  const { group, topic } = await createGroup(harness);
  const accepted = await acceptAutomatic(harness, group.id, topic.id, "req-router-throw");
  const run = harness.store.getRun(accepted.run.id)!;
  expect(run.state).toBe("failed");
  expect(run.completionReason).toBe("router-execution-failed");
  expect(harness.runner.runs).toHaveLength(0);
  harness.store.close();
});

// ---------------------------------------------------------------------------
// Acceptance 7 — assignment fields survive durably
// ---------------------------------------------------------------------------

test("router dispatch preserves assignmentId, task, expectedOutput, dependsOn, triggerMessageIds", async () => {
  const router = new RecordingRouter([
    { type: "complete", reason: "noop" },
  ]);
  const harness = await createHarness({ router });
  const { group, topic } = await createGroup(harness);
  const botA = harness.bots.getBot(BOT_ID);
  const botB = harness.bots.getBot(TESTER_ID);
  const accepted = harness.store.acceptRequest({
    conversationId: group.id, topicId: topic.id, requestId: "req-assign",
    botId: botA.id, content: "go",
    profileSnapshot: snapshotGroupMemberProfile(botA, topic.executionTarget!, NOW),
    mode: "automatic", members: [], now: NOW,
  });
  const decision: RoutingDecision = {
    type: "dispatch",
    mode: "sequential",
    assignments: [
      { id: "assign_review", botId: BOT_ID, task: "review the diff", expectedOutput: "notes", triggerMessageIds: [accepted.message.id] },
      { id: "assign_fix", botId: TESTER_ID, task: "apply fix", expectedOutput: "patch", triggerMessageIds: [accepted.message.id], dependsOn: ["assign_review"] },
    ],
  };
  const gate = gateRoutingDecision(decision, harness.engineInput(accepted.run.id));
  expect(gate.kind).toBe("decision");
  const applied = harness.store.applyRoutingDecision({
    runId: accepted.run.id,
    routingGeneration: harness.store.markRoutingState(accepted.run.id, "routing", NOW).routingGeneration!,
    now: NOW,
    decision: harness.withSnapshots(gate.decision, topic.executionTarget!),
    requestMessageId: accepted.message.id,
  });
  expect(applied.memberTurns).toHaveLength(2);
  expect(applied.dispatches).toHaveLength(2);
  const [review, fix] = applied.memberTurns;
  expect(review!.assignmentId).toBe("assign_review");
  expect(review!.task).toBe("review the diff");
  expect(review!.expectedOutput).toBe("notes");
  // (Absence of dependsOn means none: the durable JSON default is empty.)
  expect(review!.dependsOn ?? []).toEqual([]);
  expect(review!.triggerMessageIds).toEqual([accepted.message.id]);
  expect(review!.origin).toBe("router");
  expect(fix!.assignmentId).toBe("assign_fix");
  expect(fix!.task).toBe("apply fix");
  expect(fix!.dependsOn).toEqual(["assign_review"]);
  // Durable across reopen.
  harness.store.close();
  const reopened = await SqliteConversationStore.open(harness.path);
  const reopenedTurns = reopened.listMemberTurns(accepted.run.id);
  expect(reopenedTurns.map((turn) => turn.assignmentId)).toEqual(["assign_review", "assign_fix"]);
  expect(reopenedTurns[1]!.dependsOn).toEqual(["assign_review"]);
  expect(reopenedTurns[0]!.profileSnapshot!.execution.agent).toBe("codex");
  reopened.close();
});

// ---------------------------------------------------------------------------
// Direct conversations never route
// ---------------------------------------------------------------------------

test("direct conversations are untouched by routing", async () => {
  const router = new RecordingRouter([{ type: "complete", reason: "unreachable" }]);
  const harness = await createHarness({ router });
  const accepted = await harness.service.acceptDirectPrompt({
    botId: BOT_ID, requestId: "req-direct", content: "hello",
  });
  expect(accepted.run.mode).toBe("explicit");
  expect(accepted.run.routingState).toBeUndefined();
  expect(() => harness.store.markRoutingState(accepted.run.id, "routing", NOW))
    .toThrow(/not automatic/);
  expect(router.inputs).toHaveLength(0);
  harness.store.close();
});

test("automatic accept on a group with no eligible member is refused", async () => {
  const harness = await createHarness({ router: new RecordingRouter() });
  const group = await harness.bots.createGroup({ title: "Team", botIds: [BOT_ID, TESTER_ID] });
  // Disable every member: admission must refuse rather than admit a Run the
  // Router could never populate.
  harness.state.bots[BOT_ID]!.enabled = false;
  harness.state.bots[TESTER_ID]!.enabled = false;
  const topic = await harness.service.createGroupTopic(group.id, "Sprint", {
    workspace: "backend", isolation: "shared-single-writer",
  });
  await expect(acceptAutomatic(harness, group.id, topic.id, "req-empty-group"))
    .rejects.toMatchObject({ code: "empty_target" });
  expect(harness.store.listRuns(group.id, topic.id)).toHaveLength(0);
  harness.store.close();
});

// ---------------------------------------------------------------------------
// Blocked-step seam (design §16 / plan §11.7)
// ---------------------------------------------------------------------------

test("blocked-step evidence persists on the automatic member turn", async () => {
  const router = new RecordingRouter([{ type: "complete", reason: "done" }]);
  const harness = await createHarness({ router });
  const { group, topic } = await createGroup(harness);
  const botA = harness.bots.getBot(BOT_ID);
  const accepted = harness.store.acceptRequest({
    conversationId: group.id, topicId: topic.id, requestId: "req-blocked",
    botId: botA.id, content: "go",
    profileSnapshot: snapshotGroupMemberProfile(botA, topic.executionTarget!, NOW),
    mode: "automatic", members: [], now: NOW,
  });
  const gate = gateRoutingDecision({
    type: "dispatch", mode: "single",
    assignments: [{ id: "a1", botId: BOT_ID, task: "write code", triggerMessageIds: [accepted.message.id] }],
  }, harness.engineInput(accepted.run.id));
  expect(gate.kind).toBe("decision");
  harness.store.applyRoutingDecision({
    runId: accepted.run.id, now: NOW,
    routingGeneration: harness.store.markRoutingState(accepted.run.id, "routing", NOW).routingGeneration!,
    decision: harness.withSnapshots(gate.decision, topic.executionTarget!),
    requestMessageId: accepted.message.id,
  });
  const turn = harness.store.listMemberTurns(accepted.run.id)[0]!;
  // Durable blocked-step field: PR8 stores the domain seam; the UX action
  // itself is a NEW explicit human request (PR9+), never an origin upgrade.
  expect(turn.blockedReason).toBeUndefined();
  harness.runner.result = { status: "failed", error: "permission required", blockedReason: "human-authority-required" };
  await harness.dispatcher.kick();
  harness.store.close();
  const reopened = await SqliteConversationStore.open(harness.path);
  const reopenedTurn = reopened.listMemberTurns(accepted.run.id)[0]!;
  expect(reopenedTurn.blockedReason).toBe("human-authority-required");
  expect(reopenedTurn.origin).toBe("router");
  reopened.close();
});

// ---------------------------------------------------------------------------
// Explicit behavior must never regress
// ---------------------------------------------------------------------------

test("explicit multi-member run has no continuation after members terminal", async () => {
  const router = new RecordingRouter([{ type: "complete", reason: "unreachable" }]);
  const harness = await createHarness({ router });
  const { group, topic } = await createGroup(harness);
  const accepted = await harness.service.acceptGroupPrompt({
    conversationId: group.id, topicId: topic.id, requestId: "req-explicit-multi",
    text: "review", target: { mode: "members", botIds: [BOT_ID, TESTER_ID] },
    humanIngress: { chatKey: "relay:acct", senderId: "acct", isOwner: true, chatType: "group" },
  });
  await harness.dispatcher.kick();
  expect(harness.store.getRun(accepted.run.id)!.state).toBe("completed");
  expect(harness.store.getRun(accepted.run.id)!.routingState).toBeUndefined();
  expect(router.inputs).toHaveLength(0);
  expect(harness.store.listMemberTurns(accepted.run.id)).toHaveLength(2);
  harness.store.close();
});

// ---------------------------------------------------------------------------
// Control/Relay DTO projection (§17)
// ---------------------------------------------------------------------------

test("run DTO projects routing state on automatic runs only", async () => {
  const base = {
    id: "run_1",
    conversationId: "conversation_1",
    topicId: "topic_1",
    requestMessageId: "cmsg_1",
    requestId: "req",
    generation: 1,
    maxMemberTurns: 24,
    consumedMemberTurns: 0,
    failedBotIds: [],
    unavailableBotIds: [],
    profileRevision: 1,
    profileSnapshot: {
      revision: 1,
      capturedAt: NOW,
      presentation: { name: "Reviewer" },
      behavior: {},
      execution: { agent: "codex", workspace: "backend" },
    },
    createdAt: NOW,
  };
  // Explicit Runs never carry a routing state: the field is absent, so a
  // client cannot display routing UI for explicit work.
  expect(toConversationRun({ ...base, mode: "explicit", state: "running" }).routingState).toBeUndefined();
  // Automatic Runs project the durable substate verbatim.
  expect(toConversationRun({ ...base, mode: "automatic", state: "running", routingState: "dispatching" }).routingState)
    .toBe("dispatching");
  expect(toConversationRun({ ...base, mode: "automatic", state: "waiting-human", routingState: "done" }).routingState)
    .toBe("done");
});

test("member turn DTO projects blocked-step evidence", async () => {
  const base = {
    id: "mturn_1",
    runId: "run_1",
    conversationId: "conversation_1",
    topicId: "topic_1",
    botId: BOT_ID,
    batch: 1,
    memberIndex: 0,
    attempt: 1,
    origin: "router" as const,
    state: "queued" as const,
    triggerMessageIds: ["cmsg_1"],
    createdAt: NOW,
  };
  // Absent unless the step is actually blocked: a normal automatic turn must
  // not advertise "start this step myself".
  expect(toMemberTurnSummary(base).blockedReason).toBeUndefined();
  expect(toMemberTurnSummary({ ...base, blockedReason: "human-authority-required" }).blockedReason)
    .toBe("human-authority-required");
});

test("relay-protocol wire validators accept the PR8 fields and reject foreign values", async () => {
  const run = {
    type: "conversation-run-changed",
    run: {
      id: "run_1",
      conversationId: "conversation_1",
      topicId: "topic_1",
      requestMessageId: "cmsg_1",
      requestId: "req",
      mode: "automatic",
      state: "running",
      routingState: "dispatching",
      profileRevision: 1,
      createdAt: NOW,
    },
  };
  expect(validControlEvent(run)).toBe(true);
  // A foreign routing state fails the event rather than reaching the run card.
  expect(validControlEvent({
    ...run,
    run: { ...run.run, routingState: "deciding" },
  })).toBe(false);
  // Explicit Runs stay valid without the field (backwards compatible).
  expect(validControlEvent({
    ...run,
    run: { ...run.run, mode: "explicit", routingState: undefined },
  })).toBe(true);
  const memberEvent = {
    type: "member-turn-started",
    run: run.run,
    memberTurn: {
      id: "mturn_1",
      runId: "run_1",
      conversationId: "conversation_1",
      topicId: "topic_1",
      botId: BOT_ID,
      batch: 1,
      attempt: 1,
      origin: "router",
      state: "running",
      createdAt: NOW,
      blockedReason: "human-authority-required",
    },
  };
  expect(validControlEvent(memberEvent)).toBe(true);
  expect(validControlEvent({
    ...memberEvent,
    memberTurn: { ...memberEvent.memberTurn, blockedReason: "nope" },
  })).toBe(false);
});


// ---------------------------------------------------------------------------
// §14 restart determinism for automatic Runs
// ---------------------------------------------------------------------------

test("restart after routing recovers the owed decision from durable rows alone", async () => {
  const router = new RecordingRouter([
    { type: "dispatch", mode: "single", assignments: [{ id: "a1", botId: BOT_ID, task: "review", triggerMessageIds: [] }] },
    { type: "complete", reason: "done" },
  ]);
  const harness = await createHarness({ router });
  const { group, topic } = await createGroup(harness);
  const botA = harness.bots.getBot(BOT_ID);
  const accepted = harness.store.acceptRequest({
    conversationId: group.id, topicId: topic.id, requestId: "req-restart-route",
    botId: botA.id, content: "go",
    profileSnapshot: snapshotGroupMemberProfile(botA, topic.executionTarget!, NOW),
    mode: "automatic", members: [], now: NOW,
  });
  // Simulate a crash AFTER the batch settled but BEFORE the next decision:
  // drain the batch, then wipe nothing — durable rows are the only state.
  await harness.service.routeAutomaticRun(accepted.run.id, false);
  expect(harness.store.getRun(accepted.run.id)!.routingState).toBe("dispatching");
  await harness.dispatcher.kick();
  // The batch-settle hook already routed (decision 2: complete).
  await harness.service.awaitRouting();
  expect(harness.store.getRun(accepted.run.id)!.state).toBe("completed");

  // A fresh consumer over the SAME durable rows must not route again.
  harness.store.close();
  const reopened = await SqliteConversationStore.open(harness.path);
  const awaiting = reopened.automaticRunsAwaitingRouting();
  expect(awaiting).toHaveLength(0);
  reopened.close();
});

test("restart with an unsettled kept batch routes only after it terminals", async () => {
  const router = new RecordingRouter([
    { type: "dispatch", mode: "single", assignments: [{ id: "a1", botId: BOT_ID, task: "review", triggerMessageIds: [] }] },
    { type: "complete", reason: "never" },
  ]);
  const harness = await createHarness({ router });
  const { group, topic } = await createGroup(harness);
  const botA = harness.bots.getBot(BOT_ID);
  const accepted = harness.store.acceptRequest({
    conversationId: group.id, topicId: topic.id, requestId: "req-restart-held",
    botId: botA.id, content: "go",
    profileSnapshot: snapshotGroupMemberProfile(botA, topic.executionTarget!, NOW),
    mode: "automatic", members: [], now: NOW,
  });
  await harness.service.routeAutomaticRun(accepted.run.id, false);
  const held = harness.store.listMemberTurns(accepted.run.id)[0]!;
  expect(harness.store.getRun(accepted.run.id)!.state).toBe("running");
  // Never dispatch: the batch is unsettled, so recovery must NOT ask again.
  expect(harness.store.automaticRunsAwaitingRouting()).toHaveLength(0);
  void held;
  harness.store.close();
});

test("activation recovers an automatic run whose decision was never committed", async () => {
  const router = new RecordingRouter([
    { type: "dispatch", mode: "single", assignments: [{ id: "a1", botId: BOT_ID, task: "review", triggerMessageIds: [] }] },
    { type: "complete", reason: "recovered" },
  ]);
  const harness = await createHarness({ router, autoKick: false });
  const { group, topic } = await createGroup(harness);
  const botA = harness.bots.getBot(BOT_ID);
  const accepted = harness.store.acceptRequest({
    conversationId: group.id, topicId: topic.id, requestId: "req-activation-recover",
    botId: botA.id, content: "go",
    profileSnapshot: snapshotGroupMemberProfile(botA, topic.executionTarget!, NOW),
    mode: "automatic", members: [], now: NOW,
  });
  // Durable state: accepted automatic Run, no decision committed, no batch.
  expect(accepted.run.routingState).toBe("queued");
  expect(harness.store.listMemberTurns(accepted.run.id)).toHaveLength(0);
  // A fresh consumer activating over these rows must recover the FIRST
  // decision itself — no web request, no in-process memory.
  await harness.service.activateAfterConsumerLock();
  await harness.service.awaitRouting();
  const recovered = harness.store.getRun(accepted.run.id)!;
  expect(recovered.routingState).toBe("dispatching");
  expect(harness.store.listMemberTurns(accepted.run.id).map((turn) => turn.origin)).toEqual(["router"]);
  // Drain and route to completion: the recovered Run keeps its full lifecycle.
  await harness.dispatcher.kick();
  await harness.service.awaitRouting();
  expect(harness.store.getRun(accepted.run.id)!.state).toBe("completed");
  expect(harness.store.getRun(accepted.run.id)!.completionReason).toBe("recovered");
  harness.store.close();
});

test("zero-member waiting-human run cancels, releases the Topic and survives replay", async () => {
  const harness = await createHarness({ router: new RecordingRouter([{ type: "need-human", question: "Choose scope" }]), autoKick: false });
  const { group, topic } = await createGroup(harness);
  const accepted = await acceptAutomatic(harness, group.id, topic.id, "zero-cancel");
  expect(accepted.memberTurn).toBeUndefined();
  expect(accepted.dispatch).toBeUndefined();
  expect(harness.store.getRun(accepted.run.id)?.finishedAt).toBeUndefined();
  await harness.service.cancelRun(accepted.run.id);
  expect(harness.store.getRun(accepted.run.id)?.state).toBe("cancelled");
  expect(harness.store.getRun(accepted.run.id)?.finishedAt).toBe(NOW);
  const replay = harness.store.getAcceptedRequest(group.id, topic.id, "zero-cancel")!;
  expect(replay.run.id).toBe(accepted.run.id);
  expect(replay.memberTurns).toEqual([]);
  const next = await harness.service.acceptGroupPrompt({ conversationId: group.id, topicId: topic.id, requestId: "after-cancel", text: "next", target: { botId: BOT_ID } });
  await harness.dispatcher.kick();
  expect(harness.store.getRun(next.run.id)?.state).toBe("completed");
  harness.store.close();
});

test("durable automatic replay precedes current Router and live policy gates", async () => {
  const harness = await createHarness({ router: new RecordingRouter([{ type: "need-human", question: "scope?" }]), autoKick: false });
  const { group, topic } = await createGroup(harness);
  const accepted = await acceptAutomatic(harness, group.id, topic.id, "lost-response");
  const withoutRouter = new ConversationRunService(harness.store, harness.bots, harness.runtime, harness.dispatcher, harness.sessions, harness.state, harness.stateStore, {
    autoKick: false, releaseOwnedSession: createStrictOwnedSessionRelease({ sessions: harness.sessions, transport: { async deleteSession() {}, async releaseLogicalSession() {} } }),
  });
  const replay = await withoutRouter.acceptGroupPrompt({ conversationId: group.id, topicId: topic.id, requestId: "lost-response", text: "ignored", target: { mode: "automatic" } });
  expect(replay.reused).toBe(true);
  expect(replay.run.id).toBe(accepted.run.id);
  expect(replay.memberTurns).toEqual([]);
  expect(replay.memberTurn).toBeUndefined();
  harness.store.close();
});

test("activation recovery shares the pending per-run Router call and shutdown aborts it", async () => {
  const entered = deferred<void>();
  const answer = deferred<RoutingDecision>();
  let calls = 0;
  const router: ConversationRouter = { capabilityRestriction: RESTRICTED, async decide() {
    calls++;
    if (calls === 1) return { type: "dispatch", mode: "single", assignments: [{ id: "initial", botId: BOT_ID, task: "review", triggerMessageIds: [] }] };
    entered.resolve();
    return answer.promise;
  } };
  const harness = await createHarness({ router, autoKick: false });
  const { group, topic } = await createGroup(harness);
  const accepted = await acceptAutomatic(harness, group.id, topic.id, "singleflight");
  const activation = harness.service.activateAfterConsumerLock();
  await entered.promise;
  await new Promise((resolve) => setTimeout(resolve, 20));
  const replayedRoute = harness.service.routeAutomaticRun(accepted.run.id, false);
  harness.service.trackAutomaticRouting(accepted.run.id);
  expect(calls).toBe(2);
  let closed = false;
  const shutdown = harness.service.shutdown().then(() => { closed = true; });
  await Promise.resolve();
  expect(closed).toBe(false);
  await bounded(Promise.all([activation, replayedRoute, shutdown]));
  answer.resolve({ type: "complete", reason: "late" });
  const reopened = await SqliteConversationStore.open(harness.path);
  expect(reopened.getRun(accepted.run.id)).toMatchObject({ state: "running", routingState: "routing", consumedMemberTurns: 1 });
  expect(reopened.getRun(accepted.run.id)?.completionReason).toBeUndefined();
  expect(reopened.getRun(accepted.run.id)?.finishedAt).toBeUndefined();
  expect(reopened.automaticRunsAwaitingRouting().map(({ run }) => run.id)).toContain(accepted.run.id);
  expect(reopened.listRoutingDecisions(accepted.run.id)).toHaveLength(1);
  reopened.close();
});

test("durable routing ownership fences stale complete, need-human and failures", async () => {
  const harness = await createHarness({ router: new RecordingRouter(), autoKick: false });
  const { group, topic } = await createGroup(harness);
  const accepted = harness.store.acceptRequest({ conversationId: group.id, topicId: topic.id, requestId: "cas", botId: BOT_ID, content: "go", mode: "automatic", members: [], profileSnapshot: snapshotGroupMemberProfile(harness.bots.getBot(BOT_ID), topic.executionTarget!, NOW), now: NOW });
  const old = harness.store.markRoutingState(accepted.run.id, "routing", NOW).routingGeneration!;
  const current = harness.store.markRoutingState(accepted.run.id, "routing", NOW).routingGeneration!;
  expect(current).toBeGreaterThan(old);
  expect(() => harness.store.applyRoutingDecision({ runId: accepted.run.id, routingGeneration: old,
    now: NOW, requestMessageId: accepted.message.id, decision: { type: "complete", reason: "stale before next dispatch" } })).toThrow(/routing ownership changed/);
  harness.store.applyRoutingDecision({ runId: accepted.run.id, routingGeneration: current, now: NOW, requestMessageId: accepted.message.id,
    decision: harness.withSnapshots({ type: "dispatch", mode: "single", assignments: [{ id: "new", botId: BOT_ID, task: "new batch", triggerMessageIds: [accepted.message.id] }] }, topic.executionTarget!) });
  for (const decision of [{ type: "complete", reason: "stale" }, { type: "need-human", question: "stale?" }] as const) {
    expect(() => harness.store.applyRoutingDecision({ runId: accepted.run.id, routingGeneration: old, now: NOW, requestMessageId: accepted.message.id, decision })).toThrow(/routing ownership changed/);
  }
  harness.store.failRun(accepted.run.id, "stale-model-error", "failed", NOW, old);
  expect(harness.store.getRun(accepted.run.id)?.state).toBe("running");
  expect(harness.store.listMemberTurns(accepted.run.id)[0]?.batch).toBe(1);
  expect(harness.store.listDispatchesForRun(accepted.run.id)[0]?.state).toBe("pending");
  harness.store.close();
});

test("Router refuses a same-Topic foreign Run request snapshot before deciding", async () => {
  const router = new RecordingRouter();
  const harness = await createHarness({ router, autoKick: false });
  const { group, topic } = await createGroup(harness);
  const seed = (requestId: string) => harness.store.acceptRequest({ conversationId: group.id, topicId: topic.id, requestId, botId: BOT_ID, content: requestId, mode: "automatic", members: [], profileSnapshot: snapshotGroupMemberProfile(harness.bots.getBot(BOT_ID), topic.executionTarget!, NOW), now: NOW });
  const a = seed("snapshot-a");
  const b = seed("snapshot-b");
  harness.store.cancelRun(a.run.id, NOW);
  harness.store.directWriteForTest("runs", b.run.id, { request_message_id: a.message.id });
  await harness.service.routeAutomaticRun(b.run.id, false);
  expect(router.inputs).toHaveLength(0);
  expect(harness.store.getRun(b.run.id)?.completionReason).toBe("request_snapshot_mismatch");
  harness.store.close();
});

for (const change of ["remove", "disable"] as const) {
  test(`Router revalidates ${change} during the model call before durable dispatch`, async () => {
    const entered = deferred<void>();
    const answer = deferred<RoutingDecision>();
    const harness = await createHarness({ router: { capabilityRestriction: RESTRICTED, async decide() { entered.resolve(); return answer.promise; } }, autoKick: false });
    const { group, topic } = await createGroup(harness);
    const accepted = await harness.service.acceptGroupPrompt({ conversationId: group.id, topicId: topic.id, requestId: `live-${change}`, text: "go", target: { mode: "automatic" } });
    await entered.promise;
    if (change === "remove") await harness.bots.updateGroup(group.id, { botIds: [TESTER_ID, BUILDER_ID] });
    else await harness.bots.updateBot(BOT_ID, { enabled: false });
    answer.resolve({ type: "dispatch", mode: "single", assignments: [{ id: "stale-member", botId: BOT_ID, task: "review", triggerMessageIds: [] }] });
    await harness.service.awaitRouting();
    expect(harness.store.listMemberTurns(accepted.run.id)).toEqual([]);
    expect(harness.store.getRun(accepted.run.id)?.state).toBe("failed");
    expect(harness.store.getRun(accepted.run.id)?.completionReason).toBe(change === "remove" ? "router_unknown_member" : "router_disabled_member");
    harness.store.close();
  });
}


test("Router uses the nearest 200 public rows and retains the latest text on a long Topic", async () => {
  const harness = await createHarness({ router: new RecordingRouter(), autoKick: false });
  const { group, topic } = await createGroup(harness);
  for (let index = 1; index <= 500; index++) {
    const entry = await harness.service.acceptGroupPrompt({ conversationId: group.id, topicId: topic.id, requestId: `history-${index}`, text: `context-${index}:`.padEnd(3_000, "T"), target: { botId: BOT_ID } });
    harness.store.cancelRun(entry.run.id, NOW);
  }
  const accepted = await acceptAutomatic(harness, group.id, topic.id, "latest-window");
  const input = harness.router!.inputs[0]!;
  expect(input.publicTranscript).toHaveLength(200);
  expect(input.publicTranscript[0]?.seq).toBe(500);
  expect(input.publicTranscript[199]?.seq).toBe(301);
  expect(input.publicTranscript[0]?.content).toBe("context-500:".padEnd(2_000, "T"));
  expect(input.publicTranscript[15]?.seq).toBe(485);
  expect(input.publicTranscript[15]?.content.length).toBe(2_000);
  expect(input.publicTranscript[16]?.content).toBe("");
  expect(input.publicTranscript[199]?.content).toBe("");
  expect(input.publicTranscript.reduce((sum, row) => sum + row.content.length, 0)).toBe(32_000);
  expect(input.publicTranscript.every(({ contextTruncated }) => contextTruncated === true)).toBe(true);
  expect(harness.store.getMessage(input.publicTranscript[199]!.id)?.content.length).toBe(3_000);
  expect(input.publicTranscript.some((row) => row.id === accepted.message.id)).toBe(false);
  harness.store.close();
});

test("a new automatic batch resets current aggregates while retaining failed assignment history", async () => {
  const router = new RecordingRouter([
    { type: "dispatch", mode: "single", assignments: [{ id: "failed-review", botId: BOT_ID, task: "review", triggerMessageIds: [] }] },
    { type: "dispatch", mode: "single", assignments: [{ id: "retry-review", botId: TESTER_ID, task: "retry review", triggerMessageIds: [] }] },
    { type: "complete", reason: "retry succeeded" },
  ]);
  const harness = await createHarness({ autoKick: false, router });
  const { group, topic } = await createGroup(harness);
  const accepted = await acceptAutomatic(harness, group.id, topic.id, "retry-aggregate");
  // unavailableBotIds is a reserved current-batch aggregate, seeded here
  // to verify that the same durable dispatch boundary clears both lists.
  harness.store.directWriteForTest("runs", accepted.run.id, { unavailable_bot_ids_json: JSON.stringify([TESTER_ID]) });
  harness.runner.result = { status: "failed", error: "first assignment failed" };
  await harness.dispatcher.kick(); await harness.service.awaitRouting();
  expect(router.inputs[1]?.runState.failedBotIds).toEqual([BOT_ID]);
  expect(router.inputs[1]?.completedAssignments[0]).toMatchObject({ id: "failed-review", outcome: "failed", failureReason: "first assignment failed" });
  expect(harness.store.getRun(accepted.run.id)).toMatchObject({ activeBatch: 2, consumedMemberTurns: 1, failedBotIds: [], unavailableBotIds: [] });
  harness.runner.result = { status: "completed", text: "retry succeeded" };
  await harness.dispatcher.kick(); await harness.service.awaitRouting();
  expect(router.inputs[2]?.runState.failedBotIds).toEqual([]);
  expect(router.inputs[2]?.completedAssignments.map(({ id, batch, outcome }) => ({ id, batch, outcome }))).toEqual([
    { id: "failed-review", batch: 1, outcome: "failed" }, { id: "retry-review", batch: 2, outcome: "completed" },
  ]);
  expect(router.inputs[2]?.completedAssignments[1]?.result).toBe("retry succeeded");
  harness.store.close();
  const reopened = await SqliteConversationStore.open(harness.path);
  try {
    expect(toConversationRun(reopened.getRun(accepted.run.id)!)).toMatchObject({ state: "completed", activeBatch: 2,
      consumedMemberTurns: 2, failedBotIds: [], unavailableBotIds: [] });
    expect(reopened.listMemberTurns(accepted.run.id).map(({ state }) => state)).toEqual(["failed", "completed"]);
  } finally { reopened.close(); }
});

test("cancelling a queued retry does not reimport a historical failed Bot aggregate", async () => {
  const harness = await createHarness({ autoKick: false, router: new RecordingRouter([
    { type: "dispatch", mode: "single", assignments: [{ id: "failed-A", botId: BOT_ID, task: "first", triggerMessageIds: [] }] },
    { type: "dispatch", mode: "single", assignments: [{ id: "queued-B", botId: TESTER_ID, task: "second", triggerMessageIds: [] }] },
  ]) });
  const { group, topic } = await createGroup(harness);
  const accepted = await acceptAutomatic(harness, group.id, topic.id, "cancel-retry-aggregate");
  harness.runner.result = { status: "failed", error: "historical failure" };
  await harness.dispatcher.kick(); await harness.service.awaitRouting();
  expect(harness.store.getRun(accepted.run.id)).toMatchObject({ activeBatch: 2, failedBotIds: [] });
  await harness.service.cancelRun(accepted.run.id);
  try {
    expect(toConversationRun(harness.store.getRun(accepted.run.id)!)).toMatchObject({
      state: "cancelled", activeBatch: 2, routingState: "done", failedBotIds: [],
    });
    expect(harness.store.listMemberTurns(accepted.run.id).map(({ batch, state }) => ({ batch, state }))).toEqual([
      { batch: 1, state: "failed" }, { batch: 2, state: "cancelled" },
    ]);
  } finally { harness.store.close(); }
});

test("same Bot in multiple batches keeps exact results and dependency references", async () => {
  const router = new RecordingRouter([
    { type: "dispatch", mode: "single", assignments: [{ id: "A", botId: BOT_ID, task: "review 1", triggerMessageIds: [] }] },
    { type: "dispatch", mode: "single", assignments: [{ id: "B", botId: BOT_ID, task: "review 2", triggerMessageIds: [] }] },
    { type: "dispatch", mode: "sequential", assignments: [{ id: "C", botId: TESTER_ID, task: "use A", triggerMessageIds: [], dependsOn: ["A"] }] },
    { type: "complete", reason: "done" },
  ]);
  const harness = await createHarness({ router, autoKick: false });
  const { group, topic } = await createGroup(harness);
  const accepted = await acceptAutomatic(harness, group.id, topic.id, "same-bot");
  harness.runner.run = async (input) => {
    harness.runner.runs.push(input);
    return { status: "completed", text: harness.runner.runs.length === 1 ? "RESULT A" : "RESULT B" };
  };
  await harness.dispatcher.kick(); await harness.service.awaitRouting();
  await harness.dispatcher.kick(); await harness.service.awaitRouting();
  expect(router.inputs[2]?.completedAssignments.map((a) => [a.id, a.result])).toEqual([["A", "RESULT A"], ["B", "RESULT B"]]);
  const [a, b, c] = harness.store.listMemberTurns(accepted.run.id);
  expect(c!.triggerMessageIds).toContain(harness.store.getMemberResult(a!)!.id);
  expect(c!.triggerMessageIds).not.toContain(harness.store.getMemberResult(b!)!.id);
  await harness.dispatcher.kick(); await harness.service.awaitRouting();
  const prompt = harness.runner.runs.find((call) => call.memberTurnId === c!.id)!.text;
  expect(prompt).toContain("RESULT A");
  expect(prompt).not.toContain("RESULT B");
  harness.store.close();
});

test("sequential successor excludes a later queued Run's intervening request", async () => {
  const harness = await createHarness({ router: new RecordingRouter([{ type: "dispatch", mode: "sequential", assignments: [
    { id: "a", botId: BOT_ID, task: "review", triggerMessageIds: [] },
    { id: "b", botId: TESTER_ID, task: "fix", triggerMessageIds: [], dependsOn: ["a"] },
  ] }, { type: "complete", reason: "done" }]), autoKick: false });
  const { group, topic } = await createGroup(harness);
  const accepted = await acceptAutomatic(harness, group.id, topic.id, "seq-isolation");
  await harness.service.acceptGroupPrompt({ conversationId: group.id, topicId: topic.id, requestId: "later-request", text: "FOREIGN QUEUED REQUEST", target: { botId: BUILDER_ID } });
  harness.runner.result = { status: "completed", text: "DEPENDENCY RESULT" };
  await harness.dispatcher.kick(); await harness.service.awaitRouting();
  const second = harness.runner.runs.filter((call) => call.runId === accepted.run.id)[1]!;
  expect(second.text).toContain("DEPENDENCY RESULT");
  expect(second.text).not.toContain("FOREIGN QUEUED REQUEST");
  harness.store.close();
});

test("assignment ids are unique throughout the Run, in both gate and durable store", async () => {
  const harness = await createHarness({ router: new RecordingRouter([{ type: "dispatch", mode: "single", assignments: [{ id: "review", botId: BOT_ID, task: "review", triggerMessageIds: [] }] }]), autoKick: false });
  const { group, topic } = await createGroup(harness);
  const accepted = await acceptAutomatic(harness, group.id, topic.id, "unique-assignment");
  const turn = harness.store.listMemberTurns(accepted.run.id)[0]!;
  harness.store.directWriteForTest("member_turns", turn.id, { source_turn_id: "exact" });
  harness.store.completeExecution({ runId: accepted.run.id, memberTurnId: turn.id, botId: BOT_ID, content: "done", sourceTurn: { sessionAlias: "test", turnId: "exact" }, now: NOW });
  const decision: Extract<RoutingDecision, { type: "dispatch" }> = { type: "dispatch", mode: "single", assignments: [{ id: "review", botId: TESTER_ID, task: "again", triggerMessageIds: [accepted.message.id] }] };
  expect(gateRoutingDecision(decision, harness.engineInput(accepted.run.id))).toMatchObject({ kind: "rejected", code: "router_assignment_duplicate" });
  const generation = harness.store.markRoutingState(accepted.run.id, "routing", NOW).routingGeneration!;
  expect(() => harness.store.applyRoutingDecision({ runId: accepted.run.id, routingGeneration: generation, now: NOW, requestMessageId: accepted.message.id,
    decision: harness.withSnapshots(decision, topic.executionTarget!) })).toThrow(/repeats an assignment id/);
  harness.store.close();
});

for (const wholeGroup of [false, true]) {
  test(`verified ${wholeGroup ? "Group" : "Topic"} teardown removes Router audit rows`, async () => {
    const harness = await createHarness({ router: new RecordingRouter([{ type: "need-human", question: "scope?" }]), autoKick: false });
    const { group, topic } = await createGroup(harness);
    const accepted = await acceptAutomatic(harness, group.id, topic.id, "audit-delete");
    expect(harness.store.listRoutingDecisions(accepted.run.id)).toHaveLength(1);
    if (wholeGroup) await harness.service.teardownGroupConversation(group.id);
    else await harness.service.teardownGroupTopic(group.id, topic.id);
    expect(harness.store.getRun(accepted.run.id)).toBeUndefined();
    expect(harness.store.listRoutingDecisions(accepted.run.id)).toEqual([]);
    harness.store.close();
  });
}

test("strict Router parsing rejects unknown fields and unsupported synthesis", () => {
  for (const decision of [
    { type: "complete", reason: "done", assignments: [] },
    { type: "need-human", question: "scope", reason: "extra" },
    { type: "dispatch", mode: "single", assignments: [{ id: "a", botId: BOT_ID, task: "go", triggerMessageIds: [], extra: true }] },
    { type: "dispatch", mode: "single", assignments: [{ id: "a", botId: BOT_ID, task: "go" }] },
  ]) expect(() => parseRoutingDecision(decision)).toThrow(RoutingDecisionError);
  expect(() => parseRoutingDecision({ type: "complete", reason: "done", synthesisBotId: BOT_ID })).toThrow(/unsupported/);
});

test("cancel during the first Router call seals a zero-member Run against late dispatch", async () => {
  const entered = deferred<void>();
  const answer = deferred<RoutingDecision>();
  const harness = await createHarness({ router: { capabilityRestriction: RESTRICTED, async decide() {
    entered.resolve(); return answer.promise;
  } }, autoKick: false });
  const { group, topic } = await createGroup(harness);
  const accepted = await harness.service.acceptGroupPrompt({ conversationId: group.id, topicId: topic.id,
    requestId: "cancel-first-decision", text: "go", target: { mode: "automatic" } });
  await entered.promise;
  await harness.service.cancelRun(accepted.run.id);
  answer.resolve({ type: "dispatch", mode: "single", assignments: [{ id: "late", botId: BOT_ID, task: "late", triggerMessageIds: [] }] });
  await harness.service.awaitRouting();
  expect(harness.store.getRun(accepted.run.id)?.state).toBe("cancelled");
  expect(harness.store.listMemberTurns(accepted.run.id)).toEqual([]);
  expect(harness.store.listDispatchesForRun(accepted.run.id)).toEqual([]);
  harness.store.close();
});

test("parallel assignments with different supplied references receive the same effective public context", async () => {
  let calls = 0;
  let priorResultId = "";
  const harness = await createHarness({ router: { capabilityRestriction: RESTRICTED, async decide() {
    if (++calls === 1) return { type: "dispatch", mode: "single", assignments: [{ id: "prior", botId: BOT_ID, task: "review", triggerMessageIds: [] }] };
    if (calls === 2) return { type: "dispatch", mode: "parallel", assignments: [
      { id: "a", botId: BOT_ID, task: "review again", triggerMessageIds: [priorResultId] },
      { id: "b", botId: TESTER_ID, task: "test", triggerMessageIds: [] },
    ] };
    return { type: "complete", reason: "done" };
  } }, autoKick: false });
  const { group, topic } = await createGroup(harness);
  const accepted = await acceptAutomatic(harness, group.id, topic.id, "parallel-references");
  // The next Router references a prior public result for only one assignment.
  const prior = harness.store.listMemberTurns(accepted.run.id)[0]!;
  harness.store.directWriteForTest("member_turns", prior.id, { source_turn_id: "prior-result" });
  harness.store.completeExecution({ runId: accepted.run.id, memberTurnId: prior.id, botId: BOT_ID,
    content: "SHARED PRIOR RESULT", sourceTurn: { sessionAlias: "test", turnId: "prior-result" }, now: NOW });
  const result = harness.store.listMessages({ conversationId: group.id, topicId: topic.id, limit: 10 }).find((row) => row.role === "bot")!;
  priorResultId = result.id;
  await harness.service.routeAutomaticRun(accepted.run.id, false);
  const turns = harness.store.listMemberTurns(accepted.run.id).slice(1);
  expect(turns[0]!.triggerMessageIds).toEqual(turns[1]!.triggerMessageIds);
  expect(turns[1]!.triggerMessageIds).toContain(result.id);
  await harness.dispatcher.kick(); await harness.service.awaitRouting();
  for (const call of harness.runner.runs) expect(call.text).toContain("SHARED PRIOR RESULT");
  harness.store.close();
});

for (const phase of ["routing", "waiting-human"] as const) {
  test(`cancel after a completed batch in ${phase} preserves members but cancels the automatic Run`, async () => {
    let calls = 0;
    const entered = deferred<void>();
    const answer = deferred<RoutingDecision>();
    const harness = await createHarness({ router: { capabilityRestriction: RESTRICTED, async decide() {
      if (++calls === 1) return { type: "dispatch", mode: "single", assignments: [{ id: "completed", botId: BOT_ID, task: "review", triggerMessageIds: [] }] };
      entered.resolve(); return answer.promise;
    } }, autoKick: false });
    const { group, topic } = await createGroup(harness);
    const accepted = await acceptAutomatic(harness, group.id, topic.id, `cancel-settled-${phase}`);
    await harness.dispatcher.kick();
    await entered.promise;
    if (phase === "waiting-human") {
      answer.resolve({ type: "need-human", question: "scope?" });
      await harness.service.awaitRouting();
      expect(harness.store.getRun(accepted.run.id)?.finishedAt).toBeUndefined();
    }
    await harness.service.cancelRun(accepted.run.id);
    if (phase === "routing") answer.resolve({ type: "complete", reason: "late" });
    await harness.service.awaitRouting();
    expect(harness.store.getRun(accepted.run.id)?.state).toBe("cancelled");
    expect(harness.store.getRun(accepted.run.id)?.completionReason).toBe("human-cancelled");
    expect(harness.store.listMemberTurns(accepted.run.id).map((turn) => turn.state)).toEqual(["completed"]);
    harness.store.close();
  });
}

for (const [code, reason] of [["bot_not_found", "router_unknown_member"], ["bot_disabled", "router_disabled_member"]] as const) {
  for (const stale of [false, true]) {
    test(`commit-time ${code} ${stale ? "cannot fail a newer routing owner" : "fails the Run durably"}`, async () => {
      const harness = await createHarness({ autoKick: false });
      const { group, topic } = await createGroup(harness);
      const accepted = harness.store.acceptRequest({ conversationId: group.id, topicId: topic.id,
        requestId: `typed-error-${code}-${stale}`, botId: BOT_ID, content: "review", mode: "automatic", members: [],
        profileSnapshot: snapshotGroupMemberProfile(harness.bots.getBot(BOT_ID), topic.executionTarget!, NOW), now: NOW });
      let committing = false;
      const router: ConversationRouter = { capabilityRestriction: RESTRICTED, async decide() {
        committing = true;
        if (stale) harness.store.markRoutingState(accepted.run.id, "routing", NOW);
        return { type: "dispatch", mode: "single", assignments: [
          { id: "selected", botId: BOT_ID, task: "review", triggerMessageIds: [] },
        ] };
      } };
      const engine = new ConversationRouterEngine(router, {
        store: harness.store,
        readGroup: (id) => harness.state.conversations[id],
        readTopic: (_id, topicId) => harness.state.conversation_topics[topicId],
        readBot: (botId) => {
          if (committing && botId === BOT_ID) throw new BotError(code, "commit-time lifecycle rejection");
          return harness.bots.getBot(botId);
        },
        runLifecycleAll: (ids, critical) => harness.bots.runLifecycleAll(ids, critical),
        now: () => new Date(NOW),
      });
      try {
        const outcome = await engine.route(accepted.run.id);
        expect(outcome.reason).toBe(reason);
        const run = harness.store.getRun(accepted.run.id)!;
        expect(run.state).toBe(stale ? "running" : "failed");
        expect(run.routingState).toBe(stale ? "routing" : "done");
        expect(run.completionReason).toBe(stale ? undefined : reason);
        expect(run.routingGeneration).toBe(stale ? 2 : 1);
        expect(harness.store.listMemberTurns(run.id)).toEqual([]);
        expect(harness.store.listDispatchesForRun(run.id)).toEqual([]);
      } finally {
        harness.store.close();
      }
    });
  }
}
