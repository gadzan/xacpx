import { expect, test } from "bun:test";

import { ControlService } from "../../../src/control/control-service";
import { createControlEventBus, type ControlEvent } from "../../../src/control/control-event-bus";

function makeDeps() {
  const events = createControlEventBus();
  const seen: ControlEvent[] = [];
  const calls: Array<{ kind: "fresh" | "native"; internalAlias: string; agent: string; workspace: string; agentSessionId?: string }> = [];
  events.subscribe((event) => seen.push(event));
  const session = {
    alias: "backend",
    agent: "claude",
    workspace: "/ws/backend",
    transportSession: "xacpx-backend",
  };
  const deps = {
    agent: { chat: async () => ({ text: "" }) },
    sessions: {
      listAllResolvedSessions: () => [session],
      removeSession: async (_alias: string) => ({ wasActive: true }),
      useSession: async () => ({ alias: "backend", agent: "claude", workspace: "/ws/backend" }),
      resolveAliasForChat: async (_chatKey: string, alias: string) => alias,
    },
    createSessionWithTransport: async (internalAlias: string, agent: string, workspace: string) => {
      calls.push({ kind: "fresh", internalAlias, agent, workspace });
      return { ...session, alias: internalAlias, agent, workspace };
    },
    listNativeSessions: async (_agent: string, _workspace: string) => [
      { sessionId: "ses_abc", title: "Fix login", updatedAt: "2026-06-10T00:00:00Z", cwd: "/ws/docs" },
      { sessionId: "ses_def", title: null },
    ],
    attachNativeSessionWithTransport: async (internalAlias: string, agent: string, workspace: string, agentSessionId: string) => {
      calls.push({ kind: "native", internalAlias, agent, workspace, agentSessionId });
      return { ...session, alias: internalAlias, agent, workspace };
    },
    activeTurns: { isActiveAnywhere: (alias: string) => alias === "backend" },
    scheduled: {
      listPending: () => [],
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
  };
  return { deps, seen, calls };
}

test("listSessions maps resolved sessions with running flag", () => {
  const { deps } = makeDeps();
  const control = new ControlService(deps as never);

  expect(control.listSessions("relay:acct")).toEqual([
    {
      alias: "backend",
      agent: "claude",
      workspace: "/ws/backend",
      transportSession: "xacpx-backend",
      running: true,
    },
  ]);
});

test("createSession runs the transport lifecycle and emits sessions-changed", async () => {
  const { deps, seen, calls } = makeDeps();
  const control = new ControlService(deps as never);
  const created = await control.createSession("relay:acct", "docs", "codex", "/ws/docs");
  expect(created.alias).toBe("docs");
  expect(calls).toEqual([{ kind: "fresh", internalAlias: "docs", agent: "codex", workspace: "/ws/docs" }]);
  expect(seen).toContainEqual({ type: "sessions-changed" });
});

test("listNativeSessions maps agent-native sessions for the web picker", async () => {
  const { deps } = makeDeps();
  const control = new ControlService(deps as never);
  const sessions = await control.listNativeSessions("relay:acct", "codex", "/ws/docs");
  expect(sessions).toEqual([
    { sessionId: "ses_abc", title: "Fix login", updatedAt: "2026-06-10T00:00:00Z", cwd: "/ws/docs" },
    { sessionId: "ses_def", title: null },
  ]);
});

test("createSession with an agentSessionId resumes the native session instead of creating fresh", async () => {
  const { deps, seen, calls } = makeDeps();
  const control = new ControlService(deps as never);
  const created = await control.createSession("relay:acct", "resumed", "codex", "/ws/docs", "ses_abc");
  expect(created.alias).toBe("resumed");
  // Routed to the native-attach path, NOT the fresh-create lifecycle.
  expect(calls).toEqual([{ kind: "native", internalAlias: "resumed", agent: "codex", workspace: "/ws/docs", agentSessionId: "ses_abc" }]);
  expect(seen).toContainEqual({ type: "sessions-changed" });
});

test("removeSession delegates and emits sessions-changed", async () => {
  const { deps, seen } = makeDeps();
  const control = new ControlService(deps as never);

  const result = await control.removeSession("relay:acct", "backend");
  expect(result.wasActive).toBe(true);
  expect(seen).toContainEqual({ type: "sessions-changed" });
});
