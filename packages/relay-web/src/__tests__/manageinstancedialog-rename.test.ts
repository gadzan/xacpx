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
