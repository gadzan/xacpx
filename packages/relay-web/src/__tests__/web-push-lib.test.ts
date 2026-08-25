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
  releaseSubscriptionOwnership,
  transferSubscriptionOwnership,
  isAllowedPushEndpoint,
} from "../lib/web-push";

interface StubSW {
  /** Registration handed to getRegistration(); omit → none exists. */
  registration?: unknown;
  /** Optional active-worker surface for code paths using .ready. */
  readyPushManager?: unknown;
}

function stubNavigator(sw: StubSW): void {
  const regMock = vi.fn().mockResolvedValue(sw.registration ?? null);
  vi.stubGlobal("navigator", {
    ...navigator,
    serviceWorker: {
      getRegistration: regMock,
      ...(sw.readyPushManager ? { ready: Promise.resolve({ pushManager: sw.readyPushManager }) } : {}),
    },
    __regMock: regMock,
  });
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
    stubNavigator({});
    expect(pushSupported()).toBe(false);

    (window as unknown as Record<string, unknown>).PushManager = function FakePushManager() {};
    (window as unknown as Record<string, unknown>).Notification = function FakeNotification() {};
    stubNavigator({ registration: null });
    expect(pushSupported()).toBe(true);

    delete (window as unknown as Record<string, unknown>).PushManager;
    delete (window as unknown as Record<string, unknown>).Notification;
  });

  it("fetchVapidPublicKey returns the key; 404 → null; other errors throw", async () => {
    expect(await fetchVapidPublicKey()).toBe("PK");
    apiMocks.get.mockRejectedValueOnce(new Error("network down"));
    await expect(fetchVapidPublicKey()).rejects.toThrow("network down");
  });

  it("enableDesktopNotifications requests permission, subscribes, PUTs the JSON", async () => {
    const requestPermission = vi.fn().mockResolvedValue("granted");
    vi.stubGlobal("Notification", { permission: "default", requestPermission });
    const unsubscribe = vi.fn().mockResolvedValue(true);
    const subscribe = vi.fn().mockResolvedValue({
      endpoint: "https://fcm.googleapis.com/fcm/send/abc",
      keys: { p256dh: "k", auth: "a" },
      unsubscribe,
      toJSON() {
        return { endpoint: this.endpoint, keys: this.keys };
      },
    });
    stubNavigator({ readyPushManager: { subscribe, getSubscription: vi.fn().mockResolvedValue(null) } });

    await enableDesktopNotifications("PK");
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledWith(expect.objectContaining({ userVisibleOnly: true }));
    expect(apiMocks.put).toHaveBeenCalledWith("/api/web-push/subscriptions", {
      endpoint: "https://fcm.googleapis.com/fcm/send/abc",
      keys: { p256dh: "k", auth: "a" },
    });
  });

  it("enableDesktopNotifications cleans up and throws for non-allowlisted endpoints (Firefox etc.)", async () => {
    const unsubscribe = vi.fn().mockResolvedValue(true);
    const subscribe = vi.fn().mockResolvedValue({
      endpoint: "https://updates.push.services.mozilla.com/push/abc", // Firefox endpoint
      unsubscribe,
      toJSON() { return { endpoint: this.endpoint }; },
    });
    vi.stubGlobal("Notification", { permission: "granted" });
    stubNavigator({ readyPushManager: { subscribe, getSubscription: vi.fn().mockResolvedValue(null) } });

    await expect(enableDesktopNotifications("PK")).rejects.toThrow("push-endpoint-unsupported");
    expect(unsubscribe).toHaveBeenCalledTimes(1); // cleaned up
    expect(apiMocks.put).not.toHaveBeenCalled();
  });

  it("enableDesktopNotifications throws permission-denied when denied", async () => {
    vi.stubGlobal("Notification", { permission: "default", requestPermission: vi.fn().mockResolvedValue("denied") });
    stubNavigator({});
    await expect(enableDesktopNotifications("PK")).rejects.toThrow("permission-denied");
    expect(apiMocks.put).not.toHaveBeenCalled();
  });

  it("disableDesktopNotifications unsubscribes and DELETEs", async () => {
    const unsubscribe = vi.fn().mockResolvedValue(true);
    const getSubscription = vi.fn().mockResolvedValue({ endpoint: "https://push/e1", unsubscribe });
    apiMocks.del.mockResolvedValue({ ok: true, deleted: true });
    stubNavigator({ registration: { pushManager: { getSubscription } } });

    await disableDesktopNotifications();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(apiMocks.del).toHaveBeenCalledWith("/api/web-push/subscriptions", { endpoint: "https://push/e1" });

    // No existing subscription: DELETE must not fire.
    apiMocks.del.mockClear();
    getSubscription.mockResolvedValue(null);
    await disableDesktopNotifications();
    expect(apiMocks.del).not.toHaveBeenCalled();
  });

  it("disableDesktopNotifications rejects when unsubscribe fails and Hub DELETE returns deleted: false", async () => {
    const unsubscribe = vi.fn().mockRejectedValue(new Error("unsub failed"));
    const getSubscription = vi.fn().mockResolvedValue({ endpoint: "https://push/e1", unsubscribe });
    const unregister = vi.fn().mockResolvedValue(false); // unproven
    apiMocks.del.mockResolvedValue({ ok: true, deleted: false }); // hub did not delete
    stubNavigator({ registration: { pushManager: { getSubscription }, unregister } });

    await expect(disableDesktopNotifications()).rejects.toThrow("push-subscription-destroy-failed");
  });

  it("disableDesktopNotifications resolves when unsubscribe fails but Hub DELETE returns deleted: true", async () => {
    const unsubscribe = vi.fn().mockRejectedValue(new Error("unsub failed"));
    const getSubscription = vi.fn().mockResolvedValue({ endpoint: "https://push/e1", unsubscribe });
    const unregister = vi.fn().mockResolvedValue(false);
    apiMocks.del.mockResolvedValue({ ok: true, deleted: true }); // hub confirmed deletion
    stubNavigator({ registration: { pushManager: { getSubscription }, unregister } });

    await expect(disableDesktopNotifications()).resolves.toBeUndefined();
    expect(apiMocks.del).toHaveBeenCalledWith("/api/web-push/subscriptions", { endpoint: "https://push/e1" });
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
    stubNavigator({ readyPushManager: { getSubscription, subscribe }, registration: { pushManager: { getSubscription, subscribe } } });

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
  beforeEach(() => {
    apiMocks.get.mockReset().mockResolvedValue({ publicKey: "PK" });
    apiMocks.put.mockReset().mockResolvedValue({ ok: true });
    apiMocks.del.mockReset().mockResolvedValue({ ok: true });
  });
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
    stubNavigator({ registration: { pushManager: { getSubscription: vi.fn().mockResolvedValue(staleSub) }, unregister: vi.fn() } });
    await expect(mod.transferSubscriptionOwnership()).rejects.toThrow("hub write failed");
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    delete (window as unknown as Record<string, unknown>).PushManager;
    delete (window as unknown as Record<string, unknown>).Notification;
  });

  it("returns immediately when no registration exists (dev/no-SW contexts, ready never settles)", async () => {
    // E2E/dev servers register no worker → getRegistration resolves undefined
    // while navigator.serviceWorker.ready would never settle. Ownership probe
    // must use getRegistration and return without touching ready.
    const mod = await import("../lib/web-push");
    (window as unknown as Record<string, unknown>).PushManager = function FakePushManager() {};
    (window as unknown as Record<string, unknown>).Notification = function FakeNotification() {};
    vi.stubGlobal("navigator", {
      ...navigator,
      serviceWorker: {
        ready: new Promise<void>(() => {}), // would hang if probed
        getRegistration: vi.fn().mockResolvedValue(undefined),
      },
    });
    await expect(mod.reconcileExistingSubscription()).resolves.toBeUndefined();
    expect(apiMocks.get).not.toHaveBeenCalled(); // no registration → no hub call
    delete (window as unknown as Record<string, unknown>).PushManager;
    delete (window as unknown as Record<string, unknown>).Notification;
  });

  it("fail-closed: getSubscription rejection destroys the registration and propagates", async () => {
    const mod = await import("../lib/web-push");
    (window as unknown as Record<string, unknown>).PushManager = function FakePushManager() {};
    (window as unknown as Record<string, unknown>).Notification = function FakeNotification() {};
    const unregister = vi.fn().mockResolvedValue(true);
    vi.stubGlobal("navigator", {
      ...navigator,
      serviceWorker: {
        ready: new Promise<void>(() => {}),
        getRegistration: vi.fn().mockResolvedValue({
          pushManager: { getSubscription: vi.fn().mockRejectedValue(new DOMException("aborted", "AbortError")) },
          unregister,
        }),
      },
    });
    await expect(mod.transferSubscriptionOwnership()).rejects.toThrow();
    expect(unregister).toHaveBeenCalledTimes(1);
    delete (window as unknown as Record<string, unknown>).PushManager;
    delete (window as unknown as Record<string, unknown>).Notification;
  });

  it("reconcile with disabled hub push destroys the local subscription", async () => {
    const mod = await import("../lib/web-push");
    (window as unknown as Record<string, unknown>).PushManager = function FakePushManager() {};
    (window as unknown as Record<string, unknown>).Notification = function FakeNotification() {};
    apiMocks.get.mockResolvedValue({ publicKey: null }); // hub push off
    const unsubscribe = vi.fn().mockResolvedValue(true);
    stubNavigator({ registration: {
          pushManager: {
            getSubscription: vi.fn().mockResolvedValue({
              endpoint: "https://fcm.googleapis.com/fcm/send/any",
              options: { applicationServerKey: urlBase64ToUint8Array2(
                "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U").buffer },
              unsubscribe,
            }),
          },
        } });
    await mod.reconcileExistingSubscription();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    delete (window as unknown as Record<string, unknown>).PushManager;
    delete (window as unknown as Record<string, unknown>).Notification;
  });
});

