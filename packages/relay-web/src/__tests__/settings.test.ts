import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

vi.mock("../api/client", () => ({
  api: { get: vi.fn(), post: vi.fn(), del: vi.fn() },
  ApiError: class extends Error {},
}));

const push = vi.fn();
vi.mock("vue-router", () => ({ useRouter: () => ({ push }) }));
vi.mock("../lib/use-confirm", () => ({ confirm: vi.fn().mockResolvedValue(true) }));

import { api } from "../api/client";
import SettingsView from "../views/SettingsView.vue";
import { useAuthStore } from "../stores/auth";

const get = api.get as unknown as ReturnType<typeof vi.fn>;
const post = api.post as unknown as ReturnType<typeof vi.fn>;

describe("SettingsView", () => {
  beforeEach(() => { setActivePinia(createPinia()); get.mockReset(); post.mockReset(); push.mockReset(); });

  it("loads and shows the retention policy", async () => {
    get.mockResolvedValueOnce({ historyRetention: { days: 30, maxPerSession: 2000 } });
    const w = mount(SettingsView, { global: { stubs: { "router-link": true } } });
    await flushPromises();
    expect(get).toHaveBeenCalledWith("/api/config");
    expect(w.text()).toContain("30");
  });

  it("invite section does not exist for any user", async () => {
    get.mockResolvedValueOnce({ historyRetention: { days: 30, maxPerSession: 2000 } });
    const auth = useAuthStore();
    auth.account = { username: "m" };
    const w = mount(SettingsView, { global: { stubs: { "router-link": true } } });
    await flushPromises();
    expect(w.find('[data-test="invite-section"]').exists()).toBe(false);
    expect(w.find('[data-test="gen-invite"]').exists()).toBe(false);
  });

  it("generates a pairing token and shows the install command", async () => {
    get.mockResolvedValueOnce({ historyRetention: { days: 30, maxPerSession: 2000 } });
    post.mockResolvedValueOnce({ token: "PAIR9", expiresAt: "2030-01-01T00:00:00Z" });
    const auth = useAuthStore();
    auth.account = { username: "a" };
    const w = mount(SettingsView, { global: { stubs: { "router-link": true } } });
    await flushPromises();
    await w.find('[data-test="gen-pairing"]').trigger("click");
    await flushPromises();
    expect(post).toHaveBeenCalledWith("/api/instances/pairing-token", { name: "" });
    expect(w.text()).toContain("PAIR9");
    expect(w.text()).toContain("channel add relay");
  });

  it("signs out from the Account section (logout now lives in Settings, not the sidebar)", async () => {
    get.mockResolvedValueOnce({ historyRetention: { days: 30, maxPerSession: 2000 } });
    const auth = useAuthStore();
    auth.logout = vi.fn().mockResolvedValue(undefined);
    const w = mount(SettingsView, { global: { stubs: { "router-link": true } } });
    await flushPromises();
    await w.find('[data-test="logout"]').trigger("click");
    await flushPromises();
    expect(auth.logout).toHaveBeenCalled();
    expect(push).toHaveBeenCalledWith({ name: "login" });
  });
});
