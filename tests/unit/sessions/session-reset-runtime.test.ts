import { beforeEach, expect, test } from "bun:test";
import { EngineRouter } from "../../../src/bridge/engine/engine-router";
import { SessionEngineBinding } from "../../../src/bridge/engine/session-engine-binding";
import type { BridgeEngine, EnginePromptResult, EngineSessionInput } from "../../../src/bridge/engine/bridge-engine";
import { CommandRouter } from "../../../src/commands/command-router";
import { SessionService } from "../../../src/sessions/session-service";
import { createEmptyState, type AppState } from "../../../src/state/types";
import type { AppConfig } from "../../../src/config/types";
import type { SessionTransport, ResolvedSession } from "../../../src/transport/types";
import { setLocale, t } from "../../../src/i18n";

beforeEach(() => {
  setLocale("zh");
});

function createConfig(): AppConfig {
  return {
    transport: {
      type: "acpx-bridge",
      command: "acpx",
      engine: "runtime",
      permissionMode: "approve-all",
      nonInteractivePermissions: "deny",
    },
    logging: { level: "info", maxSizeBytes: 1024, maxFiles: 2, retentionDays: 1 },
    channel: { type: "weixin", replyMode: "stream" },
    channels: [{ id: "weixin", type: "weixin", enabled: true }],
    agents: {
      codex: { driver: "codex" },
    },
    workspaces: {
      backend: { cwd: "/tmp/backend" },
    },
    orchestration: {
      maxPendingAgentRequestsPerCoordinator: 3,
      allowWorkerChainedRequests: false,
      allowedAgentRequestTargets: [],
      allowedAgentRequestRoles: [],
    },
  };
}

class MemoryStateStore {
  public savedStates: AppState[] = [];

  async save(state: AppState): Promise<void> {
    this.savedStates.push(structuredClone(state));
  }

  async saveNow(state: AppState): Promise<void> {
    this.savedStates.push(structuredClone(state));
  }
}

function createMockEngine(kind: "cli" | "runtime", calls: string[]): BridgeEngine {
  return {
    kind,
    async hasSession(input: EngineSessionInput) {
      calls.push(`${kind}:hasSession:${input.name}:${input.logicalSessionId}`);
      return { exists: true };
    },
    async ensureSession(input: EngineSessionInput) {
      calls.push(`${kind}:ensureSession:${input.name}:${input.logicalSessionId}`);
    },
    async prompt(input: EngineSessionInput & { text: string }): Promise<EnginePromptResult> {
      calls.push(`${kind}:prompt:${input.name}:${input.logicalSessionId}:${input.text}`);
      return { text: `reply:${input.text}` };
    },
    async isSessionWarm(input: EngineSessionInput) {
      calls.push(`${kind}:isSessionWarm:${input.name}:${input.logicalSessionId}`);
      return { warm: true };
    },
    async removeSession(input: EngineSessionInput) {
      calls.push(`${kind}:removeSession:${input.name}:${input.logicalSessionId}`);
    },
    async tailSessionHistory() {
      return { lines: [] };
    },
    async listAgentSessions() {
      return undefined;
    },
    async resumeAgentSession() {},
    async injectMessage() {
      return { ok: true, messageId: "msg-1" };
    },
    async setMode() {},
    async setModel() {},
    async getSessionModel() {
      return { available: [] };
    },
    async setSessionEffort() {},
    async getSessionEffort() {
      return { available: [] };
    },
    async cancel() {
      return { cancelled: true, message: "ok" };
    },
    async deleteSession() {},
    async freeWarmProcess() {},
    async getAgentSessionId() {
      return undefined;
    },
    async shutdown() {
      return {};
    },
  };
}

function createEngineRouterTransport(router: EngineRouter): SessionTransport {
  return {
    async ensureSession(session: ResolvedSession) {
      await router.ensureSession({
        name: session.transportSession,
        agent: session.agent,
        cwd: session.cwd,
        logicalSessionId: session.logicalSessionId,
        transportEngine: session.transportEngine,
      });
    },
    async prompt(session: ResolvedSession, text: string) {
      const res = await router.prompt({
        name: session.transportSession,
        agent: session.agent,
        cwd: session.cwd,
        logicalSessionId: session.logicalSessionId,
        transportEngine: session.transportEngine,
        text,
      });
      return { text: res.text };
    },
    async hasSession(session: ResolvedSession) {
      const res = await router.hasSession({
        name: session.transportSession,
        agent: session.agent,
        cwd: session.cwd,
        logicalSessionId: session.logicalSessionId,
        transportEngine: session.transportEngine,
      });
      return res.exists;
    },
    async removeSession(session: ResolvedSession) {
      await router.removeSession({
        name: session.transportSession,
        agent: session.agent,
        cwd: session.cwd,
        logicalSessionId: session.logicalSessionId,
        transportEngine: session.transportEngine,
      });
    },
    async isSessionWarm(session: ResolvedSession) {
      const res = await router.isSessionWarm({
        name: session.transportSession,
        agent: session.agent,
        cwd: session.cwd,
        logicalSessionId: session.logicalSessionId,
        transportEngine: session.transportEngine,
      });
      return res.warm;
    },
    async tailSessionHistory() {
      return { text: "" };
    },
    async cancel() {
      return { cancelled: true, message: "ok" };
    },
    async setMode() {},
  };
}