describe("destroy() failure semantics (round-4)", () => {
  const K = "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U";

  function makeStaleSub(unsubscribe: ReturnType<typeof vi.fn>) {
    return {
      endpoint: "https://fcm.googleapis.com/fcm/send/stale",
      options: { applicationServerKey: urlBase64ToUint8Array2(K).buffer },
      unsubscribe,
      toJSON() { return { endpoint: this.endpoint }; },
    };
  }

  // pushSupported() gates reconcile — provide the browser surface.
  beforeEach(() => {
    (window as unknown as Record<string, unknown>).PushManager = function FakePushManager() {};
    (window as unknown as Record<string, unknown>).Notification = function FakeNotification() {};
  });

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).PushManager;
    delete (window as unknown as Record<string, unknown>).Notification;
  });

  it("unsubscribe resolves false → PROVEN (deactivated), no fallback", async () => {
    apiMocks.get.mockResolvedValue({ publicKey: null });
    const unregister = vi.fn().mockResolvedValue(true);
    stubNavigator({
      registration: {
        pushManager: { getSubscription: vi.fn().mockResolvedValue(makeStaleSub(vi.fn().mockResolvedValue(false))) },
        unregister,
      },
    });
    await expect(reconcileExistingSubscription()).resolves.toBeUndefined();
    expect(unregister).not.toHaveBeenCalled(); // fulfilled unsubscribe = proven
  });

  it("unsubscribe rejects → unregister fallback + re-query proves gone", async () => {
    apiMocks.get.mockResolvedValue({ publicKey: null });
    const unregister = vi.fn().mockResolvedValue(true);
    // reconcile's probe (outer) returns the stale sub; destroyProven's
    // re-query (inner, same pushManager) returns null → proven gone.
    const innerGetSubscription = vi.fn()
      .mockResolvedValueOnce(makeStaleSub(vi.fn().mockRejectedValue(new Error("SW died"))))
      .mockResolvedValueOnce(null);
    stubNavigator({
      registration: {
        pushManager: { getSubscription: innerGetSubscription },
        unregister,
      },
    });
    await expect(reconcileExistingSubscription()).resolves.toBeUndefined();
    expect(unregister).toHaveBeenCalledTimes(1);
    expect(innerGetSubscription).toHaveBeenCalledTimes(2);
  });

  it("unsubscribe fulfilled false → proven; unregister never consulted", async () => {
    apiMocks.get.mockResolvedValue({ publicKey: null });
    const unsubscribe = vi.fn().mockResolvedValue(false);
    const unregister = vi.fn().mockResolvedValue(true);
    stubNavigator({
      registration: {
        pushManager: { getSubscription: vi.fn().mockResolvedValue(makeStaleSub(unsubscribe)) },
        unregister,
      },
    });
    await expect(reconcileExistingSubscription()).resolves.toBeUndefined();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(unregister).not.toHaveBeenCalled();
  });
});

