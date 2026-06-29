import { test, expect, mock } from "bun:test";
import { CommandRouter } from "../../../src/commands/command-router";
import type { SessionService } from "../../../src/sessions/session-service";
import type { ResolvedSession, SessionTransport } from "../../../src/transport/types";

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
}): SessionService {
  const session = makeSession();
  return {
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
