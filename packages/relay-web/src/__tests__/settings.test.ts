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
    get.mockImplementation((url: string) =>
      url === "/api/version"
        ? Promise.resolve({ current: "0.6.0", latest: null, updateAvailable: false })
        : Promise.resolve({ historyRetention: { days: 30, maxPerSession: 2000 } }));
    const w = mount(SettingsView, { global: { stubs: { "router-link": true } } });
    await flushPromises();
    expect(get).toHaveBeenCalledWith("/api/config");
    expect(w.text()).toContain("30");
  });

  it("invite section does not exist for any user", async () => {
    get.mockImplementation((url: string) =>
      url === "/api/version"
        ? Promise.resolve({ current: "0.6.0", latest: null, updateAvailable: false })
        : Promise.resolve({ historyRetention: { days: 30, maxPerSession: 2000 } }));
    const auth = useAuthStore();
    auth.account = { username: "m" };
    const w = mount(SettingsView, { global: { stubs: { "router-link": true } } });
    await flushPromises();
    expect(w.find('[data-test="invite-section"]').exists()).toBe(false);
    expect(w.find('[data-test="gen-invite"]').exists()).toBe(false);
  });

  it("generates a pairing token and shows the install command", async () => {
    get.mockImplementation((url: string) =>
      url === "/api/version"
        ? Promise.resolve({ current: "0.6.0", latest: null, updateAvailable: false })
        : Promise.resolve({ historyRetention: { days: 30, maxPerSession: 2000 } }));
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
    get.mockImplementation((url: string) =>
      url === "/api/version"
        ? Promise.resolve({ current: "0.6.0", latest: null, updateAvailable: false })
        : Promise.resolve({ historyRetention: { days: 30, maxPerSession: 2000 } }));
    const auth = useAuthStore();
    auth.logout = vi.fn().mockResolvedValue(undefined);
    const w = mount(SettingsView, { global: { stubs: { "router-link": true } } });
    await flushPromises();
    await w.find('[data-test="logout"]').trigger("click");
    await flushPromises();
    expect(auth.logout).toHaveBeenCalled();
    expect(push).toHaveBeenCalledWith({ name: "login" });
  });

  it("shows the relay version from /api/version", async () => {
    get.mockImplementation((url: string) =>
      url === "/api/version"
        ? Promise.resolve({ current: "0.6.0", latest: null, updateAvailable: false })
        : Promise.resolve({ historyRetention: { days: 30, maxPerSession: 2000 } }));
    const w = mount(SettingsView, { global: { stubs: { "router-link": true } } });
    await flushPromises();
    expect(get).toHaveBeenCalledWith("/api/version");
    expect(w.get('[data-test="relay-version"]').text()).toContain("0.6.0");
    expect(w.find('[data-test="relay-update"]').exists()).toBe(false);
  });

  it("shows an update hint when a newer relay is available", async () => {
    get.mockImplementation((url: string) =>
      url === "/api/version"
        ? Promise.resolve({ current: "0.6.0", latest: "0.7.0", updateAvailable: true })
        : Promise.resolve({ historyRetention: { days: 30, maxPerSession: 2000 } }));
    const w = mount(SettingsView, { global: { stubs: { "router-link": true } } });
    await flushPromises();
    expect(w.get('[data-test="relay-update"]').text()).toContain("0.7.0");
  });
});
