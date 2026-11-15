import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

const replace = vi.fn();
vi.mock("vue-router", () => ({ useRouter: () => ({ replace }) }));

import LoginView from "../views/LoginView.vue";
import { useAuthStore } from "../stores/auth";
import { readRememberedToken } from "../lib/login-token";

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
    localStorage.clear();
    if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
    else delete (navigator as { clipboard?: unknown }).clipboard;
  });

  it("renders the brand lockup above the card and the mint command", () => {
    const w = mount(LoginView);
    expect(w.find('[data-test="login-window"]').exists()).toBe(true);
    expect(w.find("h1").text()).toBe("xacpx relay");
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

  it("renders no enter hint in the submit button", () => {
    const w = mount(LoginView);
    expect(w.find('[data-test="signin"]').text()).not.toMatch(/enter|⏎/i);
  });

  it("localizes a known error code and does not redirect on failed login", async () => {
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
    expect(err.text()).toContain("invalid or has been revoked");
    expect(err.text()).not.toContain("invalid-token");
    expect(err.attributes("role")).toBe("alert");
  });

  it("falls back to the generic message for an unknown error code", async () => {
    const auth = useAuthStore();
    vi.spyOn(auth, "login").mockImplementation(async () => {
      auth.error = "rate-limited";
      return false;
    });
    const w = mount(LoginView);
    await w.find('[data-test="login-window"]').trigger("submit");
    await flushPromises();
    expect(w.find('[data-test="login-error"]').text()).toContain("Sign-in failed");
  });

  it("autofills a remembered token and pre-ticks the box", () => {
    localStorage.setItem("xacpx.loginToken", "rl_remembered");
    const w = mount(LoginView);
    expect(w.find<HTMLInputElement>('[data-test="token-input"]').element.value).toBe("rl_remembered");
    expect(w.find<HTMLInputElement>('[data-test="remember-token"]').element.checked).toBe(true);
  });

  it("leaves the box unticked with no remembered token", () => {
    const w = mount(LoginView);
    expect(w.find<HTMLInputElement>('[data-test="token-input"]').element.value).toBe("");
    expect(w.find<HTMLInputElement>('[data-test="remember-token"]').element.checked).toBe(false);
  });

  it("persists the token only when the box is ticked", async () => {
    vi.spyOn(useAuthStore(), "login").mockResolvedValue(true);
    const w = mount(LoginView);
    await w.find('[data-test="token-input"]').setValue("rl_secret_token");
    await w.find('[data-test="remember-token"]').setValue(true);
    await w.find('[data-test="login-window"]').trigger("submit");
    await flushPromises();
    expect(readRememberedToken()).toBe("rl_secret_token");
  });

  it("erases a previously remembered token the moment the box is unticked", async () => {
    localStorage.setItem("xacpx.loginToken", "rl_old");
    const w = mount(LoginView);
    await w.find('[data-test="remember-token"]').setValue(false);
    expect(readRememberedToken()).toBe("");
  });

  it("still renders and logs in when storage access throws", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage blocked");
    });
    const login = vi.spyOn(useAuthStore(), "login").mockResolvedValue(true);
    const w = mount(LoginView);
    expect(w.find<HTMLInputElement>('[data-test="token-input"]').element.value).toBe("");
    await w.find('[data-test="token-input"]').setValue("rl_secret_token");
    await w.find('[data-test="remember-token"]').setValue(true);
    await w.find('[data-test="login-window"]').trigger("submit");
    await flushPromises();
    expect(login).toHaveBeenCalledWith("rl_secret_token");
    expect(replace).toHaveBeenCalledWith("/");
  });

  it("keeps no token when the login itself fails", async () => {
    const auth = useAuthStore();
    vi.spyOn(auth, "login").mockImplementation(async () => {
      auth.error = "invalid-token";
      return false;
    });
    const w = mount(LoginView);
    await w.find('[data-test="token-input"]').setValue("rl_rejected");
    await w.find('[data-test="remember-token"]').setValue(true);
    await w.find('[data-test="login-window"]').trigger("submit");
    await flushPromises();
    expect(readRememberedToken()).toBe("");
  });
});
