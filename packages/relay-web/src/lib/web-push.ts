import { ApiError, api } from "../api/client";

/**
 * Push endpoints we accept. The hub POSTes to each endpoint from its own
 * network context — an arbitrary client-supplied HTTPS URL would be a blind
 * SSRF primitive.
 *
 * Allowed providers:
 * - Google FCM: fcm.googleapis.com, fcm.notifications.google.com (Chrome/Chromium)
 * - Apple APNs: *.push.apple.com (Safari on macOS, iOS/iPadOS Home Screen Web Apps)
 */
export function isAllowedPushEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "https:") return false;
    // Push services should only be reachable over normal HTTPS (implicit or 443).
    if (url.port !== "" && url.port !== "443") return false;

    if (
      url.hostname === "fcm.googleapis.com" ||
      url.hostname === "fcm.notifications.google.com"
    ) {
      return true;
    }

    // Apple officially requires allowing any subdomain of push.apple.com.
    if (url.hostname.endsWith(".push.apple.com")) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}
export const DESKTOP_NOTIFICATIONS_ENABLED_KEY = "xrelay.desktopNotificationsEnabled";

export function isDesktopNotificationsEnabled(): boolean {
  try {
    return localStorage.getItem(DESKTOP_NOTIFICATIONS_ENABLED_KEY) === "true";
  } catch {
    return false;
  }
}

export function setDesktopNotificationsEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(DESKTOP_NOTIFICATIONS_ENABLED_KEY, enabled ? "true" : "false");
  } catch { /* ignore */ }
}

/** VAPID public keys are base64url without padding — restore padding before atob. */
export function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
}

export function pushSupported(): boolean {
  return (
    ("serviceWorker" in navigator && "PushManager" in window && "Notification" in window) ||
    ("pushManager" in window && "Notification" in window)
  );
}

/** Compare a stored subscription's applicationServerKey with the hub's current
 *  key. `options.applicationServerKey` is BufferSource | null; normalize both
 *  sides to base64url for equality. */
export function subscriptionMatchesKey(sub: PushSubscription, publicKey: string): boolean {
  const opt = sub.options?.applicationServerKey as BufferSource | null | undefined;
  if (!opt) return false;
  const bytes = opt instanceof ArrayBuffer
    ? new Uint8Array(opt)
    : new Uint8Array((opt as ArrayBufferView).buffer, (opt as ArrayBufferView).byteOffset, (opt as ArrayBufferView).byteLength);
  let raw = "";
  for (const b of bytes) raw += String.fromCharCode(b);
  // Normalize both sides to standard base64 (btoa output form) before
  // comparing — comparing base64url(sub) against raw base64url(hub) would
  // differ on -/_ vs +// characters and never match.
  const subB64 = btoa(raw);
  const paddedHub = publicKey.replace(/-/g, "+").replace(/_/g, "/")
    + "=".repeat((4 - (publicKey.length % 4)) % 4);
  return subB64 === paddedHub;
}

type WindowWithPushManager = Window & {
  pushManager?: PushManager;
};

function getWindowPushManager(): PushManager | null {
  if (typeof window === "undefined") return null;
  return (window as WindowWithPushManager).pushManager ?? null;
}

export interface ExistingSubscriptionTarget {
  sub: PushSubscription | null;
  reg: ServiceWorkerRegistration | null;
  winPm: PushManager | null;
}

/**
 * Probe for an existing push subscription across both the origin-level
 * window.pushManager (Safari 18.4+ Declarative Web Push) and the root-scoped
 * ServiceWorkerRegistration.
 */
export async function getExistingSubscriptionTarget(): Promise<ExistingSubscriptionTarget> {
  const winPm = getWindowPushManager();
  let reg: ServiceWorkerRegistration | null = null;
  if (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof navigator.serviceWorker?.getRegistration === "function"
  ) {
    reg = (await navigator.serviceWorker.getRegistration("/")) ?? null;
  }

  let sub: PushSubscription | null = null;
  // In Safari 18.4+ / Declarative Web Push, window.pushManager represents the
  // origin-level subscription authority and may exist even when no root SW
  // registration is active. Query window.pushManager first.
  if (winPm) {
    sub = (await winPm.getSubscription()) ?? null;
  }
  if (!sub && reg) {
    sub = (await reg.pushManager.getSubscription()) ?? null;
  }

  return { sub, reg, winPm };
}

export async function getExistingSubscription(): Promise<PushSubscription | null> {
  const target = await getExistingSubscriptionTarget();
  return target.sub;
}

