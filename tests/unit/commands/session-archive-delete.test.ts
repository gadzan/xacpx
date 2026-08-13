import { beforeAll, test, expect, mock } from "bun:test";
import { CommandRouter } from "../../../src/commands/command-router";
import { SessionService } from "../../../src/sessions/session-service";
import { CoreSessionResourceCatalog, type SessionResourceLifecycleEvent } from "../../../src/sessions/session-resource-catalog";
import { createEmptyState, type AppState } from "../../../src/state/types";
import type { AppConfig } from "../../../src/config/types";
import type { AppLogger } from "../../../src/logging/app-logger";
import { registerKnownChannelId } from "../../../src/channels/channel-scope";
import { setLocale } from "../../../src/i18n";
import type { ResolvedSession, SessionTransport } from "../../../src/transport/types";

beforeAll(() => {
  setLocale("zh");
  registerKnownChannelId("weixin");
});

function makeSession(): ResolvedSession {
  return {
    alias: "demo",
    agent: "codex",
    workspace: "backend",
    transportSession: "backend:demo",
    cwd: "/tmp/backend",
  } as unknown as ResolvedSession;
}

function makeSessions(overrides: {
  sharedCount: number;
  lifecycleBusy?: boolean;
}): SessionService {
  const session = makeSession();
  return {
    tryReserveSessionAliasOperation: mock((_alias: string) =>
      overrides.lifecycleBusy ? null : () => {},
    ),
    getSession: mock(async (_alias: string) => session),
    countAliasesSharingTransport: mock(
      (_transportSession: string, _excludeAlias?: string) => overrides.sharedCount,
    ),
    removeSession: mock(async (_alias: string) => ({ wasActive: true })),
    setArchived: mock(async (_alias: string, _archived: boolean) => {}),
  } as unknown as SessionService;
}

function makeTransport(): SessionTransport {
  return {
    cancel: mock(async () => ({ cancelled: true, message: "cancelled" })),
    removeSession: mock(async (_session: ResolvedSession) => {}),
    deleteSession: mock(async (_session: ResolvedSession) => {}),
    freeWarmProcess: mock(async (_session: ResolvedSession) => {}),
  } as unknown as SessionTransport;
}

test("removeSessionWithTransport deletes acpx history when no other alias shares the transport", async () => {
  const sessions = makeSessions({ sharedCount: 0 });
  const transport = makeTransport();
  const router = new CommandRouter(sessions, transport);

  const result = await router.removeSessionWithTransport("backend:demo");

  expect((sessions.removeSession as ReturnType<typeof mock>).mock.calls.length).toBe(1);
  expect((transport.deleteSession as ReturnType<typeof mock>).mock.calls.length).toBe(1);
  expect((transport.removeSession as ReturnType<typeof mock>).mock.calls.length).toBe(0);
  expect(result.transportTornDown).toBe(true);
  expect(result.sharedAliasCount).toBe(0);
});

test("removeSessionWithTransport leaves the shared transport intact", async () => {
  const sessions = makeSessions({ sharedCount: 1 });
  const transport = makeTransport();
  const router = new CommandRouter(sessions, transport);

  const result = await router.removeSessionWithTransport("backend:demo");

  expect((sessions.removeSession as ReturnType<typeof mock>).mock.calls.length).toBe(1);
  expect((transport.deleteSession as ReturnType<typeof mock>).mock.calls.length).toBe(0);
  expect(result.transportTornDown).toBe(false);
  expect(result.sharedAliasCount).toBe(1);
});

test("removeSessionWithTransport refuses to race another alias lifecycle operation", async () => {
  const sessions = makeSessions({ sharedCount: 0, lifecycleBusy: true });
  const transport = makeTransport();
  const router = new CommandRouter(sessions, transport);

  await expect(router.removeSessionWithTransport("backend:demo")).rejects.toThrow(
    /lifecycle operation in progress/,
  );
  expect((sessions.removeSession as ReturnType<typeof mock>).mock.calls).toHaveLength(0);
  expect((transport.deleteSession as ReturnType<typeof mock>).mock.calls).toHaveLength(0);
});

