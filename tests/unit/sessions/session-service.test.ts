import { beforeAll, expect, test } from "bun:test";

import type { AppConfig } from "../../../src/config/types";
import { createEmptyState } from "../../../src/state/types";
import type { AppState } from "../../../src/state/types";
import type { StateStore } from "../../../src/state/state-store";
import { DebouncedStateStore } from "../../../src/state/debounced-state-store";
import { SessionService } from "../../../src/sessions/session-service";
import { registerKnownChannelId } from "../../../src/channels/channel-scope";
import { setLocale, t } from "../../../src/i18n";

beforeAll(() => {
  registerKnownChannelId("feishu");
  setLocale("zh");
});

function createConfig(): AppConfig {
  return {
    transport: { type: "acpx-cli", command: "acpx", permissionMode: "approve-all", nonInteractivePermissions: "deny" },
    logging: { level: "info", maxSizeBytes: 1024, maxFiles: 2, retentionDays: 1 },
    channel: { type: "weixin", replyMode: "stream" },
    channels: [{ id: "weixin", type: "weixin", enabled: true }],
    agents: {
      codex: { driver: "codex" },
      claude: { driver: "claude" },
    },
    workspaces: {
      backend: {
        cwd: "/tmp/backend",
      },
    },
    orchestration: {
      maxPendingAgentRequestsPerCoordinator: 3,
      allowWorkerChainedRequests: false,
      allowedAgentRequestTargets: [],
      allowedAgentRequestRoles: [],
    },
  };
}

class MemoryStateStore implements Pick<StateStore, "save"> {
  public savedStates: AppState[] = [];

  async save(state: AppState): Promise<void> {
    this.savedStates.push(structuredClone(state));
  }

  async saveNow(state: AppState): Promise<void> {
    this.savedStates.push(structuredClone(state));
  }
}

test("durability-gated adapter transaction publishes only after saveNow settles", async () => {
  const state = createEmptyState();
  let releaseSave!: () => void;
  const saveGate = new Promise<void>((resolve) => { releaseSave = resolve; });
  const events: string[] = [];
  const store = {
    save: async () => {},
    saveNow: async () => { events.push("save:start"); await saveGate; events.push("save:done"); },
  };
  const service = new SessionService(createConfig(), store, state);
  await service.createSession("api-fix", "codex", "backend");
  const transaction = service.withSessionLock(async (locked) => {
    events.push("session:locked");
    events.push("adapter:locked");
    await locked.setTransportAgentCommandDurably("api-fix", "new-adapter");
    events.push("transaction:done");
  });
  await Promise.resolve();
  expect(state.sessions["api-fix"]?.transport_agent_command).toBeUndefined();
  const followingMutation = service.setDisplayName("api-fix", "after").then(() => events.push("following:done"));
  await Promise.resolve();
  expect(events).not.toContain("following:done");
  releaseSave();
  await transaction;
  await followingMutation;
  expect(state.sessions["api-fix"]?.transport_agent_command).toBe("new-adapter");
  expect(events).toEqual([
    "session:locked", "adapter:locked", "save:start", "save:done", "transaction:done", "following:done",
  ]);
});

test("failed saveNow leaves live state unchanged and later debounced saves cannot persist the failed command", async () => {
  const state = createEmptyState();
  const saved: AppState[] = [];
  const store = {
    save: async (snapshot: AppState) => { saved.push(structuredClone(snapshot)); },
    saveNow: async () => { throw new Error("disk full"); },
  };
  const service = new SessionService(createConfig(), store, state);
  await service.createSession("api-fix", "codex", "backend");
  await expect(service.withSessionLock((locked) =>
    locked.setTransportAgentCommandDurably("api-fix", "failed-adapter"),
  )).rejects.toThrow("disk full");
  expect(state.sessions["api-fix"]?.transport_agent_command).toBeUndefined();
  await service.setDisplayName("api-fix", "still-good");
  expect(saved.at(-1)?.sessions["api-fix"]?.transport_agent_command).toBeUndefined();
});

test("creates a session with xacpx's pinned managed adapter", async () => {
  const store = new MemoryStateStore();
  const service = new SessionService(createConfig(), store, createEmptyState());

  const session = await service.createSession("api-fix", "codex", "backend");

  expect(session.transportSession).toBe("backend:api-fix");
  expect(session.cwd).toBe("/tmp/backend");
  expect(session.agentCommand).toBe("npx -y --registry=https://registry.npmjs.org --@agentclientprotocol:registry=https://registry.npmjs.org @agentclientprotocol/codex-acp@1.1.9");
});

test("carries Claude execution policy from config to a resolved session", async () => {
  const store = new MemoryStateStore();
  const config = createConfig();
  config.agents.claude = { driver: "claude", settingsPolicy: "provider-only" };
  const service = new SessionService(config, store, createEmptyState());

  const session = await service.createSession("review", "claude", "backend");

  expect(session).toMatchObject({
    agent: "claude",
    driver: "claude",
    settingsPolicy: "provider-only",
  });
});

test("ignores a legacy raw codex command and falls back to xacpx's pinned adapter", async () => {
  const store = new MemoryStateStore();
  const config = createConfig();
  config.agents.codex = {
    driver: "codex",
    command: "node E:/projects/weacpx/node_modules/@zed-industries/codex-acp/bin/codex-acp.js",
  };
  const service = new SessionService(config, store, createEmptyState());

  const session = await service.createSession("api-fix", "codex", "backend");

  expect(session.agentCommand).toBe("npx -y --registry=https://registry.npmjs.org --@agentclientprotocol:registry=https://registry.npmjs.org @agentclientprotocol/codex-acp@1.1.9");
});