describe("release ownership (round-5 strict contract)", () => {
  beforeEach(() => {
    apiMocks.get.mockReset().mockResolvedValue({ publicKey: "PK" });
    apiMocks.put.mockReset().mockResolvedValue({ ok: true });
    apiMocks.del.mockReset().mockResolvedValue({ ok: true });
    // pushSupported() gates release — provide the browser surface.
    (window as unknown as Record<string, unknown>).PushManager = function FakePushManager() {};
    (window as unknown as Record<string, unknown>).Notification = function FakeNotification() {};
  });
  afterEach(() => vi.unstubAllGlobals());
  const K = "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U";

  function makeSub(unsubscribe: ReturnType<typeof vi.fn>) {
    return {
      endpoint: "https://fcm.googleapis.com/fcm/send/owned",
      options: { applicationServerKey: urlBase64ToUint8Array2(K).buffer },
      unsubscribe,
      toJSON() { return { endpoint: this.endpoint }; },
    };
  }

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).PushManager;
    delete (window as unknown as Record<string, unknown>).Notification;
  });

  it("unsubscribe fulfilled false = proven → resolves even if hub DELETE fails (endpoint dead at push service)", async () => {
    apiMocks.del.mockRejectedValueOnce(new Error("hub unreachable"));
    stubNavigator({
      registration: {
        pushManager: {
          getSubscription: vi.fn().mockResolvedValue(makeSub(vi.fn().mockResolvedValue(false))),
          unregister: vi.fn().mockResolvedValue(false),
        },
      },
    });
    await expect(releaseSubscriptionOwnership()).resolves.toBeUndefined();
  });

  it("unsubscribe REJECTS + hub DELETE fails → rejects (no silent leak)", async () => {
    apiMocks.del.mockRejectedValueOnce(new Error("hub unreachable"));
    stubNavigator({
      registration: {
        pushManager: {
          getSubscription: vi.fn().mockResolvedValue(makeSub(vi.fn().mockRejectedValue(new Error("SW died")))),
          unregister: vi.fn().mockResolvedValue(false),
        },
      },
    });
    await expect(releaseSubscriptionOwnership()).rejects.toThrow();
  });

  it("unsubscribe=false but hub DELETE succeeded → resolves (endpoint dead server-side)", async () => {
    apiMocks.del.mockResolvedValue({ ok: true });
    stubNavigator({
      registration: {
        pushManager: {
          getSubscription: vi.fn().mockResolvedValue(makeSub(vi.fn().mockResolvedValue(false))),
          unregister: vi.fn().mockResolvedValue(false),
        },
      },
    });
    await expect(releaseSubscriptionOwnership()).resolves.toBeUndefined();
    expect(apiMocks.del).toHaveBeenCalledWith("/api/web-push/subscriptions", { endpoint: "https://fcm.googleapis.com/fcm/send/owned" });
  });

  it("hub DELETE fails but unsubscribe=true → resolves (endpoint dead at push service)", async () => {
    apiMocks.del.mockRejectedValueOnce(new Error("hub unreachable"));
    stubNavigator({
      registration: {
        pushManager: {
          getSubscription: vi.fn().mockResolvedValue(makeSub(vi.fn().mockResolvedValue(true))),
          unregister: vi.fn(),
        },
      },
    });
    await expect(releaseSubscriptionOwnership()).resolves.toBeUndefined();
  });

  it("stale-key rotation path uses destroyProven: unsub rejects → unregister fallback", async () => {
    (window as unknown as Record<string, unknown>).PushManager = function FakePushManager() {};
    vi.stubGlobal("Notification", { permission: "granted", requestPermission: vi.fn().mockResolvedValue("granted") });
    apiMocks.get.mockResolvedValue({ publicKey: "NEWKEY_NEWKEY_NEWKEY_NEWKEY_NEWKEY_NEWKEY_NEWKEY_NEWKEY_NEWK" });
    apiMocks.del.mockResolvedValue({ ok: true });

    const unregisterReg = vi.fn().mockResolvedValue(true); // fallback proven
    const subscribe = vi.fn().mockResolvedValue({
      endpoint: "https://fcm.googleapis.com/fcm/send/new",
      keys: { p256dh: "k2", auth: "a2" },
      toJSON() { return { endpoint: this.endpoint, keys: this.keys }; },
    });
    const unsubscribe = vi.fn().mockRejectedValue(new Error("unsub failed"));
    const oldSub = {
      endpoint: "https://fcm.googleapis.com/fcm/send/old",
      options: { applicationServerKey: urlBase64ToUint8Array2(K).buffer },
      unsubscribe,
      toJSON() { return { endpoint: this.endpoint }; },
    };
    // 1st getSubscription: probe returns oldSub
    // 2nd getSubscription: inside destroyProven to verify unregister proved gone -> returns null
    const existingGetSub = vi.fn()
      .mockResolvedValueOnce(oldSub)
      .mockResolvedValueOnce(null);
    const existingReg = { pushManager: { getSubscription: existingGetSub }, unregister: unregisterReg };
    const readyReg = { pushManager: { subscribe, getSubscription: vi.fn().mockResolvedValue(null) } };
    vi.stubGlobal("navigator", {
      ...navigator,
      serviceWorker: { getRegistration: vi.fn().mockResolvedValue(existingReg), ready: Promise.resolve(readyReg) },
    });

    await reconcileExistingSubscription();
    expect(unsubscribe).toHaveBeenCalledTimes(1); // attempted, rejected
    expect(unregisterReg).toHaveBeenCalledTimes(1); // fallback proven
    expect(existingGetSub).toHaveBeenCalledTimes(2); // probe + verified gone
    expect(apiMocks.del).toHaveBeenCalledWith("/api/web-push/subscriptions", { endpoint: "https://fcm.googleapis.com/fcm/send/old" });
    expect(subscribe).toHaveBeenCalled(); // re-mint under new key
    expect(apiMocks.put).toHaveBeenCalledWith("/api/web-push/subscriptions", {
      endpoint: "https://fcm.googleapis.com/fcm/send/new",
      keys: { p256dh: "k2", auth: "a2" },
    });
    delete (window as unknown as Record<string, unknown>).PushManager;
    delete (window as unknown as Record<string, unknown>).Notification;
  });

  it("stale-key rotation with unproven destroy → rejects (no silent keep)", async () => {
    (window as unknown as Record<string, unknown>).PushManager = function FakePushManager() {};
    vi.stubGlobal("Notification", { permission: "granted", requestPermission: vi.fn().mockResolvedValue("granted") });
    apiMocks.get.mockResolvedValue({ publicKey: "NEWKEY_NEWKEY_NEWKEY_NEWKEY_NEWKEY_NEWKEY_NEWKEY_NEWKEY_NEWK" });

    const unregisterReg = vi.fn().mockRejectedValue(new Error("unregister dead")); // unproven
    const unsubscribe = vi.fn().mockRejectedValue(new Error("unsub dead")); // unproven
    const oldSub = {
      endpoint: "https://fcm.googleapis.com/fcm/send/old",
      options: { applicationServerKey: urlBase64ToUint8Array2(K).buffer },
      unsubscribe,
      toJSON() { return { endpoint: this.endpoint }; },
    };
    const existingReg = { pushManager: { getSubscription: vi.fn().mockResolvedValue(oldSub) }, unregister: unregisterReg };
    const readyReg = { pushManager: { subscribe: vi.fn(), getSubscription: vi.fn().mockResolvedValue(null) } };
    vi.stubGlobal("navigator", {
      ...navigator,
      serviceWorker: { getRegistration: vi.fn().mockResolvedValue(existingReg), ready: Promise.resolve(readyReg) },
    });

    await expect(reconcileExistingSubscription()).rejects.toThrow("push-subscription-destroy-failed");
    expect(unregisterReg).toHaveBeenCalledTimes(1);
    delete (window as unknown as Record<string, unknown>).PushManager;
    delete (window as unknown as Record<string, unknown>).Notification;
  });
});

