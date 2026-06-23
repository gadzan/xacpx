import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createRouter, createMemoryHistory } from "vue-router";
import { i18n } from "../i18n";
import LoginView from "../views/LoginView.vue";

const router = createRouter({
  history: createMemoryHistory(),
  routes: [{ path: "/", component: { template: "<div />" } }],
});

describe("long-tail components i18n", () => {
  beforeEach(() => setActivePinia(createPinia()));
  afterEach(() => { i18n.global.locale.value = "en"; });

  it("renders Chinese login affordances when locale is zh-CN", async () => {
    i18n.global.locale.value = "zh-CN";
    const w = mount(LoginView, { global: { plugins: [router] } });
    // Sign-in button label ("Sign in" → 登录).
    expect(w.find('button[type="submit"]').text()).toContain("登录");
    // Token input placeholder ("paste token…" → 粘贴 token…).
    expect(w.find("input#access-token").attributes("placeholder")).toBe("粘贴 token…");
  });

  it("points users at the real token command (xacpx-relay add token, not user new)", () => {
    const w = mount(LoginView, { global: { plugins: [router] } });
    // The mint command is shown verbatim in the terminal command line.
    const text = w.find('[data-test="login-window"]').text();
    expect(text).toContain("xacpx-relay add token");
    expect(text).not.toContain("user new");
  });
});
