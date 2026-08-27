import { setActivePinia, createPinia } from "pinia";
import { beforeEach, expect, test, vi } from "vitest";
import { useInstancesStore, groupArchivedKey } from "../stores/instances";
import { archivedLast } from "../lib/sidebar-group-mode";

beforeEach(() => setActivePinia(createPinia()));

function seed() {
  const store = useInstancesStore();
  store.instances = [{
    id: "i1", name: "pc", online: true, lastSeenAt: null,
    sessions: [{ alias: "active", agent: "codex", workspace: "backend", transportSession: "t0", running: false, archived: false }],
    sessionsLoaded: true, agents: [{ name: "codex", driver: "codex" }], workspaces: [], agentCatalog: [],
  }];
  return store;
}

const sleeping = (alias: string, workspace = "backend", agent = "codex") => ({
  alias, agent, workspace, transportSession: `t-${alias}`, running: false, archived: true,
});

const awake = (alias: string, workspace = "backend", agent = "codex") => ({
  alias, agent, workspace, transportSession: `t-${alias}`, running: false, archived: false,
});

test("loadGroupArchivedSessions fetches one archivedOnly page scoped to the group", async () => {
  const store = seed();
  const { api } = await import("../api/client");
  const rpc = vi.spyOn(api, "rpc").mockResolvedValue({ sessions: [sleeping("s1"), sleeping("s2")], hasMore: true, nextOffset: 5 });

  await store.loadGroupArchivedSessions("i1", "workspace", "backend");

  expect(rpc).toHaveBeenCalledWith("i1", "control.sessions.list", { offset: 0, limit: 5, archivedOnly: true, workspace: "backend" });
  const state = store.byId("i1")!.groupArchived![groupArchivedKey("workspace", "backend")]!;
  expect(state).toMatchObject({ loaded: true, hasMore: true, nextOffset: 5, sessions: [
    expect.objectContaining({ alias: "s1" }), expect.objectContaining({ alias: "s2" }),
  ] });
  // Grouped sleeping rows stay OUT of the flat instance snapshot.
  expect(store.byId("i1")!.sessions.map((s) => s.alias)).toEqual(["active"]);
  vi.restoreAllMocks();
});

test("agent mode filters by agent instead of workspace", async () => {
  const store = seed();
  const { api } = await import("../api/client");
  const rpc = vi.spyOn(api, "rpc").mockResolvedValue({ sessions: [], hasMore: false });

  await store.loadGroupArchivedSessions("i1", "agent", "codex");

  expect(rpc).toHaveBeenCalledWith("i1", "control.sessions.list", { offset: 0, limit: 5, archivedOnly: true, agent: "codex" });
  vi.restoreAllMocks();
});

test("append pages from nextOffset and dedupes by alias", async () => {
  const store = seed();
  const { api } = await import("../api/client");
  const rpc = vi.spyOn(api, "rpc");
  rpc.mockResolvedValueOnce({ sessions: [sleeping("s1"), sleeping("s2")], hasMore: true, nextOffset: 5 });
  await store.loadGroupArchivedSessions("i1", "workspace", "backend");
  rpc.mockResolvedValueOnce({ sessions: [sleeping("s2"), sleeping("s3")], hasMore: false, nextOffset: 10 });
  await store.loadGroupArchivedSessions("i1", "workspace", "backend", true);

  expect(rpc).toHaveBeenLastCalledWith("i1", "control.sessions.list", { offset: 5, limit: 5, archivedOnly: true, workspace: "backend" });
  const state = store.byId("i1")!.groupArchived![groupArchivedKey("workspace", "backend")]!;
  expect(state.sessions.map((s) => s.alias)).toEqual(["s1", "s2", "s3"]);
  expect(state.hasMore).toBe(false);
  vi.restoreAllMocks();
});

