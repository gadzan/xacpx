import {
  decodeEnvelope,
  DESKTOP_RPC_TIMEOUT_MS,
  encodeEnvelope,
  parseWebServerEvent,
  TERMINAL_RPC_TIMEOUT_MS,
  webClientEnvelope,
  type WebClientMessage,
  type WebServerEvent,
} from "@ganglion/xacpx-relay-protocol";

let activeSocket: WebSocket | null = null;

type WebEventSubscriber = (event: WebServerEvent) => void;
const webEventSubscribers = new Set<WebEventSubscriber>();

/** Subscribe to every decoded server event without owning the websocket lifecycle. */
export function subscribeWebEvents(listener: WebEventSubscriber): () => void {
  webEventSubscribers.add(listener);
  return () => { webEventSubscribers.delete(listener); };
}

function publishWebEvent(event: WebServerEvent): void {
  for (const listener of [...webEventSubscribers]) {
    try {
      listener(event);
    } catch (error) {
      // Passive observers must never break the primary dashboard fan-out.
      console.error("[relay-web] passive web event subscriber failed", error);
    }
  }
}

/** Send a browser→hub frame up the live /ws socket. No-op if disconnected. */
export function sendWebClientMessage(msg: WebClientMessage): void {
  if (activeSocket && activeSocket.readyState === WebSocket.OPEN) {
    activeSocket.send(encodeEnvelope(webClientEnvelope(msg)));
  }
}

/** Tell the hub which instance(s) this socket is viewing, so it scopes control-events. */
export function sendSubscribe(instanceIds: string[]): void {
  sendWebClientMessage({ kind: "subscribe", instanceIds });
}

export class TerminalRequestError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message || code);
    this.name = "TerminalRequestError";
    this.code = code;
  }
}

export type TerminalOpenedResult = {
  requestId: string;
  instanceId: string;
  terminalId: string;
  generation: string;
  attachmentId: string;
  role: "controller" | "spectator";
  viewerCount: number;
};

export class DesktopRequestError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message || code);
    this.name = "DesktopRequestError";
    this.code = code;
  }
}

export type DesktopOpenedResult = {
  requestId: string;
  instanceId: string;
  streamId: string;
  wsPath: string;
  expiresAt: number;
  security: "vnc-auth" | "ard";
};

export type TerminalAckResult = {
  code: "ok" | "terminated" | "cleanup-pending";
  message: string;
  instanceId: string;
  requestId: string;
};

/** Success codes delivered via `terminal-request-failed` (protocol gap — no dedicated ack kinds). */
const ACK_SUCCESS_CODES = new Set(["ok", "terminated", "cleanup-pending"]);

type PendingEntry =
  | {
    expect: "opened";
    resolve: (v: TerminalOpenedResult) => void;
    reject: (e: TerminalRequestError) => void;
    timer: ReturnType<typeof setTimeout>;
  }
  | {
    expect: "ack";
    resolve: (v: TerminalAckResult) => void;
    reject: (e: TerminalRequestError) => void;
    timer: ReturnType<typeof setTimeout>;
  }
  | {
    expect: "desktop-opened";
    resolve: (v: DesktopOpenedResult) => void;
    reject: (e: DesktopRequestError) => void;
    timer: ReturnType<typeof setTimeout>;
  };

const pending = new Map<string, PendingEntry>();
const desktopPending = new Map<string, Extract<PendingEntry, { expect: "desktop-opened" }>>();

let requestSeq = 0;
/**
 * True once any control socket has opened in this page lifetime.
 *
 * Reconnect subscribers are owned by long-lived stores, not by a socket, so
 * they must be notified whenever the control plane becomes available again —
 * including the FIRST open of a brand-new `connectEvents` after a teardown
 * (router navigation, remounted view). Without this the remount's first open
 * looks identical to a cold start, the subscribers are never told, and their
 * viewers stay dead until the user reconnects by hand.
 */