test("archiveSessionWithTransport cancels the in-flight turn and reaps the warm process but KEEPS the acpx session resumable", async () => {
  const sessions = makeSessions({ sharedCount: 0 });
  const transport = makeTransport();
  const router = new CommandRouter(sessions, transport);

  await router.archiveSessionWithTransport("backend:demo");

  expect((transport.cancel as ReturnType<typeof mock>).mock.calls.length).toBe(1);
  // Frees the warm queue-owner process now (instead of waiting for TTL)...
  expect((transport.freeWarmProcess as ReturnType<typeof mock>).mock.calls.length).toBe(1);
  // ...but must NOT close: closing marks the record `closed`, making it unresumable
  // and losing history on the next prompt. The session stays alive so re-prompting
  // resumes the same conversation.
  expect((transport.removeSession as ReturnType<typeof mock>).mock.calls.length).toBe(0);
  const setArchived = sessions.setArchived as ReturnType<typeof mock>;
  expect(setArchived.mock.calls.length).toBe(1);
  expect(setArchived.mock.calls[0]).toEqual(["backend:demo", true]);
  // archive must not delete history.
  expect((transport.deleteSession as ReturnType<typeof mock>).mock.calls.length).toBe(0);
});

test("archiveSessionWithTransport keeps a shared process running", async () => {
  const sessions = makeSessions({ sharedCount: 2 });
  const transport = makeTransport();
  const router = new CommandRouter(sessions, transport);

  await router.archiveSessionWithTransport("backend:demo");

  // Shared transport: don't cancel and don't reap — another live alias needs the process.
  expect((transport.cancel as ReturnType<typeof mock>).mock.calls.length).toBe(0);
  expect((transport.freeWarmProcess as ReturnType<typeof mock>).mock.calls.length).toBe(0);
  expect((transport.removeSession as ReturnType<typeof mock>).mock.calls.length).toBe(0);
  expect((sessions.setArchived as ReturnType<typeof mock>).mock.calls.length).toBe(1);
});

test("archiveSessionWithTransport still archives when freeWarmProcess throws", async () => {
  const sessions = makeSessions({ sharedCount: 0 });
  const transport = makeTransport();
  (transport.freeWarmProcess as ReturnType<typeof mock>).mockImplementation(async () => {
    throw new Error("kill failed");
  });
  const router = new CommandRouter(sessions, transport);

  await router.archiveSessionWithTransport("backend:demo");

  expect((transport.freeWarmProcess as ReturnType<typeof mock>).mock.calls.length).toBe(1);
  const setArchived = sessions.setArchived as ReturnType<typeof mock>;
  expect(setArchived.mock.calls.length).toBe(1);
  expect(setArchived.mock.calls[0]).toEqual(["backend:demo", true]);
});

function makeOrchestration(overrides: {
  blocking: unknown[];
}) {
  return {
    listSessionBlockingTasks: mock(async (_transportSession: string) => overrides.blocking),
    purgeSessionReferences: mock(async (_transportSession: string) => {}),
  };
}

function makeActiveTurns(active: boolean) {
  return {
    isActiveAnywhere: mock((_alias: string) => active),
  };
}

test("removeSessionWithTransport throws and deletes nothing when orchestration reports blocking tasks", async () => {
  const sessions = makeSessions({ sharedCount: 0 });
  const transport = makeTransport();
  const orchestration = makeOrchestration({ blocking: [{ taskId: "t1" }] });
  const router = new CommandRouter(
    sessions,
    transport,
    undefined,
    undefined,
    undefined,
    undefined,
    orchestration as never,
  );

  await expect(router.removeSessionWithTransport("backend:demo")).rejects.toThrow(/blocking task/);

  expect((orchestration.listSessionBlockingTasks as ReturnType<typeof mock>).mock.calls.length).toBe(1);
  expect((sessions.removeSession as ReturnType<typeof mock>).mock.calls.length).toBe(0);
  expect((transport.deleteSession as ReturnType<typeof mock>).mock.calls.length).toBe(0);
  expect((orchestration.purgeSessionReferences as ReturnType<typeof mock>).mock.calls.length).toBe(0);
});

