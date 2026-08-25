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
  // The hub only POSTes to allowlisted Chrome push-service origins — a
  // non-Chrome browser would subscribe fine and then fail on the PUT. Detect
  // that here, clean up, and surface as unsupported.
  if (!isAllowedPushEndpoint(sub.endpoint)) {
    await sub.unsubscribe().catch(() => {});
    throw new Error("push-endpoint-unsupported");
  }
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
  // Push API: unsubscribe() fulfilling — true OR false — means the
  // subscription is deactivated and can no longer receive pushes. Both count
  // as proven destruction.
  if (target.sub) {
    try {
      await target.sub.unsubscribe();
      return;
    } catch {
      // fall through to registration-level proof
    }
  }
  if (target.reg) {
    // unregister() === true does NOT prove the push binding died (a concurrent
    // register() can resurrect the registration, and "/"-scope unregister need
    // not deactivate push subscriptions). Prove by re-querying: the push
    // subscription must PROVABLY resolve null. If getSubscription rejects or
    // returns non-null, it is unproven.
    const unregistered = await target.reg.unregister().catch(() => false);
    if (unregistered === true) {
      try {
        const gone = await target.reg.pushManager.getSubscription();
        if (gone === null) return;
      } catch {
        // rejection on re-query does NOT prove gone; fall through to throw
      }
    }
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
  // The hub reports real deletion semantics ({deleted}) — a 200 with
  // deleted:false (endpoint missing or owned by another account) is NOT a
  // proven server-side teardown.
  const hubDeleted = await api
    .del<{ ok: boolean; deleted: boolean }>("/api/web-push/subscriptions", { endpoint: sub.endpoint })
    .then((r) => r.deleted === true)
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
 * Called on LOGIN with a new token and AWAITED before login reports success:
 * either the browser-held endpoint is successfully rebound to the new account,
 * or the local subscription is destroyed so no stale binding can survive.
 *
 * Any network or hub failure during ownership transfer fails closed (destroys
 * local subscription and throws), allowing login() to abort and revoke.
 */
export async function transferSubscriptionOwnership(): Promise<void> {
  if (!pushSupported()) return;
  const reg = await getExistingRegistration();
  let sub: PushSubscription | null = null;
  if (reg) {
    try {
      sub = await reg.pushManager.getSubscription();
    } catch (err) {
      await destroyProven({ sub: null, reg });
      throw err;
    }
  }
  if (!sub) return;

  let publicKey: string | null = null;
  try {
    publicKey = await fetchVapidPublicKey();
  } catch (err) {
    await destroyProven({ sub, reg });
    throw err;
  }
  if (!publicKey) {
    // Hub push disabled -> destroy local sub for hygiene.
    await destroyProven({ sub, reg });
    return;
  }
  if (!subscriptionMatchesKey(sub, publicKey)) {
    // Stale VAPID key -> destroy old and re-mint under new key.
    await destroyProven({ sub, reg });
    await api.del("/api/web-push/subscriptions", { endpoint: sub.endpoint }).catch(() => {});
    await enableDesktopNotifications(publicKey);
    return;
  }
  try {
    await api.put("/api/web-push/subscriptions", sub.toJSON());
  } catch (err) {
    await destroyProven({ sub, reg });
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
  const reg = await getExistingRegistration();
  let sub: PushSubscription | null = null;
  if (reg) {
    try {
      sub = await reg.pushManager.getSubscription();
    } catch {
      return; // transient local error on reload: keep registration intact
    }
  }
  if (!sub) return;

  let publicKey: string | null = null;
  try {
    publicKey = await fetchVapidPublicKey();
  } catch {
    // Transient network/5xx error on reload: do NOT destroy the user's subscription.
    return;
  }
  if (!publicKey) {
    // Hub explicitly predates or disabled push (404) -> destroy local sub.
    await destroyProven({ sub, reg });
    return;
  }
  if (!subscriptionMatchesKey(sub, publicKey)) {
    // Hub rotated VAPID key -> destroy old and re-mint under new key.
    await destroyProven({ sub, reg });
    await api.del("/api/web-push/subscriptions", { endpoint: sub.endpoint }).catch(() => {});
    await enableDesktopNotifications(publicKey);
    return;
  }
  await api.put("/api/web-push/subscriptions", sub.toJSON()).catch(() => {});
}
