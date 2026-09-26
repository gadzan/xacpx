// Desktop session: one noVNC lifecycle per instance. The VNC password lives
// only in this store's memory (never localStorage/sessionStorage); tickets
// are single-use, so every reconnect re-issues desktop-open over /ws.
import { defineStore } from "pinia";
import { ref } from "vue";

import {
  DESKTOP_RPC_TIMEOUT_MS,
  type DesktopSecurityKind,
} from "@ganglion/xacpx-relay-protocol";
import {
  DesktopRequestError,
  isRetryableDesktopError,
  nextDesktopRequestId,
  requestDesktop,
  sendWebClientMessage,
} from "../api/events";
import { connectDesktopRfb, type DesktopRfbConnection, type DesktopRfbHooks } from "../lib/desktop-client";
import { supportsDesktop } from "./instances";

export type DesktopStatus =
  | "idle"
  | "opening"
  | "auth-required"
  | "connecting"
  | "open"
  | "closed"
  | "error";

export interface DesktopSessionView {
  instanceId: string;
  status: DesktopStatus;
  streamId?: string;
  security?: DesktopSecurityKind;
  needsPassword: boolean;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  fit: boolean;
}

function errorMessageFor(code: string, fallback: string): string {
  return fallback || code;
}

export const useDesktopStore = defineStore("desktop", () => {
  const sessions = ref(new Map<string, DesktopSessionView>());
  const connections = new Map<string, DesktopRfbConnection>();
  // Own the abort handle for in-flight `desktop-open`s: close()/unmount()/instance
  // change arrive BEFORE prepare resolves, so the component's own AbortController
  // (if any) must not be the only way to abandon a pending stream. Without this a
  // close during prepare leaves the panel gone while the RPC continues, and
  // `desktop-opened` later resurrects the session on an unmounted target.
  const pending = new Map<string, AbortController>();

  function viewFor(instanceId: string): DesktopSessionView {
    let view = sessions.value.get(instanceId);
    if (!view) {
      view = { instanceId, status: "idle", needsPassword: false, fit: true };
      sessions.value.set(instanceId, view);
    }
    return view;
  }

  function patch(instanceId: string, patch: Partial<DesktopSessionView>): DesktopSessionView {
    const view = { ...viewFor(instanceId), ...patch, instanceId };
    sessions.value.set(instanceId, view);
    return view;
  }

  function canOpen(instance: { online: boolean; capabilities?: string[] | null }): boolean {
    return supportsDesktop(instance);
  }

  async function open(
    instanceId: string,
    hooks: DesktopRfbHooks,
    opts: { signal?: AbortSignal; target?: HTMLElement | null } = {},
  ): Promise<void> {
    const existing = connections.get(instanceId);
    if (existing) return;
    // A superseding open aborts the previous pending prepare: its streamId never
    // existed yet, so it can only be closed by the cloud, never desynced here.
    pending.get(instanceId)?.abort();
    const controller = new AbortController();
    pending.set(instanceId, controller);
    const view = patch(instanceId, { status: "opening", lastErrorCode: undefined, lastErrorMessage: undefined });
    void view;
    let opened;
    try {
      opened = await requestDesktop(
        { kind: "desktop-open", requestId: nextDesktopRequestId(), instanceId },
        { timeoutMs: DESKTOP_RPC_TIMEOUT_MS },
      );
    } catch (err) {
      if (controller.signal.aborted || opts.signal?.aborted) {
        // Abandoned: close() already deleted the session row. Patching here
        // (even to "error") would recreate a row for a gone panel, and the hub
        // already reaps the stream via its TTL sweep.
        throw err;
      }
      const code = err instanceof DesktopRequestError ? err.code : "desktop-protocol-error";
      patch(instanceId, {
        status: isRetryableDesktopError(code) ? "closed" : "error",
        lastErrorCode: code,
        lastErrorMessage: errorMessageFor(code, err instanceof Error ? err.message : String(err)),
      });
      throw err;
    } finally {
      // Identity-safe cleanup: a newer open() for the same instance may have
      // already replaced the entry (A aborted → B opened while A's prepare was
      // still in flight). Deleting unconditionally would orphan B's controller
      // so a later close() could not abort it.
      if (pending.get(instanceId) === controller) pending.delete(instanceId);
    }
    if (controller.signal.aborted || opts.signal?.aborted) {
      // Abandoned mid-prepare: the hub already minted a stream + browser ticket,
      // so close it now instead of letting it linger as an orphan stream. The
      // session row must also go: `viewFor`'s lazy recreate would otherwise
      // resurrect an idle row for a panel that is already gone.
      sendWebClientMessage({ kind: "desktop-close", instanceId, streamId: opened.streamId });
      sessions.value.delete(instanceId);
      return;
    }
    patch(instanceId, {
      status: opened.security === "ard" ? "error" : "connecting",
      streamId: opened.streamId,
      security: opened.security,
      needsPassword: false,
      ...(opened.security === "ard"
        ? { lastErrorCode: "desktop-auth-unsupported", lastErrorMessage: "ARD auth needs Phase B" }
        : {}),
    });
    if (opened.security !== "vnc-auth") return;
    const url = desktopBinaryUrl(opened.wsPath);
    const connection = connectDesktopRfb({
      url,
      security: opened.security,
      ...(opts.target ? { target: opts.target } : {}),
      hooks: {
        onConnect: () => {
          patch(instanceId, { status: "open", needsPassword: false });
          hooks.onConnect?.();
        },
        onDisconnect: (detail) => {
          connections.delete(instanceId);
          patch(instanceId, {
            status: detail.clean ? "closed" : "error",
            ...(detail.clean ? {} : { lastErrorCode: "desktop-stream-timeout", lastErrorMessage: detail.reason }),
          });
          hooks.onDisconnect?.(detail);
        },
        onCredentialsRequired: () => {
          patch(instanceId, { status: "auth-required", needsPassword: true });
          hooks.onCredentialsRequired?.();
        },
        onSecurityFailure: (reason) => {
          connections.delete(instanceId);
          patch(instanceId, {
            status: "error",
            needsPassword: false,
            lastErrorCode: "desktop-auth-unsupported",
            lastErrorMessage: reason,
          });
          hooks.onSecurityFailure?.(reason);
        },
      },
    });
    connections.set(instanceId, connection);
  }

  function sendCredentials(instanceId: string, password: string): void {
    const connection = connections.get(instanceId);
    if (!connection) return;
    patch(instanceId, { status: "connecting", needsPassword: false });
    connection.sendCredentials(password);
  }

  function setFit(instanceId: string, fit: boolean): void {
    patch(instanceId, { fit });
    connections.get(instanceId)?.setScaleViewport(fit);
  }

  function close(instanceId: string): void {
    const view = sessions.value.get(instanceId);
    const connection = connections.get(instanceId);
    // Abort any in-flight prepare BEFORE the view lookup: the pending RPC must
    // not resurrect this session (no connectDesktopRfb, no session row) when
    // `desktop-opened` lands after the panel is gone.
    pending.get(instanceId)?.abort();
    pending.delete(instanceId);
    connections.delete(instanceId);
    try { connection?.dispose(); } catch { /* gone */ }
    if (view?.streamId) {
      try {
        sendWebClientMessage({ kind: "desktop-close", instanceId, streamId: view.streamId });
      } catch { /* offline: hub times the stream out */ }
    }
    sessions.value.delete(instanceId);
  }

  function applyEvent(event: { kind: string; instanceId?: string }): void {
    if (event.kind === "instance-status" && event.instanceId) {
      const view = sessions.value.get(event.instanceId);
      if (view && (event as { online?: boolean }).online === false) close(event.instanceId);
    }
  }

  return { sessions, viewFor, canOpen, open, sendCredentials, setFit, close, applyEvent };
});

export function desktopBinaryUrl(wsPath: string): string {
  if (typeof location === "undefined") return wsPath;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}${wsPath}`;
}