export async function fetchVapidPublicKey(): Promise<string | null> {
  try {
    const r = await api.get<{ publicKey: string | null }>("/api/web-push/vapid-public-key");
    return r.publicKey ?? null;
  } catch (err) {
    // Only a 404 means "hub predates this feature" → push disabled. Network
    // failures and 5xx must propagate: treating them as disabled would let
    // reconcile destroy a perfectly good subscription on a transient blip.
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}
export async function enableDesktopNotifications(publicKey: string): Promise<void> {
  if (typeof Notification !== "undefined" && Notification.permission !== "granted") {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") throw new Error("permission-denied");
  }
  try {
    // Creating a subscription requires an ACTIVE worker → ready (which waits
    // for activation) is correct here, unlike the ownership probe below.
    const reg = await navigator.serviceWorker.ready;
    // A subscription minted under an older VAPID key would silently never receive
    // pushes after a hub re-key — replace it instead of failing downstream.
    const existing = await reg.pushManager.getSubscription();
    if (existing && !subscriptionMatchesKey(existing, publicKey)) {
      await existing.unsubscribe();
    }
    const keyBytes = urlBase64ToUint8Array(publicKey);
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: keyBytes.buffer.slice(keyBytes.byteOffset, keyBytes.byteOffset + keyBytes.byteLength) as ArrayBuffer,
    });
    if (!isAllowedPushEndpoint(sub.endpoint)) {
      await sub.unsubscribe().catch(() => {});
      throw new Error("push-endpoint-unsupported");
    }
    await api.put("/api/web-push/subscriptions", sub.toJSON());
    setDesktopNotificationsEnabled(true);
  } catch (err) {
    setDesktopNotificationsEnabled(false);
    throw err;
  }
}

export async function disableDesktopNotifications(): Promise<void> {
  setDesktopNotificationsEnabled(false);
  const target = await getExistingSubscriptionTarget();
  if (!target.sub) return;
  const endpoint = target.sub.endpoint;
  // Local destruction MUST be proven so same-account reload (reconcile)
  // cannot resurrect the subscription.
  await destroyProven(target);

  // Hub binding cleanup: best-effort delete on the server.
  await api
    .del("/api/web-push/subscriptions", { endpoint })
    .catch(() => {});
}

/**
 * The ONE destruction contract for every path that must prove a push binding
 * is dead: unsubscribe() first (fulfilling — true or false — confirms deactivation);
 * on rejection, fall back to unregistering the registration and verifying that
 * both window.pushManager and reg.pushManager resolve null; if neither confirms,
 * THROW — a stale binding surviving an account switch is worse than any error.
 */
async function destroyProven(target: {
  sub: PushSubscription | null;
  reg: ServiceWorkerRegistration | null;
  winPm?: PushManager | null;
}): Promise<void> {
  const winPm = target.winPm ?? getWindowPushManager();

  // 1. If we have a subscription object, try unsubscribing it directly.
  if (target.sub) {
    try {
      await target.sub.unsubscribe();
      // If window.pushManager exists, verify that the origin-level subscription
      // is genuinely dead (null). A rejection during verification is NOT proof
      // of absence — do NOT catch-to-null.
      if (winPm) {
        const stillThere = await winPm.getSubscription();
        if (stillThere === null) return;
      } else {
        return;
      }
    } catch {
      // fall through to registration & origin unregister/probe
    }
  }
  // 2. If a SW registration exists, try unregistering it.
  if (target.reg) {
    try {
      await target.reg.unregister();
    } catch {
      // ignore
    }
  }

  // 3. Prove that NO subscription remains across both window.pushManager and reg.pushManager:
  let winPmDead = true;
  if (winPm) {
    try {
      const gone = await winPm.getSubscription();
      if (gone !== null) winPmDead = false;
    } catch {
      winPmDead = false;
    }
  }

  let regDead = true;
  if (target.reg) {
    try {
      const gone = await target.reg.pushManager.getSubscription();
      if (gone !== null) regDead = false;
    } catch {
      regDead = false;
    }
  }

  if (winPmDead && regDead && (target.sub || target.reg || winPm)) {
    return;
  }

  throw new Error("push-subscription-destroy-failed");
}
/**
 * Auth-lifecycle ownership transfer.
 *
 * - On LOGOUT: drop the browser↔account binding BEFORE /api/logout clears the
 *   session, so the next account on this machine cannot receive (or observe in
 *   Settings) the previous account's notifications.
 * - On LOGIN/fetchMe: bind any pre-existing browser subscription to the now-
 *   authenticated account. If it was minted under an older VAPID key, resubscribe.
 */
