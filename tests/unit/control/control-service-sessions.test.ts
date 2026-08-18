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
      getSession: async (_alias: string) => session,
    },
    removeSessionWithTransport: async (_internalAlias: string) => ({ wasActive: true }),
    archiveSessionWithTransport: async (_internalAlias: string) => {},
    unarchiveSession: async (_internalAlias: string) => {},
    createSessionWithTransport: async (internalAlias: string, agent: string, workspace: string, model?: string) => {
      calls.push({ kind: "fresh", internalAlias, agent, workspace, ...(model ? { model } : {}) });
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
      archived: false,
      // Running implies a live process, so warm is asserted even without a tracker.
      warm: true,
    },
  ]);
});

test("listSessionsPage filters sleeping sessions and returns a server cursor", () => {
  const { deps } = makeDeps();
  deps.sessions.listAllResolvedSessions = () => Array.from({ length: 5 }, (_, index) => ({
    alias: `s${index}`,
    agent: "claude",
    workspace: "/ws",
    transportSession: `t${index}`,
    ...(index === 1 ? { archived: true } : {}),
  }));
  const control = new ControlService(deps as never);

  expect(control.listSessionsPage("relay:acct", 0, 2)).toMatchObject({
    sessions: [expect.objectContaining({ alias: "s0" }), expect.objectContaining({ alias: "s2" })],
    hasMore: true,
    nextOffset: 2,
  });
  expect(control.listSessionsPage("relay:acct", 0, 2, true).sessions.map((session) => session.alias)).toEqual(["s0", "s1"]);
});

test("listSessionsPage archivedOnly orders sleeping sessions newest-sleep-first", () => {
  const { deps } = makeDeps();
  deps.sessions.listAllResolvedSessions = () => [
    { alias: "oldest", agent: "claude", workspace: "/ws", transportSession: "t1", archived: true, archivedAt: "2026-08-01T00:00:00Z" },
    { alias: "fresh", agent: "claude", workspace: "/ws", transportSession: "t2", archived: true, archivedAt: "2026-08-17T00:00:00Z" },
    { alias: "mid", agent: "claude", workspace: "/ws", transportSession: "t3", archived: true, archivedAt: "2026-08-09T00:00:00Z" },
    { alias: "live", agent: "claude", workspace: "/ws", transportSession: "t4" },
  ];
  const control = new ControlService(deps as never);

  const page = control.listSessionsPage("relay:acct", 0, 10, false, { archivedOnly: true });
  expect(page.sessions.map((s) => s.alias)).toEqual(["fresh", "mid", "oldest"]);
  // Cursor math runs on the sorted set: paging yields the same order.
  expect(control.listSessionsPage("relay:acct", 0, 2, false, { archivedOnly: true }))
    .toMatchObject({ sessions: [expect.objectContaining({ alias: "fresh" }), expect.objectContaining({ alias: "mid" })], hasMore: true, nextOffset: 2 });
});

test("listSessions surfaces archivedAt for sleeping sessions and omits it otherwise", () => {
  const { deps } = makeDeps();
  deps.sessions.listAllResolvedSessions = () => [
    { alias: "slept", agent: "claude", workspace: "/ws", transportSession: "t1", archived: true, archivedAt: "2026-08-17T00:00:00Z" },
    { alias: "legacy", agent: "claude", workspace: "/ws", transportSession: "t2", archived: true },
    { alias: "awake", agent: "claude", workspace: "/ws", transportSession: "t3" },
  ];
  const control = new ControlService(deps as never);
  const byAlias = new Map(control.listSessions("relay:acct").map((s) => [s.alias, s]));
  expect(byAlias.get("slept")!.archivedAt).toBe("2026-08-17T00:00:00Z");
  // Old records without archived_at keep the field omitted (wire stays minimal).
  expect("archivedAt" in byAlias.get("legacy")!).toBe(false);
  expect("archivedAt" in byAlias.get("awake")!).toBe(false);
});

