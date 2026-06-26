import { setActivePinia, createPinia } from "pinia";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { useInstancesStore } from "../stores/instances";

beforeEach(() => setActivePinia(createPinia()));

test("loadInstances populates the list with online flags", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    instances: [{ id: "i1", name: "pc", online: true, lastSeenAt: null }],
  }), { status: 200 })));
  const store = useInstancesStore();
  await store.loadInstances();
  expect(store.instances[0]).toMatchObject({ id: "i1", name: "pc", online: true });
});

test("applyEvent instance-status toggles online without refetch", () => {
  const store = useInstancesStore();
  store.instances = [{ id: "i1", name: "pc", online: true, lastSeenAt: null, sessions: [], sessionsLoaded: true, agents: [], workspaces: [], agentCatalog: [] }];
  store.applyEvent({ kind: "instance-status", instanceId: "i1", online: false });
  expect(store.instances[0]?.online).toBe(false);
});

test("loadSessions caches sessions under the instance", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    result: { sessions: [{ alias: "backend", agent: "claude", workspace: "/w", transportSession: "t", running: false }] },
  }), { status: 200 })));
  const store = useInstancesStore();
  store.instances = [{ id: "i1", name: "pc", online: true, lastSeenAt: null, sessions: [], sessionsLoaded: true, agents: [], workspaces: [], agentCatalog: [] }];
  await store.loadSessions("i1");
  expect(store.instances[0]?.sessions.map((s) => s.alias)).toEqual(["backend"]);
});

test("loadInstances eagerly loads sessions for online instances", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo) => {
    const url = typeof input === "string" ? input : String(input);
    const body = url.includes("/rpc")
      ? { result: { sessions: [{ alias: "backend", agent: "claude", workspace: "/w", transportSession: "t", running: false }] } }
      : { instances: [{ id: "i1", name: "pc", online: true, lastSeenAt: null }, { id: "i2", name: "off", online: false, lastSeenAt: null }] };
    return new Response(JSON.stringify(body), { status: 200 });
  }));
  const store = useInstancesStore();
  await store.loadInstances();
  // Wait a microtask turn for the fire-and-forget loadSessions to settle.
  await new Promise((r) => setTimeout(r, 0));
  expect(store.byId("i1")!.sessions.map((s) => s.alias)).toEqual(["backend"]);
  expect(store.byId("i1")!.sessionsLoaded).toBe(true);
  // The offline instance is left untouched (no eager fetch).
  expect(store.byId("i2")!.sessionsLoaded).toBe(false);
  vi.unstubAllGlobals();
});

test("applyEvent instance-status loads sessions when an instance comes online", async () => {
  const store = useInstancesStore();
  store.instances = [{ id: "i1", name: "pc", online: false, lastSeenAt: null, sessions: [], sessionsLoaded: false, agents: [], workspaces: [], agentCatalog: [] }];
  const { api } = await import("../api/client");
  const rpc = vi.spyOn(api, "rpc").mockResolvedValue({ sessions: [{ alias: "backend", agent: "claude", workspace: "/w", transportSession: "t", running: false }] });
  store.applyEvent({ kind: "instance-status", instanceId: "i1", online: true });
  await new Promise((r) => setTimeout(r, 0));
  expect(rpc).toHaveBeenCalledWith("i1", "control.sessions.list");
  expect(store.byId("i1")!.sessionsLoaded).toBe(true);
  vi.restoreAllMocks();
});

test("applyEvent workspaces-changed re-fetches the instance's workspace list", async () => {
  const store = useInstancesStore();
  store.instances = [{ id: "i1", name: "pc", online: true, lastSeenAt: null, sessions: [], sessionsLoaded: true, agents: [], workspaces: [], agentCatalog: [] }];
  const { api } = await import("../api/client");
  const rpc = vi.spyOn(api, "rpc").mockResolvedValue({ workspaces: [{ name: "backend", cwd: "/srv/api" }] });
  // Simulates `xacpx workspace add` on the instance: the daemon emits workspaces-changed.
  store.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "workspaces-changed" } });
  await new Promise((r) => setTimeout(r, 0));
  expect(rpc).toHaveBeenCalledWith("i1", "control.workspaces.list");
  expect(store.byId("i1")!.workspaces).toEqual([{ name: "backend", cwd: "/srv/api" }]);
  vi.restoreAllMocks();
});