test("refreshes recorded generated adapter commands but preserves custom recorded commands", async () => {
  const config = createConfig();
  config.transport.adapterVersions = { codex: "1.1.2" };
  const generatedState = createEmptyState();
  generatedState.sessions.review = {
    alias: "review",
    agent: "codex",
    workspace: "backend",
    transport_session: "backend:review",
    transport_agent_command: "npx -y @agentclientprotocol/codex-acp@^0.0.44",
  };
  const generated = new SessionService(config, new MemoryStateStore(), generatedState);
  expect((await generated.getSession("review"))?.agentCommand).toBe(
    "npx -y --registry=https://registry.npmjs.org --@agentclientprotocol:registry=https://registry.npmjs.org @agentclientprotocol/codex-acp@1.1.2",
  );

  generatedState.sessions.review!.transport_agent_command = "my-codex-wrapper --safe";
  const custom = new SessionService(config, new MemoryStateStore(), generatedState);
  expect((await custom.getSession("review"))?.agentCommand).toBe("my-codex-wrapper --safe");
});

test("refreshes a recorded legacy codex shim to the current managed pin", async () => {
  const config = createConfig();
  const state = createEmptyState();
  state.sessions.review = {
    alias: "review",
    agent: "codex",
    workspace: "backend",
    transport_session: "backend:review",
    transport_agent_command: "./node_modules/.bin/codex-acp",
  };

  const service = new SessionService(config, new MemoryStateStore(), state);
  expect((await service.getSession("review"))?.agentCommand).toBe(
    "npx -y --registry=https://registry.npmjs.org --@agentclientprotocol:registry=https://registry.npmjs.org @agentclientprotocol/codex-acp@1.1.9",
  );
});

test("an explicit agents.<name>.command overrides a recorded session command", async () => {
  const config = createConfig();
  config.agents.codex = { driver: "codex", command: "configured-codex-wrapper" };
  const state = createEmptyState();
  state.sessions.review = {
    alias: "review",
    agent: "codex",
    workspace: "backend",
    transport_session: "backend:review",
    transport_agent_command: "recorded-codex-wrapper",
  };

  const service = new SessionService(config, new MemoryStateStore(), state);
  expect((await service.getSession("review"))?.agentCommand).toBe("configured-codex-wrapper");
});

test("attaches an existing transport session with a custom name", async () => {
  const store = new MemoryStateStore();
  const service = new SessionService(createConfig(), store, createEmptyState());

  const session = await service.attachSession("review", "codex", "backend", "existing-review");

  expect(session.transportSession).toBe("existing-review");
  expect(session.cwd).toBe("/tmp/backend");
});

test("rejects creating a logical session that collides with an external coordinator handle", async () => {
  const store = new MemoryStateStore();
  const state = createEmptyState();
  state.orchestration.externalCoordinators["backend:api-fix"] = {
    coordinatorSession: "backend:api-fix",
    workspace: "backend",
    createdAt: "2026-04-28T10:00:00.000Z",
    updatedAt: "2026-04-28T10:00:00.000Z",
  };
  const service = new SessionService(createConfig(), store, state);

  await expect(service.createSession("api-fix", "codex", "backend")).rejects.toThrow(
    'transport session "backend:api-fix" conflicts with an external coordinator',
  );
});

test("rejects attaching a logical session that collides with an external coordinator handle", async () => {
  const store = new MemoryStateStore();
  const state = createEmptyState();
  state.orchestration.externalCoordinators["codex:backend"] = {
    coordinatorSession: "codex:backend",
    workspace: "backend",
    createdAt: "2026-04-28T10:00:00.000Z",
    updatedAt: "2026-04-28T10:00:00.000Z",
  };
  const service = new SessionService(createConfig(), store, state);

  await expect(service.attachSession("review", "codex", "backend", "codex:backend")).rejects.toThrow(
    'transport session "codex:backend" conflicts with an external coordinator',
  );
});

test("stores and resolves a session-level transport agent command", async () => {
  const store = new MemoryStateStore();
  const service = new SessionService(createConfig(), store, createEmptyState());

  await service.attachSession("review", "codex", "backend", "existing-review");
  await service.setSessionTransportAgentCommand("review", "npx @zed-industries/codex-acp@^0.9.5");
  const session = await service.getSession("review");

  expect(session).toMatchObject({
    alias: "review",
    transportSession: "existing-review",
    agentCommand: "npx @zed-industries/codex-acp@^0.9.5",
  });
});

test("rejects duplicate aliases", async () => {
  const store = new MemoryStateStore();
  const service = new SessionService(createConfig(), store, createEmptyState());

  await service.createSession("api-fix", "codex", "backend");
  await expect(service.createSession("api-fix", "codex", "backend")).resolves.toMatchObject({
    alias: "api-fix",
    transportSession: "backend:api-fix",
  });
});

test("recreates an existing alias by overwriting its logical session binding", async () => {
  const store = new MemoryStateStore();
  const service = new SessionService(createConfig(), store, createEmptyState());

  await service.attachSession("api-fix", "codex", "backend", "stale-session");

  const session = await service.createSession("api-fix", "codex", "backend");

  expect(session.transportSession).toBe("backend:api-fix");
});

test("rebinds an existing alias to a different transport session", async () => {
  const store = new MemoryStateStore();
  const service = new SessionService(createConfig(), store, createEmptyState());

  await service.createSession("review", "codex", "backend");

  const session = await service.attachSession("review", "codex", "backend", "existing-review");

  expect(session.transportSession).toBe("existing-review");
});

test("preserves a display name when an alias is recreated on the same agent", async () => {
  const store = new MemoryStateStore();
  const service = new SessionService(createConfig(), store, createEmptyState());

  await service.createSession("api-fix", "codex", "backend");
  await service.setDisplayName("api-fix", "API hotfix");

  const session = await service.attachSession("api-fix", "codex", "backend", "fresh-session");

  expect(session.displayName).toBe("API hotfix");
});

test("sets and resolves current session by chat key", async () => {
  const store = new MemoryStateStore();
  const service = new SessionService(createConfig(), store, createEmptyState());

  await service.createSession("api-fix", "codex", "backend");
  await service.useSession("wx:user", "api-fix");

  await expect(service.getCurrentSession("wx:user")).resolves.toMatchObject({
    alias: "api-fix",
    transportSession: "backend:api-fix",
  });
});

test("stores and resolves the current session mode", async () => {
  const store = new MemoryStateStore();
  const service = new SessionService(createConfig(), store, createEmptyState());

  await service.createSession("api-fix", "codex", "backend");
  await service.useSession("wx:user", "api-fix");
  await service.setCurrentSessionMode("wx:user", "plan");

  await expect(service.getCurrentSession("wx:user")).resolves.toMatchObject({
    alias: "api-fix",
    modeId: "plan",
  });
});

