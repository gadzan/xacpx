// packages/relay-web/src/__tests__/manage-instance-router.test.ts
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import ManageInstanceDialog from "../components/ManageInstanceDialog.vue";
import { useInstancesStore } from "../stores/instances";
import { api } from "../api/client";
import { i18n } from "../i18n";

const READY = { status: "ready", configPath: "conversations.router" };
const DISABLED = {
  status: "disabled-by-config",
  configPath: "conversations.router",
  reason: { code: "disabled", message: "Automatic collaboration is off." },
};
const UNSUPPORTED = {
  status: "unsupported",
  configPath: "conversations.router",
  reason: { code: "not-advertised", message: "This instance does not advertise automatic collaboration." },
};
const COMMAND_MISSING = {
  status: "failed",
  configPath: "conversations.router",
  reason: { code: "command-missing", message: "conversations.router.command is missing." },
};

const unavailableText = (reason: string) =>
  i18n.global.t("instance.autoCollabUnavailable", { reason, path: "conversations.router" });

/** Answer every router RPC from `state` and record each call. `state.update` may be
 *  an `{error:{code}}` payload to exercise the older-daemon fallback; mutate the
 *  object between steps to change what the daemon answers next. */
function stubRouter(state: { update: unknown; get?: unknown }) {
  const calls: Array<{ type: string; payload: unknown }> = [];
  vi.spyOn(api, "rpc").mockImplementation(async (_id: string, type: string, payload: unknown = {}) => {
    calls.push({ type, payload });
    if (type === "control.conversations.router.get") return (state.get ?? state.update) as never;
    return state.update as never;
  });
  return calls;
}

const writes = (calls: Array<{ type: string; payload: unknown }>) =>
  calls.filter((call) => call.type === "control.conversations.router.update");

/** Mount the dialog with the panel read held open, so the loading phase is
 *  observable. `answer` lands when the returned `release` runs. */
function mountWithPendingPanel(answer: unknown, online = true) {
  const calls: Array<{ type: string; payload: unknown }> = [];
  let release: (value: unknown) => void = () => {};
  const pending = new Promise<unknown>((resolve) => {
    release = resolve;
  });
  let answered = false;
  vi.spyOn(api, "rpc").mockImplementation(async (_id: string, type: string, payload: unknown = {}) => {
    calls.push({ type, payload });
    if (answered) return answer as never;
    answered = true;
    return (await pending) as never;
  });
  const mounted = mountDialog(online);
  return { ...mounted, calls, release: () => release(answer) };
}

function mountDialog(online = true) {
  const store = useInstancesStore();
  store.instances = [{
    id: "i1", name: "pc", online, lastSeenAt: null, sessions: [], sessionsLoaded: true,
    agents: [], workspaces: [], agentCatalog: [],
  }];
  // The panel read is the behaviour under test; the form options and the child
  // managers are stubbed so the dialog leaves its loading state without a network.
  vi.spyOn(store, "loadFormOptions").mockResolvedValue(undefined as never);
  const w = mount(ManageInstanceDialog, {
    props: { instanceId: "i1", instanceName: "pc" },
    global: { stubs: { WorkspacesManager: true, AgentsManager: true, Teleport: true } },
  });
  return { store, w };
}

beforeEach(() => setActivePinia(createPinia()));
afterEach(() => {
  vi.restoreAllMocks();
  i18n.global.locale.value = "en";
});

test("the status line reports each of the four availability statuses", async () => {
  const cases = [
    { availability: READY, config: { enabled: true }, expected: i18n.global.t("instance.autoCollabOn") },
    { availability: DISABLED, config: { enabled: false }, expected: i18n.global.t("instance.autoCollabOff") },
    {
      availability: UNSUPPORTED,
      config: { enabled: false },
      expected: unavailableText(UNSUPPORTED.reason.message),
    },
    {
      availability: COMMAND_MISSING,
      config: { enabled: true },
      expected: unavailableText(COMMAND_MISSING.reason.message),
    },
  ];
  for (const c of cases) {
    setActivePinia(createPinia());
    const { w, release } = mountWithPendingPanel({ availability: c.availability, config: c.config });
    await flushPromises();
    expect(w.get('[data-test="router-status"]').text()).toBe(i18n.global.t("instance.autoCollabChecking"));
    release();
    await flushPromises();
    expect(w.get('[data-test="router-status"]').text()).toBe(c.expected);
    w.unmount();
  }
});

test("a command-missing failure shows the reason and keeps the form enabled", async () => {
  stubRouter({ update: { availability: COMMAND_MISSING, config: { enabled: true } } });
  const { w } = mountDialog();
  await flushPromises();
  const status = w.get('[data-test="router-status"]').text();
  expect(status).toContain(COMMAND_MISSING.reason.message);
  expect(status).toContain(COMMAND_MISSING.configPath);
  expect(w.get('[data-test="router-toggle"]').attributes("disabled")).toBeUndefined();
  expect(w.get('[data-test="router-command"]').attributes("disabled")).toBeUndefined();
  expect(w.get('[data-test="router-auth-env"]').attributes("disabled")).toBeUndefined();
});

