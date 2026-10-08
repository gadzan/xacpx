import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, spyOn, test } from "bun:test";

import type { AppConfig } from "../../../src/config/types";
import { ControlService, conversationKernel } from "../../../src/control/control-service";
import { createControlEventBus, type ControlEvent } from "../../../src/control/control-event-bus";
import { SqliteConversationStore } from "../../../src/conversations/sqlite-conversation-store";
import { createSqlDriver } from "../../../src/conversations/sql-driver";
import { toConversationRun } from "../../../src/control/conversation-control-dtos";
import { validControlEvent } from "@ganglion/xacpx-relay-protocol";
import {
  createConversationRuntime,
  createProductionOwnedSessionRelease,
} from "../../../src/conversations/conversation-composition";
import { createDirectConversationId } from "../../../src/domain/ids";
import { AsyncMutex } from "../../../src/orchestration/async-mutex";
import { SessionService } from "../../../src/sessions/session-service";
import { createEmptyState, type AppState } from "../../../src/state/types";
import type { ConversationRouter, RoutingDecision } from "../../../src/conversations/conversation-router-types";
import type { Agent } from "../../../src/weixin/agent/interface";
import { ConsoleAgent } from "../../../src/console-agent";
import { CommandRouter } from "../../../src/commands/command-router";
import type { SessionTransport, ResolvedSession } from "../../../src/transport/types";
import { isRunCancelling } from "../../../src/conversations/conversation-store";
import type { ConversationDispatcherHooks, LeaseScheduler } from "../../../src/conversations/conversation-dispatcher";
import type { ConversationTurnRunner } from "../../../src/conversations/conversation-turn-runner";

const RESTRICTED = { toolsDisabled: true, filesystemDisabled: true, terminalDisabled: true, permissionInteractionDisabled: true, messagingDisabled: true, orchestrationDisabled: true, structuredOutputOnly: true };

test("actual ConsoleAgent and CommandRouter reach transport on the exact trusted Group session", async () => {
  let consoleAgent!: ConsoleAgent, current!: Awaited<ReturnType<typeof compose>>, targetId = "";
  let retiredMetadata: Parameters<ConsoleAgent["chat"]>[0]["metadata"];
  const physical: { session: ResolvedSession; text: string }[] = [];
  current = await compose(new BarrierStateStore(), { agent: { chat: async (request) => {
    retiredMetadata ??= request.metadata;
    const before = physical.length;
    // Even a clone retaining the exact live Group metadata lacks the core's
    // one-shot ChatRequest provenance, imported from the main fix.
    await consoleAgent.chat({ ...request });
    expect(physical).toHaveLength(before);
    const response = await consoleAgent.chat(request);
    const after = physical.length;
    // Metadata is still live until this Agent call returns, but the request
    // authority has already been consumed and cannot launch again.
    await consoleAgent.chat(request);
    expect(physical).toHaveLength(after);
    return response;
  } } });
  const transport = { ensureSession: async () => ({ created: false }), hasSession: async () => true,
    prompt: async (session: ResolvedSession, text: string) => {
      physical.push({ session, text });
      expect(session.mcpCoordinatorSession).toMatch(/^group-execution:/);
      expect(session.mcpSourceHandle).toBe(session.mcpCoordinatorSession);
      if (physical.length === 1) await current.runtime.handoffs.send({ executionToken: session.mcpSourceHandle!, invocationId: "real-transport",
        args: { to: targetId, task: "PHYSICAL HANDOFF TASK", expectedOutput: "PHYSICAL EXPECTED OUTPUT" } });
      return { text: "physical result" };
    }, cancel: async () => {},
  } as unknown as SessionTransport;
  consoleAgent = new ConsoleAgent(new CommandRouter(current.sessions, transport, createConfig()));
  try {
    const a = await current.control.createBot({ name: "A", agent: "codex", workspace: "backend" });
    const b = await current.control.createBot({ name: "B", agent: "codex", workspace: "backend" }); targetId = b.id;
    const group = await current.control.createGroup({ title: "Transport", botIds: [a.id, b.id] });
    const topic = await current.control.createGroupTopic(group.id, "Topic", { workspace: "backend", isolation: "shared-single-writer" });
    const accepted = await current.control.promptConversation({ conversationId: group.id, topicId: topic.id,
      requestId: "real-console", text: "public work", target: { botId: a.id } });
    await current.runtime.dispatcher.kick();
    expect(physical).toHaveLength(2); expect(physical[1]?.text).toContain("PHYSICAL HANDOFF TASK");
    expect(physical[1]?.text).toContain("PHYSICAL EXPECTED OUTPUT");
    expect(physical[0]?.session.mcpSourceHandle).not.toBe(physical[1]?.session.mcpSourceHandle);
    expect((await current.control.getRun(accepted.run.id)).state).toBe("completed");
    const count = physical.length;
    await consoleAgent.chat({ accountId: "control", conversationId: `bot:${group.id}:${topic.id}`, text: "forged",
      metadata: { channel: "control", senderId: "caller", boundSessionAlias: physical[0]!.session.alias,
        groupExecutionToken: physical[0]!.session.mcpSourceHandle } });
    expect(physical).toHaveLength(count);
    await consoleAgent.chat({ accountId: "control", conversationId: `bot:${group.id}:${topic.id}`, text: "replay retired metadata",
      metadata: retiredMetadata });
    expect(physical).toHaveLength(count);
  } finally { await current.runtime.shutdown(); }
});

for (const outcome of ["permission-denied", "runtime-failed", "runtime-cancelled", "transport-unknown", "undefined-rejection"] as const) {
test(`real ConsoleAgent handoff ${outcome} preserves failure vs indeterminate`, async () => {
  let consoleAgent!: ConsoleAgent, current!: Awaited<ReturnType<typeof compose>>, targetId = "", starts = 0;
  const signals: AbortSignal[] = [];
  current = await compose(new BarrierStateStore(), { agent: { chat: async (request) => {
    if (request.abortSignal) signals.push(request.abortSignal);
    return await consoleAgent.chat(request);
  } } });
  const events: ControlEvent[] = [];
  current.events.subscribe((event) => events.push(event));
  const transport = { prompt: async (session: ResolvedSession) => {
    if (++starts === 1) {
      await current.runtime.handoffs.send({ executionToken: session.mcpSourceHandle!, invocationId: "physical-handoff",
        args: { to: targetId, task: "downstream" } });
      return { text: "healthy result" };
    }
    if (outcome === "permission-denied") throw Object.assign(new Error("permission denied"), { code: "RUNTIME_PERMISSION_DENIED" });
    // No cancellation/permission text or local abort may supply the evidence.
    if (outcome === "runtime-failed" || outcome === "runtime-cancelled") {
      throw Object.assign(new Error("provider terminal evidence"), {
        code: outcome === "runtime-failed" ? "RUNTIME_TURN_FAILED" : "RUNTIME_TURN_CANCELLED",
      });
    }
    if (outcome === "undefined-rejection") throw undefined;
    throw new Error("connection lost after possible filesystem write");
  }, cancel: async () => {} } as unknown as SessionTransport;
  consoleAgent = new ConsoleAgent(new CommandRouter(current.sessions, transport, createConfig()));
  try {
    const a = await current.control.createBot({ name: "A", agent: "codex", workspace: "backend" });
    const b = await current.control.createBot({ name: "B", agent: "codex", workspace: "backend" }); targetId = b.id;
    const group = await current.control.createGroup({ title: "Physical", botIds: [a.id, b.id] });
    const topic = await current.control.createGroupTopic(group.id, "Topic", { workspace: "backend", isolation: "shared-single-writer" });
    const accepted = await current.control.promptConversation({ conversationId: group.id, topicId: topic.id,
      requestId: "physical-outcome", text: "work", target: { botId: a.id } });
    await current.runtime.dispatcher.kick(); await current.runtime.dispatcher.kick();
    const detail = await current.control.getRun(accepted.run.id);
    const expectedState = outcome === "runtime-cancelled" ? "cancelled"
      : outcome === "permission-denied" || outcome === "runtime-failed" ? "failed" : "indeterminate";
    expect(starts).toBe(2);
    expect(detail.state).toBe(expectedState);
    expect(detail.memberTurns[0]?.state).toBe("completed");
    expect(detail.memberTurns[1]?.state).toBe(expectedState);
    if (outcome === "runtime-cancelled") expect(detail.completionReason).toBe("execution-cancelled");
    if (outcome === "permission-denied") expect(detail.memberTurns[1]?.blockedReason).toBe("human-authority-unknown");
    else if (expectedState === "indeterminate") expect(detail.completionReason).toBe("started_result_unknown");
    if (outcome === "runtime-failed" || outcome === "runtime-cancelled") {
      expect(signals).toHaveLength(2);
      expect(signals.every((signal) => !signal.aborted)).toBe(true);
      expect(detail.quarantinedBotIds ?? []).toEqual(outcome === "runtime-failed" ? [targetId] : []);
      expect(detail.memberTurns[1]?.blockedReason).toBeUndefined();
      const finished = events.find((event) => event.type === "turn-finished" && event.conversation?.botId === targetId);
      expect(finished).toMatchObject({ type: "turn-finished", ok: false, errorMessage: "provider terminal evidence" });
      expect(finished && "cancelled" in finished ? finished.cancelled : undefined)
        .toBe(outcome === "runtime-cancelled" ? true : undefined);
      expect(current.runtime.store.getDispatchForMemberTurn(detail.memberTurns[1]!.id)?.state).toBe("completed");
      const reopened = await SqliteConversationStore.open(current.sqlitePath);
      try {
        expect(reopened.getRun(accepted.run.id)?.state).toBe(expectedState);
        expect(reopened.getMemberTurn(detail.memberTurns[1]!.id)?.state).toBe(expectedState);
      } finally { reopened.close(); }
    }
    expect(current.runtime.store.getMemberResult(current.runtime.store.listMemberTurns(accepted.run.id)[0]!)?.content).toBe("healthy result");
  } finally { await current.runtime.shutdown(); }
});
}