test("stores and resolves the current session reply mode", async () => {
  const store = new MemoryStateStore();
  const service = new SessionService(createConfig(), store, createEmptyState());

  await service.createSession("api-fix", "codex", "backend");
  await service.useSession("wx:user", "api-fix");
  await service.setCurrentSessionReplyMode("wx:user", "final");

  await expect(service.getCurrentSession("wx:user")).resolves.toMatchObject({
    alias: "api-fix",
    replyMode: "final",
  });
});

test("rejects unknown workspaces", async () => {
  const store = new MemoryStateStore();
  const service = new SessionService(createConfig(), store, createEmptyState());

  await expect(service.createSession("x", "codex", "missing")).rejects.toThrow(t().misc.workspaceNotRegistered("missing"));
});

test("rejects blank session aliases", async () => {
  const store = new MemoryStateStore();
  const service = new SessionService(createConfig(), store, createEmptyState());

  await expect(service.createSession("   ", "codex", "backend")).rejects.toThrow('session alias must be a non-empty string');
});

test("allows any registered agent in a registered workspace", async () => {
  const store = new MemoryStateStore();
  const service = new SessionService(createConfig(), store, createEmptyState());

  await expect(service.createSession("x", "claude", "backend")).resolves.toMatchObject({
    alias: "x",
    agent: "claude",
    workspace: "backend",
  });
});

test("lists logical sessions with current markers", async () => {
  const store = new MemoryStateStore();
  const service = new SessionService(createConfig(), store, createEmptyState());

  await service.createSession("api-fix", "codex", "backend");
  await service.useSession("wx:user", "api-fix");

  expect(await service.listSessions("wx:user")).toEqual([
    {
      alias: "api-fix",
      internalAlias: "api-fix",
      agent: "codex",
      workspace: "backend",
      isCurrent: true,
    },
  ]);
});


test("returns a descriptive error when resolving a session whose agent was removed", async () => {
  const store = new MemoryStateStore();
  const config = createConfig();
  const state = createEmptyState();
  const service = new SessionService(config, store, state);

  await service.createSession("api-fix", "codex", "backend");
  delete config.agents.codex;

  await expect(service.getSession("api-fix")).rejects.toThrow(
    'session "api-fix" references agent "codex", but that agent is no longer registered',
  );
});

test("returns a descriptive error when resolving a session whose workspace was removed", async () => {
  const store = new MemoryStateStore();
  const config = createConfig();
  const state = createEmptyState();
  const service = new SessionService(config, store, state);

  await service.createSession("api-fix", "codex", "backend");
  delete config.workspaces.backend;

  await expect(service.getSession("api-fix")).rejects.toThrow(
    'session "api-fix" references workspace "backend", but that workspace is no longer registered',
  );
});

test("removes a session and clears chat contexts pointing to it", async () => {
  const store = new MemoryStateStore();
  const service = new SessionService(createConfig(), store, createEmptyState());

  await service.createSession("main", "codex", "backend");
  await service.createSession("other", "claude", "backend");
  await service.useSession("wx:user-1", "main");
  await service.useSession("wx:user-2", "main");

  const { wasActive } = await service.removeSession("main");

  expect(wasActive).toBe(true);
  expect(await service.getSession("main")).toBeNull();
  expect(await service.getSession("other")).not.toBeNull();
  expect(await service.getCurrentSession("wx:user-1")).toBeNull();
  expect(await service.getCurrentSession("wx:user-2")).toBeNull();
});

test("throws when removing a non-existent session", async () => {
  const store = new MemoryStateStore();
  const service = new SessionService(createConfig(), store, createEmptyState());

  expect(service.removeSession("nope")).rejects.toThrow('session "nope" does not exist');
});

test("lists legacy and scoped weixin sessions with display aliases", async () => {
  const state = createEmptyState();
  state.sessions["backend:codex"] = {
    alias: "backend:codex",
    agent: "codex",
    workspace: "backend",
    transport_session: "backend:codex",
    created_at: "2026-05-03T00:00:00.000Z",
    last_used_at: "2026-05-03T00:00:00.000Z",
  };
  state.sessions["weixin:frontend:codex"] = {
    alias: "weixin:frontend:codex",
    agent: "codex",
    workspace: "backend",
    transport_session: "frontend:codex",
    created_at: "2026-05-03T00:00:00.000Z",
    last_used_at: "2026-05-03T00:00:00.000Z",
  };
  state.sessions["feishu:backend:codex"] = {
    alias: "feishu:backend:codex",
    agent: "codex",
    workspace: "backend",
    transport_session: "feishu:backend:codex",
    created_at: "2026-05-03T00:00:00.000Z",
    last_used_at: "2026-05-03T00:00:00.000Z",
  };
  const config = createConfig();
  const service = new SessionService(config, new MemoryStateStore(), state);

  const sessions = await service.listSessions("weixin:default:wxid_alice");

  expect(sessions.map((session) => session.alias)).toEqual(["backend:codex", "frontend:codex"]);
});

test("lists only feishu scoped sessions with display aliases", async () => {
  const state = createEmptyState();
  state.sessions["backend:codex"] = {
    alias: "backend:codex",
    agent: "codex",
    workspace: "backend",
    transport_session: "backend:codex",
    created_at: "2026-05-03T00:00:00.000Z",
    last_used_at: "2026-05-03T00:00:00.000Z",
  };
  state.sessions["feishu:backend:codex"] = {
    alias: "feishu:backend:codex",
    agent: "codex",
    workspace: "backend",
    transport_session: "feishu:backend:codex",
    created_at: "2026-05-03T00:00:00.000Z",
    last_used_at: "2026-05-03T00:00:00.000Z",
  };
  const service = new SessionService(createConfig(), new MemoryStateStore(), state);

  const sessions = await service.listSessions("feishu:default:oc_chat");

  expect(sessions.map((session) => session.alias)).toEqual(["backend:codex"]);
});