test("listSessionsPage supports archivedOnly, workspace and agent filters", () => {
  const { deps } = makeDeps();
  deps.sessions.listAllResolvedSessions = () => [
    { alias: "a", agent: "claude", workspace: "/ws/a", transportSession: "t-a" },
    { alias: "b", agent: "claude", workspace: "/ws/b", transportSession: "t-b", archived: true },
    { alias: "c", agent: "codex", workspace: "/ws/a", transportSession: "t-c", archived: true },
    { alias: "d", agent: "codex", transportSession: "t-d", archived: true },
  ];
  const control = new ControlService(deps as never);

  // archivedOnly returns only sleeping sessions, ignoring includeArchived.
  expect(control.listSessionsPage("relay:acct", 0, 10, false, { archivedOnly: true }).sessions.map((s) => s.alias)).toEqual(["b", "c", "d"]);
  // Workspace filter narrows the sleeping page; cursor math runs on the filtered set.
  expect(control.listSessionsPage("relay:acct", 0, 1, false, { archivedOnly: true, workspace: "/ws/a" }))
    .toMatchObject({ sessions: [expect.objectContaining({ alias: "c" })], hasMore: false, nextOffset: 1 });
  // Empty-string workspace matches sessions without a workspace.
  expect(control.listSessionsPage("relay:acct", 0, 10, false, { archivedOnly: true, workspace: "" }).sessions.map((s) => s.alias)).toEqual(["d"]);
  // Agent filter works on the active listing too.
  expect(control.listSessionsPage("relay:acct", 0, 10, false, { agent: "codex" }).sessions.map((s) => s.alias)).toEqual([]);
  expect(control.listSessionsPage("relay:acct", 0, 10, true, { agent: "codex" }).sessions.map((s) => s.alias)).toEqual(["c", "d"]);
});

test("listSessions marks an agent-side (native) session with native: true", () => {
  const { deps } = makeDeps();
  // A native-attached session carries source "agent-side"; a fresh xacpx session does not.
  deps.sessions.listAllResolvedSessions = () => [
    { alias: "backend", agent: "claude", workspace: "/ws/backend", transportSession: "xacpx-backend" },
    { alias: "resumed", agent: "codex", workspace: "/ws/docs", transportSession: "ses_abc", source: "agent-side" },
  ];
  const control = new ControlService(deps as never);

  const sessions = control.listSessions("relay:acct");
  const fresh = sessions.find((s) => s.alias === "backend")!;
  const native = sessions.find((s) => s.alias === "resumed")!;
  // Fresh sessions omit the flag entirely; only native ones carry native: true.
  expect("native" in fresh).toBe(false);
  expect(native.native).toBe(true);
});

test("listSessions omits warm entirely without a warmth tracker", () => {
  const { deps } = makeDeps();
  // Use a non-running alias — running sessions force warm: true regardless.
  deps.sessions.listAllResolvedSessions = () => [
    { alias: "idle", agent: "codex", workspace: "/ws/docs", transportSession: "xacpx-idle" },
  ];
  const control = new ControlService(deps as never);

  const [session] = control.listSessions("relay:acct");
  expect("warm" in session!).toBe(false);
});

test("listSessions forces warm: true for running sessions and reads the tracker otherwise", () => {
  const { deps } = makeDeps();
  deps.sessions.listAllResolvedSessions = () => [
    { alias: "backend", agent: "claude", workspace: "/ws/backend", transportSession: "xacpx-backend" },
    { alias: "idle-cold", agent: "codex", workspace: "/ws/docs", transportSession: "xacpx-idle" },
    { alias: "unknown", agent: "codex", workspace: "/ws/docs", transportSession: "xacpx-unknown" },
  ];
  const warmth = new Map<string, boolean>([["xacpx-idle", false]]);
  (deps as Record<string, unknown>).sessionWarmth = {
    isWarm: (session: { transportSession: string }) => warmth.get(session.transportSession),
    markWarm: () => {},
    markCold: () => {},
  };
  const control = new ControlService(deps as never);

  const sessions = control.listSessions("relay:acct");
  // "backend" is running (activeTurns), so warm is forced true regardless of the tracker.
  expect(sessions.find((s) => s.alias === "backend")!.warm).toBe(true);
  expect(sessions.find((s) => s.alias === "idle-cold")!.warm).toBe(false);
  // Tracker hasn't observed this one yet → field omitted, matching old-instance wire shape.
  expect("warm" in sessions.find((s) => s.alias === "unknown")!).toBe(false);
});

