import { api } from "../api/client";

/**
 * Push endpoints we accept. This PR supports Chrome only, and the hub POSTes
 * to each endpoint from its own network context — an arbitrary client-supplied
 * HTTPS URL would be a blind SSRF primitive. Restrict to Google's public push
 * service (Chrome routes FCM endpoints); widen deliberately if Firefox/Safari
 * support ever lands (then: mozilla + apple push origins).
 */
const ALLOWED_ENDPOINT_ORIGINS: Record<string, true> = {
  "https://fcm.googleapis.com": true,
  "https://fcm.notifications.google.com": true,
};

/** True when a subscription endpoint is one this hub will actually POST to. */
export function isAllowedPushEndpoint(endpoint: string): boolean {
  try {
    return ALLOWED_ENDPOINT_ORIGINS[new URL(endpoint).origin] === true;
  } catch {
    return false;
  }
}

/** VAPID public keys are base64url without padding — restore padding before atob. */
export function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
}

export function pushSupported(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
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

/**
 * The EXISTING registration for this origin (scope "/"), or null when none has
 * ever been created. Unlike navigator.serviceWorker.ready — which never
 * settles on dev servers / insecure contexts where nothing registers —
 * getRegistration() answers immediately in every environment, so auth can
 * probe for leftover push state without waiting.
 *
 * `ready` remains correct for CREATING a subscription (enable path), where an
 * active worker is genuinely required.
 */
async function getExistingRegistration(): Promise<ServiceWorkerRegistration | null> {
  return (await navigator.serviceWorker.getRegistration("/")) ?? null;
}

export async function fetchVapidPublicKey(): Promise<string | null> {
  try {
    const r = await api.get<{ publicKey: string | null }>("/api/web-push/vapid-public-key");
    return r.publicKey ?? null;
  } catch {
    return null; // hub older than this feature: treat as disabled
  }
}

export async function enableDesktopNotifications(publicKey: string): Promise<void> {
  if (typeof Notification !== "undefined" && Notification.permission !== "granted") {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") throw new Error("permission-denied");
  }
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
    // BufferSource: hand over the exact ArrayBuffer slice (TS lib types the
    // generic buffer loosely, so assert once at this boundary).
    applicationServerKey: keyBytes.buffer.slice(keyBytes.byteOffset, keyBytes.byteOffset + keyBytes.byteLength) as ArrayBuffer,
  });
  await api.put("/api/web-push/subscriptions", sub.toJSON());
}

export async function disableDesktopNotifications(): Promise<void> {
  const reg = await getExistingRegistration();
  if (!reg) return; // no registration: there is no subscription to drop
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  const endpoint = sub.endpoint;
  await sub.unsubscribe();
  await api.del("/api/web-push/subscriptions", { endpoint });
}

/**
 * The ONE destruction contract for every path that must prove a push binding
 * is dead: unsubscribe() first; on rejection or a `false` return, fall back to
 * unregistering the whole registration; if neither confirms, THROW — a stale
 * binding surviving an account switch is worse than any error.
 */
async function destroyProven(target: {
  sub: PushSubscription | null;
  reg: ServiceWorkerRegistration | null;
}): Promise<void> {
  console.log("DP_ENTRY sub:", !!target.sub, "regKeys:", target.reg ? Object.keys(target.reg) : null);
  if (target.sub) {
    const unsubscribed = await target.sub.unsubscribe().catch(() => false);
    if (unsubscribed === true) return;
  }
  if (target.reg) {
    const unregistered = await target.reg.unregister().catch(() => false);
    if (unregistered === true) return;
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
  const reg = await getExistingRegistration();
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  if (!sub) return; // nothing held → nothing to release

  // Hub binding first: the session cookie is still valid here, so this is the
  // only chance to delete the server-side row.
  const hubDeleted = await api
    .del("/api/web-push/subscriptions", { endpoint: sub.endpoint })
    .then(() => true)
    .catch(() => false);

  // Local destruction must be PROVEN. If it is not, the only safe outcome is a
  // deleted hub row (endpoint can never receive pushes again) — otherwise
  // throw: logout aborts and the user stays logged in as themselves rather
  // than leaving a live, hub-bound subscription on a shared machine.
  try {
    await destroyProven({ sub, reg });
  } catch (err) {
    if (!hubDeleted) throw err;
  }
}

/**
 * Auth-switch ownership transfer — FAIL-CLOSED.
 *
 * Called by login()/fetchMe() and AWAITED before they report success: either
 * the browser-held endpoint is successfully rebound to the current account, or
 * the local subscription is destroyed so no stale binding can survive. Any
 * failure along the way unsubscribes locally (belt) and throws (suspenders) —
 * the caller surfaces it instead of silently leaving a leak window.
 *
 * No-op when there is nothing to bind or the hub has push disabled.
 */
export async function reconcileExistingSubscription(): Promise<void> {
  if (!pushSupported()) return;
  // Probe the EXISTING registration (never `ready`): it settles immediately in
  // every environment and cannot confuse "no registration yet" with "worker
  // still activating". Everything below is fail-closed: if we cannot PROVE the
  // leftover subscription's ownership was transferred, destroy it locally.
  const reg = await getExistingRegistration();

  // getSubscription can reject (e.g. AbortError when the registration's active
  // worker is gone). Ownership is then UNPROVABLE → destroy the registration
  // and fail closed rather than assume "nothing held".
  let sub: PushSubscription | null = null;
  if (reg) {
    try {
      sub = await reg.pushManager.getSubscription();
    } catch (err) {
      await destroyProven({ sub: null, reg });
      throw err;
    }
  }
  if (!sub) return; // provably nothing held → no transfer needed

  let publicKey: string | null = null;
  try {
    publicKey = await fetchVapidPublicKey();
  } catch (err) {
    // Cannot even ask the hub → ownership unknown → fail closed.
    await destroyProven({ sub, reg });
    throw err;
  }
  if (!publicKey) {
    // Hub push disabled → the row can never fire for any account. Destroy the
    // local binding: destroyProven throws if neither unsubscribe nor unregister
    // confirmed success, failing login rather than leaving an unproven sub.
    await destroyProven({ sub, reg });
    return;
  }
  if (!subscriptionMatchesKey(sub, publicKey)) {
    // Stale VAPID key: pushes can never succeed. Destroy (proven) + re-mint.
    await destroyProven({ sub, reg });
    await api.del("/api/web-push/subscriptions", { endpoint: sub.endpoint }).catch(() => {});
    await enableDesktopNotifications(publicKey);
    return;
  }
  // Key matches → rebind to the CURRENT account. If this PUT fails, the old
  // binding may still point at the previous account → fail closed below.
  try {
    await api.put("/api/web-push/subscriptions", sub.toJSON());
  } catch (err) {
    // Fail closed: a half-transferred ownership is worse than no subscription.
    await destroyProven({ sub, reg });
    throw err;
  }
}
