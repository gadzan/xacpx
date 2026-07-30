import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

const replace = vi.fn();
let routeCode: string | string[] = "invite-code-123";
vi.mock("vue-router", () => ({
  useRouter: () => ({ replace }),
  useRoute: () => ({ params: { code: routeCode } }),
}));

import InviteView from "../views/InviteView.vue";
import { api } from "../api/client";
import { ApiError } from "../api/client";
import { useAuthStore } from "../stores/auth";

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");

function mountView() {
  return mount(InviteView, { global: { stubs: { RouterLink: { template: "<a><slot /></a>" } } } });
}

describe("InviteView", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    replace.mockReset();
    routeCode = "invite-code-123";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
    else delete (navigator as { clipboard?: unknown }).clipboard;
  });

  it("does NOT redeem on mount — only renders the redeem button", () => {
    const post = vi.spyOn(api, "post");
    const w = mountView();
    expect(post).not.toHaveBeenCalled();
    expect(w.find('[data-test="redeem"]').exists()).toBe(true);
    expect(w.find('[data-test="invite-token"]').exists()).toBe(false);
  });

  it("redeems on click and shows the token with the not-shown-again warning", async () => {
    const post = vi.spyOn(api, "post").mockResolvedValue({ token: "tok-abc", username: "u-1" });
    const w = mountView();
    await w.find('[data-test="redeem"]').trigger("click");
    await flushPromises();
    expect(post).toHaveBeenCalledWith("/api/invites/redeem", { code: "invite-code-123" });
    expect(w.find('[data-test="invite-token"]').text()).toBe("tok-abc");
    expect(w.find('[data-test="not-shown-again"]').exists()).toBe(true);
    expect(w.text()).toContain("u-1");
  });

  it("copies the token to the clipboard", async () => {
    vi.spyOn(api, "post").mockResolvedValue({ token: "tok-abc", username: "u-1" });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const w = mountView();
    await w.find('[data-test="redeem"]').trigger("click");
    await flushPromises();
    await w.find('[data-test="copy-token"]').trigger("click");
    expect(writeText).toHaveBeenCalledWith("tok-abc");
  });

  it("signs in with the minted token and redirects home", async () => {
    vi.spyOn(api, "post").mockResolvedValue({ token: "tok-abc", username: "u-1" });
    const auth = useAuthStore();
    const login = vi.spyOn(auth, "login").mockResolvedValue(true);
    const w = mountView();
    await w.find('[data-test="redeem"]').trigger("click");
    await flushPromises();
    await w.find('[data-test="signin"]').trigger("click");
    await flushPromises();
    expect(login).toHaveBeenCalledWith("tok-abc");
    expect(replace).toHaveBeenCalledWith("/");
  });

  it("shows the invalid-code error for a 401", async () => {
    vi.spyOn(api, "post").mockRejectedValue(new ApiError("invalid-code", 401));
    const w = mountView();
    await w.find('[data-test="redeem"]').trigger("click");
    await flushPromises();
    expect(w.find('[data-test="invite-error"]').text()).toContain("invalid");
    expect(w.find('[data-test="back-to-login"]').exists()).toBe(true);
  });

  it("shows the rate-limited error for a 429", async () => {
    vi.spyOn(api, "post").mockRejectedValue(new ApiError("too-many-attempts", 429));
    const w = mountView();
    await w.find('[data-test="redeem"]').trigger("click");
    await flushPromises();
    expect(w.find('[data-test="invite-error"]').text()).toContain("Too many attempts");
  });

  it("starts in the error state when the code param is empty", () => {
    routeCode = "";
    const w = mountView();
    expect(w.find('[data-test="redeem"]').exists()).toBe(false);
    expect(w.find('[data-test="invite-error"]').exists()).toBe(true);
  });
});
