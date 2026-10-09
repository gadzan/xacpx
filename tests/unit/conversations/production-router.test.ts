import { mkdtempSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

import { parseRouterAvailability } from "@ganglion/xacpx-relay-protocol";
import type { AppConfig } from "../../../src/config/types";
import { ControlService, conversationKernel } from "../../../src/control/control-service";
import { createControlEventBus } from "../../../src/control/control-event-bus";
import { ConversationError } from "../../../src/conversations/conversation-error";
import {
  createConversationRuntime,
  createProductionOwnedSessionRelease,
} from "../../../src/conversations/conversation-composition";
import { classifyCapabilityReport, resolveProductionRouter } from "../../../src/conversations/production-router";
import { canMintHumanPermissionInteraction } from "../../../src/conversations/conversation-execution";
import { AsyncMutex } from "../../../src/orchestration/async-mutex";
import { SessionService } from "../../../src/sessions/session-service";
import { createEmptyState, type AppState } from "../../../src/state/types";
import type { ChatRequest } from "../../../src/weixin/agent/interface";

const NOW = "2026-10-09T12:00:00.000Z";
const INGRESS = { chatKey: "relay:account", senderId: "owner", accountId: "account", isOwner: true as const };

const ROUTER_SOURCE = `
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const log = process.env.ROUTER_LOG;
const mode = process.env.ROUTER_MODE ?? "";
const args = process.argv.slice(2).join(" ");
appendFileSync(log, args + "\\n");
if (process.argv.includes("--capabilities")) {
  if (mode === "hang-probe") setInterval(() => {}, 1000);
  else if (mode === "fail") process.exit(2);
  else if (mode === "garbage") process.stdout.write("nope");
  else if (mode === "tools") {
    process.stdout.write(JSON.stringify({
      toolsDisabled: false, filesystemDisabled: true, terminalDisabled: true,
      permissionInteractionDisabled: true, messagingDisabled: true, orchestrationDisabled: true,
      structuredOutputOnly: true,
    }));
  } else {
    process.stdout.write(JSON.stringify({
      toolsDisabled: true, filesystemDisabled: true, terminalDisabled: true,
      permissionInteractionDisabled: true, messagingDisabled: true, orchestrationDisabled: true,
      structuredOutputOnly: true,
    }));
  }
} else if (process.argv.includes("--decide")) {
  if (mode === "hang-decide") setInterval(() => {}, 1000);
  else {
    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { raw += chunk; });
    process.stdin.on("end", () => {
      if (raw.includes("do not use tools")) appendFileSync(log, "stdin-tool-ban\\n");
      const input = JSON.parse(raw);
      if (mode === "need-human") {
        process.stdout.write(JSON.stringify({ type: "need-human", question: "Which branch ships?" }));
        return;
      }
      if (mode === "budget") {
        const members = input.memberMetadata.filter((member) => member.enabled);
        process.stdout.write(JSON.stringify({
          type: "dispatch",
          mode: "parallel",
          assignments: members.map((member) => ({
            id: "job-" + member.botId,
            botId: member.botId,
            task: "Review the patch",
            triggerMessageIds: [input.requestMessageId],
          })),
        }));
        return;
      }
      const n = Number(readFileSync(process.env.ROUTER_COUNT, "utf8") || "0");
      writeFileSync(process.env.ROUTER_COUNT, String(n + 1));
      if (n === 0) {
        const botId = input.memberMetadata.find((member) => member.enabled).botId;
        process.stdout.write(JSON.stringify({
          type: "dispatch",
          mode: "single",
          assignments: [{
            id: "step-1", botId, task: "Review the patch", expectedOutput: "notes",
            triggerMessageIds: [input.requestMessageId],
          }],
        }));
        return;
      }
      process.stdout.write(JSON.stringify({ type: "complete", reason: "done" }));
    });
  }
}
`;

class MemoryStateStore {
  async save(state: AppState): Promise<void> {
    void state;
  }
  async saveNow(state: AppState): Promise<void> {
    void state;
  }
}

function createConfig(command?: string, extra?: Partial<AppConfig>): AppConfig {
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
    ...(command ? { conversations: { router: { enabled: true, command } } } : {}),
    ...extra,
  };
}

async function writeRouter(dir: string, mode: string): Promise<{ command: string; log: string; env: NodeJS.ProcessEnv }> {
  const command = join(dir, "router.mjs");
  const log = join(dir, "router.log");
  const count = join(dir, "count.txt");
  await writeFile(command, ROUTER_SOURCE);
  await writeFile(log, "");
  await writeFile(count, "0");
  return {
    command,
    log,
    env: { ...process.env, ROUTER_LOG: log, ROUTER_MODE: mode, ROUTER_COUNT: count },
  };
}

