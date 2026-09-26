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
  // Monotonic attempt counter per instance. Every patch/delete of a session row
  // is tagged with the generation that owns it, so a superseded attempt (A
  // aborted by close, B opened and already wrote its own row) can never mutate
  // or delete B's row when A's prepare finally settles.
  const generation = new Map<string, number>();

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

  /** True when `attempt` still owns this instance's session row. */
  function owns(instanceId: string, attempt: number): boolean {
    return generation.get(instanceId) === attempt;
  }

  /** Delete the session row only if `attempt` still owns it. */
  function dropRow(instanceId: string, attempt: number): void {
    if (owns(instanceId, attempt)) {
      generation.delete(instanceId);
      sessions.value.delete(instanceId);
    }
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
    const attempt = (generation.get(instanceId) ?? 0) + 1;
    generation.set(instanceId, attempt);
    const controller = new AbortController();
    pending.set(instanceId, controller);
    patch(instanceId, { status: "opening", lastErrorCode: undefined, lastErrorMessage: undefined });
    let opened;
    try {
      opened = await requestDesktop(
        { kind: "desktop-open", requestId: nextDesktopRequestId(), instanceId },
        { timeoutMs: DESKTOP_RPC_TIMEOUT_MS },
      );
    } catch (err) {
      if (controller.signal.aborted || opts.signal?.aborted || !owns(instanceId, attempt)) {
        // Abandoned or superseded: a newer attempt owns the row now. Patching
        // (even to "error") would clobber its status, and the hub already
        // reaps the abandoned stream via its TTL sweep.
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
    if (controller.signal.aborted || opts.signal?.aborted || !owns(instanceId, attempt)) {
      // Abandoned or superseded mid-prepare. The hub already minted a stream +
      // browser ticket for THIS attempt, so close it rather than leaving an
      // orphan stream. The session row must only go while we still own it:
      // otherwise we would delete the newer attempt's row (e.g. its Busy/Error
      // state), which `viewFor`'s lazy recreate would then turn back into a
      // bare idle row.
      sendWebClientMessage({ kind: "desktop-close", instanceId, streamId: opened.streamId });
      dropRow(instanceId, attempt);
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
    // Only this attempt may touch the row from now on: a superseding open()
    // bumps the generation, so a late hook from a stale connection must not
    // resurrect/overwrite the newer attempt's row.
    const mine = (): boolean => owns(instanceId, attempt);
    const connection = connectDesktopRfb({
      url,
      security: opened.security,
      fit: viewFor(instanceId).fit,
      ...(opts.target ? { target: opts.target } : {}),
      hooks: {
        onConnect: () => {
          if (!mine()) return;
          patch(instanceId, { status: "open", needsPassword: false });
          hooks.onConnect?.();
        },
        onDisconnect: (detail) => {
          // Generation guard FIRST: a stale connection's late hook must not
          // delete the CURRENT connection from the registry (the row patch
          // below is not the only state this closure touches).
          if (!mine()) return;
          connections.delete(instanceId);
          patch(instanceId, {
            status: detail.clean ? "closed" : "error",
            ...(detail.clean ? {} : { lastErrorCode: "desktop-stream-timeout", lastErrorMessage: detail.reason }),
          });
          hooks.onDisconnect?.(detail);
        },
        onCredentialsRequired: () => {
          if (!mine()) return;
          patch(instanceId, { status: "auth-required", needsPassword: true });
          hooks.onCredentialsRequired?.();
        },
        onSecurityFailure: (reason) => {
          if (!mine()) return;
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
    // The desired fit may have been toggled while noVNC was still loading.
    connection.setScaleViewport(viewFor(instanceId).fit);
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
    // Bump the generation so a prepare still in flight (or a connection hook
    // from the just-disposed RFB) is provably stale and cannot re-create or
    // overwrite a row after this close.
    generation.set(instanceId, (generation.get(instanceId) ?? 0) + 1);
    connections.delete(instanceId);
    try { connection?.dispose(); } catch { /* gone */ }
    if (view?.streamId) {
      try {
        sendWebClientMessage({ kind: "desktop-close", instanceId, streamId: view.streamId });
      } catch { /* offline: hub times the stream out */ }
    }
    // Deliberately keep the bumped generation: it must outlive this close so
    // the NEXT open() cannot reuse a number an in-flight attempt still holds.
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
