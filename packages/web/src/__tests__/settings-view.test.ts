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
      ? { historyRetention: { mode: "server", ...RETENTION } }
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

test("action buttons resolve to the shared button component", async () => {
  // A dropped UiButton import silently renders unknown-element soup: the rows
  // look right in text assertions but lose every size and touch rule. The
  // mobile touch gate caught it once; pin the resolution here too.
  stubHub();
  const wrapper = mountSettings();
  await flushPromises();
  // notif-toggle is intentionally absent here: this file stubs push support
  // off, so the toggle hides. The notifications suite mounts it shown.
  for (const testId of ["open-add-instance", "logout"]) {
    const btn = wrapper.find(`[data-test="${testId}"]`);
    expect(btn.exists()).toBe(true);
    expect(btn.element.tagName).toBe("BUTTON");
    expect(btn.classes()).toContain("inline-flex");
  }
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

test("the add-instance button opens the three-step dialog, which mints the pairing token", async () => {
  const posts = stubHub({ token: "pair-tok" });
  const wrapper = mountSettings();
  await flushPromises();

  await wrapper.get('[data-test="open-add-instance"]').trigger("click");
  await flushPromises();

  const dialog = wrapper.get('[data-test="add-instance-dialog"]');

  await dialog.get('[data-test="add-instance-name"]').setValue("build-box");
  await dialog.get('[data-test="add-instance-next"]').trigger("click");
  await flushPromises();

  expect(posts).toEqual([{ path: "/api/instances/pairing-token", body: { name: "build-box" } }]);
  expect(dialog.get('[data-test="add-instance-command"]').text()).toContain("pair-tok");
  expect(dialog.get('[data-test="add-instance-command"]').text()).toContain("xacpx channel add relay");

  // The overlay dims with the shared scrim token, not a raw black.
  const overlay = dialog.element.parentElement;
  expect(overlay?.className).toContain("bg-scrim");
  expect(overlay?.className).not.toContain("bg-black/");

  // The success colour rides the shared run token.
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn(async () => {}) },
  });
  await dialog.get('[data-test="add-instance-copy"]').trigger("click");
  await flushPromises();
  expect(dialog.get('[data-test="add-instance-copy"]').find("svg").classes()).toContain("text-run");
});

test("the retention and relay blocks render the server values", async () => {
  stubHub();
  const wrapper = mountSettings();
  await flushPromises();
  expect(wrapper.get('[data-test="retention-body"]').text())
    .toBe(i18n.global.t("settings.retentionShort", { max: RETENTION.maxPerSession, days: RETENTION.days }));
  // The long sentence survives behind the info icon.
  expect(wrapper.find('[data-test="retention-info"]').exists()).toBe(true);
  expect(wrapper.get('[data-test="relay-version"]').text())
    .toBe(i18n.global.t("settings.relayVersion", { version: VERSION.current }));
});

test("segments paint a 28px pill on a 32px rail while the coarse hit box stays 44 and unpainted", async () => {
  stubHub();
  const wrapper = mountSettings();
  await flushPromises();

  const track = wrapper.get('[data-test="theme-setting"] div.inline-flex');
  // 32px rail = 2px + 28px + 2px; the padding is the pill's inset.
  expect(track.classes()).toEqual(expect.arrayContaining(["h-8", "p-0.5"]));
  for (const testId of ["theme-dark", "theme-light"]) {
    const button = wrapper.get(`[data-test="${testId}"]`);
    expect(button.classes()).toContain("h-7");
    expect(button.classes()).toEqual(expect.arrayContaining([
      "[@media(pointer:coarse)]:h-11",
      "[@media(pointer:coarse)]:min-w-11",
    ]));
    // The 44px hit box never carries the selected fill; the 28px child does.
    expect(button.classes()).not.toContain("bg-accent-soft");
    expect(button.find("span").classes()).toContain("h-7");
  }
  expect(wrapper.get('[data-test="theme-dark"] span').classes()).toContain("bg-accent-soft");
  expect(wrapper.get('[data-test="theme-light"] span').classes()).not.toContain("bg-accent-soft");
  // The language rail follows the same arithmetic.
  expect(wrapper.get('[data-test="language-setting"] div.inline-flex').classes())
    .toEqual(expect.arrayContaining(["h-8", "p-0.5"]));
  expect(wrapper.get('[data-test="lang-en"]').classes()).toContain("h-7");

  // Add-instance is a light text action (no filled blue block), logout stays red.
  const add = wrapper.get('[data-test="open-add-instance"]');
  expect(add.element.tagName).toBe("BUTTON");
  expect(add.classes()).toContain("text-accent-text");
  expect(add.classes()).toContain("min-h-11");
  expect(add.classes()).not.toContain("bg-accent");
  expect(add.find("svg").exists()).toBe(true);
  expect(wrapper.get('[data-test="logout"]').classes()).toContain("text-danger-text");
});
