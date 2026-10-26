import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";

import type { AppConfig } from "../../../src/config/types";
import { ControlService, conversationKernel } from "../../../src/control/control-service";
import { asPublicControl } from "../../../src/control/public-control";
import { createControlEventBus } from "../../../src/control/control-event-bus";
import {
  createConversationRuntime,
  createProductionOwnedSessionRelease,
} from "../../../src/conversations/conversation-composition";
import { AsyncMutex } from "../../../src/orchestration/async-mutex";
import { WorkspaceRemovalRefusedError } from "../../../src/config/workspace-removal";
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
  takeoverCwd?: string;
  removeWorkspace?: (name: string) => Promise<never>;
  logger?: { error: (event: string, message: string, context?: Record<string, unknown>) => Promise<void> };
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
      const registered = options?.takeoverCwd ?? cwd;
      config.workspaces[name] = { cwd: registered, ...(description ? { description } : {}) };
      return { name, cwd: registered, ...(description ? { description } : {}) };
    }),
    remove: options?.removeWorkspace ?? (async (name: string) => {
      delete config.workspaces[name];
    }),
  };
  const configMutex = new AsyncMutex();
  const control = new ControlService({
    now: () => now().getTime(),
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
    ...(options?.logger ? { logger: options.logger } : {}),
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

test("a Bot rolled back while its workspace is occupied keeps the registration and directory", async () => {
  const w = await wire({
    removeWorkspace: async () => {
      throw new WorkspaceRemovalRefusedError(
        "in_use",
        "Reviewer",
        'workspace "Reviewer" is still used by sessions: squatter; remove those sessions first',
      );
    },
  });
  const failure = await w.control.createBot({ name: "Reviewer", agent: "unregistered" }).catch((error: unknown) => error);
  expect(failure).toMatchObject({ code: "agent_not_registered" });
  expect(readdirSync(w.botsHome)).toEqual(["Reviewer"]);
  expect(w.config.workspaces["Reviewer"]).toMatchObject({
    cwd: join(w.botsHome, "Reviewer"),
    description: "Bot default workspace for Reviewer",
  });
  expect(w.control.listBots()).toEqual([]);
});
test("a Bot rolled back over a replaced cwd keeps the registration and directory", async () => {
  const w = await wire({
    removeWorkspace: async () => {
      throw new WorkspaceRemovalRefusedError(
        "cwd_mismatch",
        "Reviewer",
        'workspace "Reviewer" no longer points at the expected directory; leaving it alone',
      );
    },
  });
  const failure = await w.control.createBot({ name: "Reviewer", agent: "unregistered" }).catch((error: unknown) => error);
  expect(failure).toMatchObject({ code: "agent_not_registered" });
  expect(w.config.workspaces["Reviewer"]).toMatchObject({ cwd: join(w.botsHome, "Reviewer") });
  expect(readdirSync(w.botsHome)).toEqual(["Reviewer"]);
  expect(w.control.listBots()).toEqual([]);
});

test("a Bot rolled back over a taken-over registration keeps that registration", async () => {
  const foreign = "/tmp/foreign-owner";
  const w = await wire({ takeoverCwd: foreign });
  await expect(w.control.createBot({ name: "Reviewer", agent: "unregistered" }))
    .rejects.toMatchObject({ code: "agent_not_registered" });
  expect(w.config.workspaces["Reviewer"]).toEqual({ cwd: foreign, description: "Bot default workspace for Reviewer" });
  expect(readdirSync(w.botsHome)).toEqual([]);
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
  for (const name of ["!!!", "🤖", ".", "..", "..."]) {
    await expect(w.control.createBot({ name, agent: "codex" })).rejects.toMatchObject({
      name: "BotError",
      code: "workspace_name_underivable",
      message: "Name needs a letter or number, or pick a workspace.",
      details: { field: "workspace" },
    });
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

test("the core advertises dedicated Bot workspaces through the public control facade", async () => {
  const w = await wire();
  const publicControl = asPublicControl(w.control) as unknown as { supportsBotDedicatedWorkspace?: () => unknown };
  expect("supportsBotDedicatedWorkspace" in publicControl).toBe(true);
  expect(publicControl.supportsBotDedicatedWorkspace?.()).toBe(true);
});

test("an emoji-only Bot name still works with an explicit workspace", async () => {
  const w = await wire();
  const bot = await w.control.createBot({ name: "🤖", agent: "codex", workspace: "backend" });
  expect(bot.workspace).toBe("backend");
  expect(existsSync(w.botsHome)).toBe(false);
});

test("an auto-allocated workspace is recorded as a dedicated-workspace marker on the Bot", async () => {
  const w = await wire();
  const bot = await w.control.createBot({ name: "Reviewer", agent: "codex" });
  expect(w.state.bots[bot.id]?.dedicatedWorkspace).toEqual({
    name: "Reviewer",
    cwd: join(w.botsHome, "Reviewer"),
    createdAt: NOW,
  });
  expect(bot.workspace).toBe("Reviewer");
});

test("a user-chosen workspace leaves the Bot without a dedicated-workspace marker", async () => {
  const w = await wire();
  const bot = await w.control.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  expect(w.state.bots[bot.id]?.dedicatedWorkspace).toBeUndefined();
  expect(existsSync(w.botsHome)).toBe(false);
});

test("a dedicatedWorkspace key smuggled through the public payload is ignored", async () => {
  const w = await wire();
  const smuggled = { name: "Evil", cwd: "/etc", createdAt: NOW };
  // The relay protocol passes unknown keys through, so the core must not trust one.
  const chosen = await w.control.createBot({
    name: "Chosen", agent: "codex", workspace: "backend", dedicatedWorkspace: smuggled,
  } as never);
  expect(w.state.bots[chosen.id]?.dedicatedWorkspace).toBeUndefined();

  const auto = await w.control.createBot({
    name: "Auto", agent: "codex", dedicatedWorkspace: smuggled,
  } as never);
  expect(w.state.bots[auto.id]?.dedicatedWorkspace).toEqual({
    name: "Auto",
    cwd: join(w.botsHome, "Auto"),
    createdAt: NOW,
  });
});

interface BotWorkspaceHarness {
  botsHome: string;
  config: AppConfig;
  state: AppState;
  control: ControlService;
  runtime: Awaited<ReturnType<typeof createConversationRuntime>>;
}

async function removeBot(
  w: BotWorkspaceHarness,
  botId: string,
  requestId: string,
  flags?: { deleteDedicatedWorkspace?: boolean },
) {
  const impact = await w.control.previewBotRemoval(botId);
  return w.control.removeBot({
    botId,
    requestId,
    previewRevision: impact.revision,
    deleteDedicatedWorkspace: flags?.deleteDedicatedWorkspace === true,
  });
}

test("preview reports the dedicated workspace and whether something still keeps it", async () => {
  const w = await wire();
  const bot = await w.control.createBot({ name: "Reviewer", agent: "codex" });
  const dir = join(w.botsHome, "Reviewer");
  expect((await w.control.previewBotRemoval(bot.id)).dedicatedWorkspace).toEqual({
    name: "Reviewer",
    path: dir,
    inUse: false,
  });

  w.state.sessions["stray"] = {
    alias: "stray",
    agent: "codex",
    workspace: "Reviewer",
    transport_session: "Reviewer:stray",
    logical_session_id: "55555555-5555-4555-8555-555555555555",
    created_at: NOW,
    last_used_at: NOW,
  };
  expect((await w.control.previewBotRemoval(bot.id)).dedicatedWorkspace?.inUse).toBe(true);
});

test("a Bot without a marker reports no dedicated workspace in the preview", async () => {
  const w = await wire();
  const bot = await w.control.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  expect((await w.control.previewBotRemoval(bot.id)).dedicatedWorkspace).toBeUndefined();
});

test("removing a Bot with deleteDedicatedWorkspace deletes the directory and unregisters it", async () => {
  const w = await wire();
  const bot = await w.control.createBot({ name: "Reviewer", agent: "codex" });
  const dir = join(w.botsHome, "Reviewer");
  expect(existsSync(dir)).toBe(true);

  const removed = await removeBot(w, bot.id, "rm-delete", { deleteDedicatedWorkspace: true });
  expect(removed.operation.phase).toBe("completed");
  expect(removed.operation.workspaceCleanup).toEqual({ outcome: "deleted", path: dir });
  expect(existsSync(dir)).toBe(false);
  expect(w.config.workspaces["Reviewer"]).toBeUndefined();
  expect(w.state.bots[bot.id]).toBeUndefined();
  expect(w.control.getLifecycleOperation(removed.operation.id).workspaceCleanup)
    .toEqual({ outcome: "deleted", path: dir });
});

test("removing a Bot without the flag keeps the directory and its registration", async () => {
  const w = await wire();
  const bot = await w.control.createBot({ name: "Reviewer", agent: "codex" });
  const dir = join(w.botsHome, "Reviewer");

  const removed = await removeBot(w, bot.id, "rm-keep");
  expect(removed.operation.phase).toBe("completed");
  expect(removed.operation.workspaceCleanup).toBeUndefined();
  expect(existsSync(dir)).toBe(true);
  expect(w.config.workspaces["Reviewer"]?.cwd).toBe(dir);
});

test("a Bot that switched away from its dedicated workspace keeps the directory", async () => {
  const w = await wire();
  const bot = await w.control.createBot({ name: "Reviewer", agent: "codex" });
  const dir = join(w.botsHome, "Reviewer");
  await w.control.updateBot(bot.id, { workspace: "backend" });

  const removed = await removeBot(w, bot.id, "rm-switched", { deleteDedicatedWorkspace: true });
  expect(removed.operation.workspaceCleanup).toBeUndefined();
  expect(existsSync(dir)).toBe(true);
  expect(w.config.workspaces["Reviewer"]?.cwd).toBe(dir);
});

test("a directory still referenced by another Bot, a topic, a task, or a worktree is kept", async () => {
  for (const reference of ["bot", "topic", "task", "worktree"] as const) {
    const w = await wire();
    const bot = await w.control.createBot({ name: "Reviewer", agent: "codex" });
    const dir = join(w.botsHome, "Reviewer");
    if (reference === "bot") {
      await w.control.createBot({ name: "Second", agent: "codex", workspace: "Reviewer" });
    }
    if (reference === "topic") {
      w.state.conversation_topics["topic_x"] = {
        id: "topic_x",
        conversationId: "group_x",
        title: "Sprint",
        status: "active",
        executionTarget: { workspace: "Reviewer", isolation: "shared-single-writer" },
        createdAt: NOW,
        updatedAt: NOW,
      } as never;
    }
    if (reference === "task") {
      w.state.scheduled_tasks["task_x"] = {
        id: "task_x",
        chat_key: "wx:user",
        session_alias: "stray",
        session_mode: "temp",
        agent: "codex",
        workspace: "Reviewer",
        execute_at: NOW,
        message: "later",
        status: "pending",
        created_at: NOW,
      };
    }
    if (reference === "worktree") {
      w.runtime.store.worktrees.create(
        "run_x",
        "group_x",
        "topic_x",
        {
          workspace: "Reviewer",
          sourceRoot: dir,
          commonDir: join(dir, ".git"),
          repositoryIdentity: "abc",
          baseCommitSha: "a".repeat(40),
        },
        NOW,
      );
    }

    const removed = await removeBot(w, bot.id, `rm-${reference}`, { deleteDedicatedWorkspace: true });
    expect(removed.operation.workspaceCleanup).toEqual({
      outcome: "kept",
      path: dir,
      code: "workspace_in_use",
    });
    expect(existsSync(dir)).toBe(true);
    expect(w.config.workspaces["Reviewer"]?.cwd).toBe(dir);
    expect(w.state.bots[bot.id]).toBeUndefined();
  }
});

test("a registry entry that moved off the marker cwd keeps the directory", async () => {
  const w = await wire();
  const bot = await w.control.createBot({ name: "Reviewer", agent: "codex" });
  const dir = join(w.botsHome, "Reviewer");
  w.config.workspaces["Reviewer"] = { cwd: "/tmp/somewhere-else" };

  const removed = await removeBot(w, bot.id, "rm-moved", { deleteDedicatedWorkspace: true });
  expect(removed.operation.workspaceCleanup).toEqual({
    outcome: "kept",
    path: dir,
    code: "cwd_mismatch",
  });
  expect(existsSync(dir)).toBe(true);
});

test("a marker whose directory is a symlink keeps the directory", async () => {
  const w = await wire();
  const bot = await w.control.createBot({ name: "Reviewer", agent: "codex" });
  const dir = join(w.botsHome, "Reviewer");
  const elsewhere = join(w.botsHome, "elsewhere");
  mkdirSync(elsewhere);
  rmSync(dir, { recursive: true });
  symlinkSync(elsewhere, dir);

  const removed = await removeBot(w, bot.id, "rm-symlink", { deleteDedicatedWorkspace: true });
  expect(removed.operation.workspaceCleanup).toEqual({
    outcome: "kept",
    path: dir,
    code: "symlink",
  });
  expect(existsSync(elsewhere)).toBe(true);
});

test("a marker pointing outside the bots root keeps the directory", async () => {
  const w = await wire();
  mkdirSync(w.botsHome, { recursive: true });
  const outside = join(w.botsHome, "..", "outside");
  mkdirSync(outside, { recursive: true });
  w.config.workspaces["outside"] = { cwd: outside };
  const bot = await w.control.createBot({ name: "Reviewer", agent: "codex", workspace: "outside" });
  w.state.bots[bot.id]!.dedicatedWorkspace = { name: "outside", cwd: outside, createdAt: NOW };

  const removed = await removeBot(w, bot.id, "rm-outside", { deleteDedicatedWorkspace: true });
  expect(removed.operation.workspaceCleanup).toEqual({
    outcome: "kept",
    path: outside,
    code: "outside_root",
  });
  expect(existsSync(outside)).toBe(true);
});

test("a cleanup that cannot delete the directory reports failed and leaves the Bot retired", async () => {
  const errors: Array<{ event: string; context?: Record<string, unknown> }> = [];
  const w = await wire({
    logger: {
      error: async (event, _message, context) => {
        errors.push({ event, context });
      },
    },
  });
  const bot = await w.control.createBot({ name: "Reviewer", agent: "codex" });
  const dir = join(w.botsHome, "Reviewer");
  chmodSync(w.botsHome, 0o500);
  try {
    const removed = await removeBot(w, bot.id, "rm-failed", { deleteDedicatedWorkspace: true });
    expect(removed.operation.phase).toBe("completed");
    expect(removed.operation.workspaceCleanup?.outcome).toBe("failed");
    expect(removed.operation.workspaceCleanup?.path).toBe(dir);
    expect(w.state.bots[bot.id]).toBeUndefined();
    // The registry entry is already unregistered when the removal fails, so
    // the directory is orphaned and the operator sees the path in the log.
    expect(w.config.workspaces["Reviewer"]).toBeUndefined();
    expect(existsSync(dir)).toBe(true);
    expect(errors).toEqual([{
      event: "bot.remove.workspace_cleanup_failed",
      context: { botId: bot.id, name: "Reviewer", path: dir, error: "cleanup_failed" },
    }]);
  } finally {
    chmodSync(w.botsHome, 0o700);
  }
});

test("a registry refusal inside the transaction reports its reason and keeps the directory", async () => {
  const w = await wire({
    removeWorkspace: async (name: string) => {
      throw new WorkspaceRemovalRefusedError("cwd_mismatch", name, "moved");
    },
  });
  const bot = await w.control.createBot({ name: "Reviewer", agent: "codex" });
  const dir = join(w.botsHome, "Reviewer");

  const removed = await removeBot(w, bot.id, "rm-refused", { deleteDedicatedWorkspace: true });
  expect(removed.operation.workspaceCleanup).toEqual({
    outcome: "failed",
    path: dir,
    code: "cwd_mismatch",
  });
  expect(existsSync(dir)).toBe(true);
  expect(w.config.workspaces["Reviewer"]?.cwd).toBe(dir);
});

test("a retried removal keeps the workspaceCleanup the first attempt recorded", async () => {
  const w = await wire();
  const bot = await w.control.createBot({ name: "Reviewer", agent: "codex" });
  const dir = join(w.botsHome, "Reviewer");
  const first = await removeBot(w, bot.id, "rm-retry", { deleteDedicatedWorkspace: true });
  expect(first.operation.workspaceCleanup).toEqual({ outcome: "deleted", path: dir });

  const retried = await removeBot(w, bot.id, "rm-retry", { deleteDedicatedWorkspace: true });
  expect(retried.operation.workspaceCleanup).toEqual({ outcome: "deleted", path: dir });
  expect(existsSync(dir)).toBe(false);
});