for (const mode of ["automatic", "explicit"] as const) {
for (const humanStop of [false, true]) {
test(`real ${mode} budget rejection then typed cancellation preserves ${humanStop ? "live human Stop" : "budget failure"}`, async () => {
  const budgetRejected = shutdownBarrier(), releaseProvider = shutdownBarrier(), cancelEntered = shutdownBarrier();
  let consoleAgent!: ConsoleAgent, senderId = "", targetId = "", runId = "", routerCalls = 0, starts = 0;
  let signal: AbortSignal | undefined;
  const current = await compose(new BarrierStateStore(), {
    agent: { chat: (request) => { signal = request.abortSignal; return consoleAgent.chat(request); } },
    router: { capabilityRestriction: RESTRICTED, async decide() {
      if (++routerCalls > 1) return { type: "complete", reason: "unexpected continuation" };
      return { type: "dispatch", mode: "single", assignments: [
        { id: "budget-sender", botId: senderId, task: "exhaust handoff budget", triggerMessageIds: [] },
      ] };
    } },
  });
  const transport = { prompt: async (session: ResolvedSession) => {
    ++starts;
    expect(starts).toBe(1);
    expect(session.mcpSourceHandle).toMatch(/^group-execution:/);
    try {
      const limit = current.runtime.store.getRun(runId)!.maxMemberTurns;
      expect(limit).toBe(24);
      // Fill the real production budget with accepted public handoffs. No SQL
      // budget override or model-supplied capability is needed for this case.
      for (let index = 1; index < limit; index++) {
        await current.runtime.handoffs.send({ executionToken: session.mcpSourceHandle!, invocationId: `budget-${index}`,
          args: { to: targetId, task: `accepted downstream work ${index}` } });
      }
      await expect(current.runtime.handoffs.send({ executionToken: session.mcpSourceHandle!, invocationId: "budget-rejected",
        args: { to: targetId, task: "must exceed durable work budget" } })).rejects.toMatchObject({ code: "budget-exhausted" });
    } finally { budgetRejected.resolve(); }
    await releaseProvider.promise;
    throw Object.assign(new Error("provider terminal evidence"), { code: "RUNTIME_TURN_CANCELLED" });
  }, cancel: async () => {
    if (!humanStop) throw new Error("no human Stop was requested");
    cancelEntered.resolve();
  } } as unknown as SessionTransport;
  consoleAgent = new ConsoleAgent(new CommandRouter(current.sessions, transport, createConfig()));
  let drain: Promise<void> | undefined, cancellation: Promise<unknown> | undefined;
  try {
    senderId = (await current.control.createBot({ name: "Sender", agent: "codex", workspace: "backend" })).id;
    targetId = (await current.control.createBot({ name: "Target", agent: "codex", workspace: "backend" })).id;
    const group = await current.control.createGroup({ title: "Budget cancellation priority", botIds: [senderId, targetId] });
    const topic = await current.control.createGroupTopic(group.id, "Topic", { workspace: "backend", isolation: "shared-single-writer" });
    const accepted = await current.control.promptConversation({ conversationId: group.id, topicId: topic.id,
      requestId: "budget-runtime-cancellation", text: "work", target: mode === "automatic" ? { mode: "automatic" } : { botId: senderId } });
    runId = accepted.run.id;
    await current.runtime.runs.awaitRouting();
    drain = current.runtime.dispatcher.kick();
    await budgetRejected.promise;
    expect(current.runtime.store.listMemberTurns(runId)).toHaveLength(24);
    const sql = await createSqlDriver(current.sqlitePath);
    try { expect(sql.get("SELECT budget_exhausted, cancellation_reason FROM runs WHERE id = ?", [runId]))
      .toMatchObject({ budget_exhausted: 1, cancellation_reason: null }); }
    finally { sql.close(); }
    if (humanStop) { cancellation = current.control.cancelRun(runId); await cancelEntered.promise; }
    expect(signal?.aborted).toBe(humanStop);
    releaseProvider.resolve();
    await Promise.all([drain, cancellation]);
    await current.runtime.runs.awaitRouting();
    const expected = { state: humanStop ? "cancelled" : "failed",
      completionReason: humanStop ? "human-cancelled" : "budget-exhausted", consumedMemberTurns: 1 };
    const detail = await current.control.getRun(runId);
    expect(detail).toMatchObject(expected);
    expect(detail.memberTurns).toHaveLength(24);
    expect(detail.memberTurns.every((turn) => turn.state === "cancelled")).toBe(true);
    expect(detail.memberTurns.filter((turn) => turn.startedAt)).toHaveLength(1);
    expect(detail.quarantinedBotIds ?? []).toEqual([]);
    for (const turn of detail.memberTurns) expect(current.runtime.store.getDispatchForMemberTurn(turn.id)?.state).toBe("completed");
    expect(starts).toBe(1);
    expect(routerCalls).toBe(mode === "automatic" ? 1 : 0);
    await current.runtime.shutdown();
    const reopened = await SqliteConversationStore.open(current.sqlitePath);
    try {
      expect(reopened.getRun(runId)).toMatchObject(expected);
      expect(reopened.automaticRunsAwaitingRouting()).toEqual([]);
      expect(reopened.recoverExpiredClaims("2026-10-07T00:00:00.000Z")).toEqual([]);
      expect(reopened.listMemberTurns(runId)).toHaveLength(24);
    } finally { reopened.close(); }
  } finally {
    releaseProvider.resolve();
    await Promise.allSettled([drain, cancellation]);
    await current.runtime.shutdown();
  }
});
}
}