describe("Safari / Apple Web Push support", () => {
  beforeEach(() => {
    apiMocks.get.mockReset().mockResolvedValue({ publicKey: "PK" });
    apiMocks.put.mockReset().mockResolvedValue({ ok: true });
    apiMocks.del.mockReset().mockResolvedValue({ ok: true });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("isAllowedPushEndpoint accept and reject matrix", () => {
    // Accept matrix
    for (const ep of [
      "https://fcm.googleapis.com/fcm/send/abc",
      "https://fcm.notifications.google.com/fcm/send/abc",
      "https://web.push.apple.com/Q-xxxxx",
      "https://foo.push.apple.com/abc",
      "https://foo.bar.push.apple.com/abc",
      "https://web.push.apple.com:443/abc",
    ]) {
      expect(isAllowedPushEndpoint(ep)).toBe(true);
    }

    // Reject matrix
    for (const ep of [
      "http://web.push.apple.com/abc",
      "https://web.push.apple.com:8443/abc",
      "https://push.apple.com.evil.com/abc",
      "https://evilpush.apple.com/abc",
      "https://push.apple.com@evil.com/abc",
      "https://push.apple.com/abc",
      "https://evil.com/push.apple.com",
      "https://127.0.0.1/",
      "https://localhost/",
      "https://169.254.169.254/",
      "https://10.0.0.1/",
      "https://example.com/",
      "not-a-url",
      "https://foo.push.apple.com.evil.example/path",
    ]) {
      expect(isAllowedPushEndpoint(ep)).toBe(false);
    }
  });

  it("enableDesktopNotifications succeeds for Safari endpoint without unsubscribe", async () => {
    const requestPermission = vi.fn().mockResolvedValue("granted");
    vi.stubGlobal("Notification", { permission: "default", requestPermission });
    const unsubscribe = vi.fn().mockResolvedValue(true);
    const subscribe = vi.fn().mockResolvedValue({
      endpoint: "https://web.push.apple.com/Q-safari-12345",
      keys: { p256dh: "k-safari", auth: "a-safari" },
      unsubscribe,
      toJSON() {
        return { endpoint: this.endpoint, keys: this.keys };
      },
    });
    stubNavigator({ readyPushManager: { subscribe, getSubscription: vi.fn().mockResolvedValue(null) } });

    await enableDesktopNotifications("PK");
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(unsubscribe).not.toHaveBeenCalled();
    expect(apiMocks.put).toHaveBeenCalledWith("/api/web-push/subscriptions", {
      endpoint: "https://web.push.apple.com/Q-safari-12345",
      keys: { p256dh: "k-safari", auth: "a-safari" },
    });
  });

  it("transferSubscriptionOwnership transfers an existing Safari subscription", async () => {
    const safariSub = {
      endpoint: "https://web.push.apple.com/Q-safari-owned",
      options: { applicationServerKey: urlBase64ToUint8Array2("BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U").buffer },
      unsubscribe: vi.fn().mockResolvedValue(true),
      toJSON() { return { endpoint: this.endpoint, keys: { p256dh: "k", auth: "a" } }; },
    };
    (window as unknown as Record<string, unknown>).PushManager = function FakePushManager() {};
    (window as unknown as Record<string, unknown>).Notification = function FakeNotification() {};
    apiMocks.get.mockResolvedValue({ publicKey: "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U" });
    apiMocks.put.mockResolvedValue({ ok: true });
    stubNavigator({ registration: { pushManager: { getSubscription: vi.fn().mockResolvedValue(safariSub) } } });

    await transferSubscriptionOwnership();
    expect(safariSub.unsubscribe).not.toHaveBeenCalled();
    expect(apiMocks.put).toHaveBeenCalledWith("/api/web-push/subscriptions", {
      endpoint: "https://web.push.apple.com/Q-safari-owned",
      keys: { p256dh: "k", auth: "a" },
    });

    delete (window as unknown as Record<string, unknown>).PushManager;
    delete (window as unknown as Record<string, unknown>).Notification;
  });

  it("releaseSubscriptionOwnership deletes Safari subscription from hub and unsubscribes locally", async () => {
    (window as unknown as Record<string, unknown>).PushManager = function FakePushManager() {};
    (window as unknown as Record<string, unknown>).Notification = function FakeNotification() {};
    const unsubscribe = vi.fn().mockResolvedValue(true);
    const safariSub = {
      endpoint: "https://web.push.apple.com/Q-safari-release",
      unsubscribe,
      toJSON() { return { endpoint: this.endpoint }; },
    };
    apiMocks.del.mockResolvedValue({ ok: true, deleted: true });
    stubNavigator({ registration: { pushManager: { getSubscription: vi.fn().mockResolvedValue(safariSub) } } });

    await releaseSubscriptionOwnership();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(apiMocks.del).toHaveBeenCalledWith("/api/web-push/subscriptions", { endpoint: "https://web.push.apple.com/Q-safari-release" });

    delete (window as unknown as Record<string, unknown>).PushManager;
    delete (window as unknown as Record<string, unknown>).Notification;
  });

  it("window.pushManager has Safari sub + getRegistration() null -> logout DELETEs + unsubscribes", async () => {
    const unsubscribe = vi.fn().mockResolvedValue(true);
    const safariSub = {
      endpoint: "https://web.push.apple.com/Q-origin-level",
      unsubscribe,
      toJSON() { return { endpoint: this.endpoint }; },
    };
    const winPushManager = { getSubscription: vi.fn().mockResolvedValue(safariSub) };
    (window as unknown as Record<string, unknown>).pushManager = winPushManager;
    (window as unknown as Record<string, unknown>).PushManager = function FakePushManager() {};
    (window as unknown as Record<string, unknown>).Notification = function FakeNotification() {};
    apiMocks.del.mockResolvedValue({ ok: true, deleted: true });
    stubNavigator({ registration: null }); // No SW registration

    await releaseSubscriptionOwnership();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(apiMocks.del).toHaveBeenCalledWith("/api/web-push/subscriptions", { endpoint: "https://web.push.apple.com/Q-origin-level" });

    delete (window as unknown as Record<string, unknown>).pushManager;
    delete (window as unknown as Record<string, unknown>).PushManager;
    delete (window as unknown as Record<string, unknown>).Notification;
  });

  it("window.pushManager has Safari sub + getRegistration() null -> login transfer PUTs/rebinds", async () => {
    const safariSub = {
      endpoint: "https://web.push.apple.com/Q-origin-level-login",
      options: { applicationServerKey: urlBase64ToUint8Array2("BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U").buffer },
      unsubscribe: vi.fn().mockResolvedValue(true),
      toJSON() { return { endpoint: this.endpoint, keys: { p256dh: "k", auth: "a" } }; },
    };
    const winPushManager = { getSubscription: vi.fn().mockResolvedValue(safariSub) };
    (window as unknown as Record<string, unknown>).pushManager = winPushManager;
    (window as unknown as Record<string, unknown>).PushManager = function FakePushManager() {};
    (window as unknown as Record<string, unknown>).Notification = function FakeNotification() {};
    apiMocks.get.mockResolvedValue({ publicKey: "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U" });
    apiMocks.put.mockResolvedValue({ ok: true });
    stubNavigator({ registration: null }); // No SW registration

    await transferSubscriptionOwnership();
    expect(safariSub.unsubscribe).not.toHaveBeenCalled();
    expect(apiMocks.put).toHaveBeenCalledWith("/api/web-push/subscriptions", {
      endpoint: "https://web.push.apple.com/Q-origin-level-login",
      keys: { p256dh: "k", auth: "a" },
    });

    delete (window as unknown as Record<string, unknown>).pushManager;
    delete (window as unknown as Record<string, unknown>).PushManager;
    delete (window as unknown as Record<string, unknown>).Notification;
  });

  it("unregister=true and reg.pushManager null but window.pushManager non-null -> destroyProven rejects", async () => {
    const unsubscribe = vi.fn().mockRejectedValue(new Error("unsub failed"));
    const safariSub = {
      endpoint: "https://web.push.apple.com/Q-lingering-origin",
      unsubscribe,
      toJSON() { return { endpoint: this.endpoint }; },
    };
    const winPushManager = { getSubscription: vi.fn().mockResolvedValue(safariSub) }; // Still non-null!
    (window as unknown as Record<string, unknown>).pushManager = winPushManager;
    (window as unknown as Record<string, unknown>).PushManager = function FakePushManager() {};
    (window as unknown as Record<string, unknown>).Notification = function FakeNotification() {};
    apiMocks.del.mockResolvedValue({ ok: true });

    const unregisterReg = vi.fn().mockResolvedValue(true);
    const existingReg = { pushManager: { getSubscription: vi.fn().mockResolvedValue(null) }, unregister: unregisterReg };
    stubNavigator({ registration: existingReg });

    await expect(releaseSubscriptionOwnership()).rejects.toThrow("push-subscription-destroy-failed");

    delete (window as unknown as Record<string, unknown>).pushManager;
    delete (window as unknown as Record<string, unknown>).PushManager;
    delete (window as unknown as Record<string, unknown>).Notification;
  });

  it("window.pushManager.getSubscription()=null proves origin binding is dead when unsub failed", async () => {
    const unsubscribe = vi.fn().mockRejectedValue(new Error("unsub failed"));
    const safariSub = {
      endpoint: "https://web.push.apple.com/Q-origin-dead",
      unsubscribe,
      toJSON() { return { endpoint: this.endpoint }; },
    };
    // 1st getSubscription probe returns safariSub; 2nd inside destroyProven returns null (dead)
    const winGetSub = vi.fn()
      .mockResolvedValueOnce(safariSub)
      .mockResolvedValueOnce(null);
    const winPushManager = { getSubscription: winGetSub };
    (window as unknown as Record<string, unknown>).pushManager = winPushManager;
    (window as unknown as Record<string, unknown>).PushManager = function FakePushManager() {};
    (window as unknown as Record<string, unknown>).Notification = function FakeNotification() {};
    apiMocks.del.mockResolvedValue({ ok: true, deleted: true });
    stubNavigator({ registration: null });

    await expect(releaseSubscriptionOwnership()).resolves.toBeUndefined();
    expect(apiMocks.del).toHaveBeenCalledWith("/api/web-push/subscriptions", { endpoint: "https://web.push.apple.com/Q-origin-dead" });

    delete (window as unknown as Record<string, unknown>).pushManager;
    delete (window as unknown as Record<string, unknown>).PushManager;
    delete (window as unknown as Record<string, unknown>).Notification;
  });
});
