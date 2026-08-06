import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import InstanceTree from "../components/InstanceTree.vue";
import { useInstancesStore, groupArchivedKey } from "../stores/instances";

const instance = (sessions: unknown[] = []) => ({
  id: "i1", name: "pc", online: true, lastSeenAt: null, sessions, sessionsLoaded: true,
  agents: [], workspaces: [], agentCatalog: [],
});

const active = (alias: string, workspace: string, agent = "codex") => ({
  alias, agent, workspace, transportSession: `t-${alias}`, running: false, archived: false,
});
const sleeping = (alias: string, workspace: string, agent = "codex") => ({
  alias, agent, workspace, transportSession: `t-${alias}`, running: false, archived: true,
});

const mountTree = () => mount(InstanceTree, { global: { stubs: { NewSessionDialog: true } } });

describe("InstanceTree grouped sleeping sessions", () => {
  beforeEach(() => setActivePinia(createPinia()));

  it("renders a per-group sleeping toggle in workspace mode and hides the instance-level one", () => {
    const store = useInstancesStore();
    store.instances = [instance([active("a", "backend"), active("b", "web")])] as never;
    store.setGroupMode("i1", "workspace");
    const w = mountTree();
    expect(w.findAll('[data-test="group-toggle-archived"]')).toHaveLength(2);
    expect(w.find('[data-test="toggle-archived-sessions"]').exists()).toBe(false);
  });

  it("keeps the instance-level sleeping toggle in flat mode and shows no group toggles", () => {
    const store = useInstancesStore();
    // Distinct id: other tests persist "workspace" for i1 in shared localStorage.
    store.instances = [{ ...instance([active("a", "backend")]), id: "i-flat" }] as never;
    const w = mountTree();
    expect(w.find('[data-test="toggle-archived-sessions"]').exists()).toBe(true);
    expect(w.find('[data-test="group-toggle-archived"]').exists()).toBe(false);
  });

  it("loads the first sleeping page on expand, renders rows below the group, and hides on second click", async () => {
    const store = useInstancesStore();
    store.instances = [instance([active("a", "backend")])] as never;
    store.setGroupMode("i1", "workspace");
    const load = vi.spyOn(store, "loadGroupArchivedSessions").mockImplementation(async (instanceId, mode, groupKey) => {
      store.byId(instanceId)!.groupArchived = {
        [groupArchivedKey(mode, groupKey)]: {
          sessions: [sleeping("s1", "backend")], loaded: true, hasMore: true, nextOffset: 5,
        },
      };
    });
    const w = mountTree();

    await w.find('[data-test="group-toggle-archived"]').trigger("click");
    await flushPromises();
    expect(load).toHaveBeenCalledWith("i1", "workspace", "backend");
    expect(w.find('[data-test="session-name"]').element.textContent).toContain("a");
    expect(w.text()).toContain("s1");
    // hasMore + expanded → the per-group load-more button appears.
    expect(w.find('[data-test="group-load-more"]').exists()).toBe(true);

    await w.find('[data-test="group-toggle-archived"]').trigger("click");
    expect(w.text()).not.toContain("s1");
    expect(w.find('[data-test="group-load-more"]').exists()).toBe(false);
    // Hiding keeps the cache: no second fetch.
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("appends the next page via load-more until hasMore is false", async () => {
    const store = useInstancesStore();
    store.instances = [instance([active("a", "backend")])] as never;
    store.setGroupMode("i1", "workspace");
    const state = { sessions: [sleeping("s1", "backend")], loaded: true, hasMore: true, nextOffset: 5 };
    store.byId("i1")!.groupArchived = { [groupArchivedKey("workspace", "backend")]: state };
    const load = vi.spyOn(store, "loadGroupArchivedSessions").mockImplementation(async (instanceId, mode, groupKey, append) => {
      const key = groupArchivedKey(mode, groupKey);
      const inst = store.byId(instanceId)!;
      const prev = inst.groupArchived![key]!;
      if (append) {
        inst.groupArchived![key] = { ...prev, sessions: [...prev.sessions, sleeping("s2", "backend")], hasMore: false, nextOffset: 10 };
      }
    });
    const w = mountTree();

    // Show the loaded group first.
    await w.find('[data-test="group-toggle-archived"]').trigger("click");
    await flushPromises();
    expect(w.find('[data-test="group-load-more"]').exists()).toBe(true);
    await w.find('[data-test="group-load-more"]').trigger("click");
    await flushPromises();
    expect(load).toHaveBeenCalledWith("i1", "workspace", "backend", true);
    expect(w.text()).toContain("s2");
    // hasMore=false → the load-more button disappears.
    expect(w.find('[data-test="group-load-more"]').exists()).toBe(false);
  });

  it("hides group sleeping controls for offline instances", () => {
    const store = useInstancesStore();
    store.instances = [{ ...instance([active("a", "backend")]), online: false }] as never;
    store.setGroupMode("i1", "workspace");
    const w = mountTree();
    expect(w.find('[data-test="group-toggle-archived"]').exists()).toBe(false);
  });
});