test("resolves display alias to internal alias per channel", async () => {
  const state = createEmptyState();
  state.sessions["backend:codex"] = {
    alias: "backend:codex",
    agent: "codex",
    workspace: "backend",
    transport_session: "backend:codex",
    created_at: "2026-05-03T00:00:00.000Z",
    last_used_at: "2026-05-03T00:00:00.000Z",
  };
  state.sessions["feishu:backend:codex"] = {
    alias: "feishu:backend:codex",
    agent: "codex",
    workspace: "backend",
    transport_session: "feishu:backend:codex",
    created_at: "2026-05-03T00:00:00.000Z",
    last_used_at: "2026-05-03T00:00:00.000Z",
  };
  const service = new SessionService(createConfig(), new MemoryStateStore(), state);

  expect(await service.resolveAliasForChat("weixin:default:wxid_alice", "backend:codex")).toBe("backend:codex");
  expect(await service.resolveAliasForChat("feishu:default:oc_chat", "backend:codex")).toBe("feishu:backend:codex");
});

test("listAllResolvedSessions resolves all sessions, dedups by composite identity, and skips de-registered ones", async () => {
  const config = createConfig();
  config.workspaces.frontend = { cwd: "/tmp/frontend" };
  const state = createEmptyState();
  const baseTimes = { created_at: "2026-05-03T00:00:00.000Z", last_used_at: "2026-05-03T00:00:00.000Z" };
  state.sessions["api-fix"] = { alias: "api-fix", agent: "codex", workspace: "backend", transport_session: "backend:api-fix", ...baseTimes };
  state.sessions["docs"] = { alias: "docs", agent: "claude", workspace: "backend", transport_session: "backend:docs", ...baseTimes };
  // Second alias bound to the same transport session as api-fix → must dedup.
  state.sessions["api-fix-mirror"] = { alias: "api-fix-mirror", agent: "codex", workspace: "backend", transport_session: "backend:api-fix", ...baseTimes };
  // Same transport-session NAME but a different workspace (possible via
  // /session attach) resolves to a different acpx record with its own warm
  // queue owner → must NOT collapse with backend's api-fix.
  state.sessions["api-fix-frontend"] = { alias: "api-fix-frontend", agent: "codex", workspace: "frontend", transport_session: "backend:api-fix", ...baseTimes };
  // Workspace de-registered after the session was created → must be skipped (no throw).
  state.sessions["orphan"] = { alias: "orphan", agent: "codex", workspace: "ghost-workspace", transport_session: "ghost-workspace:orphan", ...baseTimes };
  const service = new SessionService(config, new MemoryStateStore(), state);

  const resolved = service.listAllResolvedSessions();
  const identities = resolved.map((s) => `${s.transportSession}@${s.cwd}`).sort();

  expect(identities).toEqual([
    "backend:api-fix@/tmp/backend",
    "backend:api-fix@/tmp/frontend",
    "backend:docs@/tmp/backend",
  ]);
});

test("stores native metadata when attaching a native session", async () => {
  const config = createConfig();
  config.workspaces.project = { cwd: "/tmp/project" };
  const state = createEmptyState();
  const sessions = new SessionService(config, new MemoryStateStore(), state);

  await sessions.attachNativeSession({
    alias: "project:codex",
    agent: "codex",
    workspace: "project",
    transportSession: "project:codex",
    agentSessionId: "thread-1",
    title: "Fix CI",
    updatedAt: "2026-05-26T01:00:00.000Z",
  });

  expect(state.sessions["project:codex"]).toMatchObject({
    source: "agent-side",
    agent_session_id: "thread-1",
    agent_session_title: "Fix CI",
    agent_session_updated_at: "2026-05-26T01:00:00.000Z",
  });
});

test("stores a native transport agent command when attaching a native session", async () => {
  const config = createConfig();
  config.workspaces.project = { cwd: "/tmp/project" };
  const state = createEmptyState();
  const sessions = new SessionService(config, new MemoryStateStore(), state);

  await sessions.attachNativeSession({
    alias: "project:codex",
    agent: "codex",
    workspace: "project",
    transportSession: "project:codex",
    transportAgentCommand: "npx @zed-industries/codex-acp@^0.9.5",
    agentSessionId: "thread-1",
  });

  expect(state.sessions["project:codex"]?.transport_agent_command).toBe(
    "npx @zed-industries/codex-acp@^0.9.5",
  );
});

test("clears native metadata when rewriting a native session as a normal logical session", async () => {
  const config = createConfig();
  config.workspaces.project = { cwd: "/tmp/project" };
  const state = createEmptyState();
  const sessions = new SessionService(config, new MemoryStateStore(), state);

  await sessions.attachNativeSession({
    alias: "project:codex",
    agent: "codex",
    workspace: "project",
    transportSession: "project:codex",
    agentSessionId: "thread-1",
    title: "Fix CI",
  });

  await sessions.attachSession("project:codex", "codex", "project", "project:codex-plain");

  expect(state.sessions["project:codex"]).toMatchObject({
    source: undefined,
    agent_session_id: undefined,
    agent_session_title: undefined,
    agent_session_updated_at: undefined,
    attached_at: undefined,
  });
  await expect(sessions.findAttachedNativeSession("wx:user", "codex", "thread-1")).resolves.toBeNull();
});

test("finds attached native sessions visible in the current channel", async () => {
  const config = createConfig();
  config.workspaces.project = { cwd: "/tmp/project" };
  const state = createEmptyState();
  state.sessions["project:codex"] = {
    alias: "project:codex",
    agent: "codex",
    workspace: "project",
    transport_session: "project:codex",
    source: "agent-side",
    agent_session_id: "thread-1",
    created_at: "2026-05-26T01:00:00.000Z",
    last_used_at: "2026-05-26T01:00:00.000Z",
  };
  state.sessions["feishu:project:codex"] = {
    alias: "feishu:project:codex",
    agent: "codex",
    workspace: "project",
    transport_session: "feishu:project:codex",
    source: "agent-side",
    agent_session_id: "thread-2",
    created_at: "2026-05-26T01:00:00.000Z",
    last_used_at: "2026-05-26T01:00:00.000Z",
  };
  const sessions = new SessionService(config, new MemoryStateStore(), state);

  await expect(sessions.findAttachedNativeSession("wx:user", "codex", "thread-1")).resolves.toMatchObject({
    alias: "project:codex",
    agentSessionId: "thread-1",
  });
  await expect(sessions.findAttachedNativeSession("wx:user", "codex", "thread-2")).resolves.toBeNull();
});