test("sessions-changed refreshes only loaded groups, never unloaded ones", async () => {
  const store = seed();
  const { api } = await import("../api/client");
  const rpc = vi.spyOn(api, "rpc");
  rpc.mockResolvedValueOnce({ sessions: [sleeping("s1")], hasMore: false });
  await store.loadGroupArchivedSessions("i1", "workspace", "backend");
  rpc.mockClear();
  rpc.mockResolvedValue({ sessions: [sleeping("fresh")], hasMore: false });

  store.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "sessions-changed" } });
  await new Promise((r) => setTimeout(r, 0));

  const archivedCalls = rpc.mock.calls.filter((call) => (call[2] as { archivedOnly?: boolean })?.archivedOnly);
  expect(archivedCalls).toEqual([["i1", "control.sessions.list", { offset: 0, limit: 5, archivedOnly: true, workspace: "backend" }]]);
  expect(store.byId("i1")!.groupArchived![groupArchivedKey("workspace", "backend")]!.sessions.map((s) => s.alias)).toEqual(["fresh"]);
  vi.restoreAllMocks();
});

test("archiveSession refreshes loaded group pages", async () => {
  const store = seed();
  const { api } = await import("../api/client");
  const rpc = vi.spyOn(api, "rpc");
  rpc.mockResolvedValueOnce({ sessions: [], hasMore: false });
  await store.loadGroupArchivedSessions("i1", "workspace", "backend");
  rpc.mockClear();
  rpc.mockResolvedValue({ sessions: [], hasMore: false });

  await store.archiveSession("i1", "active");

  const archivedCalls = rpc.mock.calls.filter((call) => (call[2] as { archivedOnly?: boolean })?.archivedOnly);
  expect(archivedCalls).toHaveLength(1);
  vi.restoreAllMocks();
});

test("loadInstances preserves per-group archived state", async () => {
  const store = seed();
  const { api } = await import("../api/client");
  const rpc = vi.spyOn(api, "rpc").mockResolvedValue({ sessions: [sleeping("s1")], hasMore: false });
  await store.loadGroupArchivedSessions("i1", "workspace", "backend");
  vi.restoreAllMocks();

  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    instances: [{ id: "i1", name: "pc", online: true, lastSeenAt: null }],
  }), { status: 200 })));
  await store.loadInstances();
  expect(store.byId("i1")!.groupArchived![groupArchivedKey("workspace", "backend")]!.sessions.map((s) => s.alias)).toEqual(["s1"]);
  vi.unstubAllGlobals();
});

test("refresh refetches at least one page for an empty loaded group so new archives surface", async () => {
  const store = seed();
  const { api } = await import("../api/client");
  const rpc = vi.spyOn(api, "rpc");
  rpc.mockResolvedValueOnce({ sessions: [], hasMore: false });
  await store.loadGroupArchivedSessions("i1", "workspace", "backend");
  rpc.mockClear();
  rpc.mockResolvedValue({ sessions: [sleeping("newly-archived")], hasMore: false });

  store.refreshLoadedGroupArchivedSessions("i1");
  await new Promise((r) => setTimeout(r, 0));

  const archivedCalls = rpc.mock.calls.filter((call) => (call[2] as { archivedOnly?: boolean })?.archivedOnly);
  expect(archivedCalls).toHaveLength(1);
  expect(store.byId("i1")!.groupArchived![groupArchivedKey("workspace", "backend")]!.sessions.map((s) => s.alias)).toEqual(["newly-archived"]);
  vi.restoreAllMocks();
});