let everOpened = false;
/**
 * Callbacks invoked after the /ws socket re-opens following a drop.
 *
 * A SET, not a slot: terminal and desktop both need to react (terminal replays
 * its attachments, desktop re-opens its streams), and the second registrar must
 * not silently displace the first. Fn-identity is the unsubscribe key.
 */
const reconnectHandlers = new Set<() => void>();
/** The single subscription owned by the legacy replacement-semantics setter. */
let legacyReconnectHandler: (() => void) | null = null;

/**
 * Subscribe to /ws re-open. Returns an unsubscribe function; the same function
 * passed twice is only registered once.
 */
export function onEventsReconnect(handler: () => void): () => void {
  reconnectHandlers.add(handler);
  return () => { reconnectHandlers.delete(handler); };
}

/**
 * Register the ONE reconnect callback owned by a store that has not migrated to
 * `onEventsReconnect` yet.
 *
 * Kept replacement semantics deliberately: it assigns the slot, so repeat calls
 * from the same caller replace rather than accumulate. A plain `add` here would
 * silently multiply reopens, because a fresh closure is a new fn-identity every
 * time. New code should migrate to `onEventsReconnect()` and its unsubscribe.
 */
export function setEventsReconnectHandler(handler: (() => void) | null): void {
  if (handler === null) {
    if (legacyReconnectHandler) reconnectHandlers.delete(legacyReconnectHandler);
    legacyReconnectHandler = null;
    return;
  }
  if (legacyReconnectHandler) reconnectHandlers.delete(legacyReconnectHandler);
  legacyReconnectHandler = handler;
  reconnectHandlers.add(handler);
}

/** A reconnect happened; every subscriber gets a turn, second ones still run. */
function fireEventsReconnect(): void {
  for (const handler of [...reconnectHandlers]) {
    try { handler(); } catch { /* one bad subscriber must not block the others */ }
  }
}

/**
 * Test seam: fire the reconnect notification without standing up a socket.
 * Deliberately routes through `fireEventsReconnect` rather than calling a
 * store method, so a regression in the subscription wiring fails the test.
 */
export function _fireEventsReconnectForTests(): void {
  fireEventsReconnect();
}

/** Stable-enough requestId for terminal RPCs (unique per page lifetime). */
export function nextTerminalRequestId(): string {
  requestSeq += 1;
  return `tr-${Date.now().toString(36)}-${requestSeq.toString(36)}`;
}

/** Transient codes: the tab should retry, not treat the instance as gone. */
export function isRetryableTerminalError(code: string): boolean {
  return code === "instance-offline"
    || code === "events-offline"
    || code === "terminal-timeout"
    || code === "instance-reconnected";
}

function rejectAllPending(code: string, message: string): void {
  for (const [id, entry] of pending) {
    clearTimeout(entry.timer);
    pending.delete(id);
    entry.reject(new TerminalRequestError(code, message));
  }
  for (const [id, entry] of desktopPending) {
    clearTimeout(entry.timer);
    desktopPending.delete(id);
    entry.reject(new DesktopRequestError(code, message));
  }
}

/**
 * Correlate a server event against the pending request map.
 * Returns true when the event settled a pending promise (caller still may forward it).
 */