test("caches and expires native session lists", async () => {
  const state = createEmptyState();
  const store = new MemoryStateStore();
  const sessions = new SessionService(createConfig(), store, state, { now: () => 1_000 });

  await sessions.cacheNativeSessionList("wx:user", {
    agent: "codex",
    workspace: "backend",
    cwd: "/tmp/backend",
    sessions: [{ sessionId: "thread-1", title: "Fix CI", cwd: "/tmp/backend" }],
    nextCursor: null,
  });

  expect(await sessions.getNativeSessionList("wx:user", 10_000)).toMatchObject({
    agent: "codex",
    sessions: [{ sessionId: "thread-1", title: "Fix CI" }],
  });

  const expired = new SessionService(createConfig(), store, state, { now: () => 20_000 });
  expect(await expired.getNativeSessionList("wx:user", 10_000)).toBeNull();
  expect(state.native_session_lists["wx:user"]).toBeUndefined();
  expect(store.savedStates.at(-1)?.native_session_lists["wx:user"]).toBeUndefined();
});

function createSwitchConfig(): AppConfig {
  const config = createConfig();
  config.workspaces.frontend = { cwd: "/tmp/frontend" };
  return config;
}

test("useSession records previous_session and usePreviousSession toggles", async () => {
  const service = new SessionService(createSwitchConfig(), new MemoryStateStore(), createEmptyState());
  await service.createSession("a", "codex", "backend");
  await service.createSession("b", "codex", "backend");

  await service.useSession("weixin:room1", "a");
  await service.useSession("weixin:room1", "b");

  const prev = await service.usePreviousSession("weixin:room1");
  expect(prev?.alias).toBe("a");

  const back = await service.usePreviousSession("weixin:room1");
  expect(back?.alias).toBe("b");
});

test("usePreviousSession returns null when there is no previous", async () => {
  const service = new SessionService(createSwitchConfig(), new MemoryStateStore(), createEmptyState());
  await service.createSession("a", "codex", "backend");
  await service.useSession("weixin:room1", "a");

  expect(await service.usePreviousSession("weixin:room1")).toBeNull();
});

test("useSession returns switch info with previousAlias", async () => {
  const service = new SessionService(createSwitchConfig(), new MemoryStateStore(), createEmptyState());
  await service.createSession("a", "codex", "backend");
  await service.createSession("b", "claude", "frontend");

  await service.useSession("weixin:room1", "a");
  const result = await service.useSession("weixin:room1", "b");

  expect(result).toEqual({ alias: "b", agent: "claude", workspace: "frontend", previousAlias: "a" });
});

test("resolveFuzzyAlias matches exact / prefix / substring / ambiguous / none", async () => {
  const service = new SessionService(createSwitchConfig(), new MemoryStateStore(), createEmptyState());
  await service.createSession("api-review", "codex", "backend");
  await service.createSession("api-smoke", "claude", "backend");
  await service.createSession("docs", "codex", "backend");

  expect(service.resolveFuzzyAlias("weixin:room1", "docs")).toEqual({ kind: "match", alias: "docs" });
  expect(service.resolveFuzzyAlias("weixin:room1", "api-r")).toEqual({ kind: "match", alias: "api-review" });
  expect(service.resolveFuzzyAlias("weixin:room1", "review")).toEqual({ kind: "match", alias: "api-review" });

  const ambiguous = service.resolveFuzzyAlias("weixin:room1", "api");
  expect(ambiguous.kind).toBe("ambiguous");
  if (ambiguous.kind === "ambiguous") {
    expect(ambiguous.candidates.map((c) => c.alias).sort()).toEqual(["api-review", "api-smoke"]);
  }

  expect(service.resolveFuzzyAlias("weixin:room1", "zzz")).toEqual({ kind: "none" });
});

test("removeSession clears dangling previous_session references", async () => {
  const service = new SessionService(createSwitchConfig(), new MemoryStateStore(), createEmptyState());
  await service.createSession("a", "codex", "backend");
  await service.createSession("b", "codex", "backend");
  await service.useSession("weixin:room1", "a");
  await service.useSession("weixin:room1", "b");

  await service.removeSession("a");

  expect(await service.usePreviousSession("weixin:room1")).toBeNull();
});

test("previous_session is isolated per chat", async () => {
  const service = new SessionService(createSwitchConfig(), new MemoryStateStore(), createEmptyState());
  await service.createSession("a", "codex", "backend");
  await service.createSession("b", "codex", "backend");
  await service.useSession("weixin:room1", "a");
  await service.useSession("weixin:room1", "b");
  await service.useSession("weixin:room2", "a");

  expect(await service.usePreviousSession("weixin:room2")).toBeNull();
  expect((await service.usePreviousSession("weixin:room1"))?.alias).toBe("a");
});

test("setBackgroundResult then takeBackgroundResult returns and clears it", async () => {
  const store = new MemoryStateStore();
  const service = new SessionService(createConfig(), store, createEmptyState());
  const chatKey = "weixin:acc:user";
  await service.setBackgroundResult(chatKey, "backend", {
    text: "build finished", status: "done", finished_at: "2026-05-30T01:00:00.000Z",
  });
  expect(service.listBackgroundResultAliases(chatKey)).toEqual(["backend"]);
  const taken = await service.takeBackgroundResult(chatKey, "backend");
  expect(taken?.text).toBe("build finished");
  expect(service.listBackgroundResultAliases(chatKey)).toEqual([]);
  const again = await service.takeBackgroundResult(chatKey, "backend");
  expect(again).toBeNull();
});

test("setBackgroundResult overwrites a prior unread result for the same alias", async () => {
  const store = new MemoryStateStore();
  const service = new SessionService(createConfig(), store, createEmptyState());
  const chatKey = "weixin:acc:user";
  await service.setBackgroundResult(chatKey, "backend", { text: "first", status: "done", finished_at: "2026-05-30T01:00:00.000Z" });
  await service.setBackgroundResult(chatKey, "backend", { text: "second", status: "error", finished_at: "2026-05-30T02:00:00.000Z" });
  const taken = await service.takeBackgroundResult(chatKey, "backend");
  expect(taken?.text).toBe("second");
  expect(taken?.status).toBe("error");
});

