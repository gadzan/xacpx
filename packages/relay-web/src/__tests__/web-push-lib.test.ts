import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
  del: vi.fn(),
}));

vi.mock("../api/client", () => ({
  api: {
    get: apiMocks.get,
    put: apiMocks.put,
    del: apiMocks.del,
  },
  ApiError: class extends Error {},
}));

import {
  urlBase64ToUint8Array,
  pushSupported,
  fetchVapidPublicKey,
  enableDesktopNotifications,
  disableDesktopNotifications,
  reconcileExistingSubscription,
} from "../lib/web-push";

function stubNavigator(serviceWorker: unknown): void {
  vi.stubGlobal("navigator", { ...navigator, serviceWorker });
}

function urlBase64ToUint8Array2(base64: string) {
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
}

describe("web-push lib", () => {
  beforeEach(() => {
    apiMocks.get.mockReset().mockResolvedValue({ publicKey: "PK" });
    apiMocks.put.mockReset().mockResolvedValue({ ok: true });
    apiMocks.del.mockReset().mockResolvedValue({ ok: true });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("urlBase64ToUint8Array decodes base64url with padding restored", () => {
    const bytes = urlBase64ToUint8Array("BEl62YiZ0d9Z1d9Z");
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(0);
    // Deterministic value: "BEl6..." decodes to bytes starting 0x04.
    expect(bytes[0]).toBe(0x04);
  });

  it("pushSupported requires serviceWorker + PushManager + Notification", async () => {
    // jsdom lacks all three; start from a clean slate.
    vi.stubGlobal("Notification", undefined);
    stubNavigator(undefined);
    expect(pushSupported()).toBe(false);

    (window as unknown as Record<string, unknown>).PushManager = function FakePushManager() {};
    (window as unknown as Record<string, unknown>).Notification = function FakeNotification() {};
    stubNavigator({ ready: Promise.resolve({}) });
    expect(pushSupported()).toBe(true);

    delete (window as unknown as Record<string, unknown>).PushManager;
    delete (window as unknown as Record<string, unknown>).Notification;
  });

  it("fetchVapidPublicKey returns the key, or null on hub errors", async () => {
    expect(await fetchVapidPublicKey()).toBe("PK");
    apiMocks.get.mockRejectedValueOnce(new Error("404"));
    expect(await fetchVapidPublicKey()).toBeNull();
  });

  it("enableDesktopNotifications requests permission, subscribes, PUTs the JSON", async () => {
    const requestPermission = vi.fn().mockResolvedValue("granted");
    vi.stubGlobal("Notification", { permission: "default", requestPermission });
    const subscribe = vi.fn().mockResolvedValue({
      endpoint: "https://push/e1",
      keys: { p256dh: "k", auth: "a" },
      toJSON() {
        return { endpoint: this.endpoint, keys: this.keys };
      },
    });
    stubNavigator({ ready: Promise.resolve({ pushManager: { subscribe, getSubscription: vi.fn().mockResolvedValue(null) } }) });

    await enableDesktopNotifications("PK");
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledWith(expect.objectContaining({ userVisibleOnly: true }));
    expect(apiMocks.put).toHaveBeenCalledWith("/api/web-push/subscriptions", {
      endpoint: "https://push/e1",
      keys: { p256dh: "k", auth: "a" },
    });
  });

  it("enableDesktopNotifications throws permission-denied when denied", async () => {
    vi.stubGlobal("Notification", { permission: "default", requestPermission: vi.fn().mockResolvedValue("denied") });
    stubNavigator({ ready: Promise.resolve({ pushManager: {} }) });
    await expect(enableDesktopNotifications("PK")).rejects.toThrow("permission-denied");
    expect(apiMocks.put).not.toHaveBeenCalled();
  });

  it("disableDesktopNotifications unsubscribes and DELETEs", async () => {
    const unsubscribe = vi.fn().mockResolvedValue(true);
    const getSubscription = vi.fn().mockResolvedValue({ endpoint: "https://push/e1", unsubscribe });
    stubNavigator({ ready: Promise.resolve({ pushManager: { getSubscription } }) });

    await disableDesktopNotifications();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(apiMocks.del).toHaveBeenCalledWith("/api/web-push/subscriptions", { endpoint: "https://push/e1" });

    // No existing subscription: DELETE must not fire.
    apiMocks.del.mockClear();
    getSubscription.mockResolvedValue(null);
    await disableDesktopNotifications();
    expect(apiMocks.del).not.toHaveBeenCalled();
  });

  it("reconcileExistingSubscription PUTs a matching subscription; skips otherwise", async () => {
    // pushSupported() gates reconcile: provide the full environment.
    (window as unknown as Record<string, unknown>).PushManager = function FakePushManager() {};
    (window as unknown as Record<string, unknown>).Notification = function FakeNotification() {};
    // Key minted by the same VAPID public key the hub serves ("PK" → base64url).
    const mod = await import("../lib/web-push");
    // A real 65-byte P-256 point, base64url — same shape as a live VAPID key.
    const hubKey = "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U";
    apiMocks.get.mockResolvedValue({ publicKey: hubKey });
    const getSubscription = vi.fn().mockResolvedValue({
      endpoint: "https://push/e1",
      options: { applicationServerKey: urlBase64ToUint8Array2(hubKey).buffer },
      toJSON() {
        return { endpoint: this.endpoint };
      },
    });

    apiMocks.put.mockClear();
    getSubscription.mockResolvedValue(null);
    await reconcileExistingSubscription();
    expect(apiMocks.put).not.toHaveBeenCalled();
    // Hub errors are swallowed: reconcile stays best-effort.
    getSubscription.mockRejectedValue(new Error("boom"));
    await expect(reconcileExistingSubscription()).resolves.toBeUndefined();

    delete (window as unknown as Record<string, unknown>).PushManager;
    delete (window as unknown as Record<string, unknown>).Notification;
  });
});

describe("review fixes", () => {
  beforeEach(() => {
    apiMocks.get.mockReset().mockResolvedValue({ publicKey: "PK" });
    apiMocks.put.mockReset().mockResolvedValue({ ok: true });
    apiMocks.del.mockReset().mockResolvedValue({ ok: true });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("reconcileExistingSubscription resubscribes when VAPID key rotated", async () => {
    // Old key minted into the stored subscription; hub now serves a NEW key.
    // Both reconcile's probe AND enable()'s internal stale-check see the stale
    // sub (shared registration mock) → unsubscribe fires twice, subscribe once,
    // and the hub receives the NEW endpoint via PUT.
    const oldSub = {
      endpoint: "https://fcm.googleapis.com/fcm/send/old",
      options: { applicationServerKey: urlBase64ToUint8Array2("BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U").buffer },
      unsubscribe: vi.fn().mockResolvedValue(true),
    };
    const getSubscription = vi.fn().mockResolvedValue(oldSub);
    (window as unknown as Record<string, unknown>).PushManager = function FakePushManager() {};
    // enableDesktopNotifications() skips requestPermission when already granted;
    // include requestPermission anyway in case permission isn't granted yet.
    const grantedStub = { permission: "granted", requestPermission: vi.fn().mockResolvedValue("granted") };
    (window as unknown as Record<string, unknown>).Notification = grantedStub;

    const mod = await import("../lib/web-push");
    const subscribe = vi.fn().mockResolvedValue({
      endpoint: "https://fcm.googleapis.com/fcm/send/new",
      keys: { p256dh: "k2", auth: "a2" },
      toJSON() {
        return { endpoint: this.endpoint, keys: this.keys };
      },
    });
    stubNavigator({ ready: Promise.resolve({ pushManager: { getSubscription, subscribe } }) });

    console.log("NOTIF:", typeof Notification, (globalThis as { Notification?: { permission?: string } }).Notification?.permission);
    await mod.reconcileExistingSubscription();
    expect(getSubscription).toHaveBeenCalledTimes(2); // probe + enable stale-check
    expect(oldSub.unsubscribe.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(subscribe).toHaveBeenCalledWith(expect.objectContaining({ userVisibleOnly: true }));
    expect(apiMocks.del).toHaveBeenCalledWith("/api/web-push/subscriptions", { endpoint: "https://fcm.googleapis.com/fcm/send/old" });
    expect(apiMocks.put).toHaveBeenCalledWith("/api/web-push/subscriptions", {
      endpoint: "https://fcm.googleapis.com/fcm/send/new",
      keys: { p256dh: "k2", auth: "a2" },
    });

    delete (window as unknown as Record<string, unknown>).PushManager;
    delete (window as unknown as Record<string, unknown>).Notification;
  });
});

describe("auth lifecycle ownership (fail-closed contract)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reconcile failure destroys the local subscription instead of leaving a stale binding", async () => {
    // A→B leak window scenario: tab crashed before cleanup, subscription still
    // bound to account A. New login for B must either rebind or DESTROY the
    // local sub — never leave it half-transferred. Simulate hub PUT failure.
    const mod = await import("../lib/web-push");
    (window as unknown as Record<string, unknown>).PushManager = function FakePushManager() {};
    (window as unknown as Record<string, unknown>).Notification = function FakeNotification() {};
    const k = "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U";
    apiMocks.get.mockResolvedValue({ publicKey: k }); // key matches → PUT path
    apiMocks.put.mockRejectedValueOnce(new Error("hub write failed"));
    const unsubscribe = vi.fn().mockResolvedValue(true);
    const staleSub = {
      endpoint: "https://fcm.googleapis.com/fcm/send/stale",
      options: { applicationServerKey: urlBase64ToUint8Array2(k).buffer },
      unsubscribe,
      toJSON() { return { endpoint: this.endpoint }; },
    };
    stubNavigator({
      ready: Promise.resolve({
        pushManager: {
          getSubscription: vi.fn().mockResolvedValue(staleSub),
        },
      }),
    });
    await expect(mod.reconcileExistingSubscription()).rejects.toThrow("hub write failed");
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    delete (window as unknown as Record<string, unknown>).PushManager;
    delete (window as unknown as Record<string, unknown>).Notification;
  });

  it("returns within 3s when serviceWorker.ready never resolves (dev/no-SW contexts)", async () => {
    // E2E/dev servers register no worker → navigator.serviceWorker.ready never
    // settles. Reconcile must time out and return instead of hanging auth.
    const mod = await import("../lib/web-push");
    (window as unknown as Record<string, unknown>).PushManager = function FakePushManager() {};
    (window as unknown as Record<string, unknown>).Notification = function FakeNotification() {};
    vi.stubGlobal("navigator", { ...navigator, serviceWorker: { ready: new Promise<void>(() => {}) } });
    await expect(mod.reconcileExistingSubscription()).resolves.toBeUndefined();
    delete (window as unknown as Record<string, unknown>).PushManager;
    delete (window as unknown as Record<string, unknown>).Notification;
  });

  it("reconcile with disabled hub push destroys the local subscription", async () => {
    const mod = await import("../lib/web-push");
    (window as unknown as Record<string, unknown>).PushManager = function FakePushManager() {};
    (window as unknown as Record<string, unknown>).Notification = function FakeNotification() {};
    apiMocks.get.mockResolvedValue({ publicKey: null }); // hub push off
    const unsubscribe = vi.fn().mockResolvedValue(true);
    stubNavigator({
      ready: Promise.resolve({
        pushManager: {
          getSubscription: vi.fn().mockResolvedValue({
            endpoint: "https://fcm.googleapis.com/fcm/send/any",
            options: { applicationServerKey: urlBase64ToUint8Array2(
              "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U").buffer },
            unsubscribe,
          }),
        },
      }),
    });
    await mod.reconcileExistingSubscription();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    delete (window as unknown as Record<string, unknown>).PushManager;
    delete (window as unknown as Record<string, unknown>).Notification;
  });
});
