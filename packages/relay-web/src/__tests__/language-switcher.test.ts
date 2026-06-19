import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { mount, flushPromises } from "@vue/test-utils";
import { i18n } from "../i18n";
import SettingsView from "../views/SettingsView.vue";

vi.mock("vue-router", () => ({ useRouter: () => ({ push: vi.fn() }), RouterLink: { template: "<a><slot/></a>" } }));
vi.mock("../api/client", () => ({ api: { get: vi.fn().mockResolvedValue({ historyRetention: { days: 30, maxPerSession: 500 } }), post: vi.fn() } }));

describe("SettingsView language switcher", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    i18n.global.locale.value = "en";
  });

  it("switches the dashboard language to Chinese", async () => {
    const w = mount(SettingsView, { global: { stubs: { "router-link": true } } });
    await flushPromises();
    expect(w.get('[data-test="theme-setting"] h2').text()).toBe("Appearance");
    await w.get('[data-test="lang-zh-CN"]').trigger("click");
    expect(i18n.global.locale.value).toBe("zh-CN");
    expect(w.get('[data-test="theme-setting"] h2').text()).toBe("外观");
    expect(localStorage.getItem("relay-locale")).toBe("zh-CN");
  });
});
