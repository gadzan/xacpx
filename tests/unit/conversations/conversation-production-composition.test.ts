import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

import type { AppConfig } from "../../../src/config/types";
import { ControlService, conversationKernel } from "../../../src/control/control-service";
import { createControlEventBus } from "../../../src/control/control-event-bus";
import {
  createConversationRuntime,
  createProductionOwnedSessionRelease,
} from "../../../src/conversations/conversation-composition";
import { createDirectConversationId } from "../../../src/domain/ids";
import { AsyncMutex } from "../../../src/orchestration/async-mutex";
import { SessionService } from "../../../src/sessions/session-service";
import { createEmptyState, type AppState } from "../../../src/state/types";
import type { ConversationRouter } from "../../../src/conversations/conversation-router-types";
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

async function compose(stateStore: BarrierStateStore, options: { router?: ConversationRouter; agent?: Agent } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "xacpx-compose-"));
  const state = createEmptyState();
  const config = createConfig();
  const stateMutex = new AsyncMutex();
  const sessions = new SessionService(config, stateStore, state, { stateMutex });
  const control = new ControlService({
    agent: options.agent ?? { chat: async () => ({ text: "ok" }) },
    sessions,
    activeTurns: { isActiveAnywhere: () => false },
    scheduled: {} as never,
    orchestration: {} as never,
    events: createControlEventBus(),
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
    sqlitePath: join(dir, "conversations.sqlite"),
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
  return { state, sessions, control, runtime, stateMutex };
}

test("real Control automatic prompt returns zero members and same requestId replays the Run", async () => {
  let decide!: () => void;
  const router: ConversationRouter = { capabilityRestriction: RESTRICTED, async decide() {
    await new Promise<void>((resolve) => { decide = resolve; });
    return { type: "need-human", question: "Choose scope" };
  } };
  const { control, runtime } = await compose(new BarrierStateStore(), { router });
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
  await control.cancelRun(accepted.run.id);
  expect(runtime.store.getRun(accepted.run.id)?.state).toBe("cancelled");
  await runtime.shutdown();
});

test("real automatic permission failure produces durable structured blocked-step evidence", async () => {
  const { control, runtime } = await compose(new BarrierStateStore(), {
    agent: { async chat() { throw Object.assign(new Error("permission blocked"), { code: "RUNTIME_PERMISSION_DENIED" }); } },
    router: { capabilityRestriction: RESTRICTED, async decide(input) { return { type: "dispatch", mode: "single", assignments: [{ id: "write", botId: input.memberMetadata[0]!.botId, task: "write", triggerMessageIds: [] }] }; } },
  });
  const bot = await control.createBot({ name: "Writer", agent: "codex", workspace: "backend" });
  const helper = await control.createBot({ name: "Helper", agent: "codex", workspace: "backend" });
  const group = await control.createGroup({ title: "Team", botIds: [bot.id, helper.id] });
  const topic = await control.createGroupTopic(group.id, "Sprint", { workspace: "backend", isolation: "shared-single-writer" });
  const accepted = await control.promptConversation({ conversationId: group.id, topicId: topic.id, requestId: "blocked-api", text: "write", target: { mode: "automatic" } });
  await runtime.runs.awaitRouting();
  await runtime.dispatcher.kick();
  const turn = runtime.store.listMemberTurns(accepted.run.id)[0]!;
  expect(turn.state).toBe("failed");
  expect(turn.blockedReason).toBe("human-authority-unknown");
  expect(turn.origin).toBe("router");
  expect((await control.getRun(accepted.run.id)).memberTurns[0]?.blockedReason).toBe("human-authority-unknown");
  await runtime.shutdown();
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
