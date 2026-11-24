import { mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

const lib = vi.hoisted(() => ({
  pushSupported: vi.fn(),
  fetchVapidPublicKey: vi.fn(),
  enableDesktopNotifications: vi.fn(),
  disableDesktopNotifications: vi.fn(),
  subscriptionMatchesKey: vi.fn(),
  getExistingSubscription: vi.fn(),
  isDesktopNotificationsEnabled: vi.fn(),
}));

vi.mock("../lib/web-push", () => lib);

// SettingsView pulls the whole api client + confirm dialog; stub what it uses.
vi.mock("../api/client", () => {
  class ApiError extends Error {
    constructor(public readonly code: string, public readonly status: number) {
      super(code);
    }
  }
  return {
    ApiError,
    api: {
      get: vi.fn().mockRejectedValue(new ApiError("offline", 503)),
      post: vi.fn(),
    },
  };
});
vi.mock("../lib/use-confirm", () => ({ confirm: vi.fn() }));
vi.mock("vue-router", () => ({ useRouter: () => ({ push: vi.fn() }) }));

import SettingsView from "../views/SettingsView.vue";
import Tooltip from "../components/Tooltip.vue";
import { i18n } from "../i18n";
import { normalizeRuntimeConfig } from "../lib/runtime-config";
import { useRuntimeStore } from "../stores/runtime";

function mountSettings(prepare?: () => void) {
  const pinia = createPinia();
  setActivePinia(pinia);
  prepare?.();
  return mount(SettingsView, { global: { plugins: [pinia, i18n] } });
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

/** The desktop-notification control is a switch, not an action button. */
function notifSwitch(w: VueWrapper) {
  const el = w.find('[data-test="notif-toggle"]');
  return {
    exists: el.exists(),
    checked: el.exists() ? el.attributes("aria-checked") === "true" : null,
    tag: el.exists() ? el.element.tagName : null,
    attrs: el.exists() ? el.attributes() : {},
  };
}

describe("settings notifications section", () => {
  // jsdom/bun does not ship a Notification global; SettingsView probes
  // `typeof Notification === "undefined"` as its capability boundary, so most
  // tests need a minimal granted-permission stub installed.
  const notificationStub = Object.assign(function () {}, { permission: "granted" });
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    globalThis.Notification = notificationStub as unknown as typeof Notification;
    lib.pushSupported.mockReturnValue(true);
    lib.fetchVapidPublicKey.mockResolvedValue("PK");
    lib.enableDesktopNotifications.mockResolvedValue(undefined);
    lib.disableDesktopNotifications.mockResolvedValue(undefined);
    lib.subscriptionMatchesKey.mockReturnValue(true);
    lib.getExistingSubscription.mockResolvedValue(null);
    lib.isDesktopNotificationsEnabled.mockReturnValue(false);
  });
  it("keeps the row when the hub has no push channel, and leaves the switch off", async () => {
    const w = mountSettings(() => {
      const runtime = useRuntimeStore();
      runtime.config = normalizeRuntimeConfig({
        hostMode: "relay",
        capabilities: { webPush: false },
      });
      runtime.loaded = true;
    });
    await flush();
    expect(w.find('[data-test="notif-setting"]').exists()).toBe(true);
    expect(w.find('[data-test="notif-state"]').text()).toBe("Not enabled on server");
    const sw = notifSwitch(w);
    expect(sw.exists).toBe(true);
    expect(sw.attrs.disabled).toBeDefined();
  });

  it("renders an on switch when the app preference is enabled and the browser grants it", async () => {
    lib.isDesktopNotificationsEnabled.mockReturnValue(true);
    const w = mountSettings();
    await flush();
    expect(w.find('[data-test="notif-state"]').text()).toBe("On");
    const sw = notifSwitch(w);
    expect(sw.exists).toBe(true);
    expect(sw.tag).toBe("BUTTON");
    expect(sw.attrs.role).toBe("switch");
    expect(sw.checked).toBe(true);
    // A switch carries no action copy: the visual state IS the affordance.
    expect(w.find('[data-test="notif-toggle"]').text()).toBe("");
    expect(sw.attrs["aria-label"]).toBe("Desktop notifications");
    vi.unstubAllGlobals();
  });

  it("renders an off switch when a subscription exists but the app preference is off", async () => {
    lib.getExistingSubscription.mockResolvedValue({ endpoint: "https://push/e1" });
    lib.isDesktopNotificationsEnabled.mockReturnValue(false);
    const w = mountSettings();
    await flush();
    expect(w.find('[data-test="notif-state"]').text()).toBe("Off");
    expect(notifSwitch(w).checked).toBe(false);
    vi.unstubAllGlobals();
  });

  it("renders Off and allows enabling when VAPID is null and intent is false", async () => {
    lib.fetchVapidPublicKey.mockResolvedValue(null);
    lib.isDesktopNotificationsEnabled.mockReturnValue(false);
    const w = mountSettings();
    await flush();
    expect(w.find('[data-test="notif-state"]').text()).toBe("Off");
    expect(notifSwitch(w).exists).toBe(true);
    expect(notifSwitch(w).checked).toBe(false);
    await w.find('[data-test="notif-toggle"]').trigger("click");
    await flush();
    expect(lib.enableDesktopNotifications).toHaveBeenCalledWith(null);
    expect(w.find('[data-test="notif-state"]').text()).toBe("On");
    expect(notifSwitch(w).checked).toBe(true);
    vi.unstubAllGlobals();
  });

  it("turning the switch off stops app notifications without claiming the permission was revoked", async () => {
    lib.fetchVapidPublicKey.mockResolvedValue(null);
    lib.isDesktopNotificationsEnabled.mockReturnValue(true);
    const w = mountSettings();
    await flush();
    expect(notifSwitch(w).checked).toBe(true);
    await w.find('[data-test="notif-toggle"]').trigger("click");
    await flush();
    expect(lib.disableDesktopNotifications).toHaveBeenCalledTimes(1);
    expect(w.find('[data-test="notif-state"]').text()).toBe("Off");
    expect(notifSwitch(w).checked).toBe(false);
    // The browser permission is still granted; the copy must not imply otherwise.
    expect(w.text()).not.toContain("permission denied");
    vi.unstubAllGlobals();
  });

  it("switch-on calls enableDesktopNotifications and flips to On", async () => {
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
    expect(notifSwitch(w).checked).toBe(true);
    vi.unstubAllGlobals();
  });

  it("switch-off calls disableDesktopNotifications and flips to Off", async () => {
    lib.isDesktopNotificationsEnabled.mockReturnValue(true);
    lib.getExistingSubscription.mockResolvedValue({ endpoint: "https://push/e1" });
    const w = mountSettings();
    await flush();
    await w.find('[data-test="notif-toggle"]').trigger("click");
    await flush();
    expect(lib.disableDesktopNotifications).toHaveBeenCalledTimes(1);
    expect(w.find('[data-test="notif-state"]').text()).toBe("Off");
    vi.unstubAllGlobals();
  });

  it("permission-denied during enable shows a blocked state with the info hint and an off switch", async () => {
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
    expect(w.find('[data-test="notif-info"]').exists()).toBe(true);
    expect(notifSwitch(w).checked).toBe(false);
    const texts = w.findAllComponents(Tooltip).map((tip) => String(tip.props("text")));
    expect(texts.join(" ")).toContain("browser site settings");
    vi.unstubAllGlobals();
  });

  it("re-probes when the browser permission changes, so a denied row can recover", async () => {
    // A PermissionStatus is an EventTarget; jsdom lacks navigator.permissions.
    const status = new EventTarget() as PermissionStatus;
    vi.stubGlobal("navigator", {
      ...navigator,
      permissions: { query: vi.fn().mockResolvedValue(status) },
    });
    const deniedStub = Object.assign(function () {}, { permission: "denied" });
    globalThis.Notification = deniedStub as unknown as typeof Notification;
    const w = mountSettings();
    await flush();
    expect(w.find('[data-test="notif-state"]').text()).toBe("Notification permission denied");

    // The user unblocks the site elsewhere; the permission object flips.
    globalThis.Notification = notificationStub as unknown as typeof Notification;
    status.dispatchEvent(new Event("change"));
    await flush();
    expect(w.find('[data-test="notif-state"]').text()).toBe("Off");
    expect(notifSwitch(w).checked).toBe(false);
    vi.unstubAllGlobals();
  });

  it("a stale denied row whose permission is now granted turns on, never off", async () => {
    // No permission-change listener fired (older browser, restored page): the row
    // still says denied while the browser already grants.
    vi.stubGlobal("navigator", { ...navigator });
    const deniedStub = Object.assign(function () {}, { permission: "denied" });
    globalThis.Notification = deniedStub as unknown as typeof Notification;
    lib.isDesktopNotificationsEnabled.mockReturnValue(true);
    const w = mountSettings();
    await flush();
    expect(w.find('[data-test="notif-state"]').text()).toBe("Notification permission denied");

    globalThis.Notification = notificationStub as unknown as typeof Notification;
    await w.find('[data-test="notif-toggle"]').trigger("click");
    await flush();
    // The tap re-probed into "on"; it must not run the off branch and disable it.
    expect(lib.disableDesktopNotifications).not.toHaveBeenCalled();
    expect(w.find('[data-test="notif-state"]').text()).toBe("On");
    expect(notifSwitch(w).checked).toBe(true);
    vi.unstubAllGlobals();
  });

  it("marks the switch busy while the permission request is in flight", async () => {
    const pending = Promise.withResolvers<void>();
    lib.enableDesktopNotifications.mockImplementationOnce(() => pending.promise);
    vi.stubGlobal("navigator", {
      ...navigator,
      serviceWorker: { ready: Promise.resolve({ pushManager: { getSubscription: vi.fn().mockResolvedValue(null) } }) },
    });
    const w = mountSettings();
    await flush();
    await w.find('[data-test="notif-toggle"]').trigger("click");
    await flush();
    const sw = w.find('[data-test="notif-toggle"]');
    expect(sw.attributes("aria-busy")).toBe("true");
    expect(sw.attributes("disabled")).toBeDefined();
    pending.resolve();
    await flush();
    expect(w.find('[data-test="notif-toggle"]').attributes("aria-busy")).toBe("false");
    vi.unstubAllGlobals();
  });

  it("shows On when Web Push transport fails after intent was written true", async () => {
    // enableDesktopNotifications() writes intent=true BEFORE the transport step,
    // so the mock flips the source of truth when called (simulating real behavior).
    lib.enableDesktopNotifications.mockImplementationOnce(async () => {
      lib.isDesktopNotificationsEnabled.mockReturnValue(true);
      throw new Error("network down");
    });
    vi.stubGlobal("navigator", {
      ...navigator,
      serviceWorker: { ready: Promise.resolve({ pushManager: { getSubscription: vi.fn().mockResolvedValue(null) } }) },
    });
    const w = mountSettings();
    await flush();
    await w.find('[data-test="notif-toggle"]').trigger("click");
    await flush();
    expect(w.find('[data-test="notif-state"]').text()).toBe("On");
    expect(notifSwitch(w).exists).toBe(true);
    expect(notifSwitch(w).checked).toBe(true);
    vi.unstubAllGlobals();
  });

  it("renders Unsupported and hides toggle when Notification API is missing", async () => {
    lib.pushSupported.mockReturnValue(false);
    const saved = globalThis.Notification;
    try {
      // @ts-expect-error simulating an environment without the Notification API
      delete globalThis.Notification;
      const w = mountSettings();
      await flush();
      expect(w.find('[data-test="notif-state"]').text()).toBe("Not supported in this environment");
      expect(w.find('[data-test="notif-toggle"]').exists()).toBe(false);
    } finally {
      globalThis.Notification = saved;
    }
  });

  it("renders iOS / iPadOS Home Screen notification hint only on iOS/iPadOS", async () => {
    // 1. Desktop UA -> no info icon (the row stays a single line)
    vi.stubGlobal("navigator", { ...navigator, userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36", maxTouchPoints: 0 });
    const wDesktop = mountSettings();
    await flush();
    expect(wDesktop.find('[data-test="notif-info"]').exists()).toBe(false);

    // 2. iOS UA -> the hint rides the info icon's tooltip text
    vi.stubGlobal("navigator", { ...navigator, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)", maxTouchPoints: 5 });
    const wIos = mountSettings();
    await flush();
    expect(wIos.find('[data-test="notif-info"]').exists()).toBe(true);
    const texts = wIos.findAllComponents(Tooltip).map((tip) => String(tip.props("text")));
    expect(texts.join(" ")).toContain("Home Screen");
    vi.unstubAllGlobals();
  });
});
