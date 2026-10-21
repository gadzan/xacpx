// packages/relay-web/src/__tests__/manage-instance-terminal-settings.test.ts
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

/** Answer every terminal-settings RPC and record each call. */
function stubTerminal(answers: { get?: unknown; update?: unknown } = {}) {
  const calls: Array<{ type: string; payload: unknown }> = [];
  vi.spyOn(api, "rpc").mockImplementation(async (_id: string, type: string, payload: unknown = {}) => {
    calls.push({ type, payload });
    if (type === "control.terminal.settings.update") return (answers.update ?? { enabled: true, restartRequired: true }) as never;
    if (type.startsWith("control.terminal.settings")) return (answers.get ?? { enabled: false, restartRequired: true }) as never;
    return {} as never;
  });
  return calls;
}

beforeEach(() => setActivePinia(createPinia()));
afterEach(() => {
  vi.restoreAllMocks();
  i18n.global.locale.value = "en";
});

test("the switch reflects the persisted value and keeps the restart hint static", async () => {
  stubTerminal({ get: { enabled: true, restartRequired: true } });
  const w = mountDialog();
  await flushPromises();
  const toggle = w.get('[data-test="terminal-settings-toggle"]');
  expect(toggle.attributes("aria-checked")).toBe("true");
  expect(w.get('[data-test="terminal-restart-required"]').text()).toBe(
    i18n.global.t("instance.terminalSettingsRestart"),
  );
});

test("a toggle writes { enabled } and converges on the daemon answer", async () => {
  const calls = stubTerminal({ get: { enabled: false, restartRequired: true } });
  const w = mountDialog();
  await flushPromises();
  await w.get('[data-test="terminal-settings-toggle"]').trigger("click");
  await flushPromises();
  expect(calls.filter((call) => call.type === "control.terminal.settings.update")).toEqual([
    { type: "control.terminal.settings.update", payload: { enabled: true } },
  ]);
  expect(w.get('[data-test="terminal-settings-toggle"]').attributes("aria-checked")).toBe("true");
});

test("an older connector and an older daemon both render the upgrade notice", async () => {
  for (const payload of [
    { error: { code: "unknown-type", message: "unsupported rpc type: control.terminal.settings.get" } },
    { error: { code: "unsupported", message: "Relay terminal settings require a newer daemon" } },
  ]) {
    setActivePinia(createPinia());
    stubTerminal({ get: payload });
    const w = mountDialog();
    await flushPromises();
    expect(w.find('[data-test="terminal-settings-toggle"]').exists()).toBe(false);
    expect(w.get('[data-test="terminal-settings-status"]').text()).toBe(
      i18n.global.t("instance.terminalSettingsUpgradeNotice"),
    );
    w.unmount();
  }
});

test("a genuine read failure renders its own copy, not the upgrade notice", async () => {
  stubTerminal({ get: { error: { code: "timeout", message: "request timed out" } } });
  const w = mountDialog();
  await flushPromises();
  expect(w.find('[data-test="terminal-settings-toggle"]').exists()).toBe(false);
  expect(w.get('[data-test="terminal-settings-status"]').text()).toBe(
    i18n.global.t("instance.terminalSettingsReadFailed"),
  );
});

test("a rejected write keeps the previous value and stays flippable", async () => {
  stubTerminal({
    get: { enabled: false, restartRequired: true },
    update: { error: { code: "invalid-config", message: "channels must be an array" } },
  });
  const w = mountDialog();
  await flushPromises();
  await w.get('[data-test="terminal-settings-toggle"]').trigger("click");
  await flushPromises();
  expect(w.get('[data-test="terminal-settings-toggle"]').attributes("aria-checked")).toBe("false");
  expect(w.get('[data-test="terminal-settings-error"]').text()).toBe("channels must be an array");
  expect(w.get('[data-test="terminal-settings-toggle"]').attributes("disabled")).toBeUndefined();
});

test("reopening the dialog re-reads instead of serving the stale cache", async () => {
  let enabled = false;
  vi.spyOn(api, "rpc").mockImplementation(async (_id: string, type: string, payload: unknown = {}) => {
    if (type === "control.terminal.settings.get") return { enabled, restartRequired: true } as never;
    if (type === "control.terminal.settings.update") return { enabled: true, restartRequired: true } as never;
    return {} as never;
  });
  const first = mountDialog();
  await flushPromises();
  expect(first.get('[data-test="terminal-settings-toggle"]').attributes("aria-checked")).toBe("false");
  enabled = true;
  first.unmount();
  const second = mountDialog();
  await flushPromises();
  expect(second.get('[data-test="terminal-settings-toggle"]').attributes("aria-checked")).toBe("true");
});