test("typing a command and saving sends only that key and the status becomes On", async () => {
  const state: { update: unknown } = { update: { availability: COMMAND_MISSING, config: { enabled: true } } };
  const calls = stubRouter(state);
  const { w } = mountDialog();
  await flushPromises();

  await w.get('[data-test="router-command"]').setValue("/usr/bin/router");
  state.update = { availability: READY, config: { enabled: true, command: "/usr/bin/router" } };
  await w.get('[data-test="router-save"]').trigger("click");
  await flushPromises();

  expect(writes(calls).at(-1)).toEqual({
    type: "control.conversations.router.update",
    payload: { command: "/usr/bin/router" },
  });
  expect(w.get('[data-test="router-status"]').text()).toBe(i18n.global.t("instance.autoCollabOn"));
  // The answered config matches the draft, so the form is clean again.
  expect((w.get('[data-test="router-command"]').element as HTMLInputElement).value).toBe("/usr/bin/router");
  expect(w.get('[data-test="router-save"]').attributes("disabled")).toBeDefined();
});

test("a form the user never touched sends nothing", async () => {
  const calls = stubRouter({
    update: {
      availability: DISABLED,
      config: { enabled: false, command: "/usr/bin/router", authEnv: "ROUTER_TOKEN" },
    },
  });
  const { w } = mountDialog();
  await flushPromises();
  expect((w.get('[data-test="router-command"]').element as HTMLInputElement).value).toBe("/usr/bin/router");
  expect((w.get('[data-test="router-auth-env"]').element as HTMLInputElement).value).toBe("ROUTER_TOKEN");
  expect(w.get('[data-test="router-save"]').attributes("disabled")).toBeDefined();
  expect(writes(calls)).toEqual([{ type: "control.conversations.router.update", payload: {} }]);
});

test("an unknown-type answer renders the upgrade notice and no form", async () => {
  stubRouter({
    update: { error: { code: "unknown-type", message: "unsupported rpc type: control.conversations.router.update" } },
    get: READY,
  });
  const { w } = mountDialog();
  await flushPromises();
  expect(w.find('[data-test="router-command"]').exists()).toBe(false);
  expect(w.find('[data-test="router-auth-env"]').exists()).toBe(false);
  expect(w.find('[data-test="router-toggle"]').exists()).toBe(false);
  expect(w.find('[data-test="router-save"]').exists()).toBe(false);
  expect(w.get('[data-test="router-hint"]').text()).toBe(i18n.global.t("instance.autoCollabUpgradeNotice"));
  // The fallback `.get` still reports the real availability.
  expect(w.get('[data-test="router-status"]').text()).toBe(i18n.global.t("instance.autoCollabOn"));
});

test("a failed save shows the daemon's message verbatim and keeps the draft", async () => {
  const state: { update: unknown } = { update: { availability: COMMAND_MISSING, config: { enabled: true } } };
  stubRouter(state);
  const { w } = mountDialog();
  await flushPromises();

  await w.get('[data-test="router-command"]').setValue("/nope/router");
  state.update = {
    error: { code: "invalid-config", message: "conversations.router.command must be a command path" },
  };
  await w.get('[data-test="router-save"]').trigger("click");
  await flushPromises();

  expect(w.get('[data-test="router-error"]').text()).toBe("conversations.router.command must be a command path");
  expect((w.get('[data-test="router-command"]').element as HTMLInputElement).value).toBe("/nope/router");
  expect(w.get('[data-test="router-save"]').attributes("disabled")).toBeUndefined();
  expect(w.get('[data-test="router-toggle"]').attributes("disabled")).toBeUndefined();
});

test("the switch writes { enabled } through the same RPC as the form", async () => {
  const state: { update: unknown } = { update: { availability: READY, config: { enabled: true } } };
  const calls = stubRouter(state);
  const { w } = mountDialog();
  await flushPromises();
  expect(w.get('[data-test="router-toggle"]').text()).toBe(i18n.global.t("instance.autoCollabDisable"));

  state.update = { availability: DISABLED, config: { enabled: false } };
  await w.get('[data-test="router-toggle"]').trigger("click");
  await flushPromises();

  expect(writes(calls).at(-1)).toEqual({
    type: "control.conversations.router.update",
    payload: { enabled: false },
  });
  expect(w.get('[data-test="router-toggle"]').text()).toBe(i18n.global.t("instance.autoCollabEnable"));
  expect(w.get('[data-test="router-status"]').text()).toBe(i18n.global.t("instance.autoCollabOff"));
});

test("an offline instance cannot flip the switch", async () => {
  const calls = stubRouter({ update: { availability: DISABLED, config: { enabled: false } } });
  const { w } = mountDialog(false);
  await flushPromises();
  const toggle = w.get('[data-test="router-toggle"]');
  expect(toggle.attributes("disabled")).toBeDefined();
  await toggle.trigger("click");
  await flushPromises();
  expect(writes(calls)).toEqual([{ type: "control.conversations.router.update", payload: {} }]);
});