test("removeSessionWithTransport purges orchestration references after a successful unshared delete", async () => {
  const sessions = makeSessions({ sharedCount: 0 });
  const transport = makeTransport();
  const orchestration = makeOrchestration({ blocking: [] });
  const router = new CommandRouter(
    sessions,
    transport,
    undefined,
    undefined,
    undefined,
    undefined,
    orchestration as never,
  );

  const result = await router.removeSessionWithTransport("backend:demo");

  expect((sessions.removeSession as ReturnType<typeof mock>).mock.calls.length).toBe(1);
  expect((transport.deleteSession as ReturnType<typeof mock>).mock.calls.length).toBe(1);
  const purge = orchestration.purgeSessionReferences as ReturnType<typeof mock>;
  expect(purge.mock.calls.length).toBe(1);
  expect(purge.mock.calls[0]).toEqual(["backend:demo"]);
  expect(result.transportTornDown).toBe(true);
});

test("archiveSessionWithTransport throws and touches nothing when a turn is active", async () => {
  const sessions = makeSessions({ sharedCount: 0 });
  const transport = makeTransport();
  const activeTurns = makeActiveTurns(true);
  const router = new CommandRouter(
    sessions,
    transport,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    activeTurns as never,
  );

  await expect(router.archiveSessionWithTransport("backend:demo")).rejects.toThrow(/running turn/);

  expect((activeTurns.isActiveAnywhere as ReturnType<typeof mock>).mock.calls.length).toBe(1);
  expect((transport.cancel as ReturnType<typeof mock>).mock.calls.length).toBe(0);
  // The in-flight guard throws before the !shared block, so the reap is blocked too.
  expect((transport.freeWarmProcess as ReturnType<typeof mock>).mock.calls.length).toBe(0);
  expect((transport.removeSession as ReturnType<typeof mock>).mock.calls.length).toBe(0);
  expect((sessions.setArchived as ReturnType<typeof mock>).mock.calls.length).toBe(0);
});

test("unarchiveSession flips the archived flag with no transport action", async () => {
  const sessions = makeSessions({ sharedCount: 0 });
  const transport = makeTransport();
  const router = new CommandRouter(sessions, transport);

  await router.unarchiveSession("backend:demo");

  const setArchived = sessions.setArchived as ReturnType<typeof mock>;
  expect(setArchived.mock.calls.length).toBe(1);
  expect(setArchived.mock.calls[0]).toEqual(["backend:demo", false]);
  expect((transport.cancel as ReturnType<typeof mock>).mock.calls.length).toBe(0);
  expect((transport.removeSession as ReturnType<typeof mock>).mock.calls.length).toBe(0);
  expect((transport.deleteSession as ReturnType<typeof mock>).mock.calls.length).toBe(0);
});

// --- Funnel integration tests -------------------------------------------------
// Every archive/restore/remove entry point (chat command handlers AND the
// web/control surface) must converge on the same SessionService transition so
// each logical operation publishes exactly ONE resource lifecycle event.

function makeRealConfig(): AppConfig {
  return {
    transport: { type: "acpx-cli", command: "acpx", permissionMode: "approve-all", nonInteractivePermissions: "deny" },
    logging: { level: "info", maxSizeBytes: 1024, maxFiles: 2, retentionDays: 1 },
    channel: { type: "weixin", replyMode: "stream" },
    channels: [{ id: "weixin", type: "weixin", enabled: true }],
    agents: { codex: { driver: "codex" } },
    workspaces: { backend: { cwd: "/tmp/backend" } },
    orchestration: {
      maxPendingAgentRequestsPerCoordinator: 3,
      allowWorkerChainedRequests: false,
      allowedAgentRequestTargets: [],
      allowedAgentRequestRoles: [],
    },
  };
}

