import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import ManageInstanceDialog from "../components/ManageInstanceDialog.vue";
import { useInstancesStore } from "../stores/instances";
import { i18n } from "../i18n";

beforeEach(() => setActivePinia(createPinia()));
afterEach(() => { i18n.global.locale.value = "en"; });

function mountDialog() {
  const store = useInstancesStore();
  store.instances = [{
    id: "i1", name: "old", online: true, lastSeenAt: null, sessions: [], sessionsLoaded: true,
    agents: [], workspaces: [], agentCatalog: [],
  }];
  // loadFormOptions runs onMounted; stub it so the dialog leaves its loading state
  // without hitting the network, and stub the child managers to isolate the dialog.
  vi.spyOn(store, "loadFormOptions").mockResolvedValue(undefined as never);
  const rename = vi.spyOn(store, "renameInstance").mockResolvedValue(undefined as never);
  const w = mount(ManageInstanceDialog, {
    props: { instanceId: "i1", instanceName: "old" },
    global: {
      stubs: { WorkspacesManager: true, AgentsManager: true, Teleport: true },
    },
  });
  return { store, rename, w };
}

test("typing a new name and clicking Save calls renameInstance with the trimmed value", async () => {
  const { rename, w } = mountDialog();
  await flushPromises(); // let onMounted's loadFormOptions settle → render body
  await w.get('[data-test="rename-name"]').setValue("  fresh name  ");
  await w.get('[data-test="rename-save"]').trigger("click");
  await flushPromises();
  expect(rename).toHaveBeenCalledWith("i1", "fresh name");
});

test("the header reflects the updated name after a successful save", async () => {
  const { w } = mountDialog();
  await flushPromises();
  await w.get('[data-test="rename-name"]').setValue("renamed-live");
  await w.get('[data-test="rename-save"]').trigger("click");
  await flushPromises();
  expect(w.get('[data-test="manage-instance-dialog"]').find("h2").text()).toContain("renamed-live");
});

test("Save is disabled for an empty name and does not call renameInstance", async () => {
  const { rename, w } = mountDialog();
  await flushPromises();
  await w.get('[data-test="rename-name"]').setValue("   ");
  expect((w.get('[data-test="rename-save"]').element as HTMLButtonElement).disabled).toBe(true);
  await w.get('[data-test="rename-save"]').trigger("click");
  await flushPromises();
  expect(rename).not.toHaveBeenCalled();
});

test("renders the Save affordance in Chinese when locale is zh-CN", async () => {
  i18n.global.locale.value = "zh-CN";
  const { w } = mountDialog();
  await flushPromises();
  expect(w.get('[data-test="rename-save"]').text()).toBe("保存");
});

test("tabs switch between the general and agents panes", async () => {
  const { w } = mountDialog();
  await flushPromises();
  expect(w.find('[data-test="rename-name"]').exists()).toBe(true); // general is default
  await w.get('[data-test="tab-agents"]').trigger("click");
  expect(w.find('[data-test="rename-name"]').exists()).toBe(false); // general pane unmounted
  await w.get('[data-test="tab-general"]').trigger("click");
  expect(w.find('[data-test="rename-name"]').exists()).toBe(true);
});

test("the active pane is a labelled tabpanel and arrow keys move tab selection", async () => {
  const { w } = mountDialog();
  await flushPromises();
  // The default (general) pane is a tabpanel labelled by its tab.
  const panel = w.get("#tabpanel-general");
  expect(panel.attributes("role")).toBe("tabpanel");
  expect(panel.attributes("aria-labelledby")).toBe("tab-general");
  expect(w.get('[data-test="tab-general"]').attributes("aria-controls")).toBe("tabpanel-general");
  // Roving tabindex: only the selected tab is in the tab order.
  expect(w.get('[data-test="tab-general"]').attributes("tabindex")).toBe("0");
  expect(w.get('[data-test="tab-workspaces"]').attributes("tabindex")).toBe("-1");
  // ArrowRight on the tablist advances selection to the next tab.
  await w.get('[role="tablist"]').trigger("keydown", { key: "ArrowRight" });
  expect(w.get('[data-test="tab-workspaces"]').attributes("aria-selected")).toBe("true");
  expect(w.find('[data-test="rename-name"]').exists()).toBe(false); // general pane unmounted
  // ArrowLeft wraps back to general.
  await w.get('[role="tablist"]').trigger("keydown", { key: "ArrowLeft" });
  expect(w.get('[data-test="tab-general"]').attributes("aria-selected")).toBe("true");
});

test("Escape closes the dialog", async () => {
  const { w } = mountDialog();
  await flushPromises();
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  expect(w.emitted("close")).toBeTruthy();
});

test("shows the instance version row from the store's coreVersion", async () => {
  const store = useInstancesStore();
  store.instances = [{
    id: "i1", name: "old", online: true, lastSeenAt: null, coreVersion: "0.13.0",
    sessions: [], sessionsLoaded: true, agents: [], workspaces: [], agentCatalog: [],
  }];
  vi.spyOn(store, "loadFormOptions").mockResolvedValue(undefined as never);
  const w = mount(ManageInstanceDialog, {
    props: { instanceId: "i1", instanceName: "old" },
    global: { stubs: { WorkspacesManager: true, AgentsManager: true, Teleport: true } },
  });
  await flushPromises();
  expect(w.get('[data-test="instance-version"]').text()).toContain("0.13.0");
});

test("shows the unknown-version fallback when coreVersion is null", async () => {
  const store = useInstancesStore();
  store.instances = [{
    id: "i1", name: "old", online: true, lastSeenAt: null, coreVersion: null,
    sessions: [], sessionsLoaded: true, agents: [], workspaces: [], agentCatalog: [],
  }];
  vi.spyOn(store, "loadFormOptions").mockResolvedValue(undefined as never);
  const w = mount(ManageInstanceDialog, {
    props: { instanceId: "i1", instanceName: "old" },
    global: { stubs: { WorkspacesManager: true, AgentsManager: true, Teleport: true } },
  });
  await flushPromises();
  expect(w.get('[data-test="instance-version"]').text().length).toBeGreaterThan(0);
});
