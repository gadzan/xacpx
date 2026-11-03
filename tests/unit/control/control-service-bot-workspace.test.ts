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
  /** Mimic ConfigStore loading workspaces with normalized separators. */
  registryCwd?: (cwd: string) => string;
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
  const registryCwd = options?.registryCwd ?? ((cwd: string) => cwd);
  const registry = {
    list: () => Object.entries(config.workspaces).map(([name, workspace]) => ({ name, ...workspace, cwd: registryCwd(workspace.cwd) })),
    create: options?.createWorkspace ?? (async (name: string, cwd: string, description?: string, createOptions?: { dedicated?: boolean }) => {
      const registered = options?.takeoverCwd ?? cwd;
      config.workspaces[name] = { cwd: registered, ...(description ? { description } : {}), ...(createOptions?.dedicated ? { dedicated: true } : {}) };
      return { name, cwd: registryCwd(registered), ...(description ? { description } : {}), ...(createOptions?.dedicated ? { dedicated: true } : {}) };
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
  return { botsHome, config, state, control, runtime, sessions };
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
    dedicated: true,
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
  expect(w.config.workspaces["Reviewer"]).toEqual({ cwd: foreign, description: "Bot default workspace for Reviewer", dedicated: true });
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
    "Reviewer-4": { cwd: join(w.botsHome, "Reviewer-4"), description: "Bot default workspace for Reviewer", dedicated: true },
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

/** The separator this platform does NOT use; see the cleanup-unit helper. */
function nonNativeSeparators(dir: string): string {
  return process.platform === "win32" ? dir.replace(/\\/g, "/") : dir.replace(/\//g, "\\");
}

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
      // Squatting on the dedicated name through the daemon-internal channel:
      // the registry entry is what keeps the directory alive at cleanup.
      const second = await w.control.createBot({ name: "Squatter", agent: "codex" });
      w.state.bots[second.id].workspace = "Reviewer";
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
test("a marker committed while the removal is in flight still gets cleaned up", async () => {
  const w = await wire();
  const bot = await w.control.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  // Deterministic race: removeBot reads the claim from the live profile before
  // the removal barrier exists, so an allocator can still commit a marker in
  // that window. The delegate performs exactly that allocation between the
  // claim read and the real removal, then retires the Bot.
  const realRemove = w.runtime.removals.remove.bind(w.runtime.removals);
  (w.runtime.removals as { remove: typeof realRemove }).remove = async (input) => {
    await w.control.updateBot(bot.id, { dedicatedWorkspace: true });
    return realRemove(input);
  };

  const { operation } = await removeBot(w, bot.id, "rm-race", { deleteDedicatedWorkspace: true });
  expect(operation.workspaceCleanup).toEqual({ outcome: "deleted", path: join(w.botsHome, "Reviewer") });
  expect(existsSync(join(w.botsHome, "Reviewer"))).toBe(false);
  expect(w.config.workspaces["Reviewer"]).toBeUndefined();
});

test("removing a Bot without a dedicated workspace records no workspace cleanup", async () => {
  const w = await wire();
  const bot = await w.control.createBot({ name: "Helper", agent: "codex", workspace: "backend" });
  const { operation } = await removeBot(w, bot.id, "rm-plain");
  expect(operation.workspaceCleanup).toBeUndefined();
});

/** Deterministically fail the first post-barrier cleanup step. */
function failFirstCleanup(w: BotWorkspaceHarness): void {
  const real = w.runtime.runs.cancelDirectExecution.bind(w.runtime.runs);
  let failed = false;
  (w.runtime.runs as { cancelDirectExecution: typeof real }).cancelDirectExecution = async (botId) => {
    if (!failed) {
      failed = true;
      return "indeterminate";
    }
    return real(botId);
  };
}

test("a retried removal honours the delete flag frozen on the operation", async () => {
  const w = await wire();
  const bot = await w.control.createBot({ name: "Reviewer", agent: "codex" });
  const dir = join(w.botsHome, "Reviewer");
  const impact = await w.control.previewBotRemoval(bot.id);
  failFirstCleanup(w);

  // The attempt fails after the barrier, so the operation keeps
  // `deleteDedicatedWorkspace: true` as a frozen param.
  await expect(w.control.removeBot({
    botId: bot.id,
    requestId: "rm-frozen-on",
    previewRevision: impact.revision,
    deleteDedicatedWorkspace: true,
  })).rejects.toMatchObject({ code: "conversation_indeterminate" });

  // The retry arrives with the box unchecked, but the operation already
  // decided to delete: skipping the cleanup would strand the directory, its
  // `dedicated: true` registration, and no workspaceCleanup record.
  const retried = await w.control.removeBot({
    botId: bot.id,
    requestId: "rm-frozen-on",
    previewRevision: impact.revision,
    deleteDedicatedWorkspace: false,
  });
  // The client seeds its controls from this, so the mapping has to carry the
  // frozen decision and not just the live request.
  expect(retried.operation.params).toEqual({
    clearDirectHistory: false,
    releaseDirectBindings: false,
    deleteDedicatedWorkspace: true,
  });
  expect(retried.operation.workspaceCleanup).toEqual({ outcome: "deleted", path: dir });
  expect(existsSync(dir)).toBe(false);
  expect(w.config.workspaces["Reviewer"]).toBeUndefined();
});

test("a retried removal whose operation froze the flag off keeps the workspace", async () => {
  const w = await wire();
  const bot = await w.control.createBot({ name: "Reviewer", agent: "codex" });
  const dir = join(w.botsHome, "Reviewer");
  const impact = await w.control.previewBotRemoval(bot.id);
  failFirstCleanup(w);

  await expect(w.control.removeBot({
    botId: bot.id,
    requestId: "rm-frozen-off",
    previewRevision: impact.revision,
  })).rejects.toMatchObject({ code: "conversation_indeterminate" });

  // The retry asks to delete, but the operation froze the flag off: the
  // workspace must survive exactly as the operation decided.
  const retried = await w.control.removeBot({
    botId: bot.id,
    requestId: "rm-frozen-off",
    previewRevision: impact.revision,
    deleteDedicatedWorkspace: true,
  });
  // Explicit `false` must reach the client too: `??` keeps it over a live
  // `true`, which is the whole point of freezing.
  expect(retried.operation.params).toEqual({
    clearDirectHistory: false,
    releaseDirectBindings: false,
    deleteDedicatedWorkspace: false,
  });
  expect(retried.operation.workspaceCleanup).toBeUndefined();
  expect(existsSync(dir)).toBe(true);
  expect(w.config.workspaces["Reviewer"]).toMatchObject({ dedicated: true });
});

test("a dedicated workspace whose registry entry uses the other separator still cleans up", async () => {
  // ConfigStore loads workspaces through normalizePath (forward slashes) while
  // the marker keeps the native path the allocator built. The preview the
  // dialog reads and the removal must share one predicate.
  const w = await wire({ registryCwd: nonNativeSeparators });
  const bot = await w.control.createBot({ name: "Reviewer", agent: "codex" });
  const dir = join(w.botsHome, "Reviewer");
  // The registry string must differ from the marker string on every platform,
  // or the comparison this case pins would not be exercised at all.
  expect(nonNativeSeparators(dir)).not.toBe(dir);
  expect((await w.control.previewBotRemoval(bot.id)).dedicatedWorkspace).toEqual({
    name: "Reviewer",
    path: dir,
    inUse: false,
  });

  const { operation } = await removeBot(w, bot.id, "rm-normalized", { deleteDedicatedWorkspace: true });
  expect(operation.workspaceCleanup).toEqual({ outcome: "deleted", path: dir });
  expect(existsSync(dir)).toBe(false);
  expect(w.config.workspaces["Reviewer"]).toBeUndefined();
});

test("a dedicated workspace is marked dedicated and hidden from listWorkspaces", async () => {
  const w = await wire();
  await w.control.createBot({ name: "Reviewer", agent: "codex" });
  expect(w.config.workspaces["Reviewer"]).toEqual({
    cwd: join(w.botsHome, "Reviewer"),
    description: "Bot default workspace for Reviewer",
    dedicated: true,
  });
  expect(w.control.listWorkspaces().map((workspace) => workspace.name)).toEqual(["backend"]);
});

test("bot DTOs expose the owned dedicated workspace so pickers can label it", async () => {
  const w = await wire();
  const bot = await w.control.createBot({ name: "Reviewer", agent: "codex" });
  const expected = { name: "Reviewer", path: join(w.botsHome, "Reviewer") };
  expect(w.control.getBot(bot.id).dedicatedWorkspace).toEqual(expected);
  expect(w.control.listBots().find((row) => row.id === bot.id)?.dedicatedWorkspace).toEqual(expected);
  const other = await w.control.createBot({ name: "Helper", agent: "codex", workspace: "backend" });
  expect(w.control.getBot(other.id).dedicatedWorkspace).toBeUndefined();
});

test("updating to a new dedicated workspace allocates, marks, and hides it", async () => {
  for (const transaction of [true, false]) {
    const w = await wire({ transaction });
    const bot = await w.control.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });

    const updated = await w.control.updateBot(bot.id, { name: "Researcher", dedicatedWorkspace: true });
    expect(updated.workspace).toBe("Researcher");
    expect(updated.dedicatedWorkspace).toEqual({ name: "Researcher", path: join(w.botsHome, "Researcher") });
    expect(w.state.bots[bot.id]?.dedicatedWorkspace).toEqual({
      name: "Researcher",
      cwd: join(w.botsHome, "Researcher"),
      createdAt: NOW,
    });
    expect(readdirSync(w.botsHome)).toEqual(["Researcher"]);
    expect(w.config.workspaces["Researcher"]).toEqual({
      cwd: join(w.botsHome, "Researcher"),
      description: "Bot default workspace for Researcher",
      dedicated: true,
    });
    // The freshly allocated name is private: no picker offers it.
    expect(w.control.listWorkspaces().map((workspace) => workspace.name)).toEqual(["backend"]);
  }
});

test("a Bot that already owns a dedicated workspace cannot be given another one", async () => {
  const w = await wire();
  const bot = await w.control.createBot({ name: "Reviewer", agent: "codex" });
  await expect(w.control.updateBot(bot.id, { dedicatedWorkspace: true }))
    .rejects.toMatchObject({ code: "dedicated_workspace_exists" });
  expect(readdirSync(w.botsHome)).toEqual(["Reviewer"]);
  expect(Object.keys(w.config.workspaces)).toEqual(["backend", "Reviewer"]);
});

test("two concurrent dedicated-workspace updates allocate exactly one", async () => {
  for (const transaction of [true, false]) {
    const w = await wire({ transaction });
    const bot = await w.control.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
    // Both requests read "no dedicated workspace" before either allocates, so
    // only the allocation critical section can keep the loser from registering
    // a second directory nobody could ever target or delete.
    const settled = await Promise.allSettled([
      w.control.updateBot(bot.id, { dedicatedWorkspace: true }),
      w.control.updateBot(bot.id, { dedicatedWorkspace: true }),
    ]);
    const rejected = settled.filter((row) => row.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: "dedicated_workspace_exists" });
    const winner = settled.find((row) => row.status === "fulfilled") as PromiseFulfilledResult<{ dedicatedWorkspace?: { name: string } }>;
    expect(winner.value.dedicatedWorkspace?.name).toBe("Reviewer");
    expect(readdirSync(w.botsHome)).toEqual(["Reviewer"]);
    expect(Object.keys(w.config.workspaces)).toEqual(["backend", "Reviewer"]);
  }
});

test("a dedicated-workspace request cannot also name a workspace", async () => {
  const w = await wire();
  const bot = await w.control.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  await expect(w.control.updateBot(bot.id, { workspace: "backend", dedicatedWorkspace: true }))
    .rejects.toMatchObject({ code: "dedicated_workspace_conflict" });
  expect(w.state.bots[bot.id]?.workspace).toBe("backend");
});

test("a failed update rolls the freshly allocated dedicated workspace back", async () => {
  const w = await wire();
  const bot = await w.control.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  await expect(w.control.updateBot(bot.id, { agent: "ghost", dedicatedWorkspace: true }))
    .rejects.toMatchObject({ code: "agent_not_registered" });
  expect(w.config.workspaces["Reviewer"]).toBeUndefined();
  expect(existsSync(join(w.botsHome, "Reviewer"))).toBe(false);
  expect(w.state.bots[bot.id]?.workspace).toBe("backend");
  expect(w.state.bots[bot.id]?.dedicatedWorkspace).toBeUndefined();
});

test("a dedicated workspace cannot become another Bot or a Topic target", async () => {
  const w = await wire();
  const owner = await w.control.createBot({ name: "Reviewer", agent: "codex" });
  const other = await w.control.createBot({ name: "Helper", agent: "codex", workspace: "backend" });
  const group = await w.control.createGroup({ title: "G", botIds: [owner.id, other.id] });

  await expect(w.control.createBot({ name: "Squatter", agent: "codex", workspace: "Reviewer" }))
    .rejects.toMatchObject({ code: "workspace_dedicated" });
  await expect(w.control.updateBot(other.id, { workspace: "Reviewer" }))
    .rejects.toMatchObject({ code: "workspace_dedicated" });
  // The owner keeps its own default: rename and enable-only updates pass.
  await expect(w.control.updateBot(owner.id, { name: "Senior Reviewer" }))
    .resolves.toMatchObject({ workspace: "Reviewer" });
  // The Control API guards match the chat/CLI surfaces (`createWorkspace` is
  // sync, so its guard throws instead of rejecting).
  expect(() => w.control.createWorkspace("Reviewer", "/tmp/elsewhere")).toThrow("is reserved for its Bot");
  await expect(w.control.removeWorkspace("Reviewer"))
    .rejects.toThrow("is reserved for its Bot");
  await expect(w.control.createGroupTopic(group.id, "T", { workspace: "Reviewer", isolation: "shared" }))
    .rejects.toMatchObject({ code: "workspace_dedicated" });
});

test("a session may not be created on a dedicated workspace, but the owner Bot's own session still materializes", async () => {
  const w = await wire();
  const bot = await w.control.createBot({ name: "Reviewer", agent: "codex" });

  await expect(w.sessions.createSession("relay:squatter", "codex", "Reviewer"))
    .rejects.toThrow("is reserved for its Bot");
  // Another Bot's execution override must not land on this dedicated workspace.
  await w.control.createBot({ name: "Helper", agent: "codex", workspace: "backend" });
  const other = (await w.control.listBots()).find((row) => row.name === "Helper")!;
  // The owner's own session still materializes on its dedicated workspace.
  await expect(w.runtime.botRuntime.getOrCreateDirectSession({ botId: bot.id }))
    .resolves.toBeDefined();
  await expect(w.runtime.botRuntime.getOrCreateDirectSession({
    botId: other.id,
    execution: { agent: "codex", workspace: "Reviewer" } as never,
  })).rejects.toMatchObject({ code: "workspace_dedicated" });
  const [owned] = Object.values(w.state.sessions).filter((session) => session.workspace === "Reviewer");
  expect(owned?.owner?.kind).toBe("bot-direct");
});