export function settleTerminalRequest(event: WebServerEvent): boolean {
  if (event.kind === "desktop-opened" || event.kind === "desktop-request-failed") {
    return settleDesktopRequest(event);
  }
  if (event.kind === "terminal-opened") {
    const entry = pending.get(event.requestId);
    // A live pending entry that was NOT waiting for `opened` is a protocol
    // violation: the hub answered an ack-taking request (take-control, resync,
    // terminate) with a terminal-opened frame. Reject immediately instead of
    // letting the caller hang until the RPC deadline.
    if (!entry) return false;
    clearTimeout(entry.timer);
    pending.delete(event.requestId);
    if (entry.expect !== "opened") {
      entry.reject(new TerminalRequestError(
        "terminal-protocol-error",
        "unexpected terminal-opened",
      ));
      return true;
    }
    entry.resolve({
      requestId: event.requestId,
      instanceId: event.instanceId,
      terminalId: event.terminalId,
      generation: event.generation,
      attachmentId: event.attachmentId,
      role: event.role,
      viewerCount: event.viewerCount,
    });
    return true;
  }
  if (event.kind === "terminal-request-failed") {
    const entry = pending.get(event.requestId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    pending.delete(event.requestId);
    if (ACK_SUCCESS_CODES.has(event.code) && entry.expect === "ack") {
      entry.resolve({
        code: event.code as TerminalAckResult["code"],
        message: event.message,
        instanceId: event.instanceId,
        requestId: event.requestId,
      });
      return true;
    }
    entry.reject(new TerminalRequestError(event.code, event.message));
    return true;
  }
  return false;
}

function settleDesktopRequest(event: WebServerEvent): boolean {
  if (event.kind === "desktop-opened") {
    const entry = desktopPending.get(event.requestId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    desktopPending.delete(event.requestId);
    entry.resolve({
      requestId: event.requestId,
      instanceId: event.instanceId,
      streamId: event.streamId,
      wsPath: event.wsPath,
      expiresAt: event.expiresAt,
      security: event.security,
    });
    return true;
  }
  if (event.kind === "desktop-request-failed") {
    const entry = desktopPending.get(event.requestId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    desktopPending.delete(event.requestId);
    entry.reject(new DesktopRequestError(event.code, event.message));
    return true;
  }
   return false;
 }

/** True when the live socket can carry a request. */
export function isEventsSocketOpen(): boolean {
  return !!activeSocket && activeSocket.readyState === WebSocket.OPEN;
}

/**
 * Send a requestId-bearing terminal frame and wait for opened/ack correlation.
 * Rejects on deadline, socket close, or terminal-request-failed error codes.
 */
export function requestTerminal(
  msg: WebClientMessage & { requestId: string },
  options: { expect: "opened"; timeoutMs?: number },
): Promise<TerminalOpenedResult>;
export function requestTerminal(
  msg: WebClientMessage & { requestId: string },
  options: { expect: "ack"; timeoutMs?: number },
): Promise<TerminalAckResult>;
export function requestTerminal(
  msg: WebClientMessage & { requestId: string },
  options: { expect: "opened" | "ack"; timeoutMs?: number },
): Promise<TerminalOpenedResult | TerminalAckResult> {
  const timeoutMs = options.timeoutMs ?? TERMINAL_RPC_TIMEOUT_MS;
  if (!isEventsSocketOpen()) {
    return Promise.reject(new TerminalRequestError("events-offline", "events socket is offline"));
  }
  if (pending.has(msg.requestId)) {
    return Promise.reject(new TerminalRequestError("terminal-protocol-error", "duplicate requestId"));
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(msg.requestId);
      reject(new TerminalRequestError("terminal-timeout", "terminal request timed out"));
    }, timeoutMs);

    if (options.expect === "opened") {
      pending.set(msg.requestId, {
        expect: "opened",
        resolve: resolve as (v: TerminalOpenedResult) => void,
        reject,
        timer,
      });
    } else {
      pending.set(msg.requestId, {
        expect: "ack",
        resolve: resolve as (v: TerminalAckResult) => void,
        reject,
        timer,
      });
    }

    try {
      sendWebClientMessage(msg);
    } catch (err) {
      clearTimeout(timer);
      pending.delete(msg.requestId);
      reject(new TerminalRequestError(
        "terminal-protocol-error",
        err instanceof Error ? err.message : "send failed",
      ));
    }
  });
}
/** Stable-enough requestId for desktop RPCs (unique per page lifetime). */
export function nextDesktopRequestId(): string {
  requestSeq += 1;
  return `ds-${Date.now().toString(36)}-${requestSeq.toString(36)}`;
}

/** Transient desktop codes: the tab should retry, not treat the instance as gone. */
export function isRetryableDesktopError(code: string): boolean {
  return code === "desktop-instance-offline"
    || code === "events-offline"
    || code === "desktop-stream-timeout";
}

/**
 * Send a desktop-open frame and wait for desktop-opened correlation.
 * Rejects on deadline, socket close, or desktop-request-failed error codes.
 */