test("createSession runs the transport lifecycle and emits sessions-changed", async () => {
  const { deps, seen, calls } = makeDeps();
  const control = new ControlService(deps as never);
  const created = await control.createSession("relay:acct", "docs", "codex", "/ws/docs");
  expect(created.alias).toBe("docs");
  expect(calls).toEqual([{ kind: "fresh", internalAlias: "docs", agent: "codex", workspace: "/ws/docs" }]);
  expect(seen).toContainEqual({ type: "sessions-changed" });
});

test("createSession forwards a model override to the fresh-create lifecycle", async () => {
  const { deps, calls } = makeDeps();
  const control = new ControlService(deps as never);
  await control.createSession("relay:acct", "docs", "codex", "/ws/docs", undefined, "gpt-5.2[high]");
  expect(calls).toEqual([{ kind: "fresh", internalAlias: "docs", agent: "codex", workspace: "/ws/docs", model: "gpt-5.2[high]" }]);
});

test("createSession ignores a model override on a native attach (resume uses the rollout's model)", async () => {
  const { deps, calls } = makeDeps();
  const control = new ControlService(deps as never);
  await control.createSession("relay:acct", "resumed", "codex", "/ws/docs", "ses_abc", "gpt-5.2[high]");
  // Native attach path receives no model — it resumes under the rollout's recorded model.
  expect(calls).toEqual([{ kind: "native", internalAlias: "resumed", agent: "codex", workspace: "/ws/docs", agentSessionId: "ses_abc" }]);
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

// The control surface must funnel every archive/restore/remove request into
// exactly ONE call of the shared lifecycle entry points (wired in main.ts to
// SessionControlService → SessionService). Exactly one funnel call per logical
// operation is what guarantees exactly one resource lifecycle event downstream.

test("removeSession calls the shared remove funnel exactly once", async () => {
  const { deps } = makeDeps();
  let calls = 0;
  deps.removeSessionWithTransport = async (_internalAlias: string) => {
    calls += 1;
    return { wasActive: true };
  };
  const control = new ControlService(deps as never);

  await control.removeSession("relay:acct", "backend");

  expect(calls).toBe(1);
});

test("archiveSession calls the shared archive funnel exactly once and emits sessions-changed", async () => {
  const { deps, seen } = makeDeps();
  const calls: string[] = [];
  deps.archiveSessionWithTransport = async (internalAlias: string) => {
    calls.push(internalAlias);
  };
  const control = new ControlService(deps as never);

  await control.archiveSession("relay:acct", "backend");

  expect(calls).toEqual(["backend"]);
  expect(seen).toContainEqual({ type: "sessions-changed" });
});

test("unarchiveSession calls the shared unarchive funnel exactly once and emits sessions-changed", async () => {
  const { deps, seen } = makeDeps();
  const calls: string[] = [];
  deps.unarchiveSession = async (internalAlias: string) => {
    calls.push(internalAlias);
  };
  const control = new ControlService(deps as never);

  await control.unarchiveSession("relay:acct", "backend");

  expect(calls).toEqual(["backend"]);
  expect(seen).toContainEqual({ type: "sessions-changed" });
});

test("a failed archive funnel call emits no sessions-changed", async () => {
  const { deps, seen } = makeDeps();
  deps.archiveSessionWithTransport = async (_internalAlias: string) => {
    throw new Error("disk full");
  };
  const control = new ControlService(deps as never);

  await expect(control.archiveSession("relay:acct", "backend")).rejects.toThrow("disk full");

  expect(seen).not.toContainEqual({ type: "sessions-changed" });
});
