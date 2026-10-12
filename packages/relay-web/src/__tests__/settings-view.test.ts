// packages/relay-web/src/__tests__/settings-view.test.ts
import { setActivePinia, createPinia } from "pinia";
import { beforeEach, expect, test, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";

// SettingsView is a standalone route: stub the router instead of building one.
vi.mock("vue-router", () => ({ useRouter: () => ({ push: vi.fn() }) }));
// The desktop-notification probe is unrelated to the switch and touches
// service-worker APIs jsdom does not implement; stub the push surface.
vi.mock("../lib/web-push", () => ({
  pushSupported: () => false,
  fetchVapidPublicKey: async () => null,
  enableDesktopNotifications: async () => {},
  disableDesktopNotifications: async () => {},
  subscriptionMatchesKey: () => false,
  getExistingSubscription: async () => null,
  isDesktopNotificationsEnabled: () => false,
}));

import SettingsView from "../views/SettingsView.vue";
import { useInstancesStore } from "../stores/instances";
import { i18n } from "../i18n";

const READY = { status: "ready", configPath: "conversations.router" };
const DISABLED = {
  status: "disabled-by-config",
  configPath: "conversations.router",
  reason: { code: "disabled", message: "Automatic collaboration is off." },
};

/** Route hub HTTP + control RPCs. `get` answers the availability read the
 *  settings page performs on mount; `set` answers the switch. Returns the
 *  recorded RPC calls. */
function stubBackend(input: { get: unknown; set: unknown; online?: boolean }) {
  const calls: Array<{ type: string; payload: unknown }> = [];
  vi.stubGlobal("fetch", vi.fn(async (req: RequestInfo, init?: { body?: string }) => {
    const url = typeof req === "string" ? req : String(req);
    if (!url.includes("/rpc")) {
      const online = input.online ?? true;
      return new Response(JSON.stringify({
        instances: [{ id: "i1", name: "pc", online, lastSeenAt: null }],
      }), { status: 200 });
    }
    const body = JSON.parse(init?.body ?? "{}") as { type: string; payload: unknown };
    calls.push(body);
    const result = body.type === "control.conversations.router.get" ? input.get : input.set;
    return new Response(JSON.stringify({ result }), { status: 200 });
  }));
  return calls;
}

const setCalls = (calls: Array<{ type: string; payload: unknown }>) =>
  calls.filter((call) => call.type === "control.conversations.router.set");

function seedInstance(online = true) {
  const store = useInstancesStore();
  store.instances = [
    {
      id: "i1", name: "pc", online, lastSeenAt: null, sessions: [],
      agents: [], workspaces: [], agentCatalog: [],
    } as never,
  ];
  return store;
}

beforeEach(() => setActivePinia(createPinia()));

test("the section offers the switch and shows the instance's current state", async () => {
  stubBackend({ get: DISABLED, set: READY });
  seedInstance();
  const wrapper = mount(SettingsView, { global: { stubs: { "router-link": true } } });
  await flushPromises();
  const row = wrapper.find('[data-test="auto-collab-row-i1"]');
  expect(row.find('[data-test="auto-collab-state"]').text()).toBe(i18n.global.t("settings.autoCollabOff"));
  expect(row.find('[data-test="auto-collab-toggle"]').text()).toBe(i18n.global.t("settings.autoCollabEnable"));
  expect(row.find('[data-test="auto-collab-toggle"]').attributes("disabled")).toBeUndefined();
});

test("a ready answer switches the row from off to on", async () => {
  const calls = stubBackend({ get: DISABLED, set: READY });
  seedInstance();
  const wrapper = mount(SettingsView, { global: { stubs: { "router-link": true } } });
  await flushPromises();
  const row = wrapper.find('[data-test="auto-collab-row-i1"]');

  await row.find('[data-test="auto-collab-toggle"]').trigger("click");
  await flushPromises();
  expect(setCalls(calls)).toEqual([{ type: "control.conversations.router.set", payload: { enabled: true } }]);
  expect(row.find('[data-test="auto-collab-state"]').text()).toBe(i18n.global.t("settings.autoCollabOn"));
  expect(row.find('[data-test="auto-collab-toggle"]').text()).toBe(i18n.global.t("settings.autoCollabDisable"));
});

test("a non-ready answer keeps the reason visible instead of claiming success", async () => {
  const calls = stubBackend({
    get: DISABLED,
    set: {
      status: "failed",
      configPath: "conversations.router",
      reason: { code: "command-missing", message: "conversations.router.command is missing." },
    },
  });
  seedInstance();
  const wrapper = mount(SettingsView, { global: { stubs: { "router-link": true } } });
  await flushPromises();
  const row = wrapper.find('[data-test="auto-collab-row-i1"]');

  await row.find('[data-test="auto-collab-toggle"]').trigger("click");
  await flushPromises();
  expect(row.find('[data-test="auto-collab-state"]').text()).toContain("conversations.router.command is missing.");
  expect(row.find('[data-test="auto-collab-toggle"]').text()).toBe(i18n.global.t("settings.autoCollabEnable"));
  expect(row.find('[data-test="auto-collab-error"]').exists()).toBe(false);
  expect(setCalls(calls)).toHaveLength(1);
});

test("a ready answer can be switched back off", async () => {
  const calls = stubBackend({ get: READY, set: DISABLED });
  seedInstance();
  const wrapper = mount(SettingsView, { global: { stubs: { "router-link": true } } });
  await flushPromises();
  const row = wrapper.find('[data-test="auto-collab-row-i1"]');
  expect(row.find('[data-test="auto-collab-state"]').text()).toBe(i18n.global.t("settings.autoCollabOn"));

  await row.find('[data-test="auto-collab-toggle"]').trigger("click");
  await flushPromises();
  expect(setCalls(calls)).toEqual([{ type: "control.conversations.router.set", payload: { enabled: false } }]);
  expect(row.find('[data-test="auto-collab-state"]').text()).toBe(i18n.global.t("settings.autoCollabOff"));
});

test("an offline instance cannot be switched", async () => {
  const calls = stubBackend({ get: DISABLED, set: READY, online: false });
  seedInstance(false);
  const wrapper = mount(SettingsView, { global: { stubs: { "router-link": true } } });
  await flushPromises();
  const toggle = wrapper.find('[data-test="auto-collab-toggle"]');
  expect(toggle.attributes("disabled")).toBeDefined();
  await toggle.trigger("click");
  await flushPromises();
  expect(setCalls(calls)).toEqual([]);
});
