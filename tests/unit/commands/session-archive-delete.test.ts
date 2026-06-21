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

test("archiveSessionWithTransport closes the unshared process then flags archived", async () => {
  const sessions = makeSessions({ sharedCount: 0 });
  const transport = makeTransport();
  const router = new CommandRouter(sessions, transport);

  await router.archiveSessionWithTransport("backend:demo");

  expect((transport.cancel as ReturnType<typeof mock>).mock.calls.length).toBe(1);
  expect((transport.removeSession as ReturnType<typeof mock>).mock.calls.length).toBe(1);
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

  expect((transport.cancel as ReturnType<typeof mock>).mock.calls.length).toBe(0);
  expect((transport.removeSession as ReturnType<typeof mock>).mock.calls.length).toBe(0);
  expect((sessions.setArchived as ReturnType<typeof mock>).mock.calls.length).toBe(1);
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
