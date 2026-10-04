import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

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

const RESTRICTED = { toolsDisabled: true, filesystemDisabled: true, terminalDisabled: true, permissionInteractionDisabled: true, messagingDisabled: true, orchestrationDisabled: true, structuredOutputOnly: true };

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
    autoKick: false,
    ...(options.router ? { router: options.router } : {}),
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

test("real automatic permission failure produces durable structured blocked-step evidence", async () => {
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
  await runtime.dispatcher.kick();
  expect(executed).toHaveLength(1);
  expect(executed[0]).toContain("Task:\nwrite");
  expect(executed[0]).toContain("Expected output:\npatch summary");
  const turn = runtime.store.listMemberTurns(accepted.run.id)[0]!;
  expect(turn.state).toBe("failed");
  expect(turn.blockedReason).toBe("human-authority-unknown");
  expect(turn.origin).toBe("router");
  expect((await control.getRun(accepted.run.id)).memberTurns[0]?.blockedReason).toBe("human-authority-unknown");
  await runtime.shutdown();
});

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