for (const cancelledFirst of [true, false]) {
test(`real automatic typed cancellation is durable with ${cancelledFirst ? "cancelled then completed" : "completed then cancelled"} settlement`, async () => {
  const entered = [shutdownBarrier(), shutdownBarrier()];
  const release = [shutdownBarrier(), shutdownBarrier()];
  const settled = [shutdownBarrier(), shutdownBarrier()];
  const signals: AbortSignal[] = [];
  let consoleAgent!: ConsoleAgent, cancelledBot = "", completedBot = "", routerCalls = 0, providerCalls = 0;
  const current = await compose(new BarrierStateStore(), {
    agent: { chat: async (request) => {
      if (request.abortSignal) signals.push(request.abortSignal);
      return await consoleAgent.chat(request);
    } },
    router: { capabilityRestriction: RESTRICTED, async decide() {
      if (++routerCalls > 1) return { type: "complete", reason: "unexpected continuation" };
      return { type: "dispatch", mode: "parallel", assignments: [
        { id: "cancelled-assignment", botId: cancelledBot, task: "CANCELLED ASSIGNMENT", triggerMessageIds: [] },
        { id: "completed-assignment", botId: completedBot, task: "COMPLETED ASSIGNMENT", triggerMessageIds: [] },
      ] };
    } },
  });
  const transport = { prompt: async (session: ResolvedSession, text: string) => {
    ++providerCalls;
    expect(session.mcpSourceHandle).toMatch(/^group-execution:/);
    const index = text.includes("CANCELLED ASSIGNMENT") ? 0 : 1;
    entered[index]!.resolve();
    await release[index]!.promise;
    if (index === 0) throw Object.assign(new Error("provider terminal evidence"), { code: "RUNTIME_TURN_CANCELLED" });
    return { text: "healthy sibling result" };
  }, cancel: async () => { throw new Error("no local Stop was requested"); } } as unknown as SessionTransport;
  consoleAgent = new ConsoleAgent(new CommandRouter(current.sessions, transport, createConfig()));
  const unsubscribe = current.events.subscribe((event) => {
    if (event.type === "member-turn-finished") {
      const botId = event.memberTurn.botId;
      settled[botId === cancelledBot ? 0 : 1]!.resolve();
    }
  });
  let drain: Promise<void> | undefined;
  try {
    cancelledBot = (await current.control.createBot({ name: "A", agent: "codex", workspace: "backend" })).id;
    completedBot = (await current.control.createBot({ name: "B", agent: "codex", workspace: "backend" })).id;
    const group = await current.control.createGroup({ title: "Cancellation order", botIds: [cancelledBot, completedBot] });
    const topic = await current.control.createGroupTopic(group.id, "Topic", { workspace: "backend", isolation: "shared-single-writer" });
    const accepted = await current.control.promptConversation({ conversationId: group.id, topicId: topic.id,
      requestId: "typed-cancel-order", text: "work", target: { mode: "automatic" } });
    await current.runtime.runs.awaitRouting();
    // The host supplies the existing enforced read-only capability seam so
    // both real provider calls are admitted before either settles. Router
    // model fields never confer this proof in production.
    const sql = await createSqlDriver(current.sqlitePath);
    try { sql.run("UPDATE member_turns SET effect = 'read-only', effect_provenance = 'declared-enforced' WHERE run_id = ?", [accepted.run.id]); }
    finally { sql.close(); }
    drain = current.runtime.dispatcher.kick();
    await Promise.all(entered.map((entry) => entry.promise));
    const first = cancelledFirst ? 0 : 1;
    release[first]!.resolve();
    await settled[first]!.promise;
    const interim = current.runtime.store.getRun(accepted.run.id)!;
    expect(interim.state).toBe("running");
    expect(isRunCancelling(interim)).toBe(cancelledFirst);
    if (cancelledFirst) {
      expect(interim.completionReason).toBe("execution-cancelled");
      const reopened = await SqliteConversationStore.open(current.sqlitePath);
      try {
        expect(isRunCancelling(reopened.getRun(accepted.run.id)!)).toBe(true);
        expect(reopened.automaticRunsAwaitingRouting()).toEqual([]);
        expect(() => reopened.markRoutingState(accepted.run.id, "routing", new Date().toISOString()))
          .toThrow();
      } finally { reopened.close(); }
    }
    release[1 - first]!.resolve();
    await drain;
    await current.runtime.runs.awaitRouting();
    const detail = await current.control.getRun(accepted.run.id);
    expect(detail).toMatchObject({ state: "cancelled", completionReason: "execution-cancelled", consumedMemberTurns: 2 });
    expect(detail.memberTurns.map((turn) => turn.state)).toEqual(["cancelled", "completed"]);
    expect(detail.quarantinedBotIds ?? []).toEqual([]);
    expect(providerCalls).toBe(2);
    expect(routerCalls).toBe(1);
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => !signal.aborted)).toBe(true);
    for (const turn of detail.memberTurns) expect(current.runtime.store.getDispatchForMemberTurn(turn.id)?.state).toBe("completed");
    expect(current.runtime.store.getMemberResult(current.runtime.store.listMemberTurns(accepted.run.id)[1]!)?.content)
      .toBe("healthy sibling result");
    await current.runtime.shutdown();
    const reopened = await SqliteConversationStore.open(current.sqlitePath);
    try {
      expect(reopened.getRun(accepted.run.id)).toMatchObject({ state: "cancelled", completionReason: "execution-cancelled", consumedMemberTurns: 2 });
      expect(reopened.automaticRunsAwaitingRouting()).toEqual([]);
      expect(reopened.listRoutingDecisions(accepted.run.id)).toHaveLength(1);
    } finally { reopened.close(); }
  } finally {
    release.forEach((entry) => entry.resolve());
    await drain;
    unsubscribe();
    await current.runtime.shutdown();
  }
});
}

test("real automatic typed cancellation cancels unstarted writer siblings without another provider or Router call", async () => {
  let consoleAgent!: ConsoleAgent, cancelledBot = "", pendingBot = "", routerCalls = 0, providerCalls = 0;
  const current = await compose(new BarrierStateStore(), {
    agent: { chat: (request) => consoleAgent.chat(request) },
    router: { capabilityRestriction: RESTRICTED, async decide() {
      if (++routerCalls > 1) return { type: "complete", reason: "unexpected continuation" };
      return { type: "dispatch", mode: "parallel", assignments: [
        { id: "cancel-first", botId: cancelledBot, task: "cancel first", triggerMessageIds: [] },
        { id: "pending-writer", botId: pendingBot, task: "must not start", triggerMessageIds: [] },
      ] };
    } },
  });
  const finishedMembers: string[] = [];
  const unsubscribe = current.events.subscribe((event) => {
    if (event.type === "member-turn-finished" && event.memberTurn.state === "cancelled") finishedMembers.push(event.memberTurn.botId);
  });
  const transport = { prompt: async () => {
    if (++providerCalls === 1) throw Object.assign(new Error("provider terminal evidence"), { code: "RUNTIME_TURN_CANCELLED" });
    return { text: "unexpected writer result" };
  }, cancel: async () => { throw new Error("no local Stop was requested"); } } as unknown as SessionTransport;
  consoleAgent = new ConsoleAgent(new CommandRouter(current.sessions, transport, createConfig()));
  try {
    cancelledBot = (await current.control.createBot({ name: "A", agent: "codex", workspace: "backend" })).id;
    pendingBot = (await current.control.createBot({ name: "B", agent: "codex", workspace: "backend" })).id;
    const group = await current.control.createGroup({ title: "Writer cancellation", botIds: [cancelledBot, pendingBot] });
    const topic = await current.control.createGroupTopic(group.id, "Topic", { workspace: "backend", isolation: "shared-single-writer" });
    const accepted = await current.control.promptConversation({ conversationId: group.id, topicId: topic.id,
      requestId: "typed-cancel-writers", text: "work", target: { mode: "automatic" } });
    await current.runtime.runs.awaitRouting();
    await current.runtime.dispatcher.kick();
    await current.runtime.runs.awaitRouting();
    const detail = await current.control.getRun(accepted.run.id);
    expect(detail).toMatchObject({ state: "cancelled", completionReason: "execution-cancelled", consumedMemberTurns: 1 });
    expect(detail.memberTurns.map((turn) => turn.state)).toEqual(["cancelled", "cancelled"]);
    expect(detail.memberTurns[1]?.startedAt).toBeUndefined();
    expect(providerCalls).toBe(1);
    expect(routerCalls).toBe(1);
    expect(finishedMembers).toEqual([cancelledBot, pendingBot]);
    for (const turn of detail.memberTurns) expect(current.runtime.store.getDispatchForMemberTurn(turn.id)?.state).toBe("completed");
  } finally { unsubscribe(); await current.runtime.shutdown(); }
});

