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
    stubNavigator({ ready: Promise.resolve({ pushManager: { subscribe } }) });

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

  it("reconcileExistingSubscription PUTs an existing subscription; skips otherwise", async () => {
    // pushSupported() gates reconcile: provide the full environment.
    (window as unknown as Record<string, unknown>).PushManager = function FakePushManager() {};
    (window as unknown as Record<string, unknown>).Notification = function FakeNotification() {};
    const getSubscription = vi.fn().mockResolvedValue({
      endpoint: "https://push/e1",
      toJSON() {
        return { endpoint: this.endpoint };
      },
    });
    stubNavigator({ ready: Promise.resolve({ pushManager: { getSubscription } }) });
    await reconcileExistingSubscription();
    expect(apiMocks.put).toHaveBeenCalledWith("/api/web-push/subscriptions", { endpoint: "https://push/e1" });

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