test("warm Runtime session -> /clear -> no mismatch, new LID, still runtime, prompt works", async () => {
  const state = createEmptyState();
  const initialLid = "lid-warm-1";
  state.sessions["main"] = {
    alias: "main",
    agent: "codex",
    workspace: "backend",
    transport_session: "backend:main",
    logical_session_id: initialLid,
    transport_engine: "runtime",
    created_at: new Date().toISOString(),
    last_used_at: new Date().toISOString(),
  };
  state.chat_contexts["wx:user"] = {
    current_session: "main",
  };

  const store = new MemoryStateStore();
  const config = createConfig();
  const sessions = new SessionService(config, store, state);

  const binding = new SessionEngineBinding();
  const engineCalls: string[] = [];
  const cliEngine = createMockEngine("cli", engineCalls);
  const runtimeEngine = createMockEngine("runtime", engineCalls);
  const router = new EngineRouter(binding, cliEngine, runtimeEngine);
  const transport = createEngineRouterTransport(router);

  const commandRouter = new CommandRouter(sessions, transport, config);

  // 1. Initial warm prompt routes to runtime under initialLid
  const prompt1 = await commandRouter.handle("wx:user", "initial prompt");
  expect(prompt1.text).toBe("reply:initial prompt");
  expect(engineCalls).toContain(`runtime:prompt:backend:main:${initialLid}:initial prompt`);
  expect(binding.engineFor(initialLid)).toBe("runtime");

  // 2. /clear reset session
  const clearReply = await commandRouter.handle("wx:user", "/clear");
  expect(clearReply.text).toBe(t().misc.sessionResetSuccess("main"));

  // Verify session state after reset
  const afterReset = await sessions.getCurrentSession("wx:user");
  expect(afterReset).not.toBeNull();
  expect(afterReset!.alias).toBe("main");
  expect(afterReset!.logicalSessionId).toBeDefined();
  expect(afterReset!.logicalSessionId).not.toBe(initialLid);
  expect(afterReset!.transportEngine).toBe("runtime");
  expect(afterReset!.transportSession).toMatch(/^backend:main:reset-/);

  const newLid = afterReset!.logicalSessionId!;
  expect(binding.engineFor(newLid)).toBe("runtime");

  // 3. Prompt after /clear routes to runtime under newLid
  const prompt2 = await commandRouter.handle("wx:user", "second prompt");
  expect(prompt2.text).toBe("reply:second prompt");
  expect(engineCalls).toContain(`runtime:prompt:${afterReset!.transportSession}:${newLid}:second prompt`);
  // CLI engine should never have been invoked
  expect(engineCalls.some((call) => call.startsWith("cli:"))).toBe(false);
});

test("Bridge-restart cold variant: cold restarted EngineRouter with persisted runtime session -> /clear -> no mismatch, new LID, still runtime, prompt works", async () => {
  const state = createEmptyState();
  const initialLid = "lid-cold-1";
  state.sessions["main"] = {
    alias: "main",
    agent: "codex",
    workspace: "backend",
    transport_session: "backend:main",
    logical_session_id: initialLid,
    transport_engine: "runtime",
    created_at: new Date().toISOString(),
    last_used_at: new Date().toISOString(),
  };
  state.chat_contexts["wx:user"] = {
    current_session: "main",
  };

  const store = new MemoryStateStore();
  const config = createConfig();
  const sessions = new SessionService(config, store, state);

  // Cold Bridge restart: brand new SessionEngineBinding with no in-memory cache
  const freshBinding = new SessionEngineBinding();
  const engineCalls: string[] = [];
  const cliEngine = createMockEngine("cli", engineCalls);
  const runtimeEngine = createMockEngine("runtime", engineCalls);
  const router = new EngineRouter(freshBinding, cliEngine, runtimeEngine);
  const transport = createEngineRouterTransport(router);

  const commandRouter = new CommandRouter(sessions, transport, config);

  // 1. /clear on cold restarted bridge
  const clearReply = await commandRouter.handle("wx:user", "/clear");
  expect(clearReply.text).toBe(t().misc.sessionResetSuccess("main"));

  // Verify session state after reset
  const afterReset = await sessions.getCurrentSession("wx:user");
  expect(afterReset).not.toBeNull();
  expect(afterReset!.alias).toBe("main");
  expect(afterReset!.logicalSessionId).toBeDefined();
  expect(afterReset!.logicalSessionId).not.toBe(initialLid);
  expect(afterReset!.transportEngine).toBe("runtime");
  expect(afterReset!.transportSession).toMatch(/^backend:main:reset-/);

  const newLid = afterReset!.logicalSessionId!;
  expect(freshBinding.engineFor(newLid)).toBe("runtime");

  // 2. Prompt works after /clear
  const prompt = await commandRouter.handle("wx:user", "prompt after cold reset");
  expect(prompt.text).toBe("reply:prompt after cold reset");
  expect(engineCalls).toContain(`runtime:prompt:${afterReset!.transportSession}:${newLid}:prompt after cold reset`);
  // CLI engine should never have been invoked
  expect(engineCalls.some((call) => call.startsWith("cli:"))).toBe(false);
});
