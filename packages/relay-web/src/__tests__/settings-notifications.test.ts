import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

const lib = vi.hoisted(() => ({
  pushSupported: vi.fn(),
  fetchVapidPublicKey: vi.fn(),
  enableDesktopNotifications: vi.fn(),
  disableDesktopNotifications: vi.fn(),
}));

vi.mock("../lib/web-push", () => lib);

// SettingsView pulls the whole api client + confirm dialog; stub what it uses.
vi.mock("../api/client", () => ({
  api: {
    get: vi.fn().mockRejectedValue(new Error("offline")),
    post: vi.fn(),
  },
}));
vi.mock("../lib/use-confirm", () => ({ confirm: vi.fn() }));
vi.mock("vue-router", () => ({ useRouter: () => ({ push: vi.fn() }) }));

import SettingsView from "../views/SettingsView.vue";
import { i18n } from "../i18n";

function mountSettings() {
  return mount(SettingsView, { global: { plugins: [createPinia(), i18n] } });
}
/**
 * Drain the component's onMounted promise chain without real wall-clock timers.
 * The probe chain is several awaits deep (fetch key → SW ready → getSubscription),
 * so run a fixed burst of microtask turns.
 */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

describe("settings notifications section", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    lib.pushSupported.mockReturnValue(true);
    lib.fetchVapidPublicKey.mockResolvedValue("PK");
    lib.enableDesktopNotifications.mockResolvedValue(undefined);
    lib.disableDesktopNotifications.mockResolvedValue(undefined);
  });
  it("renders 已开启 when a probe subscription exists", async () => {
    vi.stubGlobal("navigator", {
      ...navigator,
      serviceWorker: {
        ready: Promise.resolve({ pushManager: { getSubscription: vi.fn().mockResolvedValue({ endpoint: "https://push/e1" }) } }),
      },
    });
    const w = mountSettings();
    await flush();
    expect(w.find('[data-test="notif-state"]').text()).toBe("On");
    expect(w.find('[data-test="notif-toggle"]').exists()).toBe(true);
    vi.unstubAllGlobals();
  });

  it("shows 服务端未启用 when hub has no VAPID key", async () => {
    lib.fetchVapidPublicKey.mockResolvedValue(null);
    vi.stubGlobal("navigator", {
      ...navigator,
      serviceWorker: { ready: Promise.resolve({ pushManager: { getSubscription: vi.fn().mockResolvedValue(null) } }) },
    });
    const w = mountSettings();
    await flush();
    expect(w.find('[data-test="notif-state"]').text()).toBe("Not enabled on server");
    expect(w.find('[data-test="notif-toggle"]').exists()).toBe(false);
    vi.unstubAllGlobals();
  });

  it("unsupported environment renders 当前环境不支持 without probing", async () => {
    lib.pushSupported.mockReturnValue(false);
    const w = mountSettings();
    await flush();
    expect(w.find('[data-test="notif-state"]').text()).toBe("Not supported in this environment");
    expect(lib.fetchVapidPublicKey).not.toHaveBeenCalled();
  });

  it("toggle-on calls enableDesktopNotifications and flips to 已开启", async () => {
    vi.stubGlobal("navigator", {
      ...navigator,
      serviceWorker: { ready: Promise.resolve({ pushManager: { getSubscription: vi.fn().mockResolvedValue(null) } }) },
    });
    const w = mountSettings();
    await flush();
    await w.find('[data-test="notif-toggle"]').trigger("click");
    await flush();
    expect(lib.enableDesktopNotifications).toHaveBeenCalledWith("PK");
    expect(w.find('[data-test="notif-state"]').text()).toBe("On");
    vi.unstubAllGlobals();
  });

  it("toggle-off calls disableDesktopNotifications and flips to 未开启", async () => {
    vi.stubGlobal("navigator", {
      ...navigator,
      serviceWorker: {
        ready: Promise.resolve({ pushManager: { getSubscription: vi.fn().mockResolvedValue({ endpoint: "https://push/e1" }) } }),
      },
    });
    const w = mountSettings();
    await flush();
    await w.find('[data-test="notif-toggle"]').trigger("click");
    await flush();
    expect(lib.disableDesktopNotifications).toHaveBeenCalledTimes(1);
    expect(w.find('[data-test="notif-state"]').text()).toBe("Off");
    vi.unstubAllGlobals();
  });

  it("permission-denied during enable shows denied state with hint", async () => {
    lib.enableDesktopNotifications.mockRejectedValueOnce(new Error("permission-denied"));
    vi.stubGlobal("navigator", {
      ...navigator,
      serviceWorker: { ready: Promise.resolve({ pushManager: { getSubscription: vi.fn().mockResolvedValue(null) } }) },
    });
    const w = mountSettings();
    await flush();
    await w.find('[data-test="notif-toggle"]').trigger("click");
    await flush();
    expect(w.find('[data-test="notif-state"]').text()).toBe("Notification permission denied");
    expect(w.text()).toContain("browser site settings");
    vi.unstubAllGlobals();
  });
});
