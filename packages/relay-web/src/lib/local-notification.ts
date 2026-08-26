export interface LocalTurnNotificationInput {
  instanceId: string;
  instanceName: string;
  sessionAlias: string;
  ok: boolean;
  text?: string;
  errorMessage?: string;
}

export const LOCAL_NOTIFICATION_BODY_CAP = 200;

/**
 * Emits a local browser desktop notification when an agent turn completes.
 * Fallback for environments where Web Push (FCM/APNs) is unavailable or blocked by network.
 * Suppressed if Notification.permission !== "granted".
 */
export async function showLocalTurnNotification(input: LocalTurnNotificationInput): Promise<void> {
  if (typeof window === "undefined" || typeof Notification === "undefined") return;
  if (Notification.permission !== "granted") return;

  const title = `${input.instanceName} · ${input.sessionAlias}`;
  let body: string;
  if (input.ok) {
    const trimmed = (input.text ?? "").trim();
    body = (trimmed.length > 0 ? trimmed : "Task completed").slice(0, LOCAL_NOTIFICATION_BODY_CAP);
  } else {
    const errMsg = (input.errorMessage ?? "").trim();
    body = `Task failed: ${errMsg || "Unknown error"}`.slice(0, LOCAL_NOTIFICATION_BODY_CAP);
  }

  const options: NotificationOptions = {
    body,
    tag: `xacpx-task:${input.instanceId}`,
    icon: "/pwa-192x192.png",
    data: {
      instanceId: input.instanceId,
      sessionAlias: input.sessionAlias,
      url: "/",
    },
  };

  // 1. Prefer ServiceWorkerRegistration.showNotification (unified with push-sw.js)
  try {
    if ("serviceWorker" in navigator) {
      const reg = await navigator.serviceWorker.ready;
      if (reg && typeof reg.showNotification === "function") {
        await reg.showNotification(title, options);
        return;
      }
    }
  } catch {
    // Fall back to standard Notification API
  }

  // 2. Fall back to standard DOM Notification
  try {
    const n = new Notification(title, options);
    n.onclick = () => {
      try { window.focus(); } catch { /* ignore */ }
      try { n.close(); } catch { /* ignore */ }
    };
  } catch {
    // Ignore environments where constructor is restricted
  }
}
