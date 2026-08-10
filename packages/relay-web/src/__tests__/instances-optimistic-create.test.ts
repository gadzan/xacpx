import { describe, it, expect, vi, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { flushPromises } from "@vue/test-utils";
import { useInstancesStore } from "../stores/instances";
import { api, ApiError } from "../api/client";

const inst = (sessions: unknown[] = []) => ({
  id: "i1", name: "pc", online: true, lastSeenAt: null,
  sessions, sessionsLoaded: true, agents: [], workspaces: [], agentCatalog: [],
});

describe("optimistic session creation", () => {
  beforeEach(() => setActivePinia(createPinia()));

  it("inserts a 'creating' row immediately, before the create RPC resolves", () => {
    const store = useInstancesStore();
    store.instances = [inst()] as never;
    // A never-resolving RPC keeps the row in its booting state for the assertion.
    vi.spyOn(api, "rpc").mockReturnValue(new Promise(() => {}) as never);
    store.beginSessionCreation("i1", "backend", "codex", "home", undefined, undefined);
    const row = store.byId("i1")!.sessions[0]!;
    expect(row).toMatchObject({ alias: "backend", agent: "codex", workspace: "home", creating: true });
    expect(typeof row.creatingSince).toBe("number");
  });

  it("replaces the optimistic row with the real list once creation succeeds", async () => {
    const store = useInstancesStore();
    store.instances = [inst()] as never;
    // create RPC resolves ok; the follow-up loadSessions returns the real (non-creating) row.
    const rpc = vi.spyOn(api, "rpc")
      .mockResolvedValueOnce({ ok: true } as never) // control.sessions.create
      .mockResolvedValueOnce({ sessions: [{ alias: "backend", agent: "codex", workspace: "home", transportSession: "t", running: false, archived: false }] } as never) // sessions.list
      .mockResolvedValue({ agents: [] } as never); // control.agents.list (loadSessions prefetch)
    store.beginSessionCreation("i1", "backend", "codex", "home");
    await flushPromises();
    const sessions = store.byId("i1")!.sessions;
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ alias: "backend", transportSession: "t" });
    expect(sessions[0]!.creating).toBeUndefined();
    expect(rpc).toHaveBeenCalledWith("i1", "control.sessions.create", { alias: "backend", agent: "codex", workspace: "home" });
  });

  it("flips the optimistic row to an error state on a hard create failure", async () => {
    const store = useInstancesStore();
    store.instances = [inst()] as never;
    vi.spyOn(api, "rpc").mockRejectedValue(new ApiError("boom", 500));
    store.beginSessionCreation("i1", "backend", "codex", "home");
    await flushPromises();
    const row = store.byId("i1")!.sessions.find((s) => s.alias === "backend")!;
    expect(row.creating).toBe(false);
    expect(row.createError).toBe("boom");
  });

  it("keeps the optimistic row on a 504 timeout (pending) — it resolves later via sessions-changed", async () => {
    const store = useInstancesStore();
    store.instances = [inst()] as never;
    vi.spyOn(api, "rpc").mockRejectedValue(new ApiError("timeout", 504));
    store.beginSessionCreation("i1", "backend", "codex", "home");
    await flushPromises();
    const row = store.byId("i1")!.sessions.find((s) => s.alias === "backend")!;
    // 504 is treated as pending (not a hard failure): the booting row stays, no error.
    expect(row.creating).toBe(true);
    expect(row.createError).toBeUndefined();
  });

  it("returns false and starts no RPC when the alias is already taken", () => {
    const store = useInstancesStore();
    store.instances = [inst([{ alias: "backend", agent: "codex", workspace: "home", transportSession: "t", running: false, archived: false }])] as never;
    const rpc = vi.spyOn(api, "rpc");
    const ok = store.beginSessionCreation("i1", "backend", "codex", "home");
    expect(ok).toBe(false);
    // No optimistic row added, no doomed create RPC fired (its rejection would be swallowed).
    expect(store.byId("i1")!.sessions).toHaveLength(1);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("returns true when the alias is free", () => {
    const store = useInstancesStore();
    store.instances = [inst()] as never;
    vi.spyOn(api, "rpc").mockReturnValue(new Promise(() => {}) as never);
    expect(store.beginSessionCreation("i1", "fresh", "codex", "home")).toBe(true);
  });

  it("patches the optimistic row alias when the backend auto-derives a different one", async () => {
    const store = useInstancesStore();
    store.instances = [inst()] as never;
    const rpc = vi.spyOn(api, "rpc")
      .mockResolvedValueOnce({ ok: true, alias: "backend-2" } as never) // create returns adjusted alias
      .mockResolvedValueOnce({ sessions: [{ alias: "backend-2", agent: "codex", workspace: "home", transportSession: "t", running: false, archived: false }] } as never)
      .mockResolvedValue({ agents: [] } as never);
    store.beginSessionCreation("i1", "backend", "codex", "home");
    // Before RPC resolves, the optimistic row carries the requested alias.
    const before = store.byId("i1")!.sessions.find((s) => s.creating);
    expect(before?.alias).toBe("backend");
    await flushPromises();
    const sessions = store.byId("i1")!.sessions;
    expect(sessions).toHaveLength(1);
    // After RPC resolves, the optimistic row is patched to the backend-chosen alias
    // and then replaced by loadSessions with the final (non-creating) row.
    expect(sessions[0]).toMatchObject({ alias: "backend-2", transportSession: "t" });
    expect(sessions[0]!.creating).toBeUndefined();
    expect(rpc).toHaveBeenCalledWith("i1", "control.sessions.create", { alias: "backend", agent: "codex", workspace: "home" });
  });

  it("returns true and fires the create RPC when the alias collides with an archived session", () => {
    const store = useInstancesStore();
    store.instances = [inst([{ alias: "archived-alias", agent: "codex", workspace: "home", transportSession: "t", running: false, archived: true }])] as never;
    const rpc = vi.spyOn(api, "rpc").mockReturnValue(new Promise(() => {}) as never);
    const ok = store.beginSessionCreation("i1", "archived-alias", "codex", "home");
    expect(ok).toBe(true);
    // An optimistic row is inserted (temporarily sharing the alias with the archived
    // entry) so the backend can auto-derive a free one and return it to be patched.
    const creatingRows = store.byId("i1")!.sessions.filter((s) => s.creating);
    expect(creatingRows).toHaveLength(1);
    expect(rpc).toHaveBeenCalled();
  });

  it("cancelSessionCreation drops a booting/failed row but spares a materialised one", () => {
    const store = useInstancesStore();
    store.instances = [inst([
      { alias: "booting", agent: "codex", workspace: "home", transportSession: "", running: false, archived: false, creating: true },
      { alias: "real", agent: "codex", workspace: "home", transportSession: "t", running: false, archived: false },
    ])] as never;
    store.cancelSessionCreation("i1", "booting");
    const aliases = store.byId("i1")!.sessions.map((s) => s.alias);
    expect(aliases).toEqual(["real"]);
    // A real (non-creating) session of the same alias is never removed.
    store.cancelSessionCreation("i1", "real");
    expect(store.byId("i1")!.sessions.map((s) => s.alias)).toEqual(["real"]);
  });
});