export async function releaseSubscriptionOwnership(): Promise<void> {
  if (!pushSupported()) return;
  const target = await getExistingSubscriptionTarget();
  if (!target.sub) return; // nothing held → nothing to release

  // Hub binding first: the session cookie is still valid here, so this is the
  // only chance to delete the server-side row.
  // The hub reports real deletion semantics ({deleted}) — a 200 with
  // deleted:false (endpoint missing or owned by another account) is NOT a
  // proven server-side teardown.
  const hubDeleted = await api
    .del<{ ok: boolean; deleted: boolean }>("/api/web-push/subscriptions", { endpoint: target.sub.endpoint })
    .then((r) => r.deleted === true)
    .catch(() => false);

  // Local destruction must be PROVEN. If it is not, the only safe outcome is a
  // deleted hub row (endpoint can never receive pushes again) — otherwise
  // throw: logout aborts and the user stays logged in as themselves rather
  // than leaving a live, hub-bound subscription on a shared machine.
  try {
    await destroyProven(target);
  } catch (err) {
    if (!hubDeleted) throw err;
  }
}

/**
 * Auth-switch ownership transfer — FAIL-CLOSED.
 *
 * Called on LOGIN with a new token and AWAITED before login reports success:
 * either the browser-held endpoint is successfully rebound to the new account,
 * or the local subscription is destroyed so no stale binding can survive.
 *
 * Any network or hub failure during ownership transfer fails closed (destroys
 * local subscription and throws), allowing login() to abort and revoke.
 */
export async function transferSubscriptionOwnership(): Promise<void> {
  if (!pushSupported()) return;
  let reg: ServiceWorkerRegistration | null = null;
  if (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof navigator.serviceWorker?.getRegistration === "function"
  ) {
    try {
      reg = (await navigator.serviceWorker.getRegistration("/")) ?? null;
    } catch {
      reg = null;
    }
  }
  let target: ExistingSubscriptionTarget;
  try {
    target = await getExistingSubscriptionTarget();
  } catch (err) {
    await destroyProven({ sub: null, reg });
    throw err;
  }
  if (!target.sub) return;

  const sub = target.sub;
  let publicKey: string | null = null;
  try {
    publicKey = await fetchVapidPublicKey();
  } catch (err) {
    await destroyProven(target);
    throw err;
  }
  if (!publicKey) {
    // Hub push disabled -> destroy local sub for hygiene.
    await destroyProven(target);
    return;
  }
  if (!subscriptionMatchesKey(sub, publicKey)) {
    // Stale VAPID key -> destroy old and re-mint under new key.
    await destroyProven(target);
    await api.del("/api/web-push/subscriptions", { endpoint: sub.endpoint }).catch(() => {});
    await enableDesktopNotifications(publicKey);
    return;
  }
  try {
    await api.put("/api/web-push/subscriptions", sub.toJSON());
  } catch (err) {
    await destroyProven(target);
    throw err;
  }
}

/**
 * Same-account session restore reconcile — PRESERVES SUBSCRIPTION on transient network errors.
 *
 * Called by fetchMe() on reload of an existing session:
 * - If the hub explicitly reports push disabled (404/null) -> destroys local sub.
 * - If VAPID key rotated -> destroys old sub and re-mints under new key.
 * - If key matches -> ensures hub has the endpoint (best-effort PUT).
 * - If fetchVapidPublicKey or PUT encounters a transient network error -> does NOT destroy the subscription.
 */
export async function reconcileExistingSubscription(): Promise<void> {
  if (!pushSupported()) return;
  let target: ExistingSubscriptionTarget;
  try {
    target = await getExistingSubscriptionTarget();
  } catch {
    return; // transient local error on reload: keep registration intact
  }
  if (!target.sub) return;

  const sub = target.sub;
  let publicKey: string | null = null;
  try {
    publicKey = await fetchVapidPublicKey();
  } catch {
    // Transient network/5xx error on reload: do NOT destroy the user's subscription.
    return;
  }
  if (!publicKey) {
    // Hub explicitly predates or disabled push (404) -> destroy local sub.
    await destroyProven(target);
    return;
  }
  if (!subscriptionMatchesKey(sub, publicKey)) {
    // Hub rotated VAPID key -> destroy old and re-mint under new key.
    await destroyProven(target);
    await api.del("/api/web-push/subscriptions", { endpoint: sub.endpoint }).catch(() => {});
    await enableDesktopNotifications(publicKey);
    return;
  }
  await api.put("/api/web-push/subscriptions", sub.toJSON()).catch(() => {});
}
