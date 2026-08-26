import { i18n } from "../i18n";
import { isDesktopNotificationsEnabled } from "./web-push";

export interface LocalTurnNotificationInput {
  instanceId: string;
  instanceName: string;
  sessionAlias: string;
  ok: boolean;
  text?: string;
  errorMessage?: string;
}

export const LOCAL_NOTIFICATION_BODY_CAP = 200;
const ACTIVE_FOCUS_KEY = "xrelay.activeFocus";
const NOTIF_SLOT_PREFIX = "xrelay.notif_slot:";
const FOCUS_HEARTBEAT_WINDOW_MS = 4000;
const DEDUP_SLOT_WINDOW_MS = 4000;

type NotificationClickHandler = (instanceId: string, sessionAlias: string) => void;
let globalClickHandler: NotificationClickHandler | null = null;

export function setNotificationClickHandler(handler: NotificationClickHandler | null): void {
  globalClickHandler = handler;
}

export function triggerNotificationClick(instanceId: string, sessionAlias: string): void {
  if (typeof window !== "undefined") {
    try { window.focus(); } catch { /* ignore */ }
  }
  if (globalClickHandler && instanceId && sessionAlias) {
    try { globalClickHandler(instanceId, sessionAlias); } catch { /* ignore */ }
  }
}

/**
 * Records that the current window is focused and viewing the specified session.
 * Used for cross-tab active tab suppression so background tabs don't pop alerts.
 */
export function recordTabFocus(instanceId?: string | null, sessionAlias?: string | null): void {
  if (typeof localStorage === "undefined") return;
  if (!instanceId || !sessionAlias) {
    try { localStorage.removeItem(ACTIVE_FOCUS_KEY); } catch { /* ignore */ }
    return;
  }
  if (typeof document !== "undefined" && !document.hidden && (typeof document.hasFocus !== "function" || document.hasFocus())) {
    try {
      localStorage.setItem(
        ACTIVE_FOCUS_KEY,
        JSON.stringify({ instanceId, sessionAlias, at: Date.now() }),
      );
    } catch { /* ignore */ }
  }
}

/**
 * Checks if the target session is currently focused and active in ANY tab.
 */
export function isSessionActiveInAnyTab(
  targetInstanceId: string,
  targetSessionAlias: string,
  currentTabSelected = false,
): boolean {
  // 1. Current tab check
  if (
    currentTabSelected &&
    typeof document !== "undefined" &&
    !document.hidden &&
    (typeof document.hasFocus !== "function" || document.hasFocus())
  ) {
    return true;
  }

  // 2. Cross-tab check via localStorage focus heartbeat
  if (typeof localStorage === "undefined") return false;
  try {
    const raw = localStorage.getItem(ACTIVE_FOCUS_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw) as { instanceId?: unknown; sessionAlias?: unknown; at?: unknown };
    if (
      typeof parsed.instanceId === "string" &&
      typeof parsed.sessionAlias === "string" &&
      typeof parsed.at === "number" &&
      parsed.instanceId === targetInstanceId &&
      parsed.sessionAlias === targetSessionAlias &&
      Date.now() - parsed.at < FOCUS_HEARTBEAT_WINDOW_MS
    ) {
      return true;
    }
  } catch { /* ignore parse error */ }

  return false;
}

/**
 * Claims the notification slot for this (instanceId, sessionAlias) turn finish.
 * Returns true if this tab is the first to claim the slot; false if another tab claimed it.
 */
export function claimNotificationSlot(
  instanceId: string,
  sessionAlias: string,
  windowMs = DEDUP_SLOT_WINDOW_MS,
): boolean {
  if (typeof localStorage === "undefined") return true;
  const key = `${NOTIF_SLOT_PREFIX}${instanceId}:${sessionAlias}`;
  const now = Date.now();
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const at = Number(raw);
      if (Number.isFinite(at) && now - at < windowMs) {
        return false; // Another tab already emitted notification for this turn
      }
    }
    localStorage.setItem(key, String(now));
    return true;
  } catch {
    return true;
  }
}

function getLocalizedText(key: string, params?: Record<string, unknown>, fallback = ""): string {
  try {
    if (i18n && i18n.global && typeof i18n.global.t === "function") {
      const val = i18n.global.t(key, params ?? {});
      if (typeof val === "string" && val.length > 0 && val !== key) return val;
    }
  } catch { /* fallback */ }
  return fallback;
}

export function formatNotificationBody(ok: boolean, text?: string, errorMessage?: string): string {
  if (ok) {
    const trimmed = (text ?? "").trim();
    if (trimmed.length > 0) return trimmed.slice(0, LOCAL_NOTIFICATION_BODY_CAP);
    return getLocalizedText("notifications.taskCompleted", {}, "Task completed");
  }

  const trimmedErr = (errorMessage ?? "").trim();
  const errDesc = trimmedErr.length > 0 ? trimmedErr : getLocalizedText("notifications.unknownError", {}, "Unknown error");
  const template = getLocalizedText("notifications.taskFailed", { error: errDesc }, `Task failed: ${errDesc}`);
  return template.slice(0, LOCAL_NOTIFICATION_BODY_CAP);
}

async function getReadyServiceWorker(timeoutMs = 250): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
  try {
    // 1. Fast path: check if registration is already active
    if (typeof navigator.serviceWorker.getRegistration === "function") {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg && reg.active && typeof reg.showNotification === "function") {
        return reg;
      }
    }
    // 2. Bounded race with ready promise to avoid hanging forever
    const readyPromise = navigator.serviceWorker.ready;
    const timeoutPromise = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs));
    const readyReg = await Promise.race([readyPromise, timeoutPromise]);
    if (readyReg && typeof readyReg.showNotification === "function") {
      return readyReg;
    }
  } catch { /* fallback */ }
  return null;
}

/**
 * Emits a local browser desktop notification when an agent turn completes.
 * Fallback for environments where Web Push (FCM/APNs) is unavailable or blocked by network.
 * Suppressed if desktop notifications are disabled in settings or permission is not granted.
 */
export async function showLocalTurnNotification(input: LocalTurnNotificationInput): Promise<void> {
  if (typeof window === "undefined" || typeof Notification === "undefined") return;
  if (!isDesktopNotificationsEnabled()) return;
  if (Notification.permission !== "granted") return;

  const title = `${input.instanceName} · ${input.sessionAlias}`;
  const body = formatNotificationBody(input.ok, input.text, input.errorMessage);

  const options: NotificationOptions = {
    body,
    tag: `xacpx-turn:${input.instanceId}:${input.sessionAlias}`,
    icon: "/pwa-192x192.png",
    data: {
      instanceId: input.instanceId,
      sessionAlias: input.sessionAlias,
      url: "/",
    },
  };

  // 1. Prefer ServiceWorkerRegistration.showNotification (with bounded lookup timeout)
  try {
    const swReg = await getReadyServiceWorker(250);
    if (swReg) {
      await swReg.showNotification(title, options);
      return;
    }
  } catch { /* Fall back to standard Notification API */ }

  // 2. Fall back to standard DOM Notification
  try {
    const n = new Notification(title, options);
    n.onclick = () => {
      triggerNotificationClick(input.instanceId, input.sessionAlias);
      try { n.close(); } catch { /* ignore */ }
    };
  } catch {
    // Ignore environments where constructor is restricted
  }
}