async function readLog(log: string): Promise<string[]> {
  const text = await readFile(log, "utf8");
  return text.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
}

async function waitUntil(cond: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitUntil timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function wire(options: {
  dir: string;
  command?: string;
  env?: NodeJS.ProcessEnv;
  sqlitePath?: string;
  state?: AppState;
  decisionTimeoutMs?: number;
  probeTimeoutMs?: number;
  origins?: Array<string | undefined>;
}) {
  const state = options.state ?? createEmptyState();
  const stateStore = new MemoryStateStore();
  const config = createConfig(options.command);
  const now = () => new Date(NOW);
  const stateMutex = new AsyncMutex();
  const sessions = new SessionService(config, stateStore, state, { now: () => now().getTime(), stateMutex });
  const physical = { async deleteSession() {}, async releaseLogicalSession() {} };
  const events = createControlEventBus();
  const control = new ControlService({
    agent: {
      chat: async (request: ChatRequest) => {
        options.origins?.push(request.metadata?.origin);
        return { text: "assistant-reply" };
      },
    },
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
    transport: {},
  } as never);
  const kernel = conversationKernel(control);
  const resolution = await resolveProductionRouter({
    config,
    env: options.env ?? process.env,
    ...(options.probeTimeoutMs !== undefined ? { probeTimeoutMs: options.probeTimeoutMs } : {}),
  });
  const runtime = await createConversationRuntime({
    config,
    state,
    stateStore,
    sessions,
    control: kernel,
    sqlitePath: options.sqlitePath ?? join(options.dir, "conversations.sqlite"),
    releaseOwnedSession: createProductionOwnedSessionRelease({ sessions, transport: physical }),
    onProductEvent: (event) => kernel.emitConversationProduct(event),
    autoKick: true,
    stateMutex,
    now,
    ...(resolution.router ? { router: resolution.router } : {}),
    routerAvailability: resolution.availability,
    ...(options.decisionTimeoutMs !== undefined ? { routerDecisionTimeoutMs: options.decisionTimeoutMs } : {}),
  });
  kernel.bindConversationRuntime(runtime);
  await runtime.activateAfterConsumerLock();
  return { config, state, control, runtime, resolution };
}

test("a capability report is restricted only when every flag is true", () => {
  const restricted = {
    toolsDisabled: true, filesystemDisabled: true, terminalDisabled: true,
    permissionInteractionDisabled: true, messagingDisabled: true, orchestrationDisabled: true,
    structuredOutputOnly: true,
  };
  expect(classifyCapabilityReport(restricted).kind).toBe("restricted");
  expect(classifyCapabilityReport({ ...restricted, toolsDisabled: false }).kind).toBe("unproven");
  expect(classifyCapabilityReport({ ...restricted, extra: true }).kind).toBe("malformed");
  expect(classifyCapabilityReport(true).kind).toBe("malformed");
  expect(() => parseRouterAvailability(true)).toThrow("router availability");
});

test("omitted config stays disabled and refuses automatic collaboration", async () => {
  const dir = mkdtempSync(join(tmpdir(), "xacpx-router-off-"));
  try {
    const { control, runtime, resolution } = await wire({ dir });
    expect(resolution.router).toBeUndefined();
    expect(control.getConversationRouterAvailability()).toEqual({
      status: "disabled-by-config",
      configPath: "conversations.router",
      reason: { code: "disabled", message: "Automatic collaboration is off." },
    });
    const a = await control.createBot({ name: "A", agent: "codex", workspace: "backend" });
    const b = await control.createBot({ name: "B", agent: "codex", workspace: "backend" });
    const group = await control.createGroup({ title: "G", botIds: [a.id, b.id] });
    const topic = await control.createGroupTopic(group.id, "T", { workspace: "backend", isolation: "shared" });
    await expect(runtime.runs.acceptGroupPrompt({
      conversationId: group.id, topicId: topic.id, requestId: "off", text: "go", target: { mode: "automatic" },
    })).rejects.toMatchObject({ code: "automatic_unsupported" });
    await runtime.shutdown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unproven probe never starts a decision and automatic accept is refused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "xacpx-router-tools-"));
  try {
    const router = await writeRouter(dir, "tools");
    const { control, runtime, resolution } = await wire({ dir, command: router.command, env: router.env });
    expect(resolution.availability.status).toBe("unsupported");
    expect(resolution.router).toBeUndefined();
    expect(await readLog(router.log)).toEqual(["--capabilities"]);
    const a = await control.createBot({ name: "A", agent: "codex", workspace: "backend" });
    const b = await control.createBot({ name: "B", agent: "codex", workspace: "backend" });
    const group = await control.createGroup({ title: "G", botIds: [a.id, b.id] });
    const topic = await control.createGroupTopic(group.id, "T", { workspace: "backend", isolation: "shared" });
    await expect(runtime.runs.acceptGroupPrompt({
      conversationId: group.id, topicId: topic.id, requestId: "tools", text: "go", target: { mode: "automatic" },
    })).rejects.toBeInstanceOf(ConversationError);
    expect(await readLog(router.log)).toEqual(["--capabilities"]);
    await runtime.shutdown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing auth does not spawn the router", async () => {
  const dir = mkdtempSync(join(tmpdir(), "xacpx-router-auth-"));
  try {
    const router = await writeRouter(dir, "restricted");
    const config = createConfig(router.command);
    config.conversations = { router: { enabled: true, command: router.command, authEnv: "ROUTER_TOKEN_FOR_TEST" } };
    const resolution = await resolveProductionRouter({
      config,
      env: { PATH: process.env.PATH ?? "" },
    });
    expect(resolution.availability).toMatchObject({ status: "failed", reason: { code: "auth-missing" } });
    expect(resolution.router).toBeUndefined();
    expect(await readLog(router.log)).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a restricted probe routes through the production resolver without a tool prompt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "xacpx-router-ready-"));
  const origins: Array<string | undefined> = [];
  try {
    const router = await writeRouter(dir, "dispatch");
    const { control, runtime } = await wire({ dir, command: router.command, env: router.env, origins });
    expect(control.getConversationRouterAvailability().status).toBe("ready");
    const a = await control.createBot({ name: "A", agent: "codex", workspace: "backend" });
    const b = await control.createBot({ name: "B", agent: "codex", workspace: "backend" });
    const group = await control.createGroup({ title: "G", botIds: [a.id, b.id] });
    const topic = await control.createGroupTopic(group.id, "T", { workspace: "backend", isolation: "shared" });
    const accepted = await conversationKernel(control).promptConversationFromHumanIngress({
      conversationId: group.id, topicId: topic.id, requestId: "auto-1", text: "review the patch",
      target: { mode: "automatic" },
    }, INGRESS);
    await waitUntil(() => control.getRun(accepted.run.id).state === "completed");
    const turns = runtime.store.listMemberTurns(accepted.run.id);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ origin: "router", task: "Review the patch", assignmentId: "step-1" });
    expect(turns[0]?.humanIngress).toBeUndefined();
    expect(turns[0]?.authorityEpoch).toBeUndefined();
    expect(origins[0]).toBe("orchestration");
    expect(canMintHumanPermissionInteraction(origins[0])).toBe(false);
    const lines = await readLog(router.log);
    expect(lines[0]).toBe("--capabilities");
    expect(lines).toContain("--decide");
    expect(lines).not.toContain("stdin-tool-ban");
    expect(lines.join("\n")).not.toContain("do not use tools");
    const explicit = await conversationKernel(control).promptConversationFromHumanIngress({
      conversationId: group.id, topicId: topic.id, requestId: "human-1", text: "I will do this step",
      target: { botId: a.id },
    }, INGRESS);
    await waitUntil(() => control.getRun(explicit.run.id).state === "completed");
    const humanTurns = runtime.store.listMemberTurns(explicit.run.id);
    expect(humanTurns[0]?.origin).toBe("human-explicit");
    expect(origins.at(-1)).toBe("human");
    expect(runtime.store.listMemberTurns(accepted.run.id)[0]?.humanIngress).toBeUndefined();
    expect(control.getRun(accepted.run.id).state).toBe("completed");
    await runtime.shutdown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a hung decision fails with the engine timeout", async () => {
  const dir = mkdtempSync(join(tmpdir(), "xacpx-router-timeout-"));
  try {
    const router = await writeRouter(dir, "hang-decide");
    const { control, runtime } = await wire({
      dir, command: router.command, env: router.env, decisionTimeoutMs: 200,
    });
    const a = await control.createBot({ name: "A", agent: "codex", workspace: "backend" });
    const b = await control.createBot({ name: "B", agent: "codex", workspace: "backend" });
    const group = await control.createGroup({ title: "G", botIds: [a.id, b.id] });
    const topic = await control.createGroupTopic(group.id, "T", { workspace: "backend", isolation: "shared" });
    const accepted = await runtime.runs.acceptGroupPrompt({
      conversationId: group.id, topicId: topic.id, requestId: "slow", text: "go", target: { mode: "automatic" },
    });
    await runtime.runs.awaitRouting();
    expect(runtime.store.getRun(accepted.run.id)).toMatchObject({ state: "failed", completionReason: "router_timeout" });
    await runtime.shutdown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cancel during a decision seals the run and creates no member turn", async () => {
  const dir = mkdtempSync(join(tmpdir(), "xacpx-router-cancel-"));
  try {
    const router = await writeRouter(dir, "hang-decide");
    const { control, runtime } = await wire({
      dir, command: router.command, env: router.env, decisionTimeoutMs: 10_000,
    });
    const a = await control.createBot({ name: "A", agent: "codex", workspace: "backend" });
    const b = await control.createBot({ name: "B", agent: "codex", workspace: "backend" });
    const group = await control.createGroup({ title: "G", botIds: [a.id, b.id] });
    const topic = await control.createGroupTopic(group.id, "T", { workspace: "backend", isolation: "shared" });
    const accepted = await runtime.runs.acceptGroupPrompt({
      conversationId: group.id, topicId: topic.id, requestId: "cancel-me", text: "go", target: { mode: "automatic" },
    });
    const decideDeadline = Date.now() + 4000;
    while (!(await readLog(router.log)).includes("--decide")) {
      if (Date.now() > decideDeadline) throw new Error("decision process did not start");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await runtime.runs.cancelRun(accepted.run.id);
    await runtime.runs.awaitRouting();
    expect(runtime.store.getRun(accepted.run.id)?.state).toBe("cancelled");
    expect(runtime.store.listMemberTurns(accepted.run.id)).toEqual([]);
    await runtime.shutdown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("waiting for a human survives a new runtime and does not resume", async () => {
  const dir = mkdtempSync(join(tmpdir(), "xacpx-router-wait-"));
  const sqlitePath = join(dir, "conversations.sqlite");
  try {
    const router = await writeRouter(dir, "need-human");
    const first = await wire({ dir, command: router.command, env: router.env, sqlitePath });
    const a = await first.control.createBot({ name: "A", agent: "codex", workspace: "backend" });
    const b = await first.control.createBot({ name: "B", agent: "codex", workspace: "backend" });
    const group = await first.control.createGroup({ title: "G", botIds: [a.id, b.id] });
    const topic = await first.control.createGroupTopic(group.id, "T", { workspace: "backend", isolation: "shared" });
    const accepted = await first.runtime.runs.acceptGroupPrompt({
      conversationId: group.id, topicId: topic.id, requestId: "ask", text: "go", target: { mode: "automatic" },
    });
    await first.runtime.runs.awaitRouting();
    expect(first.runtime.store.getRun(accepted.run.id)).toMatchObject({
      state: "waiting-human", waitingQuestion: "Which branch ships?",
    });
    await first.runtime.shutdown();
    const decidesBefore = (await readLog(router.log)).filter((line) => line === "--decide").length;
    const second = await wire({ dir, command: router.command, env: router.env, sqlitePath, state: first.state });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(second.runtime.store.getRun(accepted.run.id)?.state).toBe("waiting-human");
    expect((await readLog(router.log)).filter((line) => line === "--decide").length).toBe(decidesBefore);
    await second.runtime.shutdown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a decision larger than the remaining budget fails closed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "xacpx-router-budget-"));
  try {
    const router = await writeRouter(dir, "budget");
    const { control, runtime } = await wire({ dir, command: router.command, env: router.env });
    const ids: string[] = [];
    for (let i = 0; i < 25; i += 1) {
      const bot = await control.createBot({ name: `Bot ${i}`, agent: "codex", workspace: "backend" });
      ids.push(bot.id);
    }
    const group = await control.createGroup({ title: "G", botIds: ids });
    const topic = await control.createGroupTopic(group.id, "T", { workspace: "backend", isolation: "shared" });
    const accepted = await runtime.runs.acceptGroupPrompt({
      conversationId: group.id, topicId: topic.id, requestId: "budget", text: "go", target: { mode: "automatic" },
    });
    await runtime.runs.awaitRouting();
    expect(runtime.store.getRun(accepted.run.id)).toMatchObject({
      state: "failed", completionReason: "router_budget_exhausted",
    });
    expect(runtime.store.listMemberTurns(accepted.run.id)).toEqual([]);
    await runtime.shutdown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a probe timeout is failed and does not decide", async () => {
  const dir = mkdtempSync(join(tmpdir(), "xacpx-router-probe-"));
  try {
    const router = await writeRouter(dir, "hang-probe");
    const resolution = await resolveProductionRouter({
      config: createConfig(router.command),
      env: router.env,
      probeTimeoutMs: 100,
    });
    expect(resolution.availability).toMatchObject({ status: "failed", reason: { code: "probe-timeout" } });
    expect(resolution.router).toBeUndefined();
    expect(await readLog(router.log)).toEqual(["--capabilities"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
