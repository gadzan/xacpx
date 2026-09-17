import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

import { ActiveConsumerLockError } from "../../../src/channels/types";
import type { AppConfig } from "../../../src/config/types";
import { ControlService, conversationKernel } from "../../../src/control/control-service";
import { createControlEventBus } from "../../../src/control/control-event-bus";
import {
  createConversationRuntime,
  createProductionOwnedSessionRelease,
} from "../../../src/conversations/conversation-composition";
import { createDirectConversationId, createDirectTopicId } from "../../../src/domain/ids";
import { createNoopAppLogger } from "../../../src/logging/app-logger";
import type { AppRuntime } from "../../../src/main";
import { AsyncMutex } from "../../../src/orchestration/async-mutex";
import { runConsole } from "../../../src/run-console";
import { SessionService } from "../../../src/sessions/session-service";
import { createEmptyState, type AppState } from "../../../src/state/types";
import { SqliteConversationStore } from "../../../src/conversations/sqlite-conversation-store";

class MemoryStateStore {
  public saved: AppState[] = [];
  async save(state: AppState): Promise<void> {
    this.saved.push(structuredClone(state));
  }
  async saveNow(state: AppState): Promise<void> {
    this.saved.push(structuredClone(state));
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

async function compose(input: {
  sqlitePath: string;
  state: AppState;
  stateStore: MemoryStateStore;
  chat?: () => Promise<{ text: string }>;
}) {
  const config = createConfig();
  const stateMutex = new AsyncMutex();
  const sessions = new SessionService(config, input.stateStore, input.state, { stateMutex });
  let runnerCalls = 0;
  const control = new ControlService({
    agent: {
      chat: async () => {
        runnerCalls += 1;
        return input.chat ? await input.chat() : { text: "done" };
      },
    },
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
    state: input.state,
    stateStore: input.stateStore,
    sessions,
    control: kernel,
    sqlitePath: input.sqlitePath,
    releaseOwnedSession: createProductionOwnedSessionRelease({
      sessions,
      transport: { async deleteSession() {}, async releaseLogicalSession() {} },
    }),
    autoKick: true,
    stateMutex,
  });
  kernel.bindConversationRuntime(runtime);
  const asAppRuntime = (): AppRuntime => ({
    agent: {} as never,
    router: {} as never,
    sessions,
    sessionResources: {} as never,
    activeTurns: { isActiveAnywhere: () => false } as never,
    stateStore: {} as never,
    configStore: {} as never,
    scheduled: {
      service: {} as never,
      scheduler: { start: async () => {}, stop: () => {} },
    } as never,
    logger: createNoopAppLogger(),
    perfTracer: {} as never,
    quota: {} as never,
    transport: {} as never,
    orchestration: {
      service: { reconcileParallelSlots: async () => {} },
      server: { start: async () => {}, stop: async () => {} },
    } as never,
    agentMessaging: {} as never,
    control,
    conversations: runtime,
    reapStaleQueueOwners: async () => {},
    dispose: async () => {
      await runtime.shutdown();
    },
    configMutationMutex: { run: async (fn: () => Promise<unknown>) => await fn() } as never,
  });
  return { runtime, control, sessions, state: input.state, asAppRuntime, runnerCalls: () => runnerCalls };
}

const lockConflict = () =>
  new ActiveConsumerLockError("held", "/tmp/lock", {
    pid: 1,
    mode: "daemon",
    startedAt: "t",
    configPath: "/cfg",
    statePath: "/state",
  });

test("losing process buildApp does not claim or execute durable Conversation work", async () => {
  const dir = mkdtempSync(join(tmpdir(), "xacpx-lock-"));
  const sqlitePath = join(dir, "conversations.sqlite");
  const stateStore = new MemoryStateStore();
  const seeder = await compose({ sqlitePath, state: createEmptyState(), stateStore });
  const bot = await seeder.control.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  const accepted = await seeder.control.promptConversation({
    conversationId: createDirectConversationId(bot.id),
    topicId: createDirectTopicId(bot.id),
    requestId: "req-pending",
    text: "hello",
  });
  expect(seeder.runtime.store.getDispatchForRun(accepted.run.id)?.state).toBe("pending");
  expect(seeder.runnerCalls()).toBe(0);
  expect(Object.keys(seeder.state.sessions)).toHaveLength(0);
  await seeder.runtime.shutdown();

  const restored = structuredClone(stateStore.saved.at(-1)!);
  const losingStore = new MemoryStateStore();
  losingStore.saved = [structuredClone(restored)];
  const losing = await compose({ sqlitePath, state: restored, stateStore: losingStore });
  const events: string[] = [];
  await expect(runConsole(
    { configPath: join(dir, "config.json"), statePath: join(dir, "state.json") },
    {
      buildApp: async () => {
        events.push("buildApp");
        return losing.asAppRuntime();
      },
      channels: {
        startAll: async () => {
          events.push("channel:start");
        },
      },
      consumerLock: {
        acquire: async () => {
          events.push("lock:fail");
          throw lockConflict();
        },
        release: async () => {
          events.push("lock:release");
        },
      },
    },
  )).rejects.toBeInstanceOf(ActiveConsumerLockError);
  expect(events).toEqual(["buildApp", "lock:fail"]);
  expect(losing.runnerCalls()).toBe(0);
  const afterLose = await SqliteConversationStore.open(sqlitePath);
  expect(afterLose.getDispatchForRun(accepted.run.id)?.state).toBe("pending");
  expect(afterLose.getDispatchForRun(accepted.run.id)?.owner).toBeUndefined();
  expect(afterLose.getRun(accepted.run.id)?.state).toBe("queued");
  afterLose.close();

  const winnerState = structuredClone(restored);
  const winner = await compose({ sqlitePath, state: winnerState, stateStore: new MemoryStateStore() });
  const winEvents: string[] = [];
  await runConsole(
    { configPath: join(dir, "config.json"), statePath: join(dir, "state.json") },
    {
      buildApp: async () => winner.asAppRuntime(),
      channels: {
        startAll: async () => {
          winEvents.push("channel:start");
        },
      },
      consumerLock: {
        acquire: async () => {
          winEvents.push("lock:acquire");
        },
        release: async () => {
          winEvents.push("lock:release");
        },
      },
    },
  );
  expect(winEvents[0]).toBe("lock:acquire");
  expect(winEvents).toContain("channel:start");
  expect(winner.runnerCalls()).toBe(1);
  const afterWin = await SqliteConversationStore.open(sqlitePath);
  expect(afterWin.getRun(accepted.run.id)?.state).toBe("completed");
  expect(afterWin.getMemberTurn(accepted.memberTurn.id)?.origin).toBe("recovery");
  afterWin.close();
});

test("activateAfterConsumerLock does not mark the consumer activated when kick throws", async () => {
  const dir = mkdtempSync(join(tmpdir(), "xacpx-activate-gate-"));
  const sqlitePath = join(dir, "conversations.sqlite");
  const stateStore = new MemoryStateStore();
  const seeder = await compose({ sqlitePath, state: createEmptyState(), stateStore });
  const bot = await seeder.control.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  const conversationId = createDirectConversationId(bot.id);
  const topicId = createDirectTopicId(bot.id);
  await seeder.runtime.shutdown();

  const restored = structuredClone(stateStore.saved.at(-1)!);
  const failing = await compose({ sqlitePath, state: restored, stateStore: new MemoryStateStore() });
  failing.runtime.dispatcher.kick = async () => {
    throw new Error("injected recovery failure");
  };
  await expect(failing.runtime.activateAfterConsumerLock()).rejects.toMatchObject({
    message: "injected recovery failure",
  });
  expect(failing.runtime.runs.isConsumerActivated()).toBe(false);
  await expect(failing.control.promptConversation({
    conversationId,
    topicId,
    requestId: "req-after-failed-activate",
    text: "hello",
  })).rejects.toMatchObject({ code: "conversations_unavailable" });
  expect(failing.runnerCalls()).toBe(0);
  const store = await SqliteConversationStore.open(sqlitePath);
  expect(store.listRuns(conversationId)).toEqual([]);
  store.close();
  await failing.runtime.shutdown();
});

test("initial recovery kick failure leaves Conversation unavailable and does not accept new work", async () => {
  const dir = mkdtempSync(join(tmpdir(), "xacpx-activate-fail-"));
  const sqlitePath = join(dir, "conversations.sqlite");
  const stateStore = new MemoryStateStore();
  const seeder = await compose({ sqlitePath, state: createEmptyState(), stateStore });
  const bot = await seeder.control.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  const conversationId = createDirectConversationId(bot.id);
  const topicId = createDirectTopicId(bot.id);
  await seeder.runtime.shutdown();

  const restored = structuredClone(stateStore.saved.at(-1)!);
  const failing = await compose({ sqlitePath, state: restored, stateStore: new MemoryStateStore() });
  failing.runtime.dispatcher.kick = async () => {
    throw new Error("injected recovery failure");
  };
  const events: string[] = [];
  const logs: string[] = [];
  const app = failing.asAppRuntime();
  app.logger = {
    ...failing.asAppRuntime().logger,
    error: async (event: string) => {
      logs.push(event);
    },
  } as never;
  await runConsole(
    { configPath: join(dir, "config.json"), statePath: join(dir, "state.json") },
    {
      buildApp: async () => {
        events.push("buildApp");
        return app;
      },
      channels: {
        startAll: async () => {
          events.push("channel:start");
          expect(failing.runtime.runs.isConsumerActivated()).toBe(false);
          expect(failing.runnerCalls()).toBe(0);
          await expect(failing.control.promptConversation({
            conversationId,
            topicId,
            requestId: "req-after-failed-activate",
            text: "hello",
          })).rejects.toMatchObject({ code: "conversations_unavailable" });
          expect(failing.runtime.runs.isConsumerActivated()).toBe(false);
          expect(failing.runnerCalls()).toBe(0);
          const store = await SqliteConversationStore.open(sqlitePath);
          expect(store.listRuns(conversationId)).toEqual([]);
          store.close();
        },
      },
      consumerLock: {
        acquire: async () => {
          events.push("lock:acquire");
        },
        release: async () => {
          events.push("lock:release");
        },
      },
    },
  );
  expect(events[0]).toBe("buildApp");
  expect(events).toContain("lock:acquire");
  expect(events).toContain("channel:start");
  expect(logs).toContain("conversations.recover_failed");
});
