import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import InstanceTree from "../components/InstanceTree.vue";
import { useInstancesStore, groupArchivedKey } from "../stores/instances";
import type { GroupArchivedMode } from "../stores/instances";

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

const mountTree = () => mount(InstanceTree, { attachTo: document.body, global: { stubs: { NewSessionDialog: true } } });

/** Turn the instance-level 「已睡眠会话」 filter on/off through the tab-row filter menu. */
async function toggleSleepFilter(w: ReturnType<typeof mountTree>): Promise<void> {
  // The menu stays open after toggling (checkbox item); only open it when closed.
  if (!document.querySelector('[data-test="filter-sleeping-sessions"]')) {
    await w.find('[data-test="instance-filter"]').trigger("click");
    await flushPromises();
  }
  const item = document.querySelector<HTMLElement>('[data-test="filter-sleeping-sessions"]');
  expect(item).not.toBeNull();
  item!.click();
  await flushPromises();
}

/** Fake per-group page loader: each group gets one sleeping row named `zz_<group>`. */
function fakeGroupLoader(store: ReturnType<typeof useInstancesStore>, hasMore: (group: string) => boolean) {
  return vi.spyOn(store, "loadGroupArchivedSessions").mockImplementation(async (instanceId, mode: GroupArchivedMode, groupKey, append) => {
    const inst = store.byId(instanceId)!;
    const key = groupArchivedKey(mode, groupKey);
    const prev = inst.groupArchived?.[key];
    const row = mode === "agent" ? sleeping(`zz_${groupKey}${append ? "_2" : ""}`, "backend", groupKey) : sleeping(`zz_${groupKey}${append ? "_2" : ""}`, groupKey);
    inst.groupArchived = {
      ...(inst.groupArchived ?? {}),
      [key]: {
        sessions: append && prev ? [...prev.sessions, row] : [row],
        loaded: true, hasMore: append ? false : hasMore(groupKey), nextOffset: 5,
      },
    };
  });
}

describe("InstanceTree grouped sleeping sessions (instance-level filter)", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    document.body.innerHTML = "";
  });

  it("shows the instance-level filter in group mode and no per-group sleep toggles", () => {
    const store = useInstancesStore();
    store.instances = [instance([active("a", "backend"), active("b", "web")])] as never;
    store.setGroupMode("i1", "workspace");
    const w = mountTree();
    expect(w.find('[data-test="instance-filter"]').exists()).toBe(true);
    expect(w.find('[data-test="group-toggle-archived"]').exists()).toBe(false);
    expect(w.find('[data-test="group-load-more"]').exists()).toBe(false);
    w.unmount();
  });

  it("keeps the instance-level filter in flat mode", () => {
    const store = useInstancesStore();
    // Distinct id: other tests persist "workspace" for i1 in shared localStorage.
    store.instances = [{ ...instance([active("a", "backend")]), id: "i-flat" }] as never;
    const w = mountTree();
    expect(w.find('[data-test="instance-filter"]').exists()).toBe(true);
    expect(w.find('[data-test="group-toggle-archived"]').exists()).toBe(false);
    w.unmount();
  });

  it("turning the filter on in workspace mode shows sleeping rows inside every group; off hides them", async () => {
    const store = useInstancesStore();
    store.instances = [instance([active("a", "backend"), active("b", "web")])] as never;
    store.setGroupMode("i1", "workspace");
    const load = fakeGroupLoader(store, () => false);
    const w = mountTree();

    await toggleSleepFilter(w);
    expect(load).toHaveBeenCalledWith("i1", "workspace", "backend");
    expect(load).toHaveBeenCalledWith("i1", "workspace", "web");
    const groups = w.findAll('[data-test="session-group"]');
    expect(groups).toHaveLength(2);
    expect(groups[0]!.text()).toContain("zz_backend");
    expect(groups[1]!.text()).toContain("zz_web");
    expect(groups[0]!.text()).not.toContain("zz_web");

    await toggleSleepFilter(w);
    expect(w.text()).not.toContain("zz_backend");
    expect(w.text()).not.toContain("zz_web");
    // Hiding keeps the cache: re-showing does not refetch.
    await toggleSleepFilter(w);
    expect(w.text()).toContain("zz_backend");
    expect(load).toHaveBeenCalledTimes(2);
    w.unmount();
  });

  it("loads per-group sleeping pages filtered by agent in agent mode", async () => {
    const store = useInstancesStore();
    store.instances = [instance([active("a", "backend", "codex"), active("b", "web", "claude")])] as never;
    store.setGroupMode("i1", "agent");
    const load = fakeGroupLoader(store, () => false);
    const w = mountTree();

    await toggleSleepFilter(w);
    expect(load).toHaveBeenCalledWith("i1", "agent", "codex");
    expect(load).toHaveBeenCalledWith("i1", "agent", "claude");
    expect(w.text()).toContain("zz_codex");
    expect(w.text()).toContain("zz_claude");
    // Fully-loaded groups (hasMore=false) show no load-more.
    expect(w.find('[data-test="group-load-more"]').exists()).toBe(false);
    w.unmount();
  });

  it("each group with more pages has exactly one load-more at its bottom, which appends", async () => {
    const store = useInstancesStore();
    store.instances = [instance([active("a", "backend"), active("b", "web")])] as never;
    store.setGroupMode("i1", "workspace");
    const load = fakeGroupLoader(store, (group) => group === "backend");
    const w = mountTree();

    await toggleSleepFilter(w);
    const groups = w.findAll('[data-test="session-group"]');
    expect(groups[0]!.findAll('[data-test="group-load-more"]')).toHaveLength(1);
    expect(groups[1]!.findAll('[data-test="group-load-more"]')).toHaveLength(0);
    // The load-more is the last thing in the group (below its sleeping rows).
    const btn = groups[0]!.find('[data-test="group-load-more"]');
    const rows = groups[0]!.findAll('[data-test="session-row"]');
    expect(rows.at(-1)!.element.compareDocumentPosition(btn.element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await btn.trigger("click");
    await flushPromises();
    expect(load).toHaveBeenCalledWith("i1", "workspace", "backend", true);
    expect(w.text()).toContain("zz_backend_2");
    expect(w.find('[data-test="group-load-more"]').exists()).toBe(false);
    w.unmount();
  });

  it("switching from flat to group mode while the filter is on loads the groups' sleeping rows", async () => {
    const store = useInstancesStore();
    store.instances = [{ ...instance([active("a", "backend")]), id: "i-switch" }] as never;
    store.setGroupMode("i-switch", "instance");
    vi.spyOn(store, "loadArchivedSessions").mockImplementation(async () => {
      store.byId("i-switch")!.archivedSessionsLoaded = true;
    });
    const load = fakeGroupLoader(store, () => false);
    const w = mountTree();

    await toggleSleepFilter(w);
    expect(load).not.toHaveBeenCalled();
    store.setGroupMode("i-switch", "workspace");
    await flushPromises();
    expect(load).toHaveBeenCalledWith("i-switch", "workspace", "backend");
    expect(w.text()).toContain("zz_backend");
    store.setGroupMode("i-switch", "instance");
    w.unmount();
  });

  it("hides group sleeping rows and controls for offline instances", () => {
    const store = useInstancesStore();
    store.instances = [{ ...instance([active("a", "backend")]), online: false }] as never;
    store.setGroupMode("i1", "workspace");
    const w = mountTree();
    expect(w.find('[data-test="group-load-more"]').exists()).toBe(false);
    expect(w.find('[data-test="group-toggle-archived"]').exists()).toBe(false);
    w.unmount();
  });
});
