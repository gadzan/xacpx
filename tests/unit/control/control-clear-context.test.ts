import { expect, test } from "bun:test";

import { ControlService } from "../../../src/control/control-service";
import { createControlEventBus } from "../../../src/control/control-event-bus";
import { registerKnownChannelId } from "../../../src/channels/channel-scope";

registerKnownChannelId("relay");

function makeDeps(options: {
  owner?: { kind: string; bindingId?: string; botId?: string; conversationId?: string; topicId?: string };
} = {}) {
  const resetCalls: string[] = [];
  const session = {
    alias: "relay:backend",
    agent: "claude",
    driver: "claude",
    workspace: "/ws/backend",
    transportSession: "xacpx-backend",
  };
  const deps = {
    agent: { chat: async () => ({ text: "" }) },
    sessions: {
      listAllResolvedSessions: () => [session],
      resolveAliasForChat: async (_chatKey: string, alias: string) => `relay:${alias}`,
      getSession: async () => session,
      getLogicalSessionRecord: () => (options.owner ? { owner: options.owner } : undefined),
      setSessionModel: async () => {},
    },
    transport: {},
    createSessionWithTransport: async () => session,
    listNativeSessions: async () => [],
    attachNativeSessionWithTransport: async () => session,
    removeSessionWithTransport: async () => ({ wasActive: true }),
    archiveSessionWithTransport: async () => {},
    unarchiveSession: async () => {},
    resetSessionContext: async (internalAlias: string) => {
      resetCalls.push(internalAlias);
      return "context cleared";
    },
    activeTurns: { isActiveAnywhere: () => false },
    scheduled: { listPending: () => [], listRecentForChat: () => [], createTask: async () => ({}), cancelPending: async () => true },
    orchestration: { listTasks: () => [], getTask: () => undefined, requestTaskCancellation: async () => ({}) },
    events: createControlEventBus(),
  };
  return { deps, resetCalls, session };
}

test("clears the addressed session rather than the chat's current one", async () => {
  const { deps, resetCalls } = makeDeps();
  const control = new ControlService(deps as never);
  const result = await control.clearSessionContext("relay:acct", "backend");
  // The dashboard addresses the session it shows; resolving through current_session
  // would clear whichever session the daemon happened to hold.
  expect(resetCalls).toEqual(["relay:backend"]);
  expect(result.output).toBe("context cleared");
});

test("keeps the session: a clear is not a removal", async () => {
  const { deps, session } = makeDeps();
  const control = new ControlService(deps as never);
  await control.clearSessionContext("relay:acct", "backend");
  expect(session.alias).toBe("relay:backend");
});

test("refuses a Bot-owned session addressed as an ordinary one", async () => {
  const { deps, resetCalls } = makeDeps({
    owner: { kind: "bot-direct", bindingId: "b1", botId: "bot1", conversationId: "c1", topicId: "t1" },
  });
  const control = new ControlService(deps as never);
  // A Bot session's identity is owned by its topic; the topic-level clear is the only
  // supported way to reset it, and ordinary APIs must not bypass that lifecycle.
  await expect(control.clearSessionContext("relay:acct", "backend")).rejects.toThrow();
  expect(resetCalls).toEqual([]);
});

test("reports a missing reset seam instead of pretending it worked", async () => {
  const { deps } = makeDeps();
  delete (deps as { resetSessionContext?: unknown }).resetSessionContext;
  const control = new ControlService(deps as never);
  await expect(control.clearSessionContext("relay:acct", "backend")).rejects.toThrow(
    /not available/i,
  );
});