test("replays sessions-changed during an in-flight append page and discards the stale result", async () => {
  vi.useFakeTimers();
  try {
    const store = seed();
    const { api } = await import("../api/client");
    const rpc = vi.spyOn(api, "rpc");
    // First page settles normally → group is loaded (only loaded groups refresh on events).
    rpc.mockResolvedValueOnce({ sessions: [sleeping("s1")], hasMore: true, nextOffset: 5 });
    await store.loadGroupArchivedSessions("i1", "workspace", "backend");

    // The append page hangs; a sessions-changed lands mid-flight and must force a
    // discard-and-refetch from offset 0 once the append settles.
    let resolveAppend!: (value: unknown) => void;
    const appendPage = new Promise((resolve) => { resolveAppend = resolve; });
    rpc.mockImplementationOnce(() => appendPage as never);
    const append = store.loadGroupArchivedSessions("i1", "workspace", "backend", true);
    store.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "sessions-changed" } });
    resolveAppend({ sessions: [sleeping("stale")], hasMore: false });
    rpc.mockResolvedValue({ sessions: [sleeping("fresh")], hasMore: false });
    await append;
    // The refresh waiter polls on a 25ms timer; advance past it so it observes the drain.
    await vi.advanceTimersByTimeAsync(100);

    const archivedCalls = rpc.mock.calls.filter((call) => (call[2] as { archivedOnly?: boolean })?.archivedOnly);
    expect(archivedCalls).toHaveLength(3);
    // The refetch replaces from offset 0 — the stale appended row never survives.
    expect(archivedCalls[2]).toEqual(["i1", "control.sessions.list", { offset: 0, limit: 5, archivedOnly: true, workspace: "backend" }]);
    expect(store.byId("i1")!.groupArchived![groupArchivedKey("workspace", "backend")]!.sessions.map((s) => s.alias)).toEqual(["fresh"]);
    vi.restoreAllMocks();
  } finally {
    vi.useRealTimers();
  }
});

test("unarchiveSession refreshes loaded group pages", async () => {
  const store = seed();
  const { api } = await import("../api/client");
  const rpc = vi.spyOn(api, "rpc");
  rpc.mockResolvedValueOnce({ sessions: [sleeping("s1")], hasMore: false });
  await store.loadGroupArchivedSessions("i1", "workspace", "backend");
  rpc.mockClear();
  rpc.mockResolvedValue({ sessions: [], hasMore: false });

  await store.unarchiveSession("i1", "s1");

  const archivedCalls = rpc.mock.calls.filter((call) => (call[2] as { archivedOnly?: boolean })?.archivedOnly);
  expect(archivedCalls).toHaveLength(1);
  vi.restoreAllMocks();
});

test("archive moves the row into loaded group pages synchronously (no remove-then-reappear)", async () => {
  const store = seed();
  const { api } = await import("../api/client");
  // Group page for workspace "backend" is loaded BEFORE the archive.
  const rpc = vi.spyOn(api, "rpc").mockResolvedValue({ sessions: [sleeping("s1")], hasMore: false });
  await store.loadGroupArchivedSessions("i1", "workspace", "backend");
  rpc.mockClear();
  rpc.mockResolvedValue({ sessions: [], hasMore: false });

  // Capture state SYNCHRONOUSLY after invoking archiveSession (not awaiting it):
  // the point of the fix is that the row never disappears between the click and
  // the refetch publishing.
  const done = store.archiveSession("i1", "active");
  expect(store.byId("i1")!.sessions.filter((s) => !s.archived).map((s) => s.alias)).toEqual([]);
  const page = store.byId("i1")!.groupArchived![groupArchivedKey("workspace", "backend")]!;
  expect(page.sessions.map((s) => s.alias)).toEqual(["s1", "active"]);
  expect(page.sessions[1].archived).toBe(true);
  await done;
  vi.restoreAllMocks();
});

test("archive failure rolls the row back out of the group pages", async () => {
  const store = seed();
  const { api } = await import("../api/client");
  const rpc = vi.spyOn(api, "rpc").mockResolvedValue({ sessions: [sleeping("s1")], hasMore: false });
  await store.loadGroupArchivedSessions("i1", "workspace", "backend");
  rpc.mockReset();
  rpc.mockRejectedValue(new Error("still draining"));

  await expect(store.archiveSession("i1", "active")).rejects.toThrow("still draining");
  expect(store.byId("i1")!.sessions.find((s) => s.alias === "active")!.archived).toBe(false);
  const page = store.byId("i1")!.groupArchived![groupArchivedKey("workspace", "backend")]!;
  expect(page.sessions.map((s) => s.alias)).toEqual(["s1"]);
  vi.restoreAllMocks();
});

