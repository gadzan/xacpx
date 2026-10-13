// packages/relay-web/src/__tests__/settings-view.test.ts
import { setActivePinia, createPinia } from "pinia";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";

// SettingsView is a standalone route: stub the router instead of building one.
vi.mock("vue-router", () => ({ useRouter: () => ({ push: vi.fn() }) }));
// The desktop-notification probe is unrelated to these blocks and touches
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
import { useLocaleStore } from "../stores/locale";
import { useThemeStore } from "../stores/theme";
import { i18n } from "../i18n";

const RETENTION = { days: 30, maxPerSession: 200 };
const VERSION = { current: "0.14.11-beta.0", latest: null, updateAvailable: false };

/** Route the hub HTTP the surviving blocks make: the retention config, the relay
 *  version, and the pairing token. Returns the recorded POSTs. */
function stubHub(input: { token?: string } = {}) {
  const posts: Array<{ path: string; body: unknown }> = [];
  vi.stubGlobal("fetch", vi.fn(async (req: RequestInfo, init?: { body?: string; method?: string }) => {
    const url = typeof req === "string" ? req : String(req);
    if ((init?.method ?? "GET") === "POST") {
      posts.push({ path: url, body: JSON.parse(init?.body ?? "{}") });
      return new Response(JSON.stringify({ token: input.token ?? "pair-tok" }), { status: 200 });
    }
    const result = url.includes("/api/config")
      ? { historyRetention: RETENTION }
      : VERSION;
    return new Response(JSON.stringify(result), { status: 200 });
  }));
  return posts;
}

function mountSettings() {
  return mount(SettingsView, { global: { stubs: { "router-link": true } } });
}

beforeEach(() => {
  setActivePinia(createPinia());
  localStorage.clear();
  i18n.global.locale.value = "en";
});

afterEach(() => {
  vi.unstubAllGlobals();
  i18n.global.locale.value = "en";
});

test("the automatic-collaboration section is gone and the other blocks stay", async () => {
  stubHub();
  const wrapper = mountSettings();
  await flushPromises();
  expect(wrapper.find('[data-test="auto-collab-setting"]').exists()).toBe(false);
  expect(wrapper.find('[data-test="auto-collab-row-i1"]').exists()).toBe(false);
  expect(wrapper.find('[data-test="theme-setting"]').exists()).toBe(true);
  expect(wrapper.find('[data-test="notif-setting"]').exists()).toBe(true);
});

test("the theme and language blocks write their stores", async () => {
  stubHub();
  const theme = useThemeStore();
  const locale = useLocaleStore();
  const wrapper = mountSettings();
  await flushPromises();

  await wrapper.get('[data-test="theme-light"]').trigger("click");
  await wrapper.get('[data-test="lang-zh-CN"]').trigger("click");
  await flushPromises();

  expect(theme.mode).toBe("light");
  expect(locale.locale).toBe("zh-CN");
  expect(i18n.global.locale.value).toBe("zh-CN");
});

test("the pairing block posts the instance name and shows the host command", async () => {
  const posts = stubHub({ token: "pair-tok" });
  const wrapper = mountSettings();
  await flushPromises();

  await wrapper.get('[data-test="gen-pairing"]').trigger("click");
  await flushPromises();

  expect(posts).toEqual([{ path: "/api/instances/pairing-token", body: { name: "" } }]);
  expect(wrapper.text()).toContain("pair-tok");
  expect(wrapper.text()).toContain("xacpx channel add relay");
});

test("the retention and relay blocks render the server values", async () => {
  stubHub();
  const wrapper = mountSettings();
  await flushPromises();
  expect(wrapper.get('[data-test="retention-body"]').text())
    .toBe(i18n.global.t("settings.retentionBody", { max: RETENTION.maxPerSession, days: RETENTION.days }));
  expect(wrapper.get('[data-test="relay-version"]').text())
    .toBe(i18n.global.t("settings.relayVersion", { version: VERSION.current }));
});
