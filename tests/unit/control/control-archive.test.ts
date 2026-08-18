import { expect, test } from "bun:test";

import { ControlService } from "../../../src/control/control-service";
import {
  createControlEventBus,
  type ControlEvent,
} from "../../../src/control/control-event-bus";

function makeDeps() {
  const events = createControlEventBus();
  const seen: ControlEvent[] = [];
  events.subscribe((event) => seen.push(event));
  const calls: Array<{
    kind: "remove" | "archive" | "unarchive";
    internalAlias: string;
  }> = [];
  const session = {
    alias: "relay:backend",
    agent: "claude",
    workspace: "/ws/backend",
    transportSession: "xacpx-backend",
    archived: true,
  };
  const deps = {
    agent: { chat: async () => ({ text: "" }) },
    sessions: {
      listAllResolvedSessions: () => [session],
      removeSession: async (_alias: string) => ({ wasActive: false }),
      useSession: async () => ({
        alias: "backend",
        agent: "claude",
        workspace: "/ws/backend",
      }),
      resolveAliasForChat: async (_chatKey: string, alias: string) =>
        `relay:${alias}`,
      getSession: async () => session,
      setSessionModel: async () => {},
    },
    transport: {},
    createSessionWithTransport: async () => session,
    listNativeSessions: async () => [],
    attachNativeSessionWithTransport: async () => session,
    removeSessionWithTransport: async (internalAlias: string) => {
      calls.push({ kind: "remove", internalAlias });
      return { wasActive: true };
    },
    archiveSessionWithTransport: async (internalAlias: string) => {
      calls.push({ kind: "archive", internalAlias });
    },
    unarchiveSession: async (internalAlias: string) => {
      calls.push({ kind: "unarchive", internalAlias });
    },
    activeTurns: { isActiveAnywhere: () => false },
    scheduled: {
      listPending: () => [],
      listRecentForChat: () => [],
      createTask: async () => {
        throw new Error("unused");
      },
      cancelPending: async () => false,
    },
    orchestration: {
      listTasks: async () => [],
      getTask: async () => null,
      requestTaskCancellation: async () => {
        throw new Error("unused");
      },
    },
    events,
    agents: {
      list: () => [],
      catalog: () => [],
      create: async () => {
        throw new Error("unused");
      },
      remove: async () => {},
    },
    workspaces: {
      list: () => [],
      create: async () => {
        throw new Error("unused");
      },
      remove: async () => {},
    },
  };
  return { deps, seen, calls };
}

test("archiveSession resolves internal alias, routes through transport, and emits sessions-changed", async () => {
  const { deps, seen, calls } = makeDeps();
  const control = new ControlService(deps as never);
  await control.archiveSession("relay:acct", "backend");
  expect(calls).toEqual([{ kind: "archive", internalAlias: "relay:backend" }]);
  expect(seen).toContainEqual({ type: "sessions-changed" });
});

test("unarchiveSession routes through transport and emits sessions-changed", async () => {
  const { deps, seen, calls } = makeDeps();
  const control = new ControlService(deps as never);
  await control.unarchiveSession("relay:acct", "backend");
  expect(calls).toEqual([
    { kind: "unarchive", internalAlias: "relay:backend" },
  ]);
  expect(seen).toContainEqual({ type: "sessions-changed" });
});

test("removeSession routes through removeSessionWithTransport (real delete), not the logical-only removeSession", async () => {
  const { deps, seen, calls } = makeDeps();
  const control = new ControlService(deps as never);
  const result = await control.removeSession("relay:acct", "backend");
  expect(result.wasActive).toBe(true);
  expect(calls).toEqual([{ kind: "remove", internalAlias: "relay:backend" }]);
  expect(seen).toContainEqual({ type: "sessions-changed" });
});

test("listSessions includes the archived flag on each session", () => {
  const { deps } = makeDeps();
  const control = new ControlService(deps as never);
  const sessions = control.listSessions("relay:acct");
  expect(sessions).toHaveLength(1);
  expect(sessions[0]?.archived).toBe(true);
});