test("unarchive pulls the row out of loaded pages into actives in one tick (and rolls back on failure)", async () => {
  const store = seed();
  const { api } = await import("../api/client");
  // First (archivedOnly) load returns s1 SLEEPING; every later list call sees it AWAKE.
  let firstList = true;
  const rpc = vi.spyOn(api, "rpc").mockImplementation(async (_iid: string, type: string) => {
    if (type === "control.sessions.list") {
      const sleepingFirst = firstList;
      firstList = false;
      return { sessions: [sleepingFirst ? sleeping("s1") : awake("s1")], hasMore: false };
    }
    return {};
  });
  await store.loadGroupArchivedSessions("i1", "workspace", "backend");
  rpc.mockClear();

  // Success path: synchronous move before the awaited refresh lands.
  const done = store.unarchiveSession("i1", "s1");
  expect(store.byId("i1")!.sessions.some((s) => s.alias === "s1" && !s.archived)).toBe(true);
  expect(store.byId("i1")!.groupArchived![groupArchivedKey("workspace", "backend")]!.sessions.map((s) => s.alias)).toEqual([]);
  await done;

  // Failure path: wake a sleeping session whose RPC rejects. Re-seed the page with
  // the row (as if woken then re-slept), and have every list call fail-free while
  // the unarchive RPC itself rejects.
  const inst = store.byId("i1")!;
  inst.groupArchived![groupArchivedKey("workspace", "backend")] = {
    sessions: [{ ...sleeping("s1"), archived: true }],
    loaded: true, hasMore: false, nextOffset: 0,
  };
  inst.sessions = inst.sessions.filter((s) => s.alias !== "s1");
  rpc.mockReset();
  rpc.mockImplementation(async (_iid: string, type: string) => {
    if (type === "control.sessions.unarchive") throw new Error("offline");
    return { sessions: [], hasMore: false };
  });
  await expect(store.unarchiveSession("i1", "s1")).rejects.toThrow("offline");
  // Back in the sleeping page (not stranded in actives), roll-back complete.
  expect(store.byId("i1")!.groupArchived![groupArchivedKey("workspace", "backend")]!.sessions.map((s) => s.alias)).toEqual(["s1"]);
  expect(store.byId("i1")!.sessions.some((s) => s.alias === "s1")).toBe(false);
  vi.restoreAllMocks();
});

test("wake during an in-flight group refresh discards the stale snapshot instead of resurrecting the row", async () => {
  const store = seed();
  const { api } = await import("../api/client");
  const sleepingRow = sleeping("s1");
  const activeRow = awake("active");
  const awakeRow = awake("s1");

  // Page already published with s1.
  const rpc = vi.spyOn(api, "rpc").mockResolvedValue({ sessions: [sleepingRow], hasMore: false });
  await store.loadGroupArchivedSessions("i1", "workspace", "backend");
  expect(store.byId("i1")!.groupArchived![groupArchivedKey("workspace", "backend")]!.sessions.map((s) => s.alias)).toEqual(["s1"]);

  let isAwake = false;
  let sawInFlightArchivedQuery = false;
  const gate = Promise.withResolvers<void>();
  rpc.mockReset();
  rpc.mockImplementation(async (_iid: string, type: string, payload?: unknown) => {
    if (type === "control.sessions.unarchive") {
      isAwake = true;
      return {};
    }
    if (type === "control.sessions.list") {
      const isArchivedOnly = (payload as { archivedOnly?: boolean })?.archivedOnly === true;
      if (isArchivedOnly) {
        if (!sawInFlightArchivedQuery) {
          sawInFlightArchivedQuery = true;
          // HANG this pre-wake in-flight refresh until wake has optimistically
          // moved s1 out of the page.
          await gate.promise;
          // STALE snapshot: carries s1 as sleeping; must be discarded via pending mark.
          return { sessions: [sleepingRow], hasMore: false };
        }
        // Post-wake authoritative queries: s1 is awake, sleeping page is empty.
        return { sessions: isAwake ? [] : [sleepingRow], hasMore: false };
      }
      // Plain (active) listing: includes s1 once awake.
      return { sessions: isAwake ? [activeRow, awakeRow] : [activeRow], hasMore: false };
    }
    return {};
  });

  // Start an in-flight refresh (e.g. from sessions-changed), then wake mid-flight.
  void store.refreshLoadedGroupArchivedSessions("i1");
  await vi.waitFor(() => expect(store.byId("i1")!.groupArchived![groupArchivedKey("workspace", "backend")]!.loading).toBe(true));

  const waking = store.unarchiveSession("i1", "s1");
  // Synchronous contract: s1 moved to actives AND left the sleeping page in one tick.
  expect(store.byId("i1")!.sessions.some((s) => s.alias === "s1" && !s.archived)).toBe(true);
  expect(store.byId("i1")!.groupArchived![groupArchivedKey("workspace", "backend")]!.sessions.map((s) => s.alias)).toEqual([]);
  gate.resolve();

  await waking;
  await vi.waitFor(() => expect(store.byId("i1")!.groupArchived![groupArchivedKey("workspace", "backend")]!.loading).toBe(false));
  const page = store.byId("i1")!.groupArchived![groupArchivedKey("workspace", "backend")]!;
  // The stale snapshot was discarded and replaced: no duplicate in sleeping + active.
  expect(page.sessions.map((s) => s.alias)).toEqual([]);
  expect(store.byId("i1")!.sessions.filter((s) => !s.archived && s.alias === "s1")).toHaveLength(1);
  vi.restoreAllMocks();
});

