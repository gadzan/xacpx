import { beforeAll, expect, test } from "bun:test";

import type { AppConfig } from "../../../src/config/types";
import { createEmptyState } from "../../../src/state/types";
import type { AppState } from "../../../src/state/types";
import type { StateStore } from "../../../src/state/state-store";
import { DebouncedStateStore } from "../../../src/state/debounced-state-store";
import { SessionService } from "../../../src/sessions/session-service";
import type { SessionResourceLifecyclePublishInput } from "../../../src/sessions/session-resource-catalog";
import { registerKnownChannelId } from "../../../src/channels/channel-scope";
import { setLocale, t } from "../../../src/i18n";
import { deriveAgentAlias, renderAgentArgvIdentity } from "../../../src/config/agent-launch";

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
  let releaseSave: (() => void) | undefined;
  let armed = false;
  const events: string[] = [];
  const store = {
    save: async () => {},
    saveNow: async () => {
      if (armed) {
        events.push("save:start");
        await new Promise<void>((resolve) => { releaseSave = resolve; });
        events.push("save:done");
      }
    },
  };
  const service = new SessionService(createConfig(), store, state);
  await service.createSession("api-fix", "codex", "backend");
  armed = true;
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
  let fail = false;
  const store = {
    save: async (snapshot: AppState) => { saved.push(structuredClone(snapshot)); },
    saveNow: async () => {
      if (fail) throw new Error("disk full");
    },
  };
  const service = new SessionService(createConfig(), store, state);
  await service.createSession("api-fix", "codex", "backend");
  fail = true;
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
  expect(crossAgent.agentCommand).toContain("acp-output-guard-main.");
  expect(crossAgent.agentCommand).toContain("@agentclientprotocol/claude-agent-acp@0.64.2");

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

  // Back-to-back mutations must not pay a debounce interval each and must not
  // reach the delegate until the window closes.
  expect(Date.now() - startedAt).toBeLessThan(200);
  // createSession persists via saveNow for G11 crash-durability (1 immediate write),
  // while setSessionModel rides the debounced store until flush.
  expect(inner.savedStates.length).toBe(1);

  await debounced.flush();
  expect(inner.savedStates.length).toBe(2);
  // The flushed write carries the LAST committed state.
  expect(inner.savedStates.at(-1)!.sessions["api-fix"]).toMatchObject({ model: "gpt-5.5" });

  // Lifecycle transitions are durability-gated instead: archive/restore write
  // immediately via saveNow rather than riding the debounce window.
  await service.setArchived("api-fix", true);
  await service.setArchived("api-fix", false);
  expect(inner.savedStates.length).toBe(4);
  expect(inner.savedStates[3]!.sessions["api-fix"]!.archived).toBeUndefined();
  expect(inner.savedStates[3]!.sessions["api-fix"]).toMatchObject({ model: "gpt-5.5" });
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

test("new sessions persist the guarded structured launch identity", async () => {
  const service = new SessionService(createConfig(), new MemoryStateStore(), createEmptyState());
  const transient = service.resolveSession(
    "guarded-run",
    "codex",
    "backend",
    "backend:guarded-run",
    { guardAcpOutput: true },
  );
  const created = await service.attachSession(
    "guarded-run",
    "codex",
    "backend",
    transient.transportSession,
    transient.agentCommand,
    transient.acpxAgent,
    transient.agentArgv,
  );

  expect(created.agentArgv?.[0]).toBe(process.execPath);
  expect(created.agentArgv?.[1]).toContain("acp-output-guard-main.");
  expect(created.agentArgv?.[2]).toBe("--");
  expect(created.agentCommand).toBe(renderAgentArgvIdentity(created.agentArgv!));
  expect(created.acpxAgent).toBe(deriveAgentAlias("codex", created.agentArgv!));

  const afterRestart = await service.getSession("guarded-run");
  expect(afterRestart?.agentArgv).toEqual(created.agentArgv);
  expect(afterRestart?.agentCommand).toBe(created.agentCommand);
});

test("resolveSession defaults newly-created structured launches to the ACP output guard", () => {
  const service = new SessionService(createConfig(), new MemoryStateStore(), createEmptyState());
  const resolved = service.resolveSession("default-guard", "codex", "backend", "backend:default-guard");

  expect(resolved.agentArgv?.[0]).toBe(process.execPath);
  expect(resolved.agentArgv?.[1]).toContain("acp-output-guard-main.");
  expect(resolved.agentArgv?.[2]).toBe("--");
});