test("useSession preserves unread background results across switches", async () => {
  const service = new SessionService(createSwitchConfig(), new MemoryStateStore(), createEmptyState());
  await service.createSession("a", "codex", "backend");
  await service.createSession("b", "codex", "backend");
  const chatKey = "weixin:acc:user";

  await service.useSession(chatKey, "a");
  await service.setBackgroundResult(chatKey, "a", {
    text: "task a finished", status: "done", finished_at: "2026-06-10T01:00:00.000Z",
  });
  await service.useSession(chatKey, "b");
  expect(service.listBackgroundResultAliases(chatKey)).toEqual(["a"]);
  await service.useSession(chatKey, "a");

  const taken = await service.takeBackgroundResult(chatKey, "a");
  expect(taken?.text).toBe("task a finished");
});

test("usePreviousSession preserves unread background results", async () => {
  const service = new SessionService(createSwitchConfig(), new MemoryStateStore(), createEmptyState());
  await service.createSession("a", "codex", "backend");
  await service.createSession("b", "codex", "backend");
  const chatKey = "weixin:acc:user";

  await service.useSession(chatKey, "a");
  await service.useSession(chatKey, "b");
  await service.setBackgroundResult(chatKey, "a", {
    text: "task a finished", status: "done", finished_at: "2026-06-10T01:00:00.000Z",
  });

  const prev = await service.usePreviousSession(chatKey);
  expect(prev?.alias).toBe("a");
  const taken = await service.takeBackgroundResult(chatKey, "a");
  expect(taken?.text).toBe("task a finished");
});

test("removeSession of current session keeps other aliases' background results and promotes previous_session", async () => {
  const service = new SessionService(createSwitchConfig(), new MemoryStateStore(), createEmptyState());
  await service.createSession("a", "codex", "backend");
  await service.createSession("b", "codex", "backend");
  const chatKey = "weixin:acc:user";

  await service.useSession(chatKey, "a");
  await service.useSession(chatKey, "b"); // current=b, previous=a
  await service.setBackgroundResult(chatKey, "a", {
    text: "task a finished", status: "done", finished_at: "2026-06-10T01:00:00.000Z",
  });

  await service.removeSession("b");

  // previous_session promoted to current; a's background result survives.
  await expect(service.getCurrentSession(chatKey)).resolves.toMatchObject({ alias: "a" });
  const taken = await service.takeBackgroundResult(chatKey, "a");
  expect(taken?.text).toBe("task a finished");
});

test("removeSession drops only the removed alias's background result", async () => {
  const service = new SessionService(createSwitchConfig(), new MemoryStateStore(), createEmptyState());
  await service.createSession("a", "codex", "backend");
  await service.createSession("b", "codex", "backend");
  const chatKey = "weixin:acc:user";

  await service.useSession(chatKey, "b");
  await service.setBackgroundResult(chatKey, "a", {
    text: "task a finished", status: "done", finished_at: "2026-06-10T01:00:00.000Z",
  });
  await service.setBackgroundResult(chatKey, "b", {
    text: "task b finished", status: "done", finished_at: "2026-06-10T01:00:00.000Z",
  });

  await service.removeSession("b");

  expect(await service.takeBackgroundResult(chatKey, "b")).toBeNull();
  expect((await service.takeBackgroundResult(chatKey, "a"))?.text).toBe("task a finished");
});

test("removeSession of current session without previous clears the current marker", async () => {
  const service = new SessionService(createSwitchConfig(), new MemoryStateStore(), createEmptyState());
  await service.createSession("a", "codex", "backend");
  await service.createSession("b", "codex", "backend");
  const chatKey = "weixin:acc:user";

  await service.useSession(chatKey, "a");
  await service.setBackgroundResult(chatKey, "b", {
    text: "task b finished", status: "done", finished_at: "2026-06-10T01:00:00.000Z",
  });

  await service.removeSession("a");

  expect(await service.getCurrentSession(chatKey)).toBeNull();
  expect((await service.takeBackgroundResult(chatKey, "b"))?.text).toBe("task b finished");
});

test("recreating an alias with a different agent does not inherit transport agent command, mode, or reply mode", async () => {
  const store = new MemoryStateStore();
  const state = createEmptyState();
  const service = new SessionService(createConfig(), store, state);
  const chatKey = "weixin:acc:user";

  await service.createSession("foo", "codex", "backend");
  await service.useSession(chatKey, "foo");
  await service.setSessionTransportAgentCommand("foo", "npx @zed-industries/codex-acp@^0.9.5");
  await service.setCurrentSessionMode(chatKey, "plan");
  await service.setCurrentSessionReplyMode(chatKey, "final");

  const recreated = await service.createSession("foo", "claude", "backend");

  expect(recreated.agentCommand).toBe("npx -y --registry=https://registry.npmjs.org --@agentclientprotocol:registry=https://registry.npmjs.org @agentclientprotocol/claude-agent-acp@0.64.2");
  expect(recreated.modeId).toBeUndefined();
  expect(recreated.replyMode).toBeUndefined();
  expect(state.sessions.foo?.transport_agent_command).toBeUndefined();
  expect(state.sessions.foo?.mode_id).toBeUndefined();
  expect(state.sessions.foo?.reply_mode).toBeUndefined();
});

test("recreating an alias with the same agent still inherits transport agent command, mode, and reply mode", async () => {
  const store = new MemoryStateStore();
  const state = createEmptyState();
  const service = new SessionService(createConfig(), store, state);
  const chatKey = "weixin:acc:user";

  await service.createSession("foo", "codex", "backend");
  await service.useSession(chatKey, "foo");
  await service.setSessionTransportAgentCommand("foo", "npx @zed-industries/codex-acp@^0.9.5");
  await service.setCurrentSessionMode(chatKey, "plan");
  await service.setCurrentSessionReplyMode(chatKey, "final");

  const recreated = await service.createSession("foo", "codex", "backend");

  expect(recreated.agentCommand).toBe("npx @zed-industries/codex-acp@^0.9.5");
  expect(recreated.modeId).toBe("plan");
  expect(recreated.replyMode).toBe("final");
});

