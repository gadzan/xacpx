import { expect, test } from "bun:test";

import { removeAliasWithPhysicalLifecycle } from "../../../src/commands/session-remove-lifecycle";
import type { AppConfig } from "../../../src/config/types";
import { AsyncMutex } from "../../../src/orchestration/async-mutex";
import { createStrictOwnedSessionRelease } from "../../../src/sessions/owned-session-release";
import { SessionService } from "../../../src/sessions/session-service";
import type { StateStore } from "../../../src/state/state-store";
import { createEmptyState, type AppState } from "../../../src/state/types";
import type { ResolvedSession, SessionTransport } from "../../../src/transport/types";

const NOW = "2026-09-15T12:00:00.000Z";

class MemoryStateStore implements Pick<StateStore, "save" | "saveNow"> {
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

function createSessions(state = createEmptyState()) {
  const store = new MemoryStateStore();
  const sessions = new SessionService(createConfig(), store, state, {
    now: () => Date.parse(NOW),
    stateMutex: new AsyncMutex(),
  });
  return { state, sessions };
}

function throwingTransport(kind: "delete" | "release"): SessionTransport {
  return {
    deleteSession: async () => {
      if (kind === "delete") {
        throw new Error("injected CLI/Runtime delete failure");
      }
    },
    releaseLogicalSession: async () => {
      if (kind === "release") {
        throw new Error("injected Runtime release failure");
      }
    },
  } as SessionTransport;
}

function succeedingTransport(): Pick<SessionTransport, "deleteSession" | "releaseLogicalSession"> {
  return {
    deleteSession: async () => {},
    releaseLogicalSession: async () => {},
  };
}

test("legacy CLI last-owner delete failure still removes the LogicalSession", async () => {
  const { state, sessions } = createSessions();
  await sessions.createSession("cli-legacy", "codex", "backend");
  const session = await sessions.getSession("cli-legacy");
  expect(session).toBeTruthy();
  const outcome = await removeAliasWithPhysicalLifecycle({
    sessions,
    transport: throwingTransport("delete"),
    session: session as ResolvedSession,
    internalAlias: "cli-legacy",
  });
  expect(outcome.action).toBe("logical-only");
  expect(outcome.transportTeardownWarning).toContain("injected CLI/Runtime delete failure");
  expect(state.sessions["cli-legacy"]).toBeUndefined();
});

test("strict CLI last-owner delete failure keeps the LogicalSession", async () => {
  const { state, sessions } = createSessions();
  await sessions.createSession("cli-strict", "codex", "backend");
  const release = createStrictOwnedSessionRelease({
    sessions,
    transport: throwingTransport("delete"),
  });
  await expect(release("cli-strict")).rejects.toThrow("injected CLI/Runtime delete failure");
  expect(state.sessions["cli-strict"]).toBeDefined();
});

test("strict Runtime last-owner delete failure keeps the LogicalSession", async () => {
  const { state, sessions } = createSessions();
  await sessions.createSession("rt-delete", "codex", "backend");
  state.sessions["rt-delete"]!.transport_engine = "runtime";
  const release = createStrictOwnedSessionRelease({
    sessions,
    transport: throwingTransport("delete"),
  });
  await expect(release("rt-delete")).rejects.toThrow("injected CLI/Runtime delete failure");
  expect(state.sessions["rt-delete"]).toBeDefined();
});

test("strict Runtime sibling release failure keeps the LogicalSession", async () => {
  const { state, sessions } = createSessions();
  await sessions.createSession("rt-a", "codex", "backend");
  await sessions.createSession("rt-b", "codex", "backend");
  state.sessions["rt-a"]!.transport_engine = "runtime";
  state.sessions["rt-b"]!.transport_engine = "runtime";
  state.sessions["rt-b"]!.transport_session = state.sessions["rt-a"]!.transport_session;
  const release = createStrictOwnedSessionRelease({
    sessions,
    transport: throwingTransport("release"),
  });
  await expect(release("rt-a")).rejects.toThrow("injected Runtime release failure");
  expect(state.sessions["rt-a"]).toBeDefined();
  expect(state.sessions["rt-b"]).toBeDefined();
});

test("strict verified release removes the LogicalSession", async () => {
  const { state, sessions } = createSessions();
  await sessions.createSession("cli-ok", "codex", "backend");
  const release = createStrictOwnedSessionRelease({
    sessions,
    transport: succeedingTransport(),
  });
  await release("cli-ok");
  expect(state.sessions["cli-ok"]).toBeUndefined();
});