for (const mode of ["automatic", "explicit"] as const) {
test(`real ${mode} execution cancellation settles a durable-started sibling before runner admission`, async () => {
  const providerEntered = shutdownBarrier(), releaseProvider = shutdownBarrier();
  const siblingStarted = shutdownBarrier(), releaseSibling = shutdownBarrier(), cancellationCommitted = shutdownBarrier();
  let consoleAgent!: ConsoleAgent, cancelledBot = "", siblingBot = "", siblingSource = "", routerCalls = 0;
  const providerBots: string[] = [];
  const current = await compose(new BarrierStateStore(), {
    agent: { chat: (request) => consoleAgent.chat(request) },
    router: { capabilityRestriction: RESTRICTED, async decide() {
      if (++routerCalls > 1) return { type: "complete", reason: "unexpected continuation" };
      return { type: "dispatch", mode: "parallel", assignments: [
        { id: "provider-cancellation", botId: cancelledBot, task: "provider cancellation", triggerMessageIds: [] },
        { id: "pre-provider-sibling", botId: siblingBot, task: "must never reach runner", triggerMessageIds: [] },
      ] };
    } },
  });
  // Use the dispatcher's existing fault hook to hold this precise async
  // boundary in the production composition, without a new production API.
  const dispatcher = current.runtime.dispatcher as unknown as { hooks: ConversationDispatcherHooks; runner: ConversationTurnRunner };
  const runnerCalls = spyOn(dispatcher.runner, "run");
  dispatcher.hooks = { afterExecutionStart: async (turn) => {
    if (turn.botId !== siblingBot) return;
    siblingSource = turn.sourceTurnId!;
    siblingStarted.resolve();
    await releaseSibling.promise;
  } };
  const unsubscribe = current.events.subscribe((event) => {
    if (event.type === "member-turn-finished" && event.memberTurn.botId === cancelledBot) cancellationCommitted.resolve();
  });
  const transport = { prompt: async (session: ResolvedSession) => {
    const botId = current.sessions.getLogicalSessionRecord(session.alias)!.owner!.botId!;
    providerBots.push(botId);
    if (botId !== cancelledBot) return { text: "unexpected sibling provider result" };
    expect(session.mcpSourceHandle).toMatch(/^group-execution:/);
    providerEntered.resolve();
    await releaseProvider.promise;
    throw Object.assign(new Error("provider terminal evidence"), { code: "RUNTIME_TURN_CANCELLED" });
  }, cancel: async () => { throw new Error("no human Stop was requested"); } } as unknown as SessionTransport;
  consoleAgent = new ConsoleAgent(new CommandRouter(current.sessions, transport, createConfig()));
  let drain: Promise<void> | undefined;
  try {
    cancelledBot = (await current.control.createBot({ name: "A", agent: "codex", workspace: "backend" })).id;
    siblingBot = (await current.control.createBot({ name: "B", agent: "codex", workspace: "backend" })).id;
    const group = await current.control.createGroup({ title: "Provider admission gap", botIds: [cancelledBot, siblingBot] });
    const topic = await current.control.createGroupTopic(group.id, "Topic", { workspace: "backend", isolation: "shared-single-writer" });
    const accepted = await current.control.promptConversation({ conversationId: group.id, topicId: topic.id,
      requestId: "pre-provider-cancellation", text: "work", target: mode === "automatic" ? { mode: "automatic" } : { mode: "everyone" } });
    await current.runtime.runs.awaitRouting();
    // Host-controlled, side-effect-free test providers use the existing
    // enforced-read-only seam to admit concurrent siblings. Models cannot
    // grant this capability through assignment fields.
    const sql = await createSqlDriver(current.sqlitePath);
    try { sql.run("UPDATE member_turns SET effect = 'read-only', effect_provenance = 'declared-enforced' WHERE run_id = ?", [accepted.run.id]); }
    finally { sql.close(); }
    drain = current.runtime.dispatcher.kick();
    await Promise.all([providerEntered.promise, siblingStarted.promise]);
    const sibling = current.runtime.store.listMemberTurns(accepted.run.id).find((turn) => turn.botId === siblingBot)!;
    expect(sibling).toMatchObject({ state: "running", sourceTurnId: siblingSource });
    expect(sibling.startedAt).toBeDefined();
    expect(current.runtime.store.getDispatchForMemberTurn(sibling.id)?.state).toBe("claimed");
    expect(conversationKernel(current.control).inspectPromptRequest(`bot:${group.id}:${topic.id}`, sibling.sessionAlias!, siblingSource)).toBe("absent");
    releaseProvider.resolve();
    await cancellationCommitted.promise;
    expect(current.runtime.store.getRun(accepted.run.id)).toMatchObject({ state: "running", completionReason: "execution-cancelled" });
    expect(current.runtime.store.getMemberTurn(sibling.id)?.state).toBe("running");
    releaseSibling.resolve();
    await drain;
    await current.runtime.runs.awaitRouting();
    const detail = await current.control.getRun(accepted.run.id);
    expect(detail).toMatchObject({ state: "cancelled", completionReason: "execution-cancelled", consumedMemberTurns: 2 });
    expect(detail.memberTurns.map((turn) => turn.state)).toEqual(["cancelled", "cancelled"]);
    expect(providerBots).toEqual([cancelledBot]);
    expect(runnerCalls.mock.calls.map(([input]) => input.botId)).toEqual([cancelledBot]);
    expect(conversationKernel(current.control).inspectPromptRequest(`bot:${group.id}:${topic.id}`, sibling.sessionAlias!, siblingSource)).toBe("absent");
    expect(routerCalls).toBe(mode === "automatic" ? 1 : 0);
    expect(detail.quarantinedBotIds ?? []).toEqual([]);
    for (const turn of detail.memberTurns) expect(current.runtime.store.getDispatchForMemberTurn(turn.id)?.state).toBe("completed");
    await current.runtime.shutdown();
    const reopened = await SqliteConversationStore.open(current.sqlitePath);
    try {
      expect(reopened.getRun(accepted.run.id)).toMatchObject({ state: "cancelled", completionReason: "execution-cancelled", consumedMemberTurns: 2 });
      for (const turn of reopened.listMemberTurns(accepted.run.id)) {
        expect(turn.state).toBe("cancelled");
        expect(reopened.getDispatchForMemberTurn(turn.id)?.state).toBe("completed");
      }
      expect(reopened.recoverExpiredClaims("2026-10-07T00:00:00.000Z")).toEqual([]);
      expect(reopened.convergePreviousOwnerClaims("replacement-owner", "2026-10-07T00:00:00.000Z")).toEqual([]);
      expect(reopened.automaticRunsAwaitingRouting()).toEqual([]);
      expect(reopened.getRun(accepted.run.id)?.completionReason).toBe("execution-cancelled");
    } finally { reopened.close(); }
  } finally {
    releaseProvider.resolve(); releaseSibling.resolve();
    await drain;
    runnerCalls.mockRestore();
    unsubscribe();
    await current.runtime.shutdown();
  }
});
}

test("production public handoff carries private launch capability through Control and permission denial stays non-human", async () => {
  let current!: Awaited<ReturnType<typeof compose>>;
  let targetId = "";
  const metadata: unknown[] = [];
  current = await compose(new BarrierStateStore(), { agent: { async chat(request) {
    metadata.push(request.metadata);
    if (metadata.length === 1) {
      expect(request.metadata?.groupExecutionToken).toMatch(/^group-execution:/);
      await current.runtime.handoffs.send({ executionToken: request.metadata!.groupExecutionToken!, invocationId: "trusted-tool-call",
        args: { to: targetId, task: "PUBLIC TARGET TASK", expectedOutput: "PUBLIC TARGET OUTPUT" } });
      return { text: "healthy sender evidence" };
    }
    expect(request.text).toContain("PUBLIC TARGET TASK");
    expect(request.text).toContain("PUBLIC TARGET OUTPUT");
    expect(request.metadata?.origin).toBe("orchestration");
    throw Object.assign(new Error("permission denied"), { code: "RUNTIME_PERMISSION_DENIED" });
  } } });
  const events: ControlEvent[] = []; current.events.subscribe((event) => events.push(event));
  try {
    const sender = await current.control.createBot({ name: "Sender", agent: "codex", workspace: "backend" });
    const target = await current.control.createBot({ name: "Target", agent: "codex", workspace: "backend" }); targetId = target.id;
    const group = await current.control.createGroup({ title: "Public Group", botIds: [sender.id, target.id] });
    const topic = await current.control.createGroupTopic(group.id, "Topic", { workspace: "backend", isolation: "shared-single-writer" });
    const accepted = await current.control.promptConversation({ conversationId: group.id, topicId: topic.id,
      requestId: "production-handoff", text: "work", target: { botId: sender.id } });
    await current.runtime.dispatcher.kick();
    expect(metadata).toHaveLength(2);
    const detail = await current.control.getRun(accepted.run.id);
    expect(detail.memberTurns[1]).toMatchObject({ origin: "handoff", task: "PUBLIC TARGET TASK", blockedReason: "human-authority-unknown", state: "failed" });
    expect(detail.quarantinedBotIds).toEqual([target.id]);
    expect(events.filter((e) => e.type === "conversation-message" && e.message.handoff)).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain("group-execution:");
  } finally { await current.runtime.shutdown(); }
});

class BarrierStateStore {
  public saved: AppState[] = [];
  private waiting: Promise<void> | undefined;
  private resumeGate: (() => void) | undefined;
  private signalEntered: (() => void) | undefined;
  entered = Promise.resolve();

  arm(): void {
    this.entered = new Promise<void>((resolve) => {
      this.signalEntered = resolve;
    });
    this.waiting = new Promise<void>((resolve) => {
      this.resumeGate = resolve;
    });
  }

  resume(): void {
    this.resumeGate?.();
    this.waiting = undefined;
    this.resumeGate = undefined;
  }

  async save(state: AppState): Promise<void> {
    await this.saveNow(state);
  }

  async saveNow(state: AppState): Promise<void> {
    this.saved.push(structuredClone(state));
    if (this.waiting) {
      this.signalEntered?.();
      await this.waiting;
    }
  }
}

