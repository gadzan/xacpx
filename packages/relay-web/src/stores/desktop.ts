// Desktop session: one noVNC lifecycle per instance. The VNC password lives
// only in this store's memory (never localStorage/sessionStorage); tickets
// are single-use, so every reconnect re-issues desktop-open over /ws.
import { defineStore } from "pinia";
import { onScopeDispose, ref } from "vue";

import {
  DESKTOP_RPC_TIMEOUT_MS,
  parseDesktopCredential,
  type DesktopCredential,
  type DesktopSecurityKind,
} from "@ganglion/xacpx-relay-protocol";
import {
  DesktopRequestError,
  isRetryableDesktopError,
  nextDesktopRequestId,
  requestDesktop,
  sendWebClientMessage,
  onEventsReconnect,
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

export type DesktopAuthPrompt =
  | { kind: "vnc-password" }
  | { kind: "macos-account"; rejected: boolean };

type DesktopSessionBase = {
  instanceId: string;
  streamId?: string;
  security?: DesktopSecurityKind;
  /** Last macOS account name typed in this tab. Prefill only. Never a password. */
  ardUsername?: string;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  fit: boolean;
};

export type DesktopSessionView =
  | (DesktopSessionBase & { status: "auth-required"; prompt: DesktopAuthPrompt })
  | (DesktopSessionBase & { status: Exclude<DesktopStatus, "auth-required"> });

type DesktopSessionPatch =
  | (Partial<DesktopSessionBase> & { status: "auth-required"; prompt: DesktopAuthPrompt })
  | (Partial<DesktopSessionBase> & { status?: Exclude<DesktopStatus, "auth-required"> });

/**
 * Browser-local error code for a VNC password the server rejected. Distinct from
 * the stable `desktop-auth-unsupported` (which means the auth SCHEME was refused
 * — None/Tight/VeNCrypt/ARD): a wrong password is retryable and says nothing
 * about the scheme.
 */
export const DESKTOP_AUTH_FAILED_CODE = "desktop-auth-failed";

/**
 * Classify a noVNC `securityfailure`.
 *
 * noVNC 1.7.0 emits this event for a rejected security TYPE and for a rejected
 * VncAuth password. It was first told apart by regexing the server's English
 * wording (which broke as soon as a server localised its message, because
 * noVNC's API states `detail.reason` is optional and language-unspecified), then
 * by the presence of a SecurityResult `status`. Both are wrong:
 *
 * noVNC ALSO sets `_securityStatus` when the server refuses at the SCHEME stage
 * — RFB 3.3 security type 0, or a 3.7+ security-types failure — which happens
 * BEFORE any password is exchanged. Keying on `status` therefore told the user
 * "the server rejected the password" when they had never been asked for one.
 *
 * So the discriminator is the phase: only a failure AFTER the user submitted a
 * VncAuth password is a rejected password.
 */
export function classifySecurityFailure(
  failure: {
    status?: number;
    reason?: string;
    credentialsSubmitted?: boolean;
  },
  security: DesktopSecurityKind = "vnc-auth",
): { code: string; retryable: boolean } {
  if (security === "ard") return { code: "desktop-protocol-error", retryable: false };
  if (failure.credentialsSubmitted === true) {
    return { code: DESKTOP_AUTH_FAILED_CODE, retryable: true };
  }
  return { code: "desktop-auth-unsupported", retryable: false };
}

function rowAfterOpenFailure(code: string): DesktopSessionPatch {
  if (code === "desktop-credentials-required") {
    return { status: "auth-required", prompt: { kind: "macos-account", rejected: false } };
  }
  if (code === "desktop-credentials-rejected") {
    return { status: "auth-required", prompt: { kind: "macos-account", rejected: true } };
  }
  if (isRetryableDesktopError(code)) return { status: "closed", lastErrorCode: code };
  return { status: "error", lastErrorCode: code };
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
  // The requestId of each in-flight `desktop-open`, so a close that lands before
  // `desktop-opened` (no streamId known yet) can still tell the hub to release
  // the reservation. Without it a fast close→reopen hits `desktop-busy` for as
  // long as the abandoned prepare keeps the single-viewer slot.
  const pendingRequestId = new Map<string, string>();
  // Monotonic attempt counter per instance. Every patch/delete of a session row
  // is tagged with the generation that owns it, so a superseded attempt (A
  // aborted by close, B opened and already wrote its own row) can never mutate
  // or delete B's row when A's prepare finally settles.
  const generation = new Map<string, number>();
  // Unsubscribe handle for the /ws reconnect subscription. Released when THIS
  // store is disposed, so it is held at the setup scope's top level rather than
  // set inside an action: registering from inside an action would bind the
  // cleanup to whichever effect scope happened to be active when open() ran.
  let reconnectUnsub: (() => void) | null = null;
  onScopeDispose(() => {
    reconnectUnsub?.();
    reconnectUnsub = null;
  });

  function viewFor(instanceId: string): DesktopSessionView {
    let view = sessions.value.get(instanceId);
    if (!view) {
      view = { instanceId, status: "idle", fit: true };
      sessions.value.set(instanceId, view);
    }
    return view;
  }

  function patch(instanceId: string, next: DesktopSessionPatch): DesktopSessionView {
    const prev = viewFor(instanceId);
    const status = next.status ?? prev.status;
    const merged: DesktopSessionBase = { instanceId, fit: next.fit ?? prev.fit };
    const streamId = "streamId" in next ? next.streamId : prev.streamId;
    if (streamId !== undefined) merged.streamId = streamId;
    const security = "security" in next ? next.security : prev.security;
    if (security !== undefined) merged.security = security;
    const ardUsername = "ardUsername" in next ? next.ardUsername : prev.ardUsername;
    if (ardUsername !== undefined) merged.ardUsername = ardUsername;
    const lastErrorCode = "lastErrorCode" in next ? next.lastErrorCode : prev.lastErrorCode;
    if (lastErrorCode !== undefined) merged.lastErrorCode = lastErrorCode;
    const lastErrorMessage = "lastErrorMessage" in next ? next.lastErrorMessage : prev.lastErrorMessage;
    if (lastErrorMessage !== undefined) merged.lastErrorMessage = lastErrorMessage;
    let view: DesktopSessionView;
    if (status === "auth-required") {
      const prompt = next.status === "auth-required"
        ? next.prompt
        : (prev.status === "auth-required" ? prev.prompt : undefined);
      view = prompt
        ? { ...merged, status: "auth-required", prompt }
        : { ...merged, status: "error", lastErrorCode: merged.lastErrorCode ?? "desktop-protocol-error" };
    } else {
      view = { ...merged, status };
    }
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

  /**
   * Abandon an in-flight open for this instance, releasing the hub reservation
   * the abandoned request is holding.
   *
   * The order matters. `abort()` alone is not enough: the AbortController is a
   * local flag that `requestDesktop()` never sees, so it cannot stop the RPC or
   * tell the hub anything. And by the time the abandoned attempt rejects, its
   * `pendingRequestId` entry has already been overwritten by the successor, so
   * the catch path can no longer recover the requestId to cancel with. That
   * leaves the hub holding a single-viewer reservation for a prepare nobody
   * wants, and the next open fails `desktop-busy` until it expires.
   */
  function abandonPending(instanceId: string, reason: "superseded" | "closed"): void {
    const controller = pending.get(instanceId);
    const requestId = pendingRequestId.get(instanceId);
    pendingRequestId.delete(instanceId);
    controller?.abort();
    if (!requestId) return;
    try {
      sendWebClientMessage({ kind: "desktop-close", instanceId, requestId });
    } catch { /* offline: the hub reaps the stream on its TTL sweep */ }
  }

  function canOpen(instance: { online: boolean; capabilities?: string[] }): boolean {
    return supportsDesktop(instance);
  }

  async function open(
    instanceId: string,
    hooks: DesktopRfbHooks,
    opts: { signal?: AbortSignal; target?: HTMLElement | null; fit?: boolean } = {},
  ): Promise<void> {
    await beginOpen(instanceId, hooks, opts);
  }

  function signIn(instanceId: string, account: { username: string; password: string }): void {
    const parsed = parseDesktopCredential({ kind: "ard", username: account.username, password: account.password });
    if (!parsed) return;
    const context = reconnectContext.get(instanceId);
    if (!context) return;
    const fit = sessions.value.get(instanceId)?.fit ?? true;
    patch(instanceId, { ardUsername: parsed.username });
    void beginOpen(instanceId, context.hooks, { target: context.target, fit }, parsed).catch(() => undefined);
  }

  async function beginOpen(
    instanceId: string,
    hooks: DesktopRfbHooks,
    opts: { signal?: AbortSignal; target?: HTMLElement | null; fit?: boolean } = {},
    credential?: DesktopCredential,
  ): Promise<void> {
    const existing = connections.get(instanceId);
    if (existing) return;
    ensureReconnectHook();
    // Reopen passes the preference back so a transport reconnect does not
    // silently revert the user's Actual/Fit choice.
    if (opts.fit !== undefined) patch(instanceId, { fit: opts.fit });
    // A superseding open must RELEASE the previous reservation, not merely stop
    // caring about it: the hub still holds the single-viewer slot until its
    // request is cancelled, and without the cancel the successor opens straight
    // into `desktop-busy`.
    abandonPending(instanceId, "superseded");
    const attempt = (generation.get(instanceId) ?? 0) + 1;
    generation.set(instanceId, attempt);
    const controller = new AbortController();
    pending.set(instanceId, controller);
    // Remember the requestId of the in-flight open. A close that happens before
    // `desktop-opened` returns has no streamId to name, so it needs this to
    // release the hub reservation instead of waiting out the prepare.
    const requestId = nextDesktopRequestId();
    pendingRequestId.set(instanceId, requestId);
    patch(instanceId, { status: "opening", lastErrorCode: undefined, lastErrorMessage: undefined });
    // Reconnect context is recorded BEFORE the prepare, not only once it
    // succeeds: a /ws drop while `desktop-open` is still in flight rejects the
    // RPC with `events-offline`, and that failure must still be recognisable as
    // a viewer the user left open. Losing it here means the reconnect sweep
    // skips the row entirely and the panel goes dead until a manual Reconnect.
    // The target is also needed verbatim, or the reopen paints into a detached
    // div and reports success on a black panel. Recorded even when the target is
    // null (unmounted host), because the reopen still has to happen.
    // `fit` is NOT captured here: it is a live presentation preference the
    // reconnect sweep reads off the session row at reopen time.
    reconnectContext.set(instanceId, { hooks, target: opts.target ?? null });
    let opened;
    try {
      opened = await requestDesktop(
        {
          kind: "desktop-open",
          requestId,
          instanceId,
          ...(credential ? { credential } : {}),
        },
        { timeoutMs: DESKTOP_RPC_TIMEOUT_MS },
      );
    } catch (err) {
      // Release the reservation the hub granted for this request before we
      // forget the requestId. Reaching here means the browser gave up locally
      // (its own RPC timer, or a send failure) while the hub may still have a
      // live `waiting-browser` stream: a `desktop-opened` that arrives after the
      // timer fires cannot settle a pending entry that no longer exists, and a
      // later reconnect would then reserve into an orphan stream and fail
      // `desktop-busy`. Best-effort: the hub's state gate makes a late cancel
      // for a stream that already paired a harmless no-op.
      if (pendingRequestId.get(instanceId) === requestId) {
        try {
          sendWebClientMessage({ kind: "desktop-close", instanceId, requestId });
        } catch { /* offline: hub reaps the stream on its TTL sweep */ }
      }
      if (pendingRequestId.get(instanceId) === requestId) pendingRequestId.delete(instanceId);
      if (controller.signal.aborted || opts.signal?.aborted || !owns(instanceId, attempt)) {
        // Abandoned or superseded: a newer attempt owns the row now. Patching
        // (even to "error") would clobber its status, and the hub already
        // reaps the abandoned stream via its TTL sweep.
        throw err;
      }
      const code = err instanceof DesktopRequestError ? err.code : "desktop-protocol-error";
      const failure = rowAfterOpenFailure(code);
      const message = errorMessageFor(code, err instanceof Error ? err.message : String(err));
      if (failure.status === "auth-required") {
        patch(instanceId, {
          status: "auth-required",
          prompt: failure.prompt,
          lastErrorCode: undefined,
          lastErrorMessage: undefined,
        });
      } else if (failure.status === "closed") {
        patch(instanceId, { status: "closed", lastErrorCode: code, lastErrorMessage: message });
      } else {
        patch(instanceId, { status: "error", lastErrorCode: code, lastErrorMessage: message });
      }
      throw err;
    } finally {
      // Identity-safe cleanup: a newer open() for the same instance may have
      // already replaced the entry (A aborted → B opened while A's prepare was
      // still in flight). Deleting unconditionally would orphan B's controller
      // so a later close() could not abort it.
      if (pending.get(instanceId) === controller) pending.delete(instanceId);
      if (pendingRequestId.get(instanceId) === requestId) pendingRequestId.delete(instanceId);
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
    // The hub keeps honouring a requestId-based close from here until the
    // browser's binary side attaches, so clearing the local entry is what stops
    // a later close from naming a stream the hub already knows by streamId.
    if (pendingRequestId.get(instanceId) === requestId) pendingRequestId.delete(instanceId);
    patch(instanceId, {
      status: "connecting",
      streamId: opened.streamId,
      security: opened.security,
    });
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
          patch(instanceId, { status: "open" });
          hooks.onConnect?.();
        },
        onDisconnect: (detail) => {
          // Generation guard FIRST: a stale connection's late hook must not
          // delete the CURRENT connection from the registry (the row patch
          // below is not the only state this closure touches).
          if (!mine()) return;
          connections.delete(instanceId);
          // A security failure is TERMINAL for this attempt: noVNC answers it
          // with `_fail()`, which marks the connection unclean and immediately
          // emits disconnect{clean:false}. Without this guard that second
          // event would overwrite "wrong password" with a generic
          // desktop-stream-timeout and the user would reconnect forever into
          // the same wall.
          const settled = viewFor(instanceId).lastErrorCode;
          if (
            settled === DESKTOP_AUTH_FAILED_CODE
            || settled === "desktop-auth-unsupported"
            || settled === "desktop-protocol-error"
          ) {
            hooks.onDisconnect?.(detail);
            return;
          }
          patch(instanceId, {
            status: detail.clean ? "closed" : "error",
            ...(detail.clean ? {} : { lastErrorCode: "desktop-stream-timeout", lastErrorMessage: detail.reason }),
          });
          hooks.onDisconnect?.(detail);
        },
        onCredentialsRequired: () => {
          if (!mine()) return;
          patch(instanceId, { status: "auth-required", prompt: { kind: "vnc-password" } });
          hooks.onCredentialsRequired?.();
        },
        onSecurityFailure: (failure) => {
          if (!mine()) return;
          connections.delete(instanceId);
          // Classify on noVNC's structured signal — the SecurityResult status
          // together with whether a password was actually submitted — never on
          // the server's wording, which noVNC documents as optional and of
          // unspecified language.
          const failed = classifySecurityFailure(failure, viewFor(instanceId).security ?? "vnc-auth");
          patch(instanceId, {
            status: "error",
            lastErrorCode: failed.code,
            lastErrorMessage: failure.reason ?? "authentication failed",
          });
          hooks.onSecurityFailure?.(failure);
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
    patch(instanceId, { status: "connecting" });
    connection.sendCredentials(password);
  }

  function setFit(instanceId: string, fit: boolean): void {
    patch(instanceId, { fit });
    connections.get(instanceId)?.setScaleViewport(fit);
  }

  function close(instanceId: string): void {
    const view = sessions.value.get(instanceId);
    const connection = connections.get(instanceId);
    // Release whatever the hub is holding for this instance, whichever way it is
    // addressed: the paired stream by streamId, or a prepare that never answered
    // by requestId. Doing it before the view lookup keeps the pending RPC from
    // resurrecting this session when `desktop-opened` lands after the panel gone.
    abandonPending(instanceId, "closed");
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
    reconnectContext.delete(instanceId);
  }

  function applyEvent(event: { kind: string; instanceId?: string }): void {
    if (event.kind === "instance-status" && event.instanceId) {
      const view = sessions.value.get(event.instanceId);
      if (view && (event as { online?: boolean }).online === false) close(event.instanceId);
    }
  }

  /**
   * Per-instance context needed to rebuild a viewer after a control-socket
   * drop. `target` is load-bearing: DesktopTab mounts a `[data-test=desktop-host]`
   * div and passes it as noVNC's render target, and without it the client falls
   * back to a detached div, so the reconnect "succeeds" and paints nothing.
   *
   * Recorded BEFORE the prepare resolves, not only on success: a /ws drop while
   * `desktop-open` is still in flight rejects the RPC with `events-offline`,
   * which leave a `closed` row with no streamId, and the reconnect sweep must
   * still recognise it as a viewer the user left open.
   * Presentation state (Actual/Fit) is deliberately NOT carried here: it changes
   * at any time and must not require the context to be mutated. The sweep reads
   * the live value off the session row instead.
   */
  const reconnectContext = new Map<string, { hooks: DesktopRfbHooks; target: HTMLElement | null }>();

  function ensureReconnectHook(): void {
    if (reconnectUnsub) return;
    // The subscription set in events.ts is module-scoped, so without a matching
    // dispose an HMR'd or re-created store leaves its closure registered and
    // fires on every later reconnect. Cleanup itself is registered at the setup
    // scope's top level (above) and therefore belongs to this store.
    reconnectUnsub = onEventsReconnect(() => { reopenAfterWsReconnect(); });
  }

  /**
   * Re-open every desktop the user still has open after the control /ws drops.
   *
   * The hub binds desktop lifetime ownership to the control socket's viewerId,
   * so a /ws drop tears the binary stream down server-side (see
   * `cancelViewerDesktopStreams`). Without this the panel stays dead until the
   * user notices and clicks Reconnect, even though design §16 specifies
   * "old stream closed -> store cleanup -> browser re-sends desktop-open" and
   * plan Task 8 requires "reconnect -> re-open desktop, never reuse a ticket".
   *
   * Fresh open only: the hub revoked the old stream and its ticket, so reusing
   * anything from the closed session would be rejected. `close()` first so no
   * stale local state (generation, abandoned requestId) survives into the new
   * attempt. Everything else about the viewer — its render target and its hooks
   * — must be carried across verbatim, or the reconnect renders into a detached
   * div and the tab stays black while reporting success.
   */
  function reconnect(instanceId: string): void {
    const view = sessions.value.get(instanceId);
    const context = reconnectContext.get(instanceId);
    const fit = view?.fit ?? true;
    const ardUsername = view?.ardUsername;
    close(instanceId);
    if (!context) return;
    void open(instanceId, context.hooks, { target: context.target, fit }).catch(() => undefined);
    if (ardUsername) patch(instanceId, { ardUsername });
  }

  function reopenAfterWsReconnect(): void {
    const live = [...sessions.value.entries()].filter(([, view]) => {
      // A prepare interrupted by the SAME drop (`events-offline`) leaves a
      // `closed` row with no streamId. That is not an abandoned viewer: the user
      // never clicked Close, so it must be reopened too, or the panel goes dead
      // until a manual Reconnect.
      if (view.streamId !== undefined) return true;
      if (view.status !== "closed") return true;
      return view.lastErrorCode === "events-offline";
    });
    for (const [instanceId] of live) reconnect(instanceId);
  }

  return { sessions, viewFor, canOpen, open, signIn, reconnect, sendCredentials, setFit, close, applyEvent, reopenAfterWsReconnect, ensureReconnectHook };
});

export function desktopBinaryUrl(wsPath: string): string {
  if (typeof location === "undefined") return wsPath;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}${wsPath}`;
}
