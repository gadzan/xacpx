import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import InstanceTree from "../components/InstanceTree.vue";
import ManageInstanceDialog from "../components/ManageInstanceDialog.vue";
import { useInstancesStore } from "../stores/instances";
import { loadGroupMode } from "../lib/sidebar-group-mode";

const sess = (alias: string, workspace: string, agent: string, archived = false) => ({
  alias, agent, workspace, transportSession: `t-${alias}`, running: false, archived,
});

const instance = (sessions: unknown[]) => ({
  id: "i1", name: "pc", online: true, lastSeenAt: null, sessions, sessionsLoaded: true,
  agents: [{ name: "claude", driver: "claude" }, { name: "codex", driver: "codex" }], workspaces: [], agentCatalog: [],
});

const mountTree = () => mount(InstanceTree, { global: { stubs: { NewSessionDialog: true } } });

describe("InstanceTree grouped rendering", () => {
  beforeEach(() => setActivePinia(createPinia()));
  afterEach(() => localStorage.clear());

  it("renders workspace groups with header, count, and rows in server order", () => {
    const store = useInstancesStore();
    store.setGroupMode("i1", "workspace");
    store.instances = [instance([sess("web-claude", "web", "claude"), sess("api-codex", "api", "codex"), sess("web-codex", "web", "codex")])] as never;
    const w = mountTree();
    const groups = w.findAll('[data-test="session-group"]');
    expect(groups).toHaveLength(2);
    expect(groups[0]!.find('[data-test="group-name"]').text()).toBe("web");
    expect(groups[0]!.find('[data-test="group-count"]').text()).toBe("2");
    expect(groups[1]!.find('[data-test="group-name"]').text()).toBe("api");
    expect(groups[0]!.findAll('[data-test="session-row"]')).toHaveLength(2);
  });

  it("flat (default) mode renders no group zones", () => {
    const store = useInstancesStore();
    store.instances = [instance([sess("web-claude", "web", "claude")])] as never;
    const w = mountTree();
    expect(w.find('[data-test="session-group"]').exists()).toBe(false);
    expect(w.findAll('[data-test="session-row"]')).toHaveLength(1);
  });

  it("dedups the group name out of the displayed alias but keeps the full name as title", () => {
    const store = useInstancesStore();
    store.setGroupMode("i1", "workspace");
    store.instances = [instance([sess("web-claude", "web", "claude"), sess("standalone", "web", "codex")])] as never;
    const w = mountTree();
    const names = w.findAll('[data-test="session-name"]');
    expect(names[0]!.text()).toBe("claude");
    expect(names[0]!.attributes("title")).toBe("web-claude");
    expect(names[1]!.text()).toBe("standalone"); // no prefix match → untouched
  });

  it("agent mode dedups the trailing agent name and drops the per-row agent icon", () => {
    const store = useInstancesStore();
    store.setGroupMode("i1", "agent");
    store.instances = [instance([sess("web-claude", "web", "claude")])] as never;
    const w = mountTree();
    expect(w.find('[data-test="group-name"]').text()).toBe("claude");
    expect(w.find('[data-test="session-name"]').text()).toBe("web");
    // The row's AgentIcon is dropped in agent mode; the group header carries the brand icon.
    expect(w.find('[data-test="session-row"]').findComponent({ name: "AgentIcon" }).exists()).toBe(false);
  });

  it("collapses and re-expands a group via its header (view-state only)", async () => {
    const store = useInstancesStore();
    store.setGroupMode("i1", "workspace");
    store.instances = [instance([sess("web-claude", "web", "claude"), sess("api-codex", "api", "codex")])] as never;
    const w = mountTree();
    const header = w.findAll('[data-test="group-header"]')[0]!;
    expect(header.attributes("aria-expanded")).toBe("true");
    await header.trigger("click");
    expect(header.attributes("aria-expanded")).toBe("false");
    // v-show: the row stays in the DOM but is hidden.
    const rows = w.findAll('[data-test="session-group"]')[0]!.find('[data-test="session-row"]');
    expect(rows.element.closest("[style*='display: none']")).not.toBeNull();
    await header.trigger("click");
    expect(header.attributes("aria-expanded")).toBe("true");
  });

  it("does not cap grouped session lists (cap is flat-mode only)", () => {
    const store = useInstancesStore();
    store.setGroupMode("i1", "workspace");
    const many = Array.from({ length: 13 }, (_, i) => sess(`s${i}`, "web", "claude"));
    store.instances = [instance(many)] as never;
    const w = mountTree();
    expect(w.findAll('[data-test="session-row"]')).toHaveLength(13);
    expect(w.find('[data-test="sessions-show-more"]').exists()).toBe(false);
  });

  it("hides archived sessions from grouped lists", () => {
    const store = useInstancesStore();
    store.setGroupMode("i1", "workspace");
    store.instances = [instance([sess("web-old", "web", "claude", true), sess("web-live", "web", "claude")])] as never;
    const w = mountTree();
    const names = w.findAll('[data-test="session-name"]');
    expect(names).toHaveLength(1);
    expect(names[0]!.text()).toBe("live");
  });

  it("group ＋ opens the create dialog prefilled with the group's workspace", async () => {
    const store = useInstancesStore();
    store.setGroupMode("i1", "workspace");
    store.instances = [instance([sess("web-claude", "web", "claude")])] as never;
    const w = mountTree();
    await w.find('[data-test="group-new-session"]').trigger("click");
    const dialog = w.findComponent({ name: "NewSessionDialog" });
    expect(dialog.exists()).toBe(true);
    expect(dialog.props("presetWorkspace")).toBe("web");
    expect(dialog.props("presetAgent")).toBeUndefined();
  });

  it("group ＋ prefills the agent in agent mode", async () => {
    const store = useInstancesStore();
    store.setGroupMode("i1", "agent");
    store.instances = [instance([sess("web-claude", "web", "claude")])] as never;
    const w = mountTree();
    await w.find('[data-test="group-new-session"]').trigger("click");
    const dialog = w.findComponent({ name: "NewSessionDialog" });
    expect(dialog.props("presetAgent")).toBe("claude");
    expect(dialog.props("presetWorkspace")).toBeUndefined();
  });

  it("dedups a user-set displayName too (the SHOWN name is what gets deduped)", () => {
    const store = useInstancesStore();
    store.setGroupMode("i1", "workspace");
    store.instances = [instance([{ ...sess("some-alias", "web", "claude"), displayName: "web-notes" }])] as never;
    const w = mountTree();
    const name = w.find('[data-test="session-name"]');
    expect(name.text()).toBe("notes");
    expect(name.attributes("title")).toBe("web-notes"); // title = full shown name, not alias
  });

  it("isolates group collapse per mode (workspace collapse survives an agent-mode detour)", async () => {
    const store = useInstancesStore();
    store.setGroupMode("i1", "workspace");
    store.instances = [instance([sess("web-claude", "web", "claude")])] as never;
    const w = mountTree();
    await w.find('[data-test="group-header"]').trigger("click");
    expect(w.find('[data-test="group-header"]').attributes("aria-expanded")).toBe("false");
    store.setGroupMode("i1", "agent");
    await w.vm.$nextTick();
    // Agent-mode groups start expanded — the workspace collapse doesn't leak across modes.
    expect(w.find('[data-test="group-header"]').attributes("aria-expanded")).toBe("true");
    store.setGroupMode("i1", "workspace");
    await w.vm.$nextTick();
    // Back in workspace mode the in-session collapse is remembered.
    expect(w.find('[data-test="group-header"]').attributes("aria-expanded")).toBe("false");
  });

  it("re-renders live when the mode changes (store reactivity)", async () => {
    const store = useInstancesStore();
    store.instances = [instance([sess("web-claude", "web", "claude")])] as never;
    const w = mountTree();
    expect(w.find('[data-test="session-group"]').exists()).toBe(false);
    store.setGroupMode("i1", "workspace");
    await w.vm.$nextTick();
    expect(w.find('[data-test="session-group"]').exists()).toBe(true);
  });
});

describe("ManageInstanceDialog group-mode control", () => {
  beforeEach(() => setActivePinia(createPinia()));
  afterEach(() => localStorage.clear());

  it("shows the three modes with the current one selected, and persists a change", async () => {
    const store = useInstancesStore();
    store.instances = [instance([])] as never;
    const w = mount(ManageInstanceDialog, {
      props: { instanceId: "i1", instanceName: "pc" },
      global: { stubs: { WorkspacesManager: true, AgentsManager: true, Teleport: true } },
    });
    // onMounted loadFormOptions rejects (no api) → loading flips off; wait for it.
    await new Promise((r) => setTimeout(r));
    await w.vm.$nextTick();
    expect(w.find('[data-test="group-mode-instance"]').attributes("aria-checked")).toBe("true");
    await w.find('[data-test="group-mode-workspace"]').trigger("click");
    expect(w.find('[data-test="group-mode-workspace"]').attributes("aria-checked")).toBe("true");
    expect(store.groupModeFor("i1")).toBe("workspace");
    expect(loadGroupMode("i1")).toBe("workspace");
    w.unmount();
  });
});