export function requestDesktop(
  msg: Extract<WebClientMessage, { kind: "desktop-open" }>,
  options: { timeoutMs?: number } = {},
): Promise<DesktopOpenedResult> {
  const timeoutMs = options.timeoutMs ?? DESKTOP_RPC_TIMEOUT_MS;
  if (!isEventsSocketOpen()) {
    return Promise.reject(new DesktopRequestError("events-offline", "events socket is offline"));
  }
  if (pending.has(msg.requestId) || desktopPending.has(msg.requestId)) {
    return Promise.reject(new DesktopRequestError("desktop-protocol-error", "duplicate requestId"));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      desktopPending.delete(msg.requestId);
      reject(new DesktopRequestError("desktop-stream-timeout", "desktop request timed out"));
    }, timeoutMs);
    desktopPending.set(msg.requestId, { expect: "desktop-opened", resolve, reject, timer });
    try {
      sendWebClientMessage(msg);
    } catch (err) {
      clearTimeout(timer);
      desktopPending.delete(msg.requestId);
      reject(new DesktopRequestError(
        "desktop-protocol-error",
        err instanceof Error ? err.message : "send failed",
      ));
    }
  });
}

/** Connects to the relay /ws fan-out and invokes `onEvent` for each web event. Auto-reconnects. */
export function connectEvents(onEvent: (event: WebServerEvent) => void, onStatus?: (online: boolean) => void): () => void {
  let socket: WebSocket | null = null;
  let closed = false;
  let retry = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const open = () => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const wasReconnect = retry > 0;
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    socket = ws;
    activeSocket = ws;
    // Every handler below is fenced on "am I still the current socket". Two
    // connectEvents() instances legitimately overlap: a disposed view calls
    // close(), the close handshake is still in flight, and the replacement view
    // opens a new socket. The old socket's late `onclose` used to clear
    // `activeSocket` -- which by then points at the NEW, still-OPEN socket --
    // reject its in-flight RPCs, and mark the whole app offline. Since the new
    // socket never closes, nothing fires a reconnect and the damage is permanent.
    const isCurrent = (): boolean => socket === ws;
    ws.onmessage = (e) => {
      if (!isCurrent()) return;
      const decoded = decodeEnvelope(String(e.data));
      if (!decoded.ok) return;
      const event = parseWebServerEvent(decoded.envelope);
      if (!event) return;
      settleTerminalRequest(event);
      publishWebEvent(event);
      onEvent(event);
    };
    ws.onopen = () => {
      if (!isCurrent()) return;
      const reconnected = wasReconnect || everOpened;
      retry = 0;
      everOpened = true;
      onStatus?.(true);
      if (reconnected) fireEventsReconnect();
    };
    ws.onclose = () => {
      if (!isCurrent()) return;
      onStatus?.(false);
      activeSocket = null;
      rejectAllPending("events-offline", "events socket closed");
      if (closed) return;
      retry = Math.min(retry + 1, 6);
      timer = setTimeout(() => { timer = null; if (!closed) open(); }, 250 * 2 ** (retry - 1));
    };
  };

  open();
  return () => {
    closed = true;
    if (timer) { clearTimeout(timer); timer = null; }
    // Deliberately NOT touching `reconnectHandlers`: those subscribers are owned
    // by long-lived stores (Pinia), not by this socket. A router navigation that
    // unmounts a view must not silently drop next-page functionality — and the
    // store would then still believe it is subscribed, because its own
    // unsubscribe handle is non-null. Each owner releases its own subscription.
    rejectAllPending("events-offline", "events socket disposed");
    socket?.close();
  };
}

/** Test-only: clear pending map between cases. */
export function _resetTerminalRequestStateForTests(): void {
  rejectAllPending("instance-offline", "test reset");
  desktopPending.clear();
  requestSeq = 0;
  reconnectHandlers.clear();
  webEventSubscribers.clear();
  // Cold start for the reconnect signal: each case's first open must NOT count
  // as a reconnect, but a later open (or a remount) must.
  everOpened = false;
}