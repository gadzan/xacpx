import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import WorkspacesManager from "../components/WorkspacesManager.vue";
import AgentsManager from "../components/AgentsManager.vue";
import { useInstancesStore } from "../stores/instances";
import { settleConfirm, useConfirmState } from "../lib/use-confirm";
import { i18n } from "../i18n";

beforeEach(() => setActivePinia(createPinia()));
afterEach(() => { settleConfirm(false); i18n.global.locale.value = "en"; });

function seed(store: ReturnType<typeof useInstancesStore>) {
  store.instances = [{
    id: "i1", name: "n", online: true, sessions: [],
    agents: [{ name: "codex", driver: "codex" }],
    workspaces: [{ name: "backend", cwd: "/b", description: "" }],
    agentCatalog: [
      { driver: "codex", configured: true, installed: "builtin" },
      { driver: "gemini", configured: false, installed: "yes" },
    ],
  }] as never;
}

test("WorkspacesManager creates a workspace", async () => {
  const store = useInstancesStore(); seed(store);
  const createWorkspace = vi.spyOn(store, "createWorkspace").mockResolvedValue(undefined as never);
  const w = mount(WorkspacesManager, { props: { instanceId: "i1" } });
  await w.get('[data-test="wm-add-toggle"]').trigger("click");
  await w.get('[data-test="wm-name"]').setValue("frontend");
  await w.get('[data-test="wm-path"]').setValue("/f");
  await w.get('[data-test="wm-create"]').trigger("click");
  expect(createWorkspace).toHaveBeenCalledWith("i1", "frontend", "/f", undefined);
});

test("WorkspacesManager surfaces a remove-in-use error", async () => {
  const store = useInstancesStore(); seed(store);
  vi.spyOn(store, "removeWorkspace").mockRejectedValue(new Error("workspace \"backend\" is in use by an existing session"));
  const w = mount(WorkspacesManager, { props: { instanceId: "i1" } });
  await w.get('[data-test="wm-remove-backend"]').trigger("click");
  expect(useConfirmState().value?.title).toBe("Remove workspace?");
  settleConfirm(true); // confirm the popup
  await flushPromises();
  expect(w.get('[data-test="wm-error"]').text()).toMatch(/in use/);
});

test("WorkspacesManager resets its inputs after a successful create", async () => {
  const store = useInstancesStore(); seed(store);
  vi.spyOn(store, "createWorkspace").mockResolvedValue(undefined as never);
  const w = mount(WorkspacesManager, { props: { instanceId: "i1" } });
  await w.get('[data-test="wm-add-toggle"]').trigger("click");
  await w.get('[data-test="wm-name"]').setValue("frontend");
  await w.get('[data-test="wm-path"]').setValue("/f");
  await w.get('[data-test="wm-desc"]').setValue("the frontend");
  await w.get('[data-test="wm-create"]').trigger("click");
  await flushPromises();
  expect((w.get('[data-test="wm-name"]').element as HTMLInputElement).value).toBe("");
  expect((w.get('[data-test="wm-path"]').element as HTMLInputElement).value).toBe("");
  expect((w.get('[data-test="wm-desc"]').element as HTMLInputElement).value).toBe("");
});

test("AgentsManager adds an agent from the catalog driver picker", async () => {
  const store = useInstancesStore(); seed(store);
  const createAgent = vi.spyOn(store, "createAgent").mockResolvedValue(undefined as never);
  const w = mount(AgentsManager, { props: { instanceId: "i1" } });
  await w.get('[data-test="am-add-toggle"]').trigger("click");
  await w.get('[data-test="am-driver"]').setValue("gemini");
  await w.get('[data-test="am-add"]').trigger("click");
  expect(createAgent).toHaveBeenCalledWith("i1", "gemini", "gemini");
});

test("AgentsManager removes a configured agent", async () => {
  const store = useInstancesStore(); seed(store);
  const removeAgent = vi.spyOn(store, "removeAgent").mockResolvedValue(undefined as never);
  const w = mount(AgentsManager, { props: { instanceId: "i1" } });
  await w.get('[data-test="am-remove-codex"]').trigger("click");
  expect(removeAgent).not.toHaveBeenCalled(); // awaits popup confirm first
  settleConfirm(true);
  await flushPromises();
  expect(removeAgent).toHaveBeenCalledWith("i1", "codex");
});

test("AgentsManager does not remove when the confirm is cancelled", async () => {
  const store = useInstancesStore(); seed(store);
  const removeAgent = vi.spyOn(store, "removeAgent").mockResolvedValue(undefined as never);
  const w = mount(AgentsManager, { props: { instanceId: "i1" } });
  await w.get('[data-test="am-remove-codex"]').trigger("click");
  settleConfirm(false);
  await flushPromises();
  expect(removeAgent).not.toHaveBeenCalled();
});

test("managers render Chinese affordances when locale is zh-CN", async () => {
  i18n.global.locale.value = "zh-CN";
  const store = useInstancesStore(); seed(store);
  const wm = mount(WorkspacesManager, { props: { instanceId: "i1" } });
  expect(wm.get('[data-test="wm-add-toggle"]').text()).toBe("添加工作区");
  const am = mount(AgentsManager, { props: { instanceId: "i1" } });
  expect(am.get('[data-test="am-add-toggle"]').text()).toBe("添加 Agent");
});
