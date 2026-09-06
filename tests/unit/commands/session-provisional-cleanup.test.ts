import { expect, mock, test } from "bun:test";

import {
  convergeProvisionalCreate,
  convergeProvisionalNativeAttach,
} from "../../../src/commands/session-remove-lifecycle";
import type { SessionService } from "../../../src/sessions/session-service";
import type { ResolvedSession } from "../../../src/transport/types";

function session(overrides: Partial<ResolvedSession> = {}): ResolvedSession {
  return {
    alias: "u",
    agent: "codex",
    workspace: "backend",
    transportSession: "W",
    cwd: "/tmp/backend",
    transportEngine: "runtime",
    ...overrides,
  } as ResolvedSession;
}

function fakeSessions() {
  const removeSession = mock(async (_alias: string) => ({ wasActive: true }));
  return {
    sessions: { removeSession } as unknown as SessionService,
    dropRow: removeSession,
  };
}

test("native attach convergence releases the runtime identity without hard-deleting", async () => {
  const releaseLogicalSession = mock(async (_session: ResolvedSession) => {});
  const removeSession = mock(async (_session: ResolvedSession) => {});
  const deleteSession = mock(async (_session: ResolvedSession) => {});
  const { sessions, dropRow } = fakeSessions();

  await convergeProvisionalNativeAttach({
    sessions,
    transport: { releaseLogicalSession, removeSession, deleteSession },
    session: session(),
    internalAlias: "u",
    cause: new Error("resume boom"),
  });

  // The upstream thread must survive: release stops the provisional worker
  // and drops the journal without stamping the upstream record, and neither
  // soft-close (runtime) nor hard-delete ever runs.
  expect(releaseLogicalSession).toHaveBeenCalledTimes(1);
  expect(removeSession).not.toHaveBeenCalled();
  expect(deleteSession).not.toHaveBeenCalled();
  expect(dropRow).toHaveBeenCalledWith("u");
});

test("native attach convergence soft-closes CLI incarnations", async () => {
  const removeSession = mock(async (_session: ResolvedSession) => {});
  const deleteSession = mock(async (_session: ResolvedSession) => {});
  const { sessions, dropRow } = fakeSessions();

  await convergeProvisionalNativeAttach({
    sessions,
    transport: { removeSession, deleteSession },
    session: session({ transportEngine: "cli" }),
    internalAlias: "u",
    cause: new Error("resume boom"),
  });

  expect(removeSession).toHaveBeenCalledTimes(1);
  expect(deleteSession).not.toHaveBeenCalled();
  expect(dropRow).toHaveBeenCalledWith("u");
});

test("native attach convergence keeps the row when release fails", async () => {
  const releaseLogicalSession = mock(async (_session: ResolvedSession) => {
    throw new Error("release boom");
  });
  const { sessions, dropRow } = fakeSessions();

  await expect(
    convergeProvisionalNativeAttach({
      sessions,
      transport: { releaseLogicalSession },
      session: session(),
      internalAlias: "u",
      cause: new Error("resume boom"),
    }),
  ).rejects.toThrow(/kept for retry\/delete/);
  expect(dropRow).not.toHaveBeenCalled();
});

test("create convergence hard-deletes the provisional physical session", async () => {
  const deleteSession = mock(async (_session: ResolvedSession) => {});
  const { sessions, dropRow } = fakeSessions();

  await convergeProvisionalCreate({
    sessions,
    transport: { deleteSession },
    session: session(),
    internalAlias: "u",
    cause: new Error("ensure boom"),
  });

  expect(deleteSession).toHaveBeenCalledTimes(1);
  expect(dropRow).toHaveBeenCalledWith("u");
});

test("create convergence throws instead of dropping the row when delete is unimplemented", async () => {
  const { sessions, dropRow } = fakeSessions();

  await expect(
    convergeProvisionalCreate({
      sessions,
      transport: {},
      session: session(),
      internalAlias: "u",
      cause: new Error("ensure boom"),
    }),
  ).rejects.toThrow(/no deleteSession operation/);
  expect(dropRow).not.toHaveBeenCalled();
});

test("native convergence throws instead of dropping the row when remove is unimplemented", async () => {
  const { sessions, dropRow } = fakeSessions();

  await expect(
    convergeProvisionalNativeAttach({
      sessions,
      transport: {},
      session: session({ transportEngine: "cli" }),
      internalAlias: "u",
      cause: new Error("resume boom"),
    }),
  ).rejects.toThrow(/no removeSession operation/);
  expect(dropRow).not.toHaveBeenCalled();
});
