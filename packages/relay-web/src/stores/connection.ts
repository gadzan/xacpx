import { defineStore } from "pinia";
import { ref } from "vue";

/** How long a drop stays neutral before it reads as a warning. */
export const RECONNECTING_MS = 3_000;
/** How long a drop stays a warning before it reads as an error. */
export const OFFLINE_WARN_MS = 30_000;

/**
 * The badge's rendering states.
 *
 * `connecting` is the first-load neutral state: no socket has opened yet in
 * this page lifetime, so nothing is known to be wrong. `reconnecting` is a
 * fresh drop, still inside the neutral window. `degraded` and `lost` are the
 * same drop past the warn and error thresholds.
 */
export type ConnectionStatus = "connecting" | "online" | "reconnecting" | "degraded" | "lost";

export interface ConnectionStatusInput {
  online: boolean;
  /** True once any control socket has opened in this page lifetime. */
  everOpened: boolean;
  /** Milliseconds since the drop, or null when the socket never dropped. */
  offlineMs: number | null;
}

export function connectionStatus({
  online,
  everOpened,
  offlineMs,
}: ConnectionStatusInput): ConnectionStatus {
  if (online) return "online";
  if (!everOpened) return "connecting";
  const down = offlineMs ?? 0;
  if (down < RECONNECTING_MS) return "reconnecting";
  if (down < OFFLINE_WARN_MS) return "degraded";
  return "lost";
}

export const useConnectionStore = defineStore("connection", () => {
  const online = ref(false);
  const everOpened = ref(false);
  /** Epoch ms of the current drop, or null while online / before any drop. */
  const offlineSince = ref<number | null>(null);

  function setStatus(next: { online: boolean; everOpened: boolean }): void {
    online.value = next.online;
    everOpened.value = next.everOpened;
    // A repeated offline report must not restart the warn/error clock.
    offlineSince.value = next.online ? null : (offlineSince.value ?? Date.now());
  }

  return { online, everOpened, offlineSince, setStatus };
});
