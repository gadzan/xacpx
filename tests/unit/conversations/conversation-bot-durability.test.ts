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
import { createDirectConversationId, createDirectTopicId } from "../../../src/domain/ids";
import { AsyncMutex } from "../../../src/orchestration/async-mutex";
import { SessionService } from "../../../src/sessions/session-service";
import { createEmptyState, type AppState } from "../../../src/state/types";

class CrashShapeStore {
  public disk: AppState;
  public saveCalls = 0;
  public saveNowCalls = 0;

  constructor(initial: AppState) {
    this.disk = structuredClone(initial);
  }

  async save(_state: AppState): Promise<void> {
    this.saveCalls += 1;
  }

  async saveNow(state: AppState): Promise<void> {
    this.saveNowCalls += 1;
    this.disk = structuredClone(state);
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

async function boot(sqlitePath: string, state: AppState, store: CrashShapeStore) {
  const config = createConfig();
  const stateMutex = new AsyncMutex();
  const sessions = new SessionService(config, store, state, { stateMutex });
  const control = new ControlService({
    agent: { chat: async () => ({ text: "done" }) },
    sessions,
    activeTurns: { isActiveAnywhere: () => false },
    scheduled: {} as never,
    orchestration: {} as never,
    events: createControlEventBus(),
    workspaces: {
      list: () => [{ name: "backend", cwd: "/tmp/backend" }, { name: "frontend", cwd: "/tmp/frontend" }],
      create: async () => ({ name: "backend", cwd: "/tmp/backend" }),
      remove: async () => {},
    },
    uploadStore: { save: async () => ({ id: "u", path: "/tmp/u", filename: "f", mimeType: "text/plain", size: 1 }) },
  } as never);
  const kernel = conversationKernel(control);
  const runtime = await createConversationRuntime({
    config,
    state,
    stateStore: store,
    sessions,
    control: kernel,
    sqlitePath,
    releaseOwnedSession: createProductionOwnedSessionRelease({
      sessions,
      transport: { async deleteSession() {}, async releaseLogicalSession() {} },
    }),
    autoKick: false,
    stateMutex,
  });
  kernel.bindConversationRuntime(runtime);
  return { control, runtime, state };
}

test("createBot+accept cannot leave SQLite work without a durable Bot", async () => {
  const dir = mkdtempSync(join(tmpdir(), "xacpx-botdur-"));
  const sqlitePath = join(dir, "conversations.sqlite");
  const live = createEmptyState();
  const store = new CrashShapeStore(createEmptyState());
  const first = await boot(sqlitePath, live, store);
  expect(Object.keys(store.disk.bots)).toHaveLength(0);

  const bot = await first.control.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  expect(store.saveNowCalls).toBeGreaterThan(0);
  expect(store.disk.bots[bot.id]?.name).toBe("Reviewer");
  const accepted = await first.control.promptConversation({
    conversationId: createDirectConversationId(bot.id),
    topicId: createDirectTopicId(bot.id),
    requestId: "req-create",
    text: "hello",
  });
  await first.runtime.shutdown();

  const restartedState = structuredClone(store.disk);
  const restarted = await boot(sqlitePath, restartedState, new CrashShapeStore(store.disk));
  expect(restarted.control.getBot(bot.id).id).toBe(bot.id);
  expect(restarted.control.getRun(accepted.run.id).state).toBe("queued");
  await restarted.runtime.shutdown();
});

test("updateBot+accept cannot leave SQLite snapshot ahead of durable Bot identity", async () => {
  const dir = mkdtempSync(join(tmpdir(), "xacpx-botupd-"));
  const sqlitePath = join(dir, "conversations.sqlite");
  const live = createEmptyState();
  const store = new CrashShapeStore(createEmptyState());
  const first = await boot(sqlitePath, live, store);
  const bot = await first.control.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  const saveNowAfterCreate = store.saveNowCalls;
  const updated = await first.control.updateBot(bot.id, { agent: "claude", workspace: "frontend" });
  expect(store.saveNowCalls).toBeGreaterThan(saveNowAfterCreate);
  expect(store.disk.bots[bot.id]?.agent).toBe("claude");
  expect(store.disk.bots[bot.id]?.workspace).toBe("frontend");
  const accepted = await first.control.promptConversation({
    conversationId: createDirectConversationId(bot.id),
    topicId: createDirectTopicId(bot.id),
    requestId: "req-update",
    text: "hello",
  });
  expect(accepted.run.profileRevision).toBe(updated.profileRevision);
  await first.runtime.shutdown();

  const restarted = await boot(sqlitePath, structuredClone(store.disk), new CrashShapeStore(store.disk));
  expect(restarted.control.getBot(bot.id).agent).toBe("claude");
  expect(restarted.control.getBot(bot.id).workspace).toBe("frontend");
  const run = restarted.runtime.store.getRun(accepted.run.id);
  expect(run?.profileSnapshot.execution.agent).toBe("claude");
  expect(run?.profileSnapshot.execution.workspace).toBe("frontend");
  await restarted.runtime.shutdown();
});

test("createBot does not publish live state when saveNow fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "xacpx-botsave-"));
  const sqlitePath = join(dir, "conversations.sqlite");
  const live = createEmptyState();
  const store = new CrashShapeStore(createEmptyState());
  store.saveNow = async () => {
    store.saveNowCalls += 1;
    throw new Error("disk full");
  };
  const first = await boot(sqlitePath, live, store);
  await expect(first.control.createBot({
    name: "Reviewer",
    agent: "codex",
    workspace: "backend",
  })).rejects.toThrow("disk full");
  expect(Object.keys(live.bots)).toHaveLength(0);
  await first.runtime.shutdown();
});
