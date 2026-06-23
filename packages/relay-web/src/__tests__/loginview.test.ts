import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

const replace = vi.fn();
vi.mock("vue-router", () => ({ useRouter: () => ({ replace }) }));

import LoginView from "../views/LoginView.vue";
import { useAuthStore } from "../stores/auth";

describe("LoginView", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    replace.mockReset();
  });

  it("renders the terminal window chrome and the mint command", () => {
    const w = mount(LoginView);
    expect(w.find('[data-test="login-window"]').exists()).toBe(true);
    expect(w.text()).toContain("xacpx-relay");
    expect(w.text()).toContain("xacpx-relay add token");
    expect(w.find('[data-test="signin"]').text()).toContain("Sign in");
  });

  it("toggles token visibility with the eye button", async () => {
    const w = mount(LoginView);
    expect(w.find('[data-test="token-input"]').attributes("type")).toBe("password");
    await w.find('[data-test="toggle-visibility"]').trigger("click");
    expect(w.find('[data-test="token-input"]').attributes("type")).toBe("text");
    await w.find('[data-test="toggle-visibility"]').trigger("click");
    expect(w.find('[data-test="token-input"]').attributes("type")).toBe("password");
  });

  it("copies the mint command to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const w = mount(LoginView);
    await w.find('[data-test="copy-command"]').trigger("click");
    expect(writeText).toHaveBeenCalledWith("xacpx-relay add token");
  });

  it("logs in with the entered token and redirects home on success", async () => {
    const auth = useAuthStore();
    const login = vi.spyOn(auth, "login").mockResolvedValue(true);
    const w = mount(LoginView);
    await w.find('[data-test="token-input"]').setValue("rl_secret_token");
    await w.find('[data-test="login-window"]').trigger("submit");
    await flushPromises();
    expect(login).toHaveBeenCalledWith("rl_secret_token");
    expect(replace).toHaveBeenCalledWith("/");
  });

  it("surfaces an error and does not redirect on failed login", async () => {
    const auth = useAuthStore();
    vi.spyOn(auth, "login").mockImplementation(async () => {
      auth.error = "invalid-token";
      return false;
    });
    const w = mount(LoginView);
    await w.find('[data-test="login-window"]').trigger("submit");
    await flushPromises();
    expect(replace).not.toHaveBeenCalled();
    const err = w.find('[data-test="login-error"]');
    expect(err.exists()).toBe(true);
    expect(err.text()).toContain("invalid-token");
    expect(err.attributes("role")).toBe("alert");
  });
});
