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

async function compose(stateStore: BarrierStateStore) {
  const dir = mkdtempSync(join(tmpdir(), "xacpx-compose-"));
  const state = createEmptyState();
  const config = createConfig();
  const stateMutex = new AsyncMutex();
  const sessions = new SessionService(config, stateStore, state, { stateMutex });
  const control = new ControlService({
    agent: { chat: async () => ({ text: "ok" }) },
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
    stateMutex,
  });
  kernel.bindConversationRuntime(runtime);
  return { state, sessions, control, runtime, stateMutex };
}

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
