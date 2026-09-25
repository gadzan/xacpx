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
    const view = patch(instanceId, { status: "opening", lastErrorCode: undefined, lastErrorMessage: undefined });
    void view;
    let opened;
    try {
      opened = await requestDesktop(
        { kind: "desktop-open", requestId: nextDesktopRequestId(), instanceId },
        { timeoutMs: DESKTOP_RPC_TIMEOUT_MS },
      );
    } catch (err) {
      const code = err instanceof DesktopRequestError ? err.code : "desktop-protocol-error";
      patch(instanceId, {
        status: isRetryableDesktopError(code) ? "closed" : "error",
        lastErrorCode: code,
        lastErrorMessage: errorMessageFor(code, err instanceof Error ? err.message : String(err)),
      });
      throw err;
    }
    if (opts.signal?.aborted) {
      sendWebClientMessage({ kind: "desktop-close", instanceId, streamId: opened.streamId });
      patch(instanceId, { status: "closed" });
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