test("renameInstance PATCHes the instance and updates local name", async () => {
  const store = useInstancesStore();
  store.instances = [{ id: "i1", name: "old", online: true, lastSeenAt: null, sessions: [], sessionsLoaded: true, agents: [], workspaces: [], agentCatalog: [] }];
  const { api } = await import("../api/client");
  const patch = vi.spyOn(api, "patch").mockResolvedValue({ ok: true });
  await store.renameInstance("i1", "new");
  expect(patch).toHaveBeenCalledWith("/api/instances/i1", { name: "new" });
  expect(store.byId("i1")!.name).toBe("new");
  vi.restoreAllMocks();
});

describe("createSession timeout handling", () => {
  beforeEach(() => setActivePinia(createPinia()));

  function seed() {
    const store = useInstancesStore();
    store.instances = [{ id: "i1", name: "pc", online: true, lastSeenAt: null, sessions: [], sessionsLoaded: true, agents: [], workspaces: [], agentCatalog: [] }];
    return store;
  }

  test("resolves {pending:false} on success", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo) => {
      const url = typeof input === "string" ? input : String(input);
      // First call: control.sessions.create. Second: control.sessions.list reload.
      const body = url.includes("/rpc") ? { result: { sessions: [] } } : {};
      return new Response(JSON.stringify(body), { status: 200 });
    }));
    const store = seed();
    await expect(store.createSession("i1", "backend", "codex", "home")).resolves.toEqual({ pending: false });
    vi.unstubAllGlobals();
  });

  test("resolves {pending:true} when the create RPC times out (504)", async () => {
    const store = seed();
    const { api } = await import("../api/client");
    const { ApiError } = await import("../api/client");
    vi.spyOn(api, "rpc").mockRejectedValueOnce(new ApiError("timeout", 504));
    await expect(store.createSession("i1", "backend", "codex", "home")).resolves.toEqual({ pending: true });
    vi.restoreAllMocks();
  });

  test("rejects when the create RPC fails with a non-timeout ApiError", async () => {
    const store = seed();
    const { api } = await import("../api/client");
    const { ApiError } = await import("../api/client");
    vi.spyOn(api, "rpc").mockRejectedValueOnce(new ApiError("instance-offline", 503));
    await expect(store.createSession("i1", "backend", "codex", "home")).rejects.toBeInstanceOf(ApiError);
    vi.restoreAllMocks();
  });

  test("rejects on an instance-side {error} payload (unwrap path)", async () => {
    const store = seed();
    const { api } = await import("../api/client");
    vi.spyOn(api, "rpc").mockResolvedValueOnce({ error: { code: "bad", message: "workspace not registered" } });
    await expect(store.createSession("i1", "backend", "codex", "home")).rejects.toThrow("workspace not registered");
    vi.restoreAllMocks();
  });

  test("an `unknown-type` error becomes an actionable 'newer connector' hint", async () => {
    const store = seed();
    const { api } = await import("../api/client");
    // A version-skewed connector that doesn't implement this RPC replies with `unknown-type`.
    vi.spyOn(api, "rpc").mockResolvedValueOnce({ error: { code: "unknown-type", message: "unsupported rpc type: control.sessions.create" } });
    await expect(store.createSession("i1", "backend", "codex", "home")).rejects.toThrow(/newer connector/i);
    vi.restoreAllMocks();
  });
});