test("resolveSession does not reuse a cached transport agent command from a different agent", async () => {
  const store = new MemoryStateStore();
  const service = new SessionService(createConfig(), store, createEmptyState());

  await service.createSession("foo", "codex", "backend");
  await service.setSessionTransportAgentCommand("foo", "npx @zed-industries/codex-acp@^0.9.5");

  const crossAgent = service.resolveSession("foo", "claude", "backend", "backend:foo");
  expect(crossAgent.agentCommand).toBe("npx -y --registry=https://registry.npmjs.org --@agentclientprotocol:registry=https://registry.npmjs.org @agentclientprotocol/claude-agent-acp@0.64.2");

  const sameAgent = service.resolveSession("foo", "codex", "backend", "backend:foo");
  expect(sameAgent.agentCommand).toBe("npx @zed-industries/codex-acp@^0.9.5");
});

test("peekCurrentSessionAlias returns the current internal alias without mutating", async () => {
  const store = new MemoryStateStore();
  const service = new SessionService(createConfig(), store, createEmptyState());
  await service.createSession("api-fix", "codex", "backend");
  const chatKey = "weixin:acc:user";
  await service.useSession(chatKey, "api-fix");
  const first = service.peekCurrentSessionAlias(chatKey);
  expect(typeof first).toBe("string");
  expect(service.peekCurrentSessionAlias(chatKey)).toBe(first);
  expect(service.getResolvedSessionByInternalAlias(first!)).not.toBeNull();
});

test("peekCurrentSessionAlias returns undefined for unknown chat", async () => {
  const store = new MemoryStateStore();
  const service = new SessionService(createConfig(), store, createEmptyState());
  expect(service.peekCurrentSessionAlias("weixin:nope:nope")).toBeUndefined();
});

test("getPreferredSessionForTransport resolves a rotated transport session via stable id", async () => {
  const state = createEmptyState();
  state.sessions["alias"] = {
    alias: "alias",
    agent: "codex",
    workspace: "ws",
    transport_session: "ws:alias:reset-1700000000000",
    created_at: "2026-01-01T00:00:00.000Z",
    last_used_at: "2026-01-01T00:00:00.000Z",
  };
  const config = createConfig();
  config.workspaces.ws = { cwd: "/tmp/ws" };
  const service = new SessionService(config, new MemoryStateStore(), state);

  const resolved = await service.getPreferredSessionForTransport("ws:alias");

  expect(resolved).not.toBeNull();
  expect(resolved!.alias).toBe("alias");
  expect(resolved!.transportSession).toBe("ws:alias:reset-1700000000000");
});

// --- effectiveReplyMode (relay/control stream default) ---

function seedSession(
  state: AppState,
  alias: string,
  replyMode?: "stream" | "final" | "verbose",
): void {
  state.sessions[alias] = {
    alias,
    agent: "codex",
    workspace: "backend",
    transport_session: `backend:${alias}`,
    created_at: "2026-01-01T00:00:00.000Z",
    last_used_at: "2026-01-01T00:00:00.000Z",
    ...(replyMode ? { reply_mode: replyMode } : {}),
  };
}

test("relay-channel session with no reply_mode resolves effectiveReplyMode 'stream'", async () => {
  registerKnownChannelId("relay");
  const state = createEmptyState();
  seedSession(state, "relay:foo");
  const service = new SessionService(createConfig(), new MemoryStateStore(), state);

  const resolved = service.getResolvedSessionByInternalAlias("relay:foo");

  expect(resolved).not.toBeNull();
  expect(resolved!.replyMode).toBeUndefined();
  expect(resolved!.effectiveReplyMode).toBe("stream");
});

test("weixin/default session with no reply_mode leaves effectiveReplyMode undefined", async () => {
  const state = createEmptyState();
  // explicit weixin prefix
  seedSession(state, "weixin:foo");
  // legacy unprefixed (also weixin)
  seedSession(state, "legacy-foo");
  const service = new SessionService(createConfig(), new MemoryStateStore(), state);

  const prefixed = service.getResolvedSessionByInternalAlias("weixin:foo");
  expect(prefixed).not.toBeNull();
  expect(prefixed!.effectiveReplyMode).toBeUndefined();

  const legacy = service.getResolvedSessionByInternalAlias("legacy-foo");
  expect(legacy).not.toBeNull();
  expect(legacy!.effectiveReplyMode).toBeUndefined();
});

test("relay ignores a reply_mode override and always streams; the raw override is preserved", async () => {
  // Relay is hardcoded to stream — a per-session reply_mode override does NOT change the
  // effective mode (the web has no use for other modes), but the raw override is still
  // exposed on `replyMode` so `/replyMode show` reports it. Non-relay channels keep
  // honoring the override via `replyMode` (effectiveReplyMode stays undefined for them).
  registerKnownChannelId("relay");
  const state = createEmptyState();
  seedSession(state, "relay:foo", "verbose");
  seedSession(state, "weixin:bar", "verbose");
  const service = new SessionService(createConfig(), new MemoryStateStore(), state);

  const relay = service.getResolvedSessionByInternalAlias("relay:foo");
  expect(relay!.replyMode).toBe("verbose"); // raw override preserved
  expect(relay!.effectiveReplyMode).toBe("stream"); // …but relay always streams

  const weixin = service.getResolvedSessionByInternalAlias("weixin:bar");
  expect(weixin!.replyMode).toBe("verbose");
  expect(weixin!.effectiveReplyMode).toBeUndefined();
});