test("guarded new resolution wraps a previously-recorded custom structured argv", async () => {
  const config = createConfig();
  config.agents.custom = { driver: "custom" };
  const service = new SessionService(config, new MemoryStateStore(), createEmptyState());
  await service.attachSession(
    "custom-existing",
    "custom",
    "backend",
    "backend:custom-existing",
    "custom-agent --acp",
    "custom-alias",
    ["/opt/custom-agent", "--acp"],
  );

  const guarded = service.resolveSession("custom-existing", "custom", "backend", "backend:custom-existing");
  expect(guarded.agentArgv?.[1]).toContain("acp-output-guard-main.");
  expect(guarded.agentArgv?.slice(3)).toEqual(["/opt/custom-agent", "--acp"]);

  const persisted = service.resolveSession(
    "custom-existing",
    "custom",
    "backend",
    "backend:custom-existing",
    { guardAcpOutput: false },
  );
  expect(persisted.agentArgv).toEqual(["/opt/custom-agent", "--acp"]);
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
  const service = new SessionService(config, new MemoryStateStore(), createEmptyState(), {
    platform: "linux",
  });
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

test("windows upgrades a recorded preinstalled managed command instead of treating it as raw", async () => {
  const config = createConfig();
  const state = createEmptyState();
  state.sessions.review = {
    alias: "review",
    agent: "codex",
    workspace: "backend",
    transport_session: "backend:review",
    transport_agent_command:
      '"C:\\xacpx\\runtime\\node.exe" "C:\\xacpx\\runtime\\adapters\\codex\\releases\\1.1.8-12345678-abcdef12\\node_modules\\@agentclientprotocol\\codex-acp\\bin\\codex-acp.js"',
  };

  const service = new SessionService(config, new MemoryStateStore(), state, {
    platform: "win32",
    runtimeRoot: "C:\\xacpx\\runtime",
  });
  const session = await service.getSession("review");

  expect(session?.agentArgv).toContain("@agentclientprotocol/codex-acp@1.1.9");
  expect(session?.agentCommand).not.toContain("1.1.8-12345678-abcdef12");
});

test("recorded preinstalled argv is derived and follows the active managed release", async () => {
  const config = createConfig();
  const state = createEmptyState();
  state.sessions.review = {
    alias: "review",
    agent: "codex",
    workspace: "backend",
    transport_session: "backend:review",
    transport_acpx_agent: "xacpx-managed-codex-oldrelease",
    transport_agent_command:
      '"/opt/xacpx/runtime/node" "/opt/xacpx/runtime/adapters/codex/releases/1.1.8-12345678-abcdef12/node_modules/@agentclientprotocol/codex-acp/bin/codex-acp.js"',
    transport_agent_argv: [
      "/opt/xacpx/runtime/node",
      "/opt/xacpx/runtime/adapters/codex/releases/1.1.8-12345678-abcdef12/node_modules/@agentclientprotocol/codex-acp/bin/codex-acp.js",
    ],
  };

  const service = new SessionService(config, new MemoryStateStore(), state, {
    runtimeRoot: "/opt/xacpx/runtime",
  });
  const session = await service.getSession("review");

  expect(session?.agentArgv).toContain("@agentclientprotocol/codex-acp@1.1.9");
  expect(session?.agentCommand).not.toContain("1.1.8-12345678-abcdef12");
});

test("custom recorded argv containing a managed-looking release path stays sticky", async () => {
  const config = createConfig();
  const state = createEmptyState();
  state.sessions.review = {
    alias: "review",
    agent: "codex",
    workspace: "backend",
    transport_session: "backend:review",
    transport_acpx_agent: "xacpx-managed-codex-custompath",
    transport_agent_command:
      '"/usr/bin/node" "/srv/adapters/codex/releases/1.1.8-12345678-abcdef12/node_modules/@agentclientprotocol/codex-acp/bin/codex-acp.js"',
    transport_agent_argv: [
      "/usr/bin/node",
      "/srv/adapters/codex/releases/1.1.8-12345678-abcdef12/node_modules/@agentclientprotocol/codex-acp/bin/codex-acp.js",
    ],
  };

  const service = new SessionService(config, new MemoryStateStore(), state);
  const session = await service.getSession("review");

  expect(session?.acpxAgent).toBe("xacpx-managed-codex-custompath");
  expect(session?.agentArgv).toEqual([
    "/usr/bin/node",
    "/srv/adapters/codex/releases/1.1.8-12345678-abcdef12/node_modules/@agentclientprotocol/codex-acp/bin/codex-acp.js",
  ]);
});

test("windows passes a custom recorded command containing a managed-looking path as raw selector", async () => {
  const config = createConfig();
  const state = createEmptyState();
  const recorded =
    '"C:\\usr\\bin\\node.exe" "C:\\srv\\adapters\\codex\\releases\\custom\\agent.js"';
  state.sessions.review = {
    alias: "review",
    agent: "codex",
    workspace: "backend",
    transport_session: "backend:review",
    transport_agent_command: recorded,
  };

  const service = new SessionService(config, new MemoryStateStore(), state, { platform: "win32" });
  const session = await service.getSession("review");

  expect(session?.rawCommand).toBe(recorded);
  expect(session?.agentCommand).toBe(recorded);
  expect(session?.agentArgv).toBeUndefined();
  expect(session?.acpxAgent).toBe("codex");
});

// ── windows recorded raw command selector ────────────────────────────────────

test("windows passes a recorded multi-token raw command through as acpx selector (no split)", async () => {
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
  const session = await service.getSession("review");
  expect(session?.rawCommand).toBe("node C:/path with space/agent.js --acp");
  expect(session?.agentCommand).toBe("node C:/path with space/agent.js --acp");
  expect(session?.agentArgv).toBeUndefined();
});

test("windows passes a recorded single-token command through as acpx selector", async () => {
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
  const session = await service.getSession("review");
  expect(session?.rawCommand).toBe("myagent.exe");
  expect(session?.agentCommand).toBe("myagent.exe");
  expect(session?.agentArgv).toBeUndefined();
});

test("windows built-in legacy raw selector (kimi acp) is not rejected by xacpx", async () => {
  const config = createConfig();
  config.agents.kimi = { driver: "kimi" };
  const state = createEmptyState();
  state.sessions.review = {
    alias: "review",
    agent: "kimi",
    workspace: "backend",
    transport_session: "backend:review",
    transport_agent_command: "kimi acp",
  };
  const service = new SessionService(config, new MemoryStateStore(), state, { platform: "win32" });
  const session = await service.getSession("review");
  expect(session?.rawCommand).toBe("kimi acp");
  expect(session?.agentCommand).toBe("kimi acp");
  expect(session?.agentArgv).toBeUndefined();
  expect(session?.acpxAgent).toBe("kimi");
});

test("recorded custom argv stays sticky even when the config argv changes", async () => {
  const config = createConfig();
  config.agents.custom = { driver: "custom", argv: ["C:\\Program Files\\agent-b.exe", "--acp"] };
  const state = createEmptyState();
  state.sessions.review = {
    alias: "review",
    agent: "custom",
    workspace: "backend",
    transport_session: "backend:review",
    transport_acpx_agent: "xacpx-managed-custom-aaaabbbbcccc",
    transport_agent_command: "C:\\Program Files\\agent-a.exe --acp",
    transport_agent_argv: ["C:\\Program Files\\agent-a.exe", "--acp"],
  };
  const service = new SessionService(config, new MemoryStateStore(), state);
  const session = await service.getSession("review");
  expect(session?.agentArgv).toEqual(["C:\\Program Files\\agent-a.exe", "--acp"]);
  expect(session?.acpxAgent).toBe("xacpx-managed-custom-aaaabbbbcccc");
});

test("command refresh preserves recorded structured launch fields", async () => {
  const config = createConfig();
  config.agents.custom = { driver: "custom" };
  const service = new SessionService(config, new MemoryStateStore(), createEmptyState());
  const created = await service.attachNativeSession({
    alias: "review",
    agent: "custom",
    workspace: "backend",
    transportSession: "backend:review",
    transportAgentCommand: "C:\\Program Files\\agent-a.exe --acp",
    transportAcpxAgent: "xacpx-managed-custom-aaaabbbbcccc",
    transportAgentArgv: ["C:\\Program Files\\agent-a.exe", "--acp"],
    agentSessionId: "thread-1",
  });
  expect(created.agentArgv).toEqual(["C:\\Program Files\\agent-a.exe", "--acp"]);

  // Refresh-style call with only the command: structured fields must survive.
  await service.setSessionTransportAgentCommand("review", "C:\\Program Files\\agent-b.exe --acp");
  const after = await service.getSession("review");
  expect(after?.agentCommand).toBe("C:\\Program Files\\agent-b.exe --acp");
  expect(after?.acpxAgent).toBe("xacpx-managed-custom-aaaabbbbcccc");
  expect(after?.agentArgv).toEqual(["C:\\Program Files\\agent-a.exe", "--acp"]);
});

// ── immutable logical_session_id ─────────────────────────────────────────────

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

test("createSession assigns a fresh UUIDv4 logical_session_id and persists it", async () => {
  const store = new MemoryStateStore();
  const state = createEmptyState();
  const service = new SessionService(createConfig(), store, state);

  await service.createSession("api-fix", "codex", "backend");

  const id = state.sessions["api-fix"]?.logical_session_id;
  expect(id).toMatch(UUID_V4_PATTERN);
  expect(store.savedStates.at(-1)?.sessions["api-fix"]?.logical_session_id).toBe(id);
});

test("attach and attach-native paths each assign a fresh logical_session_id", async () => {
  const store = new MemoryStateStore();
  const state = createEmptyState();
  const service = new SessionService(createConfig(), store, state);

  await service.attachSession("ext", "codex", "backend", "backend:ext");
  await service.attachNativeSession({
    alias: "native",
    agent: "codex",
    workspace: "backend",
    transportSession: "backend:native",
    agentSessionId: "thread-1",
  });

  const extId = state.sessions.ext?.logical_session_id;
  const nativeId = state.sessions.native?.logical_session_id;
  expect(extId).toMatch(UUID_V4_PATTERN);
  expect(nativeId).toMatch(UUID_V4_PATTERN);
  expect(extId).not.toBe(nativeId);
});

test("two aliases sharing one transport session get different logical_session_id values", async () => {
  const store = new MemoryStateStore();
  const state = createEmptyState();
  const service = new SessionService(createConfig(), store, state);

  await service.attachSession("one", "codex", "backend", "shared-transport");
  await service.attachSession("two", "codex", "backend", "shared-transport");

  const first = state.sessions.one?.logical_session_id;
  const second = state.sessions.two?.logical_session_id;
  expect(first).toMatch(UUID_V4_PATTERN);
  expect(second).toMatch(UUID_V4_PATTERN);
  expect(first).not.toBe(second);
});

test("deleting an alias and re-creating it yields a different logical_session_id", async () => {
  const store = new MemoryStateStore();
  const state = createEmptyState();
  const service = new SessionService(createConfig(), store, state);

  await service.createSession("api-fix", "codex", "backend");
  const originalId = state.sessions["api-fix"]?.logical_session_id;
  expect(originalId).toMatch(UUID_V4_PATTERN);

  await service.removeSession("api-fix");
  await service.createSession("api-fix", "codex", "backend");

  const recreatedId = state.sessions["api-fix"]?.logical_session_id;
  expect(recreatedId).toMatch(UUID_V4_PATTERN);
  expect(recreatedId).not.toBe(originalId);
});

test("ordinary updates to an existing session keep its logical_session_id", async () => {
  const store = new MemoryStateStore();
  const state = createEmptyState();
  const service = new SessionService(createConfig(), store, state);

  await service.createSession("api-fix", "codex", "backend");
  const id = state.sessions["api-fix"]?.logical_session_id;
  expect(id).toBeDefined();

  await service.setDisplayName("api-fix", "API fix");
  await service.setSessionModel("api-fix", "gpt-5.2");
  await service.setSessionEffort("api-fix", "high");
  await service.setSessionTransportAgentCommand("api-fix", "custom-acp-adapter");
  await service.useSession("wx:user", "api-fix");
  await service.setArchived("api-fix", true);
  await service.setArchived("api-fix", false);

  expect(state.sessions["api-fix"]?.logical_session_id).toBe(id);
  for (const saved of store.savedStates) {
    expect(saved.sessions["api-fix"]?.logical_session_id).toBe(id);
  }
});

function seedLifecycleSession(state: AppState, alias: string, archived = false): void {
  state.sessions[alias] = {
    alias,
    agent: "codex",
    workspace: "backend",
    transport_session: `backend:${alias}`,
    logical_session_id: `uuid-for-${alias}`,
    created_at: "2026-01-01T00:00:00.000Z",
    last_used_at: "2026-01-01T00:00:00.000Z",
    ...(archived ? { archived: true, archived_at: "2026-01-01T00:00:00.000Z" } : {}),
  };
}

function recordLifecycleEvents(service: SessionService): SessionResourceLifecyclePublishInput[] {
  const events: SessionResourceLifecyclePublishInput[] = [];
  service.setSessionResourceLifecyclePublisher((event) => {
    events.push(event);
  });
  return events;
}

test("archive publishes its lifecycle event only after saveNow settles", async () => {
  const state = createEmptyState();
  seedLifecycleSession(state, "api-fix");
  let releaseSave!: () => void;
  const saveGate = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  const events: string[] = [];
  const lifecycle = recordLifecycleEventsEventsOnly(events);
  const store = {
    save: async () => {},
    saveNow: async () => {
      events.push("save:start");
      await saveGate;
      events.push("save:done");
    },
  };
  const service = new SessionService(createConfig(), store, state);
  lifecycle(service);

  const pending = service.setArchived("api-fix", true);
  await Promise.resolve();
  // Mid-write: neither the runtime state nor the event stream shows the transition.
  expect(state.sessions["api-fix"]?.archived).toBeUndefined();
  expect(events).toEqual(["save:start"]);

  releaseSave();
  await pending;
  // Ordering: durable write -> runtime state publish -> lifecycle event.
  expect(events).toEqual(["save:start", "save:done", "lifecycle:archived"]);
  expect(state.sessions["api-fix"]?.archived).toBe(true);
});

function recordLifecycleEventsEventsOnly(events: string[]): (service: SessionService) => void {
  return (service) =>
    service.setSessionResourceLifecyclePublisher((event) => {
      events.push(`lifecycle:${event.type}`);
    });
}

test("removeSession publishes one 'removed' event carrying the pre-delete record snapshot", async () => {
  const state = createEmptyState();
  seedLifecycleSession(state, "api-fix", true);
  state.chat_contexts["wx:user"] = { current_session: "api-fix" };
  const store = new MemoryStateStore();
  const service = new SessionService(createConfig(), store, state);
  const events = recordLifecycleEvents(service);

  const result = await service.removeSession("api-fix");

  expect(result.wasActive).toBe(true);
  expect(events).toHaveLength(1);
  expect(events[0]?.type).toBe("removed");
  // The snapshot is the record as it existed BEFORE deletion: still archived,
  // with its immutable identity intact.
  expect(events[0]?.record).toMatchObject({
    alias: "api-fix",
    logical_session_id: "uuid-for-api-fix",
    transport_session: "backend:api-fix",
    archived: true,
    archived_at: "2026-01-01T00:00:00.000Z",
  });
  expect(state.sessions["api-fix"]).toBeUndefined();
  expect(state.chat_contexts["wx:user"]).toBeUndefined();
});

test("failed saveNow on removeSession leaves sessions, chat contexts and event stream untouched", async () => {
  const state = createEmptyState();
  seedLifecycleSession(state, "api-fix");
  state.chat_contexts["wx:user"] = { current_session: "api-fix", previous_session: "other" };
  const durableWrites: AppState[] = [];
  const store = {
    save: async (snapshot: AppState) => {
      durableWrites.push(structuredClone(snapshot));
    },
    saveNow: async () => {
      throw new Error("disk full");
    },
  };
  const service = new SessionService(createConfig(), store, state);
  const events = recordLifecycleEvents(service);

  await expect(service.removeSession("api-fix")).rejects.toThrow("disk full");

  expect(state.sessions["api-fix"]).toBeDefined();
  expect(state.chat_contexts["wx:user"]).toEqual({ current_session: "api-fix", previous_session: "other" });
  expect(events).toHaveLength(0);
  // Nothing durable was written by the failed transition.
  expect(durableWrites).toHaveLength(0);
});

test("useSession restore publishes 'restored' only after saveNow settles; plain switches publish nothing", async () => {
  // beforeAll already registers the feishu channel id used by these aliases.
  const state = createEmptyState();
  seedLifecycleSession(state, "feishu:fix", true);
  seedLifecycleSession(state, "feishu:other");
  const events: string[] = [];
  let saveNowCalls = 0;
  let debouncedSaves = 0;
  const store = {
    save: async () => {
      debouncedSaves += 1;
    },
    saveNow: async () => {
      saveNowCalls += 1;
    },
  };
  const service = new SessionService(createConfig(), store, state);
  service.setSessionResourceLifecyclePublisher((event) => {
    events.push(event.type);
  });

  // Restoring an archived session is durability-gated and publishes exactly once.
  await service.useSession("feishu:acc:user", "feishu:fix");
  expect(events).toEqual(["restored"]);
  expect(saveNowCalls).toBe(1);
  expect(state.sessions["feishu:fix"]?.archived).toBeUndefined();

  // Switching between active sessions keeps the cheap debounced persist and
  // publishes no lifecycle event.
  await service.useSession("feishu:acc:user", "feishu:other");
  expect(events).toEqual(["restored"]);
  expect(saveNowCalls).toBe(1);
  expect(debouncedSaves).toBe(1);
  expect(state.chat_contexts["feishu:acc:user"]?.current_session).toBe("feishu:other");
});
test("deriveFreeAlias returns the desired alias when it is free", () => {
  const service = new SessionService(createConfig(), new MemoryStateStore(), createEmptyState());
  expect(service.deriveFreeAlias("new-session")).toBe("new-session");
  expect(service.deriveFreeAlias("relay:new-session")).toBe("relay:new-session");
});

test("deriveFreeAlias appends -2 when the desired alias already exists", async () => {
  const service = new SessionService(createConfig(), new MemoryStateStore(), createEmptyState());
  await service.attachNativeSession({
    alias: "demo", agent: "codex", workspace: "backend", transportSession: "backend:demo", agentSessionId: "a",
  });
  expect(service.deriveFreeAlias("demo")).toBe("demo-2");
});

test("deriveFreeAlias keeps appending suffixes until a free slot is found", async () => {
  const service = new SessionService(createConfig(), new MemoryStateStore(), createEmptyState());
  await service.attachNativeSession({
    alias: "demo", agent: "codex", workspace: "backend", transportSession: "backend:demo", agentSessionId: "a1",
  });
  await service.attachNativeSession({
    alias: "demo-2", agent: "codex", workspace: "backend", transportSession: "backend:demo-2", agentSessionId: "a2",
  });
  await service.attachNativeSession({
    alias: "demo-3", agent: "codex", workspace: "backend", transportSession: "backend:demo-3", agentSessionId: "a3",
  });
  expect(service.deriveFreeAlias("demo")).toBe("demo-4");
});

test("deriveFreeAlias preserves a channel prefix when appending the suffix", async () => {
  const service = new SessionService(createConfig(), new MemoryStateStore(), createEmptyState());
  await service.attachNativeSession({
    alias: "relay:demo", agent: "codex", workspace: "backend", transportSession: "backend:relay-demo", agentSessionId: "a",
  });
  expect(service.deriveFreeAlias("relay:demo")).toBe("relay:demo-2");
});

test("deriveFreeAlias increments an existing numeric suffix instead of stacking a new one", async () => {
  const service = new SessionService(createConfig(), new MemoryStateStore(), createEmptyState());
  await service.attachNativeSession({
    alias: "demo-2", agent: "codex", workspace: "backend", transportSession: "backend:demo-2", agentSessionId: "a",
  });
  expect(service.deriveFreeAlias("demo-2")).toBe("demo-3");
});

test("deriveFreeAlias increments an existing numeric suffix when a channel prefix is present", async () => {
  const service = new SessionService(createConfig(), new MemoryStateStore(), createEmptyState());
  await service.attachNativeSession({
    alias: "relay:demo-5", agent: "codex", workspace: "backend", transportSession: "backend:relay-demo-5", agentSessionId: "a",
  });
  expect(service.deriveFreeAlias("relay:demo-5")).toBe("relay:demo-6");
});

test("deriveFreeAlias treats archived sessions as taken (collisions still suffix)", async () => {
  const service = new SessionService(createConfig(), new MemoryStateStore(), createEmptyState());
  await service.attachNativeSession({
    alias: "demo", agent: "codex", workspace: "backend", transportSession: "backend:demo", agentSessionId: "a",
  });
  await service.setArchived("demo", true);
  expect(service.deriveFreeAlias("demo")).toBe("demo-2");
});

test("strict runtime engine fails session creation before persist when nonInteractivePermissions is fail", async () => {
  const state = createEmptyState();
  const store = new MemoryStateStore();
  const config = createConfig();
  delete config.transport.command;
  config.transport.engine = "runtime";
  config.transport.nonInteractivePermissions = "fail";
  const service = new SessionService(config, store, state);

  await expect(service.createSession("ineligible-session", "codex", "backend")).rejects.toThrow(
    /is not eligible with nonInteractivePermissions = "fail"/,
  );
});

test("strict runtime engine fails session creation before persist when escalate policy has no interactive permissions", async () => {
  const state = createEmptyState();
  const store = new MemoryStateStore();
  const config = createConfig();
  delete config.transport.command;
  config.transport.engine = "runtime";
  config.transport.permissionPolicy = JSON.stringify({ escalate: ["edit"] });
  const service = new SessionService(config, store, state, { permissionInteractionAvailable: false });

  await expect(service.createSession("escalate-session", "codex", "backend")).rejects.toThrow(
    /is not eligible under current permission policy/,
  );
});

test("auto engine falls back to cli when nonInteractivePermissions is fail and persists cli", async () => {
  const state = createEmptyState();
  const store = new MemoryStateStore();
  const config = createConfig();
  config.transport.engine = "auto";
  config.transport.nonInteractivePermissions = "fail";
  const service = new SessionService(config, store, state);

  const session = await service.createSession("auto-ineligible", "codex", "backend");
  expect(session.transportEngine).toBe("cli");
  expect(state.sessions["auto-ineligible"]?.transport_engine).toBe("cli");
});

test("recreated session retains persisted runtime transport_engine even under ineligible config", async () => {
  const state = createEmptyState();
  state.sessions["existing-rt"] = {
    alias: "existing-rt",
    agent: "codex",
    workspace: "backend",
    transport_session: "backend:existing-rt",
    logical_session_id: "prev-id",
    transport_engine: "runtime",
    created_at: new Date().toISOString(),
    last_used_at: new Date().toISOString(),
  };
  const store = new MemoryStateStore();
  const config = createConfig();
  config.transport.engine = "cli";
  config.transport.nonInteractivePermissions = "fail";
  const service = new SessionService(config, store, state);

  const session = await service.createSession("existing-rt", "codex", "backend");
  expect(session.transportEngine).toBe("runtime");
  expect(state.sessions["existing-rt"]?.transport_engine).toBe("runtime");
});
test("resolveSession carries persisted runtime transport_engine on transient resolution", () => {
  const state = createEmptyState();
  state.sessions["existing-rt"] = {
    alias: "existing-rt",
    agent: "codex",
    workspace: "backend",
    transport_session: "backend:existing-rt",
    logical_session_id: "prev-id",
    transport_engine: "runtime",
    created_at: new Date().toISOString(),
    last_used_at: new Date().toISOString(),
  };
  const store = new MemoryStateStore();
  const config = createConfig();
  config.transport.engine = "cli";
  const service = new SessionService(config, store, state);

  const resolved = service.resolveSession("existing-rt", "codex", "backend", "backend:existing-rt:reset-1");
  expect(resolved.transportEngine).toBe("runtime");
  expect(resolved.logicalSessionId).toBe("prev-id");
});

test("rollbackSessionRecord durably restores a snapshot", async () => {
  const state = createEmptyState();
  const snapshot = {
    alias: "test-sess",
    agent: "codex",
    workspace: "backend",
    transport_session: "backend:test-sess",
    logical_session_id: "prev-id",
    transport_engine: "runtime" as const,
    created_at: new Date().toISOString(),
    last_used_at: new Date().toISOString(),
  };
  state.sessions["test-sess"] = {
    ...snapshot,
    logical_session_id: "new-id",
    transport_session: "backend:test-sess:reset-999",
  };
  const store = new MemoryStateStore();
  const service = new SessionService(createConfig(), store, state);

  await service.rollbackSessionRecord("test-sess", snapshot);
  expect(state.sessions["test-sess"]?.logical_session_id).toBe("prev-id");
  expect(state.sessions["test-sess"]?.transport_session).toBe("backend:test-sess");
  expect(store.savedStates.at(-1)?.sessions["test-sess"]?.logical_session_id).toBe("prev-id");
});

test("rollbackSessionRecord deletes alias if snapshot was null", async () => {
  const state = createEmptyState();
  state.sessions["test-sess"] = {
    alias: "test-sess",
    agent: "codex",
    workspace: "backend",
    transport_session: "backend:test-sess",
    logical_session_id: "fresh-id",
    transport_engine: "cli" as const,
    created_at: new Date().toISOString(),
    last_used_at: new Date().toISOString(),
  };
  const store = new MemoryStateStore();
  const service = new SessionService(createConfig(), store, state);

  await service.rollbackSessionRecord("test-sess", null);
  expect(state.sessions["test-sess"]).toBeUndefined();
  expect(store.savedStates.at(-1)?.sessions["test-sess"]).toBeUndefined();
});

test("updateNativeAgentSessionId updates native session fields without changing logical_session_id", async () => {
  const state = createEmptyState();
  state.sessions["native-sess"] = {
    alias: "native-sess",
    agent: "codex",
    workspace: "backend",
    transport_session: "backend:native-sess:reset-1",
    logical_session_id: "stable-lid",
    transport_engine: "runtime",
    source: "agent-side",
    created_at: new Date().toISOString(),
    last_used_at: new Date().toISOString(),
  };
  const store = new MemoryStateStore();
  const service = new SessionService(createConfig(), store, state);

  await service.updateNativeAgentSessionId("native-sess", "fresh-agent-id", "2026-09-03T12:00:00.000Z");
  expect(state.sessions["native-sess"]?.logical_session_id).toBe("stable-lid");
  expect(state.sessions["native-sess"]?.source).toBe("agent-side");
  expect(state.sessions["native-sess"]?.agent_session_id).toBe("fresh-agent-id");
  expect(state.sessions["native-sess"]?.agent_session_updated_at).toBe("2026-09-03T12:00:00.000Z");

  // Clear native session fields on fallback
  await service.updateNativeAgentSessionId("native-sess", undefined);
  expect(state.sessions["native-sess"]?.logical_session_id).toBe("stable-lid");
  expect(state.sessions["native-sess"]?.source).toBeUndefined();
  expect(state.sessions["native-sess"]?.agent_session_id).toBeUndefined();
});
test("cached Bridge capability probe failure forces auto to cli before persist", async () => {
  const state = createEmptyState();
  const store = new MemoryStateStore();
  const config = createConfig();
  delete config.transport.command;
  config.transport.engine = "auto";
  const service = new SessionService(config, store, state);
  // Worker file may exist locally, but the Bridge host failed the probe.
  service.setRuntimeCapability({ runtimeAvailable: true, runtimeImportOk: false, contractProbeOk: false });
  const session = await service.createSession("probe-fail", "codex", "backend");
  expect(session.transportEngine).toBe("cli");
  expect(state.sessions["probe-fail"]?.transport_engine).toBe("cli");
});

test("cached Bridge capability probe failure rejects strict runtime before state mutation", async () => {
  const state = createEmptyState();
  const store = new MemoryStateStore();
  const config = createConfig();
  delete config.transport.command;
  config.transport.engine = "runtime";
  const service = new SessionService(config, store, state);
  service.setRuntimeCapability({ runtimeAvailable: true, runtimeImportOk: true, contractProbeOk: false });
  await expect(service.createSession("probe-fail-strict", "codex", "backend")).rejects.toThrow(
    /capability probe/,
  );
  expect(state.sessions["probe-fail-strict"]).toBeUndefined();
});

test("cached Bridge capability success allows auto to bind runtime", async () => {
  const state = createEmptyState();
  const store = new MemoryStateStore();
  const config = createConfig();
  delete config.transport.command;
  config.transport.engine = "auto";
  const service = new SessionService(config, store, state);
  service.setRuntimeCapability({ runtimeAvailable: true, runtimeImportOk: true, contractProbeOk: true });
  const session = await service.createSession("probe-ok", "codex", "backend");
  expect(session.transportEngine).toBe("runtime");
  expect(state.sessions["probe-ok"]?.transport_engine).toBe("runtime");
});