describe("native session attach", () => {
  beforeEach(() => setActivePinia(createPinia()));

  function seed() {
    const store = useInstancesStore();
    store.instances = [{ id: "i1", name: "pc", online: true, lastSeenAt: null, sessions: [], sessionsLoaded: true, agents: [], workspaces: [], agentCatalog: [] }];
    return store;
  }

  test("listNativeSessions unwraps the sessions array", async () => {
    const store = seed();
    const { api } = await import("../api/client");
    const rpc = vi.spyOn(api, "rpc").mockResolvedValue({ sessions: [{ sessionId: "ses_1", title: "x" }] });
    await expect(store.listNativeSessions("i1", "codex", "backend")).resolves.toEqual([{ sessionId: "ses_1", title: "x" }]);
    expect(rpc).toHaveBeenCalledWith("i1", "control.sessions.native.list", { agent: "codex", workspace: "backend" });
    vi.restoreAllMocks();
  });

  test("createSession forwards agentSessionId for a native resume", async () => {
    const store = seed();
    const { api } = await import("../api/client");
    const rpc = vi.spyOn(api, "rpc").mockResolvedValue({ sessions: [] });
    await store.createSession("i1", "resumed", "codex", "backend", "ses_1");
    expect(rpc).toHaveBeenCalledWith("i1", "control.sessions.create", { alias: "resumed", agent: "codex", workspace: "backend", agentSessionId: "ses_1" });
    vi.restoreAllMocks();
  });

  test("createSession omits agentSessionId for a fresh session", async () => {
    const store = seed();
    const { api } = await import("../api/client");
    const rpc = vi.spyOn(api, "rpc").mockResolvedValue({ sessions: [] });
    await store.createSession("i1", "fresh", "codex", "backend");
    expect(rpc).toHaveBeenCalledWith("i1", "control.sessions.create", { alias: "fresh", agent: "codex", workspace: "backend" });
    vi.restoreAllMocks();
  });
});

describe("agent catalog + management actions", () => {
  beforeEach(() => setActivePinia(createPinia()));

  test("loadAgentCatalog stores the catalog on the instance", async () => {
    const store = useInstancesStore();
    store.instances = [{ id: "i1", name: "n", online: true, lastSeenAt: null, sessions: [], sessionsLoaded: true, agents: [], workspaces: [], agentCatalog: [] }];
    const { api } = await import("../api/client");
    vi.spyOn(api, "rpc").mockResolvedValue({ agents: [{ driver: "gemini", configured: false, installed: "unknown" }] });
    await store.loadAgentCatalog("i1");
    expect(store.byId("i1")!.agentCatalog).toEqual([{ driver: "gemini", configured: false, installed: "unknown" }]);
    vi.restoreAllMocks();
  });

  test("createAgent refreshes once (single catalog fetch, no double)", async () => {
    const store = useInstancesStore();
    store.instances = [{ id: "i1", name: "n", online: true, lastSeenAt: null, sessions: [], sessionsLoaded: true, agents: [], workspaces: [], agentCatalog: [] }];
    const { api } = await import("../api/client");
    const rpc = vi.spyOn(api, "rpc").mockImplementation(async (_id: string, type: string) => {
      if (type === "control.agents.list") return { agents: [] } as never;
      if (type === "control.workspaces.list") return { workspaces: [] } as never;
      if (type === "control.agents.catalog") return { agents: [] } as never;
      return { agent: { name: "gemini", driver: "gemini" } } as never;
    });
    await expect(store.createAgent("i1", "gemini", "gemini")).resolves.toBeUndefined();
    const types = rpc.mock.calls.map((c) => c[1]);
    expect(types[0]).toBe("control.agents.create");
    // loadFormOptions refreshes everything once; the catalog is fetched exactly once.
    expect(types.filter((t) => t === "control.agents.catalog")).toHaveLength(1);
    vi.restoreAllMocks();
  });

  test("removeAgent surfaces an instance-side error payload", async () => {
    const store = useInstancesStore();
    store.instances = [{ id: "i1", name: "n", online: true, lastSeenAt: null, sessions: [], sessionsLoaded: true, agents: [], workspaces: [], agentCatalog: [] }];
    const { api } = await import("../api/client");
    vi.spyOn(api, "rpc").mockResolvedValue({ error: { code: "internal", message: 'agent "codex" is in use by an existing session' } });
    await expect(store.removeAgent("i1", "codex")).rejects.toThrow(/in use/);
    vi.restoreAllMocks();
  });
});

