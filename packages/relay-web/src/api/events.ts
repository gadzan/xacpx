import {
  decodeEnvelope,
  encodeEnvelope,
  parseWebServerEvent,
  TERMINAL_RPC_TIMEOUT_MS,
  webClientEnvelope,
  type WebClientMessage,
  type WebServerEvent,
} from "@ganglion/xacpx-relay-protocol";

let activeSocket: WebSocket | null = null;

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
  };

const pending = new Map<string, PendingEntry>();

let requestSeq = 0;
let reconnectHandler: (() => void) | null = null;

/** Register a callback invoked after the /ws socket re-opens following a drop. */
export function setEventsReconnectHandler(handler: (() => void) | null): void {
  reconnectHandler = handler;
}

/** Stable-enough requestId for terminal RPCs (unique per page lifetime). */
export function nextTerminalRequestId(): string {
  requestSeq += 1;
  return `tr-${Date.now().toString(36)}-${requestSeq.toString(36)}`;
}

function rejectAllPending(code: string, message: string): void {
  for (const [id, entry] of pending) {
    clearTimeout(entry.timer);
    pending.delete(id);
    entry.reject(new TerminalRequestError(code, message));
  }
}

/**
 * Correlate a server event against the pending request map.
 * Returns true when the event settled a pending promise (caller still may forward it).
 */
export function settleTerminalRequest(event: WebServerEvent): boolean {
  if (event.kind === "terminal-opened") {
    const entry = pending.get(event.requestId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    pending.delete(event.requestId);
    if (entry.expect !== "opened") {
      entry.reject(new TerminalRequestError("terminal-protocol-error", "unexpected terminal-opened"));
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
    return Promise.reject(new TerminalRequestError("instance-offline", "events socket is offline"));
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

/** Connects to the relay /ws fan-out and invokes `onEvent` for each web event. Auto-reconnects. */
export function connectEvents(onEvent: (event: WebServerEvent) => void, onStatus?: (online: boolean) => void): () => void {
  let socket: WebSocket | null = null;
  let closed = false;
  let retry = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const open = () => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const wasReconnect = retry > 0;
    socket = new WebSocket(`${proto}://${location.host}/ws`);
    activeSocket = socket;
    socket.onmessage = (e) => {
      const decoded = decodeEnvelope(String(e.data));
      if (!decoded.ok) return;
      const event = parseWebServerEvent(decoded.envelope);
      if (!event) return;
      settleTerminalRequest(event);
      onEvent(event);
    };
    socket.onopen = () => {
      const reconnected = wasReconnect;
      retry = 0;
      onStatus?.(true);
      if (reconnected) reconnectHandler?.();
    };
    socket.onclose = () => {
      onStatus?.(false);
      activeSocket = null;
      rejectAllPending("instance-offline", "events socket closed");
      if (closed) return;
      retry = Math.min(retry + 1, 6);
      timer = setTimeout(() => { timer = null; if (!closed) open(); }, 250 * 2 ** (retry - 1));
    };
  };

  open();
  return () => {
    closed = true;
    if (timer) { clearTimeout(timer); timer = null; }
    reconnectHandler = null;
    rejectAllPending("instance-offline", "events socket disposed");
    socket?.close();
  };
}

/** Test-only: clear pending map between cases. */
export function _resetTerminalRequestStateForTests(): void {
  rejectAllPending("instance-offline", "test reset");
  requestSeq = 0;
  reconnectHandler = null;
}
