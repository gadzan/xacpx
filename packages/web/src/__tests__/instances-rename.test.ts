import { describe, it, expect, vi, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useInstancesStore } from "../stores/instances";
import { api } from "../api/client";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("instances renameSession", () => {
  beforeEach(() => setActivePinia(createPinia()));

  it("shows the new displayName before control.sessions.rename resolves", async () => {
    const store = useInstancesStore();
    store.instances = [{
      id: "i1", name: "pc", online: true, lastSeenAt: null, sessionsLoaded: true,
      agents: [], workspaces: [], agentCatalog: [],
      sessions: [{ alias: "backend", agent: "claude", workspace: "home", transportSession: "t", running: false, archived: false, displayName: "old" }],
    }] as never;
    const result = deferred<unknown>();
    const rpc = vi.spyOn(api, "rpc").mockReturnValue(result.promise as never);
    const renaming = store.renameSession("i1", "backend", "  My label  ");

    expect(rpc).toHaveBeenCalledWith("i1", "control.sessions.rename", { alias: "backend", displayName: "My label" });
    expect(store.instances[0]!.sessions[0]!.displayName).toBe("My label");

    result.resolve({ ok: true });
    await renaming;
  });

  it("keeps a pending displayName when the authoritative session list is still stale", async () => {
    const store = useInstancesStore();
    store.instances = [{
      id: "i1", name: "pc", online: true, lastSeenAt: null, sessionsLoaded: true,
      agents: [{ name: "claude", driver: "claude" }], workspaces: [], agentCatalog: [],
      sessions: [{ alias: "backend", agent: "claude", workspace: "home", transportSession: "t", running: true, archived: false, displayName: "old" }],
    }] as never;
    const renameResult = deferred<unknown>();
    vi.spyOn(api, "rpc").mockImplementation((_instanceId, type) => {
      if (type === "control.sessions.rename") return renameResult.promise as never;
      if (type === "control.sessions.list") {
        return Promise.resolve({
          sessions: [{ alias: "backend", agent: "claude", workspace: "home", transportSession: "t", running: true, archived: false, displayName: "old" }],
        }) as never;
      }
      throw new Error(`unexpected rpc: ${type}`);
    });

    const renaming = store.renameSession("i1", "backend", "New label");
    await store.loadSessions("i1");
    const visibleWhilePending = store.instances[0]!.sessions[0]!.displayName;

    renameResult.resolve({ ok: true });
    await renaming;
    expect(visibleWhilePending).toBe("New label");
  });

  it("does not let a list started before a single successful rename restore the old name", async () => {
    const store = useInstancesStore();
    store.instances = [{
      id: "i1", name: "pc", online: true, lastSeenAt: null, sessionsLoaded: true,
      agents: [{ name: "claude", driver: "claude" }], workspaces: [], agentCatalog: [],
      sessions: [{ alias: "backend", agent: "claude", workspace: "home", transportSession: "t", running: true, archived: false, displayName: "old" }],
    }] as never;
    const staleListResult = deferred<unknown>();
    const confirmingListResult = deferred<unknown>();
    const renameResult = deferred<unknown>();
    let listCalls = 0;
    vi.spyOn(api, "rpc").mockImplementation((_instanceId, type) => {
      if (type === "control.sessions.rename") return renameResult.promise as never;
      if (type === "control.sessions.list") {
        listCalls += 1;
        return (listCalls === 1 ? staleListResult.promise : confirmingListResult.promise) as never;
      }
      throw new Error(`unexpected rpc: ${type}`);
    });

    const staleReload = store.loadSessions("i1");
    const renaming = store.renameSession("i1", "backend", "A");
    renameResult.resolve({ ok: true });
    await Promise.resolve();

    staleListResult.resolve({
      sessions: [{ alias: "backend", agent: "claude", workspace: "home", transportSession: "t", running: true, archived: false, displayName: "old" }],
    });
    // The successful rename requested a replay while the stale list was in flight;
    // resolve that replay page before awaiting the coalesced loadSessions promise.
    confirmingListResult.resolve({
      sessions: [{ alias: "backend", agent: "claude", workspace: "home", transportSession: "t", running: true, archived: false, displayName: "A" }],
    });
    await staleReload;
    expect(store.instances[0]!.sessions[0]!.displayName).toBe("A");
    await renaming;
    expect(store.instances[0]!.sessions[0]!.displayName).toBe("A");
  });

  it("serializes consecutive renames and rolls a failed latest rename back to the last confirmed value", async () => {
    const store = useInstancesStore();
    store.instances = [{
      id: "i1", name: "pc", online: true, lastSeenAt: null, sessionsLoaded: true,
      agents: [], workspaces: [], agentCatalog: [],
      sessions: [{ alias: "backend", agent: "claude", workspace: "home", transportSession: "t", running: true, archived: false, displayName: "old" }],
    }] as never;
    const firstResult = deferred<unknown>();
    const secondResult = deferred<unknown>();
    let renameCalls = 0;
    vi.spyOn(api, "rpc").mockImplementation((_instanceId, type) => {
      if (type !== "control.sessions.rename") throw new Error(`unexpected rpc: ${type}`);
      renameCalls += 1;
      return (renameCalls === 1 ? firstResult.promise : secondResult.promise) as never;
    });

    const firstRename = store.renameSession("i1", "backend", "A");
    const secondRename = store.renameSession("i1", "backend", "B");
    const secondOutcome = secondRename.catch((error: unknown) => error);
    const callsBeforeFirstSettled = renameCalls;
    expect(store.instances[0]!.sessions[0]!.displayName).toBe("B");

    firstResult.resolve({ ok: true });
    await firstRename;
    await Promise.resolve();
    expect(renameCalls).toBe(2);
    secondResult.reject(new Error("B failed"));
    expect(await secondOutcome).toBeInstanceOf(Error);

    expect(callsBeforeFirstSettled).toBe(1);
    expect(store.instances[0]!.sessions[0]!.displayName).toBe("A");
  });

  it("does not let a stale session-list response downgrade a newer confirmed rename", async () => {
    const store = useInstancesStore();
    store.instances = [{
      id: "i1", name: "pc", online: true, lastSeenAt: null, sessionsLoaded: true,
      agents: [{ name: "claude", driver: "claude" }], workspaces: [], agentCatalog: [],
      sessions: [{ alias: "backend", agent: "claude", workspace: "home", transportSession: "t", running: true, archived: false, displayName: "old" }],
    }] as never;
    const firstResult = deferred<unknown>();
    const secondResult = deferred<unknown>();
    const listResult = deferred<unknown>();
    let renameCalls = 0;
    vi.spyOn(api, "rpc").mockImplementation((_instanceId, type) => {
      if (type === "control.sessions.list") return listResult.promise as never;
      if (type !== "control.sessions.rename") throw new Error(`unexpected rpc: ${type}`);
      renameCalls += 1;
      return (renameCalls === 1 ? firstResult.promise : secondResult.promise) as never;
    });

    const firstRename = store.renameSession("i1", "backend", "A");
    const secondOutcome = store.renameSession("i1", "backend", "B").catch((error: unknown) => error);
    const staleReload = store.loadSessions("i1");

    firstResult.resolve({ ok: true });
    await firstRename;
    await Promise.resolve();
    listResult.resolve({
      sessions: [{ alias: "backend", agent: "claude", workspace: "home", transportSession: "t", running: true, archived: false, displayName: "old" }],
    });
    await staleReload;
    secondResult.reject(new Error("B failed"));
    expect(await secondOutcome).toBeInstanceOf(Error);

    expect(store.instances[0]!.sessions[0]!.displayName).toBe("A");
  });

  it("keeps a newer optimistic rename when an earlier queued rename fails", async () => {
    const store = useInstancesStore();
    store.instances = [{
      id: "i1", name: "pc", online: true, lastSeenAt: null, sessionsLoaded: true,
      agents: [], workspaces: [], agentCatalog: [],
      sessions: [{ alias: "backend", agent: "claude", workspace: "home", transportSession: "t", running: true, archived: false, displayName: "old" }],
    }] as never;
    const firstResult = deferred<unknown>();
    const secondResult = deferred<unknown>();
    let renameCalls = 0;
    vi.spyOn(api, "rpc").mockImplementation(() => {
      renameCalls += 1;
      return (renameCalls === 1 ? firstResult.promise : secondResult.promise) as never;
    });

    const firstOutcome = store.renameSession("i1", "backend", "A").catch((error: unknown) => error);
    const secondRename = store.renameSession("i1", "backend", "B");
    expect(store.instances[0]!.sessions[0]!.displayName).toBe("B");
    expect(renameCalls).toBe(1);

    firstResult.reject(new Error("A failed"));
    expect(await firstOutcome).toBeInstanceOf(Error);
    await Promise.resolve();
    expect(renameCalls).toBe(2);
    secondResult.resolve({ ok: true });
    await secondRename;

    expect(store.instances[0]!.sessions[0]!.displayName).toBe("B");
  });

  it("does not serialize renames for different sessions", async () => {
    const store = useInstancesStore();
    store.instances = [{
      id: "i1", name: "pc", online: true, lastSeenAt: null, sessionsLoaded: true,
      agents: [], workspaces: [], agentCatalog: [],
      sessions: [
        { alias: "backend", agent: "claude", workspace: "home", transportSession: "t1", running: true, archived: false, displayName: "old-backend" },
        { alias: "frontend", agent: "claude", workspace: "home", transportSession: "t2", running: true, archived: false, displayName: "old-frontend" },
      ],
    }] as never;
    const backendResult = deferred<unknown>();
    const frontendResult = deferred<unknown>();
    const seenAliases: string[] = [];
    vi.spyOn(api, "rpc").mockImplementation((_instanceId, type, payload) => {
      if (type !== "control.sessions.rename") throw new Error(`unexpected rpc: ${type}`);
      const alias = (payload as { alias: string }).alias;
      seenAliases.push(alias);
      return (alias === "backend" ? backendResult.promise : frontendResult.promise) as never;
    });

    const backendRename = store.renameSession("i1", "backend", "Backend A");
    const frontendRename = store.renameSession("i1", "frontend", "Frontend A");
    expect(seenAliases).toEqual(["backend", "frontend"]);

    backendResult.resolve({ ok: true });
    frontendResult.resolve({ ok: true });
    await Promise.all([backendRename, frontendRename]);
    expect(store.instances[0]!.sessions.map((session) => session.displayName)).toEqual(["Backend A", "Frontend A"]);
  });

  it("clears displayName when given an empty value", async () => {
    const store = useInstancesStore();
    store.instances = [{
      id: "i1", name: "pc", online: true, lastSeenAt: null, sessionsLoaded: true,
      agents: [], workspaces: [], agentCatalog: [],
      sessions: [{ alias: "backend", agent: "claude", workspace: "home", transportSession: "t", running: false, archived: false, displayName: "old" }],
    }] as never;
    const rpc = vi.spyOn(api, "rpc").mockResolvedValue({ ok: true } as never);
    await store.renameSession("i1", "backend", "   ");
    expect(rpc).toHaveBeenCalledWith("i1", "control.sessions.rename", { alias: "backend", displayName: "" });
    expect(store.instances[0]!.sessions[0]!.displayName).toBeUndefined();
  });

  it("rejects on an RPC error payload and keeps the previous displayName", async () => {
    const store = useInstancesStore();
    store.instances = [{
      id: "i1", name: "pc", online: true, lastSeenAt: null, sessionsLoaded: true,
      agents: [], workspaces: [], agentCatalog: [],
      sessions: [{ alias: "backend", agent: "claude", workspace: "home", transportSession: "t", running: false, archived: false, displayName: "old" }],
    }] as never;
    vi.spyOn(api, "rpc").mockResolvedValue({ error: { code: "invalid-payload", message: "boom" } } as never);
    await expect(store.renameSession("i1", "backend", "New label")).rejects.toThrow("boom");
    // A failed optimistic rename must restore the last confirmed label.
    expect(store.instances[0]!.sessions[0]!.displayName).toBe("old");
  });

  it("preserves the original rename error when the session row disappears in flight", async () => {
    const store = useInstancesStore();
    store.instances = [{
      id: "i1", name: "pc", online: true, lastSeenAt: null, sessionsLoaded: true,
      agents: [], workspaces: [], agentCatalog: [],
      sessions: [{ alias: "backend", agent: "claude", workspace: "home", transportSession: "t", running: false, archived: false, displayName: "old" }],
    }] as never;
    const result = deferred<unknown>();
    vi.spyOn(api, "rpc").mockReturnValue(result.promise as never);
    const renaming = store.renameSession("i1", "backend", "");

    store.instances[0]!.sessions = [];
    result.reject(new Error("instance-offline"));

    await expect(renaming).rejects.toThrow("instance-offline");
    expect(store.instances[0]!.sessions).toEqual([]);
  });

  it("maps an unknown-type error to the connector-upgrade hint", async () => {
    const store = useInstancesStore();
    store.instances = [{
      id: "i1", name: "pc", online: true, lastSeenAt: null, sessionsLoaded: true,
      agents: [], workspaces: [], agentCatalog: [],
      sessions: [{ alias: "backend", agent: "claude", workspace: "home", transportSession: "t", running: false, archived: false, displayName: "old" }],
    }] as never;
    vi.spyOn(api, "rpc").mockResolvedValue({ error: { code: "unknown-type", message: "unsupported rpc type: control.sessions.rename" } } as never);
    await expect(store.renameSession("i1", "backend", "New label")).rejects.toThrow(/needs a newer connector/);
    expect(store.instances[0]!.sessions[0]!.displayName).toBe("old");
  });
});