describe("listModelSuggestions adapter-consensus gate", () => {
  beforeEach(() => setActivePinia(createPinia()));

  function seedSessions(sessions: unknown[]) {
    const store = useInstancesStore();
    store.instances = [{ id: "i1", name: "pc", online: true, lastSeenAt: null, sessions: sessions as never, sessionsLoaded: true, agents: [], workspaces: [], agentCatalog: [] }];
    return store;
  }

  test("reuses a single same-agent+workspace session's advertised models", async () => {
    const store = seedSessions([
      { alias: "a", agent: "codex", workspace: "w", transportSession: "t", running: true, archived: false, agentCommand: "npx codex-acp@new" },
    ]);
    const { api } = await import("../api/client");
    vi.spyOn(api, "rpc").mockResolvedValue({ current: "gpt-5.5[high]", available: ["gpt-5.5[high]", "gpt-5.5[low]"] });
    await expect(store.listModelSuggestions("i1", "codex", "w")).resolves.toEqual(["gpt-5.5[high]", "gpt-5.5[low]"]);
    vi.restoreAllMocks();
  });

  test("suppresses suggestions when same-agent sessions run different adapters", async () => {
    const store = seedSessions([
      { alias: "old", agent: "codex", workspace: "w", transportSession: "t1", running: true, archived: false, agentCommand: "npx @zed-industries/codex-acp@0.10.0" },
      { alias: "new", agent: "codex", workspace: "w", transportSession: "t2", running: true, archived: false, agentCommand: "npx @agentclientprotocol/codex-acp@^0.0.44" },
    ]);
    const { api } = await import("../api/client");
    const rpc = vi.spyOn(api, "rpc");
    await expect(store.listModelSuggestions("i1", "codex", "w")).resolves.toEqual([]);
    // Ambiguous adapter → never query a live session for its (wrong-adapter) models.
    expect(rpc).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  test("reuses when same-agent sessions share one adapter", async () => {
    const store = seedSessions([
      { alias: "a", agent: "codex", workspace: "w", transportSession: "t1", running: true, archived: false, agentCommand: "npx codex-acp@new" },
      { alias: "b", agent: "codex", workspace: "w", transportSession: "t2", running: false, archived: false, agentCommand: "npx codex-acp@new" },
    ]);
    const { api } = await import("../api/client");
    vi.spyOn(api, "rpc").mockResolvedValue({ current: "gpt-5.5[high]", available: ["gpt-5.5[high]"] });
    await expect(store.listModelSuggestions("i1", "codex", "w")).resolves.toEqual(["gpt-5.5[high]"]);
    vi.restoreAllMocks();
  });

  test("ignores archived sessions when judging adapter consensus", async () => {
    const store = seedSessions([
      { alias: "live", agent: "codex", workspace: "w", transportSession: "t1", running: true, archived: false, agentCommand: "npx codex-acp@new" },
      { alias: "old", agent: "codex", workspace: "w", transportSession: "t2", running: false, archived: true, agentCommand: "npx @zed-industries/codex-acp@0.10.0" },
    ]);
    const { api } = await import("../api/client");
    vi.spyOn(api, "rpc").mockResolvedValue({ current: "gpt-5.5[high]", available: ["gpt-5.5[high]"] });
    await expect(store.listModelSuggestions("i1", "codex", "w")).resolves.toEqual(["gpt-5.5[high]"]);
    vi.restoreAllMocks();
  });

  test("reuses when adapter is unknown on all sessions (legacy state, no field)", async () => {
    const store = seedSessions([
      { alias: "a", agent: "codex", workspace: "w", transportSession: "t1", running: true, archived: false },
      { alias: "b", agent: "codex", workspace: "w", transportSession: "t2", running: false, archived: false },
    ]);
    const { api } = await import("../api/client");
    vi.spyOn(api, "rpc").mockResolvedValue({ current: "gpt-5.5[high]", available: ["gpt-5.5[high]"] });
    await expect(store.listModelSuggestions("i1", "codex", "w")).resolves.toEqual(["gpt-5.5[high]"]);
    vi.restoreAllMocks();
  });
});

import { mount } from "@vue/test-utils";
import InstanceTree from "../components/InstanceTree.vue";

test("InstanceTree renders an online dot per instance", () => {
  setActivePinia(createPinia());
  const store = useInstancesStore();
  store.instances = [
    { id: "i1", name: "pc", online: true, lastSeenAt: null, sessions: [], sessionsLoaded: true, agents: [], workspaces: [], agentCatalog: [] },
    { id: "i2", name: "srv", online: false, lastSeenAt: null, sessions: [], sessionsLoaded: true, agents: [], workspaces: [], agentCatalog: [] },
  ];
  const wrapper = mount(InstanceTree);
  const dots = wrapper.findAll('[data-test="online-dot"]');
  expect(dots.length).toBe(2);
  expect(dots[0]!.classes()).toContain("bg-run");
  expect(dots[1]!.classes()).toContain("bg-fg-muted");
});