test("mutations under the shared mutex commit immediately and coalesce into one debounced write", async () => {
  // Regression for the debounce-defeating pattern: SessionService.mutate() holds the
  // shared state mutex while it awaits persist(). When the debounced store's save()
  // only resolved after the flush, every mutation serialized on the full debounce
  // interval (N writes ~= N x 50ms) and coalescing never happened. save() must
  // resolve at commit time so back-to-back mutations batch into a single write.
  const inner = new MemoryStateStore();
  const debounced = new DebouncedStateStore({ delegate: inner, intervalMs: 200 });
  const service = new SessionService(createConfig(), debounced, createEmptyState());

  const startedAt = Date.now();
  await service.createSession("api-fix", "codex", "backend");
  await service.setSessionModel("api-fix", "gpt-5.5");
  await service.setArchived("api-fix", true);
  await service.setArchived("api-fix", false);

  // Four awaited mutations must not pay four debounce intervals (>=800ms before).
  expect(Date.now() - startedAt).toBeLessThan(200);
  // Nothing has hit the delegate yet: the debounce window is still open.
  expect(inner.savedStates.length).toBe(0);

  await debounced.flush();
  expect(inner.savedStates.length).toBe(1);
  // The single write carries the LAST committed state (all four mutations).
  expect(inner.savedStates[0]!.sessions["api-fix"]).toMatchObject({ model: "gpt-5.5" });
  expect(inner.savedStates[0]!.sessions["api-fix"]!.archived).toBeUndefined();
  await debounced.dispose();
});

test("fresh transport incarnations do not collide across service instances with a fixed clock", () => {
  const fixedNow = () => 1_700_000_000_000;
  const first = new SessionService(createConfig(), new MemoryStateStore(), createEmptyState(), { now: fixedNow });
  const second = new SessionService(createConfig(), new MemoryStateStore(), createEmptyState(), { now: fixedNow });

  const firstName = first.buildFreshTransportSession("backend:review");
  const secondName = second.buildFreshTransportSession("backend:review");

  expect(firstName).toMatch(/^backend:review:reset-\d+$/);
  expect(secondName).toMatch(/^backend:review:reset-\d+$/);
  expect(secondName).not.toBe(firstName);
});

// ── structured launch metadata ───────────────────────────────────────────────

test("resolves managed launches to an overlay alias with canonical identity", async () => {
  const service = new SessionService(createConfig(), new MemoryStateStore(), createEmptyState());
  const session = await service.createSession("alias-run", "codex", "backend");

  expect(session.acpxAgent).toMatch(/^xacpx-managed-codex-[0-9a-f]{12}$/);
  expect(session.agentCommand).toBe(
    "npx -y --registry=https://registry.npmjs.org --@agentclientprotocol:registry=https://registry.npmjs.org @agentclientprotocol/codex-acp@1.1.9",
  );
  expect(session.agentArgv).toEqual([
    "npx",
    "-y",
    "--registry=https://registry.npmjs.org",
    "--@agentclientprotocol:registry=https://registry.npmjs.org",
    "@agentclientprotocol/codex-acp@1.1.9",
  ]);
  expect(session.rawCommand).toBeUndefined();
});

test("resolves bare built-in drivers positionally", async () => {
  const config = createConfig();
  config.agents.pool = { driver: "pool" };
  const service = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const session = await service.createSession("pool-run", "pool", "backend");

  expect(session.acpxAgent).toBe("pool");
  expect(session.agentCommand).toBeUndefined();
  expect(session.agentArgv).toBeUndefined();
});

test("explicit unix command resolves to a raw override with identity", async () => {
  const config = createConfig();
  config.agents.codex = { driver: "codex", command: "custom-codex --acp" };
  const service = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const session = await service.createSession("raw-run", "codex", "backend");

  expect(session.rawCommand).toBe("custom-codex --acp");
  expect(session.agentCommand).toBe("custom-codex --acp");
  expect(session.acpxAgent).toBe("codex");
});

test("recorded custom argv stays sticky across restart while managed argv recomputes", async () => {
  const config = createConfig();
  const state = createEmptyState();
  state.sessions.review = {
    alias: "review",
    agent: "codex",
    workspace: "backend",
    transport_session: "backend:review",
    transport_acpx_agent: "xacpx-managed-codex-customhash1234",
    transport_agent_command: "custom agent",
    transport_agent_argv: ["/opt/agent", "--acp", ""],
  };
  const service = new SessionService(config, new MemoryStateStore(), state);
  const session = await service.getSession("review");
  expect(session?.acpxAgent).toBe("xacpx-managed-codex-customhash1234");
  expect(session?.agentArgv).toEqual(["/opt/agent", "--acp", ""]);
  expect(session?.agentCommand).toBe("custom agent");

  // Managed-shaped recorded argv is derived: recomputed to the current pin.
  delete state.sessions.review!.transport_agent_command;
  state.sessions.review!.transport_acpx_agent = "xacpx-managed-codex-oldhash9999";
  state.sessions.review!.transport_agent_argv = [
    "npx", "-y", "@agentclientprotocol/codex-acp@1.0.0",
  ];
  const refreshed = new SessionService(config, new MemoryStateStore(), state);
  const session2 = await refreshed.getSession("review");
  expect(session2?.agentArgv).toContain("@agentclientprotocol/codex-acp@1.1.9");
  expect(session2?.acpxAgent).not.toBe("xacpx-managed-codex-oldhash9999");
});

// ── windows recorded raw command guard ───────────────────────────────────────

test("windows rejects a recorded multi-token raw command instead of resurrecting it", async () => {
  const config = createConfig();
  config.agents.custom = { driver: "custom" };
  const state = createEmptyState();
  state.sessions.review = {
    alias: "review",
    agent: "custom",
    workspace: "backend",
    transport_session: "backend:review",
    transport_agent_command: "node C:/path with space/agent.js --acp",
  };
  const service = new SessionService(config, new MemoryStateStore(), state, { platform: "win32" });
  await expect(service.getSession("review")).rejects.toThrow(/Migrate the agent to an argv array/);
});

test("windows rejects a recorded single-token command too (no overlay alias exists for it)", async () => {
  const config = createConfig();
  config.agents.custom = { driver: "custom" };
  const state = createEmptyState();
  state.sessions.review = {
    alias: "review",
    agent: "custom",
    workspace: "backend",
    transport_session: "backend:review",
    transport_agent_command: "myagent.exe",
  };
  const service = new SessionService(config, new MemoryStateStore(), state, { platform: "win32" });
  await expect(service.getSession("review")).rejects.toThrow(/Migrate the agent to an argv array/);
});