test("archive hands off with provisional archivedAt that sorts FIRST in archivedLast", async () => {
  const store = seed();
  const { api } = await import("../api/client");
  // Existing sleeping rows carry older timestamps; the optimistic row starts at the tail.
  const rpc = vi.spyOn(api, "rpc").mockResolvedValue({
    sessions: [
      { ...sleeping("older"), archivedAt: "2024-01-01T00:00:00Z" },
      { ...sleeping("newer"), archivedAt: "2024-06-01T00:00:00Z" },
    ],
    hasMore: false,
  });
  await store.loadGroupArchivedSessions("i1", "workspace", "backend");
  rpc.mockClear();
  rpc.mockResolvedValue({ sessions: [sleeping("older"), sleeping("newer"), { ...awake("active"), transportSession: "t-active" }], hasMore: false });

  const done = store.archiveSession("i1", "active");
  const page = store.byId("i1")!.groupArchived![groupArchivedKey("workspace", "backend")]!;
  const row = page.sessions.find((s) => s.alias === "active")!;
  // Provisional stamp exists even though inst.sessions' row had none.
  expect(row.archivedAt).toBeTruthy();
  // Render-order contract through archivedLast(): newest slept session first.
  expect(archivedLast(page.sessions).map((s) => s.alias)).toEqual(["active", "newer", "older"]);
  await done;
  vi.restoreAllMocks();
});

test("archive failure restores the pre-hand-off archivedAt (stamp rollback)", async () => {
  const store = seed();
  const { api } = await import("../api/client");
  const originalStamp = "2023-05-05T00:00:00Z";
  // The active row ALREADY has an archivedAt (woken earlier once) — a failed archive
  // must restore that value, not delete it.
  store.byId("i1")!.sessions.find((s) => s.alias === "active")!.archivedAt = originalStamp;
  const rpc = vi.spyOn(api, "rpc").mockImplementation(async (_iid: string, type: string) => {
    if (type === "control.sessions.archive") throw new Error("nope");
    return { sessions: [], hasMore: false };
  });
  await store.loadGroupArchivedSessions("i1", "workspace", "backend");
  await expect(store.archiveSession("i1", "active")).rejects.toThrow("nope");
  const row = store.byId("i1")!.sessions.find((s) => s.alias === "active")!;
  expect(row.archived).toBe(false);
  expect(row.archivedAt).toBe(originalStamp);
  // And it was pulled back out of the sleeping page.
  expect(store.byId("i1")!.groupArchived![groupArchivedKey("workspace", "backend")]!.sessions.map((s) => s.alias)).toEqual([]);
  vi.restoreAllMocks();
});