function createConfig(): AppConfig {
  return {
    transport: { type: "acpx-cli", command: "acpx", permissionMode: "approve-all", nonInteractivePermissions: "deny" },
    logging: { level: "info", maxSizeBytes: 1024, maxFiles: 2, retentionDays: 1, perf: { enabled: false } },
    channel: { type: "weixin", replyMode: "stream" },
    channels: [{ id: "weixin", type: "weixin", enabled: true }],
    plugins: [],
    agents: { codex: { driver: "codex" } },
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

async function compose(stateStore: BarrierStateStore, options: {
  router?: ConversationRouter; agent?: Agent; state?: AppState; sqlitePath?: string;
  autoKick?: boolean; now?: () => Date; leaseMs?: number; leaseScheduler?: LeaseScheduler;
  beforeLeaseRenewal?: () => void;
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "xacpx-compose-"));
  const state = options.state ?? createEmptyState();
  const sqlitePath = options.sqlitePath ?? join(dir, "conversations.sqlite");
  const config = createConfig();
  const stateMutex = new AsyncMutex();
  const sessions = new SessionService(config, stateStore, state, { stateMutex });
  const events = createControlEventBus();
  const control = new ControlService({
    agent: options.agent ?? { chat: async () => ({ text: "ok" }) },
    sessions,
    activeTurns: { isActiveAnywhere: () => false },
    scheduled: {} as never,
    orchestration: {} as never,
    events,
    workspaces: {
      list: () => [{ name: "backend", cwd: "/tmp/backend" }],
      create: async () => ({ name: "backend", cwd: "/tmp/backend" }),
      remove: async () => {},
    },
    uploadStore: { save: async () => ({ id: "u", path: "/tmp/u", filename: "f", mimeType: "text/plain", size: 1 }) },
  } as never);
  const kernel = conversationKernel(control);
  const runtime = await createConversationRuntime({
    config,
    state,
    stateStore,
    sessions,
    control: kernel,
    sqlitePath,
    releaseOwnedSession: createProductionOwnedSessionRelease({
      sessions,
      transport: { async deleteSession() {}, async releaseLogicalSession() {} },
    }),
    onProductEvent: (event) => kernel.emitConversationProduct(event),
    autoKick: options.autoKick ?? false,
    ...(options.router ? { router: options.router } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.leaseMs !== undefined ? { leaseMs: options.leaseMs } : {}),
    ...(options.leaseScheduler ? { leaseScheduler: options.leaseScheduler } : {}),
    ...(options.beforeLeaseRenewal ? { beforeLeaseRenewal: options.beforeLeaseRenewal } : {}),
    stateMutex,
  });
  kernel.bindConversationRuntime(runtime);
  return { state, sessions, control, runtime, stateMutex, events, sqlitePath };
}

test("real Control automatic prompt returns zero members and same requestId replays the Run", async () => {
  let decide!: () => void;
  const router: ConversationRouter = { capabilityRestriction: RESTRICTED, async decide() {
    await new Promise<void>((resolve) => { decide = resolve; });
    return { type: "need-human", question: "Choose scope" };
  } };
  const { control, runtime, events, sqlitePath } = await compose(new BarrierStateStore(), { router });
  const observed: ControlEvent[] = [];
  const unsubscribe = events.subscribe((event) => { observed.push(event); });
  const bot = await control.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  const helper = await control.createBot({ name: "Helper", agent: "codex", workspace: "backend" });
  const group = await control.createGroup({ title: "Team", botIds: [bot.id, helper.id] });
  const topic = await control.createGroupTopic(group.id, "Sprint", { workspace: "backend", isolation: "shared-single-writer" });
  const request = { conversationId: group.id, topicId: topic.id, requestId: "automatic-api", text: "review", target: { mode: "automatic" as const } };
  const accepted = await control.promptConversation(request);
  expect(accepted.memberTurn).toBeUndefined();
  expect(accepted.memberTurns).toEqual([]);
  expect(accepted.run.mode).toBe("automatic");
  const replay = await control.promptConversation(request);
  expect(replay.reused).toBe(true);
  expect(replay.run.id).toBe(accepted.run.id);
  expect(replay.memberTurn).toBeUndefined();
  expect(replay.memberTurns).toEqual([]);
  decide();
  await runtime.runs.awaitRouting();
  const detail = await control.getRun(accepted.run.id);
  expect(detail.waitingQuestion).toBe("Choose scope");
  const changed = observed.find((event) => event.type === "conversation-run-changed"
    && event.run.id === accepted.run.id && event.run.state === "waiting-human");
  expect(changed?.type === "conversation-run-changed" && changed.run.waitingQuestion).toBe("Choose scope");
  expect(validControlEvent(changed)).toBe(true);
  if (changed?.type === "conversation-run-changed") {
    expect(validControlEvent({ ...changed, run: { ...changed.run, waitingQuestion: 42 } })).toBe(false);
    expect(validControlEvent({ ...changed, run: { ...changed.run, state: "cancelled" } })).toBe(false);
  }
  const reopened = await SqliteConversationStore.open(sqlitePath);
  expect(toConversationRun(reopened.getRun(accepted.run.id)!).waitingQuestion).toBe("Choose scope");
  reopened.close();
  await control.cancelRun(accepted.run.id);
  expect((await control.getRun(accepted.run.id)).waitingQuestion).toBeUndefined();
  unsubscribe();
  expect(runtime.store.getRun(accepted.run.id)?.state).toBe("cancelled");
  await runtime.shutdown();
});

test("legacy audit-only waiting question is available through Control after restart", async () => {
  const stateStore = new BarrierStateStore();
  const router: ConversationRouter = { capabilityRestriction: RESTRICTED,
    async decide() { return { type: "need-human", question: "Which branch ships?" }; } };
  const first = await compose(stateStore, { router });
  const bot = await first.control.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  const helper = await first.control.createBot({ name: "Helper", agent: "codex", workspace: "backend" });
  const group = await first.control.createGroup({ title: "Team", botIds: [bot.id, helper.id] });
  const topic = await first.control.createGroupTopic(group.id, "Sprint", { workspace: "backend", isolation: "shared-single-writer" });
  const accepted = await first.control.promptConversation({ conversationId: group.id, topicId: topic.id,
    requestId: "legacy-waiting", text: "ship", target: { mode: "automatic" } });
  await first.runtime.runs.awaitRouting();
  await first.runtime.shutdown();
  // Reproduce the exact previous schema: question exists only in audit.
  const legacy = await createSqlDriver(first.sqlitePath);
  legacy.exec("ALTER TABLE runs DROP COLUMN waiting_question");
  legacy.close();
  const restored = await compose(stateStore, { router, state: first.state, sqlitePath: first.sqlitePath });
  try {
    const detail = await restored.control.getRun(accepted.run.id);
    expect(detail.state).toBe("waiting-human");
    expect(detail.waitingQuestion).toBe("Which branch ships?");
    const replay = await restored.control.promptConversation({ conversationId: group.id, topicId: topic.id,
      requestId: "legacy-waiting", text: "ship", target: { mode: "automatic" } });
    expect(replay.reused).toBe(true);
    expect(replay.run.waitingQuestion).toBe("Which branch ships?");
    await restored.control.cancelRun(accepted.run.id);
    expect((await restored.control.getRun(accepted.run.id)).waitingQuestion).toBeUndefined();
  } finally { await restored.runtime.shutdown(); }
});

for (const recovered of [false, true]) {
  test(`real automatic permission failure produces durable structured blocked-step evidence${recovered ? " after claim recovery" : ""}`, async () => {
    const executed: string[] = [];
    const { control, runtime } = await compose(new BarrierStateStore(), {
      agent: { async chat(request) {
        executed.push(request.text);
        expect(request.metadata?.origin).toBe("orchestration");
        throw Object.assign(new Error("permission blocked"), { code: "RUNTIME_PERMISSION_DENIED" });
      } },
      router: { capabilityRestriction: RESTRICTED, async decide(input) { return { type: "dispatch", mode: "single", assignments: [{ id: "write", botId: input.memberMetadata[0]!.botId, task: "write", expectedOutput: "patch summary", triggerMessageIds: [] }] }; } },
    });
    const bot = await control.createBot({ name: "Writer", agent: "codex", workspace: "backend" });
    const helper = await control.createBot({ name: "Helper", agent: "codex", workspace: "backend" });
    const group = await control.createGroup({ title: "Team", botIds: [bot.id, helper.id] });
    const topic = await control.createGroupTopic(group.id, "Sprint", { workspace: "backend", isolation: "shared-single-writer" });
    const accepted = await control.promptConversation({ conversationId: group.id, topicId: topic.id, requestId: "blocked-api", text: "write", target: { mode: "automatic" } });
    await runtime.runs.awaitRouting();
    if (recovered) {
      const claim = runtime.store.claimNextDispatch({ owner: "dead-consumer", authorityEpoch: "expired",
        now: "2026-09-15T11:59:00.000Z", leaseExpiresAt: "2026-09-15T11:59:30.000Z" });
      expect(claim).toBeDefined();
    }
    await runtime.dispatcher.kick();
    expect(executed).toHaveLength(1);
    expect(executed[0]).toContain("Task:\nwrite");
    expect(executed[0]).toContain("Expected output:\npatch summary");
    const turn = runtime.store.listMemberTurns(accepted.run.id)[0]!;
    expect(turn.state).toBe("failed");
    expect(turn.blockedReason).toBe("human-authority-unknown");
    expect(turn.origin).toBe(recovered ? "recovery" : "router");
    expect((await control.getRun(accepted.run.id)).memberTurns[0]?.blockedReason).toBe("human-authority-unknown");
    await runtime.shutdown();
  });
}

for (const lateOutput of ["resolve", "reject"] as const) {
  test(`production shutdown preserves routing for activation recovery and ignores late ${lateOutput}`, async () => {
    const withCompletedBatch = lateOutput === "reject";
    const calls: Array<{ signal: AbortSignal; resolve: (decision: RoutingDecision) => void; reject: (error: Error) => void }> = [];
    const router: ConversationRouter = { capabilityRestriction: RESTRICTED, async decide(_input, options) {
      if (withCompletedBatch && calls.length === 1 && _input.completedAssignments.length === 0) {
        return { type: "dispatch", mode: "single", assignments: [{ id: "before-shutdown", botId: _input.memberMetadata[0]!.botId,
          task: "review before restart", triggerMessageIds: [] }] };
      }
      return new Promise<RoutingDecision>((resolve, reject) => { calls.push({ signal: options!.signal, resolve, reject }); });
    } };
    const stateStore = new BarrierStateStore();
    const { control, runtime, sqlitePath, state } = await compose(stateStore, { router });
    const bot = await control.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
    const helper = await control.createBot({ name: "Helper", agent: "codex", workspace: "backend" });
    const group = await control.createGroup({ title: "Team", botIds: [bot.id, helper.id] });
    const topic = await control.createGroupTopic(group.id, "Sprint", { workspace: "backend", isolation: "shared-single-writer" });
    const request = { conversationId: group.id, topicId: topic.id, text: "review", target: { mode: "automatic" as const } };
    const first = await control.promptConversation({ ...request, requestId: "cancel-hung-provider" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await control.cancelRun(first.run.id); await runtime.runs.awaitRouting();
    expect(calls[0]!.signal.aborted).toBe(true);
    expect((await control.getRun(first.run.id)).state).toBe("cancelled");
    calls[0]!.reject(new Error("late provider rejection after cancellation"));
    const second = await control.promptConversation({ ...request, requestId: "shutdown-hung-provider" });
    if (withCompletedBatch) {
      await runtime.runs.awaitRouting();
      await runtime.dispatcher.kick();
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    const generation = runtime.store.getRun(second.run.id)!.routingGeneration!;
    let timer!: ReturnType<typeof setTimeout>;
    try {
      await Promise.race([runtime.shutdown(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("production shutdown did not drain")), 1_000);
      })]);
    } finally { clearTimeout(timer); }
    expect(calls[1]!.signal.aborted).toBe(true);
    const reopened = await SqliteConversationStore.open(sqlitePath);
    expect(reopened.getRun(first.run.id)?.state).toBe("cancelled");
    expect(reopened.getRun(second.run.id)).toMatchObject({ state: "running", routingState: "routing", routingGeneration: generation,
      consumedMemberTurns: withCompletedBatch ? 1 : 0 });
    expect(reopened.getRun(second.run.id)?.completionReason).toBeUndefined();
    expect(reopened.getRun(second.run.id)?.finishedAt).toBeUndefined();
    expect(reopened.automaticRunsAwaitingRouting().map(({ run }) => run.id)).toContain(second.run.id);
    reopened.close();
    let enterRecovery!: () => void;
    const recoveryEntered = new Promise<void>((resolve) => { enterRecovery = resolve; });
    let finishRecovery!: (decision: RoutingDecision) => void;
    const decision = new Promise<RoutingDecision>((resolve) => { finishRecovery = resolve; });
    let recoveryCalls = 0;
    const restored = await compose(stateStore, { state: structuredClone(state), sqlitePath, router: {
      capabilityRestriction: RESTRICTED, async decide(input) {
        recoveryCalls++;
        expect(input.runId).toBe(second.run.id);
        expect(input.completedAssignments).toHaveLength(withCompletedBatch ? 1 : 0);
        if (withCompletedBatch) expect(input.completedAssignments[0]!.result).toBe("ok");
        enterRecovery(); return decision;
      },
    } });
    const activation = restored.runtime.activateAfterConsumerLock();
    try {
      await recoveryEntered;
      const resumedGeneration = restored.runtime.store.getRun(second.run.id)!.routingGeneration!;
      expect(resumedGeneration).toBeGreaterThan(generation);
      if (lateOutput === "resolve") calls[1]!.resolve({ type: "dispatch", mode: "single", assignments: [
        { id: "stale-shutdown", botId: bot.id, task: "stale work", triggerMessageIds: [] },
      ] });
      else calls[1]!.reject(new Error("late provider rejection after SQLite close"));
      await Promise.resolve(); await Promise.resolve();
      expect(restored.runtime.store.getRun(second.run.id)).toMatchObject({ state: "running", routingState: "routing", routingGeneration: resumedGeneration });
      expect(restored.runtime.store.listMemberTurns(second.run.id)).toHaveLength(withCompletedBatch ? 1 : 0);
      finishRecovery({ type: "complete", reason: "recovered after shutdown" });
      await activation; await restored.runtime.runs.awaitRouting();
      expect(recoveryCalls).toBe(1);
      expect(await restored.control.getRun(second.run.id)).toMatchObject({ state: "completed", completionReason: "recovered after shutdown" });
      expect((await restored.control.getRun(first.run.id)).state).toBe("cancelled");
    } finally {
      finishRecovery({ type: "complete", reason: "cleanup" });
      await activation; await restored.runtime.shutdown();
    }
  });
}

test("remove then delete during production routing fails durably and releases the Topic", async () => {
  let calls = 0;
  let resolveDecision!: (decision: RoutingDecision) => void;
  let enterRouter!: () => void;
  const entered = new Promise<void>((resolve) => { enterRouter = resolve; });
  const decision = new Promise<RoutingDecision>((resolve) => { resolveDecision = resolve; });
  const router: ConversationRouter = { capabilityRestriction: RESTRICTED, async decide() {
    if (++calls > 1) return { type: "complete", reason: "successor completed" };
    enterRouter(); return decision;
  } };
  const { control, runtime, state } = await compose(new BarrierStateStore(), { router });
  try {
    const bot = await control.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
    const helper = await control.createBot({ name: "Helper", agent: "codex", workspace: "backend" });
    const builder = await control.createBot({ name: "Builder", agent: "codex", workspace: "backend" });
    const group = await control.createGroup({ title: "Team", botIds: [bot.id, helper.id, builder.id] });
    const topic = await control.createGroupTopic(group.id, "Sprint", { workspace: "backend", isolation: "shared-single-writer" });
    const accepted = await control.promptConversation({ conversationId: group.id, topicId: topic.id,
      requestId: "remove-delete-router", text: "review", target: { mode: "automatic" } });
    await entered;
    await control.updateGroup(group.id, { botIds: [helper.id, builder.id] });
    await control.deleteBot(bot.id);
    expect(state.bots[bot.id]).toBeUndefined();
    const next = await control.promptConversation({ conversationId: group.id, topicId: topic.id,
      requestId: "after-remove-delete", text: "next", target: { mode: "automatic" } });
    await runtime.dispatcher.kick();
    expect(runtime.store.getRun(next.run.id)?.state).toBe("queued");
    resolveDecision({ type: "dispatch", mode: "single", assignments: [
      { id: "stale", botId: bot.id, task: "review", triggerMessageIds: [] },
    ] });
    await runtime.runs.awaitRouting();
    const failed = await control.getRun(accepted.run.id);
    expect(failed.state).toBe("failed");
    expect(failed.completionReason).toBe("router_unknown_member");
    expect(failed.routingState).toBe("done");
    expect(failed.memberTurns).toEqual([]);
    expect(runtime.store.listDispatchesForRun(accepted.run.id)).toEqual([]);
    expect(runtime.store.getRun(next.run.id)?.state).toBe("completed");
    expect(runtime.store.getRun(next.run.id)?.completionReason).toBe("successor completed");
    expect(calls).toBe(2);
  } finally {
    resolveDecision({ type: "complete", reason: "test cleanup" });
    await runtime.shutdown();
  }
});

test("Conversation COW snapshot then Session create keeps both domains", async () => {
  const store = new BarrierStateStore();
  const { state, sessions, control } = await compose(store);
  const bot = await control.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  const conversationId = createDirectConversationId(bot.id);

  store.arm();
  const topicP = control.createTopic(conversationId, "extra");
  await store.entered;
  const sessionP = sessions.createSession("ordinary", "codex", "backend");
  let sessionDone = false;
  void sessionP.then(() => {
    sessionDone = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  expect(sessionDone).toBe(false);
  expect(state.sessions.ordinary).toBeUndefined();

  store.resume();
  const topic = await topicP;
  await sessionP;
  expect(state.sessions.ordinary).toBeTruthy();
  expect(state.conversation_topics[topic.id]?.conversationId).toBe(conversationId);
  expect(control.getConversation(conversationId).id).toBe(conversationId);
});

test("Session COW snapshot then Conversation publish keeps both domains", async () => {
  const store = new BarrierStateStore();
  const { state, sessions, control } = await compose(store);
  const bot = await control.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  const conversationId = createDirectConversationId(bot.id);

  store.arm();
  const sessionP = sessions.createSession("ordinary", "codex", "backend");
  await store.entered;
  const topicP = control.createTopic(conversationId, "extra");
  let topicDone = false;
  void topicP.then(() => {
    topicDone = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  expect(topicDone).toBe(false);
  expect(Object.values(state.conversation_topics).some((topic) => topic.title === "extra")).toBe(false);

  store.resume();
  await sessionP;
  const topic = await topicP;
  expect(state.sessions.ordinary).toBeTruthy();
  expect(state.conversation_topics[topic.id]?.conversationId).toBe(conversationId);
  expect(control.getConversation(conversationId).id).toBe(conversationId);
});

test("shutdown waits for in-flight createTopic persist and shares one promise", async () => {
  const store = new BarrierStateStore();
  const { state, control, runtime } = await compose(store);
  const bot = await control.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  const conversationId = createDirectConversationId(bot.id);
  const writesAfterCreate = store.saved.length;

  store.arm();
  const topicP = control.createTopic(conversationId, "extra");
  await store.entered;
  let shutdownResolved = false;
  const shutdownA = runtime.shutdown().then(() => {
    shutdownResolved = true;
  });
  const shutdownB = runtime.shutdown();
  expect(shutdownB).toBe(runtime.shutdown());
  await new Promise((resolve) => setTimeout(resolve, 40));
  expect(shutdownResolved).toBe(false);
  expect(Object.values(state.conversation_topics).some((topic) => topic.title === "extra")).toBe(false);

  store.resume();
  const topic = await topicP;
  await shutdownA;
  await shutdownB;
  expect(shutdownResolved).toBe(true);
  expect(state.conversation_topics[topic.id]?.conversationId).toBe(conversationId);
  const writesAtShutdown = store.saved.length;
  expect(writesAtShutdown).toBeGreaterThan(writesAfterCreate);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(store.saved.length).toBe(writesAtShutdown);
  await expect(control.createTopic(conversationId, "later")).rejects.toMatchObject({ code: "runtime_closed" });
});

function shutdownBarrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("shutdown lets an entered group_send commit through a real Bot lifecycle gate", async () => {
  const providerEntered = shutdownBarrier(), finishProvider = shutdownBarrier();
  const gateEntered = shutdownBarrier(), releaseGate = shutdownBarrier();
  let executionToken = "", starts = 0;
  const current = await compose(new BarrierStateStore(), { agent: { async chat(request) {
    starts++;
    executionToken = request.metadata!.groupExecutionToken!;
    providerEntered.resolve();
    await finishProvider.promise;
    return { text: "healthy sender during shutdown" };
  } } });
  let drain: Promise<void> | undefined, gate: Promise<void> | undefined;
  let operation: ReturnType<typeof current.runtime.handoffs.send> | undefined;
  let shutdown: Promise<void> | undefined;
  const gates = spyOn(current.runtime.bots, "runLifecycleAll");
  try {
    const sender = await current.control.createBot({ name: "Sender", agent: "codex", workspace: "backend" });
    const target = await current.control.createBot({ name: "Target", agent: "codex", workspace: "backend" });
    const group = await current.control.createGroup({ title: "Shutdown lease", botIds: [sender.id, target.id] });
    const topic = await current.control.createGroupTopic(group.id, "Topic", { workspace: "backend", isolation: "shared-single-writer" });
    const accepted = await current.control.promptConversation({ conversationId: group.id, topicId: topic.id,
      requestId: "shutdown-handoff", text: "work", target: { botId: sender.id } });
    drain = current.runtime.dispatcher.kick();
    await providerEntered.promise;
    gate = current.runtime.bots.runLifecycle(target.id, async () => {
      gateEntered.resolve();
      await releaseGate.promise;
    });
    await gateEntered.promise;
    gates.mockClear();
    operation = current.runtime.withOperation(() => current.runtime.handoffs.send({ executionToken,
      invocationId: "entered-before-stop", args: { to: target.id, task: "durable handoff at shutdown" } }));
    // Observe the original method; its real mutex remains held, without a
    // beforeCommit fault hook or a replacement lifecycle-gate implementation.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(gates.mock.calls.some(([ids]) => ids.includes(sender.id) && ids.includes(target.id))).toBe(true);
    let shutdownDone = false;
    shutdown = current.runtime.shutdown();
    void shutdown.then(() => { shutdownDone = true; });
    expect(current.runtime.shutdown()).toBe(shutdown);
    await expect(current.runtime.withOperation(async () => {
      throw new Error("a new operation entered during stopping");
    })).rejects.toMatchObject({ code: "runtime_closed" });
    expect(shutdownDone).toBe(false);
    releaseGate.resolve();
    const receipt = await operation;
    expect(receipt.reused).toBe(false);
    expect(receipt.memberTurn).toMatchObject({ runId: accepted.run.id, botId: target.id, origin: "handoff", state: "queued" });
    expect(current.runtime.store.getMessage(receipt.message.id)?.handoff?.memberTurnId).toBe(receipt.memberTurn.id);
    expect(shutdownDone).toBe(false);
    finishProvider.resolve();
    await drain;
    await shutdown;
    expect(shutdownDone).toBe(true);
    expect(starts).toBe(1);
    const reopened = await SqliteConversationStore.open(current.sqlitePath);
    try {
      const members = reopened.listMemberTurns(accepted.run.id);
      expect(members.map((member) => member.state)).toEqual(["completed", "queued"]);
      expect(reopened.getMemberResult(members[0]!)?.content).toBe("healthy sender during shutdown");
      expect(reopened.getDispatchForMemberTurn(receipt.memberTurn.id)?.state).toBe("pending");
      expect(reopened.listMessages({ conversationId: group.id, topicId: topic.id, limit: 100 })
        .filter((message) => message.handoff)).toHaveLength(1);
    } finally { reopened.close(); }
    await expect(current.runtime.handoffs.send({ executionToken, invocationId: "after-stop",
      args: { to: target.id, task: "late" } })).rejects.toMatchObject({ code: "runtime_closed" });
  } finally {
    releaseGate.resolve(); finishProvider.resolve();
    await Promise.allSettled([operation, gate, drain].filter((work) => work !== undefined));
    await (shutdown ?? current.runtime.shutdown());
    gates.mockRestore();
  }
});

test("shutdown between durable execution-start and capability bind does not manufacture unknown outcome", async () => {
  const providerEntered = shutdownBarrier(), finishProvider = shutdownBarrier();
  let starts = 0, executionToken = "";
  const current = await compose(new BarrierStateStore(), { agent: { async chat(request) {
    starts++;
    executionToken = request.metadata!.groupExecutionToken!;
    providerEntered.resolve();
    await finishProvider.promise;
    return { text: "started execution drained normally" };
  } } });
  let shutdown: Promise<void> | undefined, drain: Promise<void> | undefined;
  const unsubscribe = current.events.subscribe((event) => {
    // This synchronous production projection is after the durable start and
    // before bindExecution, so stop is deterministic without a fault hook.
    if (event.type === "member-turn-started") shutdown = current.runtime.shutdown();
  });
  try {
    const sender = await current.control.createBot({ name: "Sender", agent: "codex", workspace: "backend" });
    const target = await current.control.createBot({ name: "Target", agent: "codex", workspace: "backend" });
    const group = await current.control.createGroup({ title: "Start-bind shutdown", botIds: [sender.id, target.id] });
    const topic = await current.control.createGroupTopic(group.id, "Topic", { workspace: "backend", isolation: "shared-single-writer" });
    const accepted = await current.control.promptConversation({ conversationId: group.id, topicId: topic.id,
      requestId: "shutdown-start-bind", text: "work", target: { botId: sender.id } });
    drain = current.runtime.dispatcher.kick();
    expect(await Promise.race([providerEntered.promise.then(() => "provider"), drain.then(() => "drained")])).toBe("provider");
    expect(shutdown).toBeDefined();
    expect(current.runtime.handoffs.memberContext(executionToken)).toContain(sender.id);
    finishProvider.resolve();
    await drain;
    await shutdown;
    expect(starts).toBe(1);
    const reopened = await SqliteConversationStore.open(current.sqlitePath);
    try {
      expect(reopened.getRun(accepted.run.id)).toMatchObject({ state: "completed", consumedMemberTurns: 1 });
      const member = reopened.listMemberTurns(accepted.run.id)[0]!;
      expect(member).toMatchObject({ state: "completed" });
      expect(member.failureReason).toBeUndefined();
      expect(reopened.getMemberResult(member)?.content).toBe("started execution drained normally");
    } finally { reopened.close(); }
    expect(() => current.runtime.handoffs.bindExecution({ senderMemberTurnId: "retired", sourceTurnId: "retired",
      dispatchId: "retired", owner: "retired", generation: 1 })).toThrow(expect.objectContaining({ code: "runtime_closed" }));
  } finally {
    finishProvider.resolve();
    await drain;
    await (shutdown ?? current.runtime.shutdown());
    unsubscribe();
  }
});

test("shutdown revokes handoff capabilities even when the Run drain fails", async () => {
  const { runtime } = await compose(new BarrierStateStore());
  const failure = new Error("injected Run shutdown failure");
  const shutdownRuns = spyOn(runtime.runs, "shutdown").mockRejectedValue(failure);
  try {
    const shutdown = runtime.shutdown();
    await expect(shutdown).rejects.toBe(failure);
    expect(runtime.shutdown()).toBe(shutdown);
    expect(() => runtime.handoffs.bindExecution({ senderMemberTurnId: "retired", sourceTurnId: "retired",
      dispatchId: "retired", owner: "retired", generation: 1 })).toThrow(expect.objectContaining({ code: "runtime_closed" }));
    await expect(runtime.withOperation(async () => "late")).rejects.toMatchObject({ code: "runtime_closed" });
  } finally {
    shutdownRuns.mockRestore();
    await runtime.runs.shutdown();
  }
});

test("production composition wires a capability-proven Router and refuses an unprovable one", async () => {
  const restricted = {
    toolsDisabled: true,
    filesystemDisabled: true,
    terminalDisabled: true,
    permissionInteractionDisabled: true,
    messagingDisabled: true,
    orchestrationDisabled: true,
    structuredOutputOnly: true,
  };
  for (const [label, router] of [
    ["provable", { capabilityRestriction: restricted, decide: async () => ({ type: "complete" as const, reason: "x" }) }],
    ["unprovable", { capabilityRestriction: { ...restricted, toolsDisabled: false }, decide: async () => ({ type: "complete" as const, reason: "x" }) }],
    ["no-decide", { capabilityRestriction: restricted }],
  ] as const) {
    const store = new BarrierStateStore();
    const dir = mkdtempSync(join(tmpdir(), "xacpx-router-wire-"));
    const state = createEmptyState();
    const config = createConfig();
    const stateMutex = new AsyncMutex();
    const sessions = new SessionService(config, store, state, { stateMutex });
    const control = new ControlService({
      agent: { chat: async () => ({ text: "ok" }) },
      sessions,
      activeTurns: { isActiveAnywhere: () => false },
      scheduled: {} as never,
      orchestration: {} as never,
      events: createControlEventBus(),
      workspaces: { list: () => [] },
    } as never);
    const kernel = conversationKernel(control);
    const runtime = await createConversationRuntime({
      config,
      state,
      stateStore: store,
      sessions,
      control: kernel,
      sqlitePath: join(dir, "conversations.sqlite"),
      releaseOwnedSession: createProductionOwnedSessionRelease({
        sessions,
        transport: { async deleteSession() {}, async releaseLogicalSession() {} },
      }),
      onProductEvent: (event) => kernel.emitConversationProduct(event),
      autoKick: false,
      stateMutex,
      ...(router === undefined ? {} : { router }),
    });
    kernel.bindConversationRuntime(runtime);
    await runtime.activateAfterConsumerLock();
    // A provable Router is accepted; everything else is dropped, so automatic
    // mode stays unsupported rather than running a Router that could act.
    if (label === "provable") {
      await expect(control.promptConversation({
        conversationId: "conversation_missing",
        topicId: "topic_missing",
        requestId: "req-missing",
        text: "x",
        target: { mode: "automatic" },
      })).rejects.toMatchObject({ code: "conversation_not_found" });
    }
    await runtime.shutdown();
  }
});

test("production composition with no Router leaves automatic mode unsupported", async () => {
  const store = new BarrierStateStore();
  const dir = mkdtempSync(join(tmpdir(), "xacpx-norouter-"));
  const state = createEmptyState();
  const config = createConfig();
  const stateMutex = new AsyncMutex();
  const sessions = new SessionService(config, store, state, { stateMutex });
  const control = new ControlService({
    agent: { chat: async () => ({ text: "ok" }) },
    sessions,
    activeTurns: { isActiveAnywhere: () => false },
    scheduled: {} as never,
    orchestration: {} as never,
    events: createControlEventBus(),
    workspaces: { list: () => [] },
  } as never);
  const kernel = conversationKernel(control);
  const runtime = await createConversationRuntime({
    config,
    state,
    stateStore: store,
    sessions,
    control: kernel,
    sqlitePath: join(dir, "conversations.sqlite"),
    releaseOwnedSession: createProductionOwnedSessionRelease({
      sessions,
      transport: { async deleteSession() {}, async releaseLogicalSession() {} },
    }),
    onProductEvent: (event) => kernel.emitConversationProduct(event),
    autoKick: false,
    stateMutex,
  });
  kernel.bindConversationRuntime(runtime);
  await runtime.activateAfterConsumerLock();
  await runtime.shutdown();
});

test("production lease renewal I/O failure fail-closes accept and still closes SQLite", async () => {
  const LEASE_MS = 30_000;
  const start = Date.parse("2026-10-08T00:00:00.000Z");
  const tasks: Array<{ due: number; cb: () => void; cancelled: boolean; fired: boolean }> = [];
  let ms = start;
  const clock = {
    date: () => new Date(ms),
    scheduler: {
      schedule(delayMs: number, callback: () => void) {
        const task = { due: ms + delayMs, cb: callback, cancelled: false, fired: false };
        tasks.push(task);
        return { cancel: () => { task.cancelled = true; } };
      },
    } satisfies LeaseScheduler,
    async advance(by: number): Promise<void> {
      const target = ms + by;
      for (;;) {
        const next = tasks
          .filter((task) => !task.cancelled && !task.fired && task.due <= target)
          .sort((left, right) => left.due - right.due)[0];
        if (!next) break;
        ms = next.due;
        next.fired = true;
        next.cb();
        for (let step = 0; step < 8; step += 1) await Promise.resolve();
      }
      ms = target;
    },
  };
  let renewals = 0;
  let entered!: () => void;
  const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const releasePromise = new Promise<void>((resolve) => { release = resolve; });
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => { unhandled.push(error); };
  process.on("unhandledRejection", onUnhandled);
  const current = await compose(new BarrierStateStore(), {
    autoKick: true,
    now: () => clock.date(),
    leaseMs: LEASE_MS,
    leaseScheduler: clock.scheduler,
    beforeLeaseRenewal: () => {
      renewals += 1;
      if (renewals === 1) throw new Error("sqlite disk I/O error");
    },
    agent: { async chat() {
      entered();
      await releasePromise;
      return { text: "provider result" };
    } },
  });
  let released = false;
  const finishProvider = () => {
    if (released) return;
    released = true;
    release();
  };
  try {
    const bot = await current.control.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
    const helper = await current.control.createBot({ name: "Helper", agent: "codex", workspace: "backend" });
    const group = await current.control.createGroup({ title: "Lease", botIds: [bot.id, helper.id] });
    const topic = await current.control.createGroupTopic(group.id, "Sprint", { workspace: "backend", isolation: "shared-single-writer" });
    await current.runtime.activateAfterConsumerLock();
    expect(current.runtime.runs.isConsumerActivated()).toBe(true);
    const accepted = await current.control.promptConversation({
      conversationId: group.id, topicId: topic.id, requestId: "live-turn", text: "work", target: { botId: bot.id },
    });
    await enteredPromise;
    const turn = current.runtime.store.listMemberTurns(accepted.run.id)[0]!;
    const dispatch = current.runtime.store.getDispatchForMemberTurn(turn.id)!;
    const leaseBefore = dispatch.leaseExpiresAt;
    const generationBefore = dispatch.generation;
    expect(turn.state).toBe("running");
    expect(current.runtime.store.getRun(accepted.run.id)?.state).toBe("running");
    await clock.advance(Math.floor(LEASE_MS / 3));
    expect(renewals).toBe(1);
    expect(current.runtime.runs.isConsumerActivated()).toBe(false);
    expect(unhandled).toEqual([]);
    const sealed = current.runtime.store.getMemberTurn(turn.id)!;
    const dispatchAfter = current.runtime.store.getDispatchForMemberTurn(turn.id)!;
    expect(sealed.state).toBe("running");
    expect(sealed.failureReason).toBeUndefined();
    expect(current.runtime.store.getRun(accepted.run.id)).toMatchObject({ state: "running" });
    expect(current.runtime.store.getRun(accepted.run.id)?.completionReason).toBeUndefined();
    expect(dispatchAfter).toMatchObject({ state: "claimed", generation: generationBefore, leaseExpiresAt: leaseBefore });
    await expect(current.control.promptConversation({
      conversationId: group.id, topicId: topic.id, requestId: "after-lease-io", text: "more", target: { botId: helper.id },
    })).rejects.toMatchObject({ code: "conversations_unavailable" });
    expect(current.runtime.store.listRuns(group.id).map((run) => run.id)).toEqual([accepted.run.id]);
    expect(unhandled).toEqual([]);
    finishProvider();
    for (let step = 0; step < 20 && current.runtime.store.getRun(accepted.run.id)?.state !== "completed"; step += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(current.runtime.store.getRun(accepted.run.id)).toMatchObject({ state: "completed", completionReason: "members-completed" });
    expect(current.runtime.store.getMemberTurn(turn.id)?.state).toBe("completed");
    expect(unhandled).toEqual([]);
    await expect(current.runtime.shutdown()).rejects.toThrow("sqlite disk I/O error");
    expect(() => current.runtime.store.getRun(accepted.run.id)).toThrow(/closed/);
    const reopened = await SqliteConversationStore.open(current.sqlitePath);
    try {
      expect(reopened.getRun(accepted.run.id)).toMatchObject({ state: "completed", completionReason: "members-completed" });
      expect(reopened.getMemberTurn(turn.id)?.state).toBe("completed");
      expect(reopened.listRuns(group.id)).toHaveLength(1);
    } finally { reopened.close(); }
  } finally {
    finishProvider();
    process.off("unhandledRejection", onUnhandled);
  }
});
