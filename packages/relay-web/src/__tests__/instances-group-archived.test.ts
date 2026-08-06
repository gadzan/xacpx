import { setActivePinia, createPinia } from "pinia";
import { beforeEach, expect, test, vi } from "vitest";
import { useInstancesStore, groupArchivedKey } from "../stores/instances";

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
