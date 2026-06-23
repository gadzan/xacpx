import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

const replace = vi.fn();
vi.mock("vue-router", () => ({ useRouter: () => ({ replace }) }));

import LoginView from "../views/LoginView.vue";
import { useAuthStore } from "../stores/auth";

// jsdom has no navigator.clipboard by default; the copy test stubs it. Restore
// afterwards so the stub never leaks into other test files (which may assert the
// insecure-context path where clipboard is undefined).
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");

describe("LoginView", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    replace.mockReset();
  });

  afterEach(() => {
    if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
    else delete (navigator as { clipboard?: unknown }).clipboard;
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

  it("disables the form and shows a pending label while a login is in flight", async () => {
    const auth = useAuthStore();
    let resolveLogin!: (ok: boolean) => void;
    vi.spyOn(auth, "login").mockReturnValue(new Promise((r) => (resolveLogin = r)));
    const w = mount(LoginView);
    await w.find('[data-test="token-input"]').setValue("rl_secret_token");
    await w.find('[data-test="login-window"]').trigger("submit");
    await flushPromises();
    expect(w.find('[data-test="signin"]').attributes("disabled")).toBeDefined();
    expect(w.find('[data-test="token-input"]').attributes("disabled")).toBeDefined();
    expect(w.find('[data-test="signin"]').text()).toContain("Signing in");
    resolveLogin(true);
    await flushPromises();
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
