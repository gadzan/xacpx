import { mkdtempSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";

import type { AppConfig } from "../../../src/config/types";
import { ControlService, conversationKernel } from "../../../src/control/control-service";
import { createControlEventBus } from "../../../src/control/control-event-bus";
import {
  createConversationRuntime,
  createProductionOwnedSessionRelease,
} from "../../../src/conversations/conversation-composition";
import { AsyncMutex } from "../../../src/orchestration/async-mutex";
import { SessionService } from "../../../src/sessions/session-service";
import { createEmptyState, type AppState } from "../../../src/state/types";
import type { ChatRequest } from "../../../src/weixin/agent/interface";

const NOW = "2026-10-22T12:00:00.000Z";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

class MemoryStateStore {
  public saved: AppState[] = [];
  constructor(private readonly failPersist = false) {}
  async save(state: AppState): Promise<void> {
    if (this.failPersist) throw new Error("state persist failed");
    this.saved.push(structuredClone(state));
  }
  async saveNow(state: AppState): Promise<void> {
    if (this.failPersist) throw new Error("state persist failed");
    this.saved.push(structuredClone(state));
  }
}

function createConfig(): AppConfig {
  return {
    transport: { type: "acpx-cli", permissionMode: "approve-all", nonInteractivePermissions: "deny" },
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

async function wire(options?: {
  transaction?: boolean;
  createWorkspace?: () => Promise<never>;
  failPersist?: boolean;
}) {
  const dir = mkdtempSync(join(tmpdir(), "xacpx-bot-ws-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const botsHome = join(dir, "bots-home");
  const state = createEmptyState();
  const stateStore = new MemoryStateStore(options?.failPersist);
  const config = createConfig();
  const now = () => new Date(NOW);
  const stateMutex = new AsyncMutex();
  const sessions = new SessionService(config, stateStore, state, {
    now: () => now().getTime(),
    stateMutex,
  });
  const events = createControlEventBus();
  const registry = {
    list: () => Object.entries(config.workspaces).map(([name, workspace]) => ({ name, ...workspace })),
    create: options?.createWorkspace ?? (async (name: string, cwd: string, description?: string) => {
      config.workspaces[name] = { cwd, ...(description ? { description } : {}) };
      return { name, cwd, ...(description ? { description } : {}) };
    }),
    remove: async (name: string) => {
      delete config.workspaces[name];
    },
  };
  const configMutex = new AsyncMutex();
  const control = new ControlService({
    agents: { resolveCapabilityContext: () => undefined },
    agent: { chat: async (_request: ChatRequest) => ({ text: "reply" }) },
    sessions,
    activeTurns: { isActiveAnywhere: () => false },
    scheduled: {} as never,
    orchestration: {} as never,
    events,
    workspaces: {
      ...registry,
      ...(options?.transaction === false
        ? {}
        : {
            transaction: <T,>(fn: (inner: typeof registry) => Promise<T>) => configMutex.run(() => fn(registry)),
          }),
    },
    botsHomeRoot: botsHome,
    uploadStore: { save: async () => ({ id: "u", path: "/tmp/u", filename: "f", mimeType: "text/plain", size: 1 }) },
    transport: {} as never,
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
      transport: { deleteSession: async () => {}, releaseLogicalSession: async () => {} },
    }),
    onProductEvent: (event) => kernel.emitConversationProduct(event),
    autoKick: false,
    stateMutex,
    now,
  });
  kernel.bindConversationRuntime(runtime);
  cleanups.push(async () => {
    await runtime.shutdown();
  });
  return { botsHome, config, state, control, runtime };
}

test("omitted workspace allocates an owner-only directory, registers it, and persists the Bot", async () => {
  const w = await wire();
  const bot = await w.control.createBot({ name: "Reviewer", agent: "codex" });
  expect(bot.workspace).toBe("Reviewer");
  const workspace = bot.workspace;
  expect(readdirSync(w.botsHome)).toEqual([workspace]);
  if (process.platform !== "win32") {
    expect(statSync(join(w.botsHome, workspace)).mode & 0o777).toBe(0o700);
  }
  expect(w.config.workspaces[workspace]).toEqual({
    cwd: join(w.botsHome, workspace),
    description: "Bot default workspace for Reviewer",
  });
  expect(w.control.listBots().map((row) => row.workspace)).toEqual([workspace]);
  expect(w.state.bots[bot.id]?.workspace).toBe(workspace);
});

test("explicit workspace keeps the caller's choice and allocates nothing", async () => {
  const w = await wire();
  const bot = await w.control.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  expect(bot.workspace).toBe("backend");
  expect(existsSync(w.botsHome)).toBe(false);
  expect(Object.keys(w.config.workspaces)).toEqual(["backend"]);
});

test("concurrent same-name creations get distinct directories and workspace names", async () => {
  for (const transaction of [true, false]) {
    const w = await wire({ transaction });
    const [a, b] = await Promise.all([
      w.control.createBot({ name: "Same", agent: "codex" }),
      w.control.createBot({ name: "Same", agent: "codex" }),
    ]);
    expect(a.workspace).not.toBe(b.workspace);
    expect([a.workspace, b.workspace].sort()).toEqual(["Same", "Same-2"]);
    expect(readdirSync(w.botsHome).sort()).toEqual(["Same", "Same-2"]);
    expect(Object.keys(w.config.workspaces).sort()).toEqual(["Same", "Same-2", "backend"]);
    expect(w.control.listBots().map((row) => row.workspace).sort()).toEqual(["Same", "Same-2"]);
  }
});

test("a failed Bot persistence rolls back the directory and registration it created", async () => {
  const w = await wire({ failPersist: true });
  await expect(w.control.createBot({ name: "Reviewer", agent: "codex" }))
    .rejects.toThrow("state persist failed");
  expect(readdirSync(w.botsHome)).toEqual([]);
  expect(Object.keys(w.config.workspaces)).toEqual(["backend"]);
  expect(w.control.listBots()).toEqual([]);
  expect(w.state.bots).toEqual({});
});

test("a rejected Bot identity also rolls back its allocated workspace", async () => {
  const w = await wire();
  await expect(w.control.createBot({ name: "Ghost", agent: "unregistered" }))
    .rejects.toMatchObject({ code: "agent_not_registered" });
  expect(readdirSync(w.botsHome)).toEqual([]);
  expect(Object.keys(w.config.workspaces)).toEqual(["backend"]);
});

test("a failed workspace registration removes the directory it just created", async () => {
  const w = await wire({
    createWorkspace: async () => {
      throw new Error("config write failed");
    },
  });
  await expect(w.control.createBot({ name: "Reviewer", agent: "codex" }))
    .rejects.toThrow("config write failed");
  expect(readdirSync(w.botsHome)).toEqual([]);
  expect(Object.keys(w.config.workspaces)).toEqual(["backend"]);
  expect(w.control.listBots()).toEqual([]);
});

test("names that sanitize to traversal or prototype keys never escape the bots root", async () => {
  const w = await wire();
  const created: string[] = [];
  for (const [name, expected] of [
    ["__proto__", "__proto__-2"],
    ["constructor", "constructor-2"],
    ["prototype", "prototype-2"],
  ] as const) {
    const bot = await w.control.createBot({ name, agent: "codex" });
    expect(bot.workspace).toBe(expected);
    expect(w.config.workspaces[expected]?.cwd).toBe(join(w.botsHome, expected));
    created.push(expected);
  }
  expect(readdirSync(w.botsHome).sort()).toEqual(created.sort());
});

test("pre-existing directories and symlinks at candidate names are never reused", async () => {
  const w = await wire();
  for (const name of ["Reviewer", "Reviewer-2"]) {
    mkdirSync(join(w.botsHome, name), { recursive: true });
  }
  const outside = mkdtempSync(join(tmpdir(), "xacpx-outside-"));
  cleanups.push(() => rmSync(outside, { recursive: true, force: true }));
  symlinkSync(outside, join(w.botsHome, "Reviewer-3"));
  const bot = await w.control.createBot({ name: "Reviewer", agent: "codex" });
  expect(bot.workspace).toBe("Reviewer-4");
  expect(readdirSync(outside)).toEqual([]);
  expect(w.config.workspaces).toEqual({
    backend: { cwd: "/tmp/backend" },
    "Reviewer-4": { cwd: join(w.botsHome, "Reviewer-4"), description: "Bot default workspace for Reviewer" },
  });
});

test("an explicit blank workspace is rejected instead of silently auto-created", async () => {
  const w = await wire();
  await expect(w.control.createBot({ name: "Reviewer", agent: "codex", workspace: "" }))
    .rejects.toMatchObject({ code: "workspace_not_registered" });
  expect(existsSync(w.botsHome)).toBe(false);
  expect(Object.keys(w.config.workspaces)).toEqual(["backend"]);
});

test("a Bot name with no letters or digits is rejected before any workspace is allocated", async () => {
  const w = await wire();
  for (const name of ["!!!", ".", "..", "..."]) {
    await expect(w.control.createBot({ name, agent: "codex" }))
      .rejects.toMatchObject({ name: "BotError", code: "workspace_name_underivable", details: { field: "workspace" } });
  }
  expect(existsSync(w.botsHome)).toBe(false);
  expect(Object.keys(w.config.workspaces)).toEqual(["backend"]);
  expect(w.control.listBots()).toEqual([]);
});

test("a symbols-only Bot name still works with an explicit workspace", async () => {
  const w = await wire();
  const bot = await w.control.createBot({ name: "!!!", agent: "codex", workspace: "backend" });
  expect(bot.workspace).toBe("backend");
  expect(existsSync(w.botsHome)).toBe(false);
});

test("an all-CJK Bot name gets an opaque dedicated workspace", async () => {
  const w = await wire();
  const bot = await w.control.createBot({ name: "代码审查", agent: "codex" });
  expect(bot.workspace).toMatch(/^workspace-[0-9a-f]{8}$/);
  expect(readdirSync(w.botsHome)).toEqual([bot.workspace]);
});