const noopLogger: AppLogger = {
  debug: async () => {},
  info: async () => {},
  warn: async () => {},
  error: async () => {},
  cleanup: async () => {},
  flush: async () => {},
};

function makeRealStack(opts: { archived?: boolean } = {}) {
  const config = makeRealConfig();
  const state = createEmptyState();
  state.sessions["weixin:demo"] = {
    alias: "weixin:demo",
    agent: "codex",
    workspace: "backend",
    transport_session: "backend:weixin:demo",
    logical_session_id: "uuid-for-weixin:demo",
    created_at: "2026-01-01T00:00:00.000Z",
    last_used_at: "2026-01-01T00:00:00.000Z",
    ...(opts.archived ? { archived: true, archived_at: "2026-01-02T00:00:00.000Z" } : {}),
  };
  const store = { save: async (_s: AppState) => {}, saveNow: async (_s: AppState) => {} };
  const sessions = new SessionService(config, store, state);
  const catalog = new CoreSessionResourceCatalog({ sessions, config, logger: noopLogger });
  sessions.setSessionResourceLifecyclePublisher((transition) => catalog.publishLifecycleEvent(transition));
  const events: SessionResourceLifecycleEvent[] = [];
  catalog.subscribe((event) => events.push(event));
  const transport = {
    cancel: mock(async () => ({ cancelled: true, message: "cancelled" })),
    freeWarmProcess: mock(async (_session: ResolvedSession) => {}),
    deleteSession: mock(async (_session: ResolvedSession) => {}),
  } as unknown as SessionTransport;
  const router = new CommandRouter(sessions, transport, config);
  return { state, events, router, transport };
}

test("web/control archive entry point publishes exactly one archived event", async () => {
  const { state, events, router } = makeRealStack();

  await router.archiveSessionWithTransport("weixin:demo");

  expect(state.sessions["weixin:demo"]?.archived).toBe(true);
  expect(events.map((event) => event.type)).toEqual(["archived"]);
  expect(events[0]?.session.internalAlias).toBe("weixin:demo");
});

test("web/control unarchive entry point publishes exactly one restored event", async () => {
  const { state, events, router } = makeRealStack({ archived: true });

  await router.unarchiveSession("weixin:demo");

  expect(state.sessions["weixin:demo"]?.archived).toBeUndefined();
  expect(events.map((event) => event.type)).toEqual(["restored"]);
});

test("web/control remove entry point publishes exactly one removed event with the pre-delete snapshot", async () => {
  const { state, events, router } = makeRealStack({ archived: true });

  await router.removeSessionWithTransport("weixin:demo");

  expect(state.sessions["weixin:demo"]).toBeUndefined();
  expect(events.map((event) => event.type)).toEqual(["removed"]);
  expect(events[0]?.session.archived).toBe(true);
  expect(events[0]?.session.logicalSessionId).toBe("uuid-for-weixin:demo");
});

test("chat /session archive publishes exactly one archived event", async () => {
  const { state, events, router } = makeRealStack();

  const response = await router.handle("weixin:user-1", "/session archive demo");

  expect(response.text.length).toBeGreaterThan(0);
  expect(state.sessions["weixin:demo"]?.archived).toBe(true);
  expect(events.map((event) => event.type)).toEqual(["archived"]);
});

test("chat /session rm publishes exactly one removed event (no double emission with the web path)", async () => {
  const { state, events, router } = makeRealStack();

  const response = await router.handle("weixin:user-1", "/session rm demo");

  expect(response.text.length).toBeGreaterThan(0);
  expect(state.sessions["weixin:demo"]).toBeUndefined();
  // The chat handler and SessionControlService share the same SessionService
  // transition, so one logical delete emits exactly one event.
  expect(events.map((event) => event.type)).toEqual(["removed"]);
  expect(events[0]?.session.internalAlias).toBe("weixin:demo");
});
