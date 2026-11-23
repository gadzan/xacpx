// packages/relay-web/src/__tests__/manage-instance-files-settings.test.ts
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import ManageInstanceDialog from "../components/ManageInstanceDialog.vue";
import { useInstancesStore } from "../stores/instances";
import { api } from "../api/client";
import { i18n } from "../i18n";

function mountDialog(online = true) {
  const store = useInstancesStore();
  store.instances = [{
    id: "i1", name: "pc", online, lastSeenAt: null, sessions: [], sessionsLoaded: true,
    agents: [], workspaces: [], agentCatalog: [],
  }];
  vi.spyOn(store, "loadFormOptions").mockResolvedValue(undefined as never);
  return mount(ManageInstanceDialog, {
    props: { instanceId: "i1", instanceName: "pc" },
    global: { stubs: { WorkspacesManager: true, AgentsManager: true, Teleport: true } },
  });
}

/** Answer every files-settings RPC and record each call. */
function stubFiles(answers: { get?: unknown; update?: unknown } = {}) {
  const calls: Array<{ type: string; payload: unknown }> = [];
  vi.spyOn(api, "rpc").mockImplementation(async (_id: string, type: string, payload: unknown = {}) => {
    calls.push({ type, payload });
    if (type === "control.files.settings.update") return (answers.update ?? { enabled: true, restartRequired: false }) as never;
    if (type.startsWith("control.files.settings")) return (answers.get ?? { enabled: false, restartRequired: false }) as never;
    return {} as never;
  });
  return calls;
}

beforeEach(() => setActivePinia(createPinia()));
afterEach(() => {
  vi.restoreAllMocks();
  i18n.global.locale.value = "en";
});

test("the switch reflects the persisted value and claims no restart", async () => {
  stubFiles({ get: { enabled: true, restartRequired: false } });
  const w = mountDialog();
  await flushPromises();
  expect(w.get('[data-test="files-settings-toggle"]').attributes("aria-checked")).toBe("true");
  expect(w.get('[data-test="files-settings-status"]').text()).toBe(i18n.global.t("instance.autoCollabOn"));
  // The hint says it takes effect immediately; there is deliberately no
  // restart-required line, unlike the terminal panel.
  expect(w.get('[data-test="files-settings-hint"]').text()).toBe(i18n.global.t("instance.filesSettingsHint"));
  expect(w.find('[data-test="files-settings-restart"]').exists()).toBe(false);
});

test("a toggle writes { enabled } and converges on the daemon answer", async () => {
  const calls = stubFiles({ get: { enabled: false, restartRequired: false } });
  const w = mountDialog();
  await flushPromises();
  await w.get('[data-test="files-settings-toggle"]').trigger("click");
  await flushPromises();
  expect(calls.filter((call) => call.type === "control.files.settings.update")).toEqual([
    { type: "control.files.settings.update", payload: { enabled: true } },
  ]);
  expect(w.get('[data-test="files-settings-toggle"]').attributes("aria-checked")).toBe("true");
});

test("an older connector and an older daemon both render the upgrade notice", async () => {
  for (const payload of [
    { error: { code: "unknown-type", message: "unsupported rpc type: control.files.settings.get" } },
    { error: { code: "unsupported", message: "File write settings require a newer daemon" } },
  ]) {
    setActivePinia(createPinia());
    stubFiles({ get: payload });
    const w = mountDialog();
    await flushPromises();
    expect(w.find('[data-test="files-settings-toggle"]').exists()).toBe(false);
    expect(w.get('[data-test="files-settings-status"]').text()).toBe(
      i18n.global.t("instance.filesSettingsUpgradeNotice"),
    );
    w.unmount();
  }
});

test("a genuine read failure renders its own copy, not the upgrade notice", async () => {
  stubFiles({ get: { error: { code: "timeout", message: "request timed out" } } });
  const w = mountDialog();
  await flushPromises();
  expect(w.find('[data-test="files-settings-toggle"]').exists()).toBe(false);
  expect(w.get('[data-test="files-settings-status"]').text()).toBe(
    i18n.global.t("instance.filesSettingsReadFailed"),
  );
});

test("a rejected write keeps the previous value and stays flippable", async () => {
  stubFiles({
    get: { enabled: false, restartRequired: false },
    update: { error: { code: "read-failed", message: "config.json is not valid JSON" } },
  });
  const w = mountDialog();
  await flushPromises();
  await w.get('[data-test="files-settings-toggle"]').trigger("click");
  await flushPromises();
  expect(w.get('[data-test="files-settings-toggle"]').attributes("aria-checked")).toBe("false");
  expect(w.get('[data-test="files-settings-error"]').text()).toBe("config.json is not valid JSON");
  expect(w.get('[data-test="files-settings-toggle"]').attributes("disabled")).toBeUndefined();
});

test("an offline instance cannot be flipped", async () => {
  stubFiles({ get: { enabled: false, restartRequired: false } });
  const w = mountDialog(false);
  await flushPromises();
  expect(w.get('[data-test="files-settings-toggle"]').attributes("disabled")).toBeDefined();
});

test("reopening the dialog re-reads instead of serving the stale cache", async () => {
  let enabled = false;
  vi.spyOn(api, "rpc").mockImplementation(async (_id: string, type: string) => {
    if (type === "control.files.settings.get") return { enabled, restartRequired: false } as never;
    if (type === "control.files.settings.update") return { enabled: true, restartRequired: false } as never;
    return {} as never;
  });
  const first = mountDialog();
  await flushPromises();
  expect(first.get('[data-test="files-settings-toggle"]').attributes("aria-checked")).toBe("false");
  enabled = true;
  first.unmount();
  const second = mountDialog();
  await flushPromises();
  expect(second.get('[data-test="files-settings-toggle"]').attributes("aria-checked")).toBe("true");
});
