import { describe, it, expect, vi, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useInstancesStore } from "../stores/instances";
import { api } from "../api/client";

describe("instances renameSession", () => {
  beforeEach(() => setActivePinia(createPinia()));

  it("calls control.sessions.rename and optimistically sets displayName", async () => {
    const store = useInstancesStore();
    store.instances = [{
      id: "i1", name: "pc", online: true, lastSeenAt: null, sessionsLoaded: true,
      agents: [], workspaces: [], agentCatalog: [],
      sessions: [{ alias: "backend", agent: "claude", workspace: "home", transportSession: "t", running: false, archived: false }],
    }] as never;
    const rpc = vi.spyOn(api, "rpc").mockResolvedValue({ ok: true } as never);
    await store.renameSession("i1", "backend", "  My label  ");
    expect(rpc).toHaveBeenCalledWith("i1", "control.sessions.rename", { alias: "backend", displayName: "My label" });
    expect(store.instances[0]!.sessions[0]!.displayName).toBe("My label");
  });

  it("clears displayName when given an empty value", async () => {
    const store = useInstancesStore();
    store.instances = [{
      id: "i1", name: "pc", online: true, lastSeenAt: null, sessionsLoaded: true,
      agents: [], workspaces: [], agentCatalog: [],
      sessions: [{ alias: "backend", agent: "claude", workspace: "home", transportSession: "t", running: false, archived: false, displayName: "old" }],
    }] as never;
    vi.spyOn(api, "rpc").mockResolvedValue({ ok: true } as never);
    await store.renameSession("i1", "backend", "   ");
    expect(store.instances[0]!.sessions[0]!.displayName).toBeUndefined();
  });
});
