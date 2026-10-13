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
const PROBE_FAILED = {
  status: "failed",
  configPath: "conversations.router",
  reason: { code: "command-missing", message: "conversations.router.command is missing." },
};

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

test("the status line maps every availability status to one line of copy", async () => {
  const cases = [
    { availability: READY, config: { enabled: true }, expected: i18n.global.t("instance.autoCollabOn") },
    { availability: DISABLED, config: { enabled: false }, expected: i18n.global.t("instance.autoCollabOff") },
    {
      availability: UNSUPPORTED,
      config: { enabled: false },
      expected: i18n.global.t("instance.autoCollabFailed"),
    },
    {
      availability: PROBE_FAILED,
      config: { enabled: true },
      expected: i18n.global.t("instance.autoCollabFailed"),
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

test("the control is a switch bound to the persisted config, with no config fields", async () => {
  stubRouter({ update: { availability: DISABLED, config: { enabled: false } } });
  const { w } = mountDialog();
  await flushPromises();
  const toggle = w.get('[data-test="router-toggle"]');
  expect(toggle.attributes("role")).toBe("switch");
  expect(toggle.attributes("aria-checked")).toBe("false");
  // Track + thumb: the one child is the thumb, so the control reads as a switch
  // rather than a labelled button.
  expect(toggle.element.childElementCount).toBe(1);
  expect(w.find('[data-test="router-command"]').exists()).toBe(false);
  expect(w.find('[data-test="router-auth-env"]').exists()).toBe(false);
  expect(w.find('[data-test="router-save"]').exists()).toBe(false);
});

test("a failed probe shows no config path and no daemon reason", async () => {
  stubRouter({ update: { availability: PROBE_FAILED, config: { enabled: true } } });
  const { w } = mountDialog();
  await flushPromises();
  const status = w.get('[data-test="router-status"]').text();
  expect(status).toBe(i18n.global.t("instance.autoCollabFailed"));
  expect(status).not.toContain(PROBE_FAILED.configPath);
  expect(status).not.toContain(PROBE_FAILED.reason.message);
  // A failed probe is not a reason to lock the feature: the switch stays usable.
  expect(w.get('[data-test="router-toggle"]').attributes("disabled")).toBeUndefined();
});

test("the switch writes { enabled } through the router update RPC", async () => {
  const state: { update: unknown } = { update: { availability: READY, config: { enabled: true } } };
  const calls = stubRouter(state);
  const { w } = mountDialog();
  await flushPromises();
  expect(w.get('[data-test="router-toggle"]').attributes("aria-checked")).toBe("true");

  state.update = { availability: DISABLED, config: { enabled: false } };
  await w.get('[data-test="router-toggle"]').trigger("click");
  await flushPromises();

  expect(writes(calls).at(-1)).toEqual({
    type: "control.conversations.router.update",
    payload: { enabled: false },
  });
  expect(w.get('[data-test="router-toggle"]').attributes("aria-checked")).toBe("false");
  expect(w.get('[data-test="router-status"]').text()).toBe(i18n.global.t("instance.autoCollabOff"));
});

test("a rejected toggle shows the daemon's message and leaves the switch flippable", async () => {
  const state: { update: unknown } = { update: { availability: DISABLED, config: { enabled: false } } };
  stubRouter(state);
  const { w } = mountDialog();
  await flushPromises();

  state.update = {
    error: { code: "invalid-config", message: "conversations.router.command must be a command path" },
  };
  await w.get('[data-test="router-toggle"]').trigger("click");
  await flushPromises();

  expect(w.get('[data-test="router-error"]').text()).toBe("conversations.router.command must be a command path");
  // The rejected write leaves the last known state in place: still off, still enabled.
  expect(w.get('[data-test="router-toggle"]').attributes("aria-checked")).toBe("false");
  expect(w.get('[data-test="router-toggle"]').attributes("disabled")).toBeUndefined();
});

test("an unknown-type answer renders the upgrade notice and no switch", async () => {
  stubRouter({
    update: { error: { code: "unknown-type", message: "unsupported rpc type: control.conversations.router.update" } },
    get: READY,
  });
  const { w } = mountDialog();
  await flushPromises();
  expect(w.find('[data-test="router-toggle"]').exists()).toBe(false);
  expect(w.get('[data-test="router-hint"]').text()).toBe(i18n.global.t("instance.autoCollabUpgradeNotice"));
  // The fallback `.get` still reports the real availability.
  expect(w.get('[data-test="router-status"]').text()).toBe(i18n.global.t("instance.autoCollabOn"));
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
