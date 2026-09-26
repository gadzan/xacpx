// packages/channel-relay/src/desktop/desktop-tunnel-runtime.ts
// Connector-side desktop tunnel: answers `instance.desktop.prepare` by probing
// the loopback RFB server, then bridges 127.0.0.1:<port> to the hub's binary
// `/desktop/instance` WebSocket. One stream at a time (v1 single-viewer);
// closing the stream only drops the TCP/tunnel, never the system VNC server.

import net from "node:net";
import WebSocket from "ws";

import {
  DESKTOP_BUFFERED_HARD_CLOSE_BYTES,
  DESKTOP_BUFFERED_SOFT_PAUSE_BYTES,
  DESKTOP_TCP_CHUNK_BYTES,
  DESKTOP_WS_MAX_PAYLOAD_BYTES,
  MSG,
  errorPayload,
  parseControlPayload,
  parseDesktopEventPayload,
  type DesktopPrepareResult,
  type RelayEnvelope,
} from "@ganglion/xacpx-relay-protocol";

import type { RelayDesktopConfig } from "../config.js";
import { desktopSetupGuidance } from "./platform-guidance.js";
import { parseBanner, probeLoopbackRfb, RFB_LOOPBACK_HOST } from "./rfb-probe.js";

export interface DesktopTunnelDeps {
  config: RelayDesktopConfig;
  /** Hub base URL (ws:// or wss://), reused to dial `/desktop/instance`. */
  hubUrl: string;
  createSocket?: (url: string) => WebSocket;
  logger?: { error(event: string, message: string, context?: Record<string, unknown>): void };
  platform?: NodeJS.Platform;
}

interface ActiveTunnel {
  streamId: string;
  ticket: string;
  socket: WebSocket;
  tcp: net.Socket;
  closed: boolean;
}

function toBinaryWsUrl(hubUrl: string, ticket: string): string {
  const url = new URL(hubUrl);
  url.protocol = url.protocol === "wss:" ? "wss:" : "ws:";
  url.pathname = "/desktop/instance";
  url.search = `?ticket=${encodeURIComponent(ticket)}`;
  url.hash = "";
  return url.toString();
}

export class DesktopTunnelRuntime {
  private active: ActiveTunnel | null = null;

  constructor(private readonly deps: DesktopTunnelDeps) {}

  get activeStreamId(): string | null {
    return this.active?.streamId ?? null;
  }

  /** Connector dispatch arm for `instance.desktop.prepare` (hub → connector req). */
  async handlePrepare(envelope: RelayEnvelope, respond: (payload: unknown) => void): Promise<boolean> {
    if (envelope.type !== MSG.desktopPrepare) return false;
    const input = parseControlPayload(MSG.desktopPrepare, envelope.payload);
    if (!input) {
      respond(errorPayload("desktop-protocol-error", "malformed desktop prepare payload"));
      return true;
    }
    const config = this.deps.config;
    if (!config.enabled) {
      respond(errorPayload("desktop-disabled", "desktop is not enabled on this instance"));
      return true;
    }
    if (this.active && !this.active.closed) {
      respond(errorPayload("desktop-busy", "another desktop viewer is active"));
      return true;
    }
    const verdict = await probeLoopbackRfb({ port: config.port, connectTimeoutMs: config.connectTimeoutMs });
    if (!verdict.ok) {
      const guidance = desktopSetupGuidance(this.deps.platform ?? process.platform, verdict.code);
      respond(errorPayload(verdict.code, `${verdict.detail}. ${guidance}`));
      return true;
    }
    try {
      await this.openTunnel(input.streamId, input.ticket);
    } catch (err) {
      respond(errorPayload("desktop-stream-timeout", err instanceof Error ? err.message : "desktop tunnel failed"));
      return true;
    }
    const result: DesktopPrepareResult = { streamId: input.streamId, security: verdict.security };
    respond(result);
    return true;
  }

  /** Connector dispatch arm for `instance.desktop.cancel` (hub → connector event). */
  handleCancel(envelope: RelayEnvelope): boolean {
    if (envelope.type !== MSG.desktopCancel) return false;
    const input = parseDesktopEventPayload(MSG.desktopCancel, envelope.payload);
    if (!input) return true;
    if (this.active?.streamId === input.streamId) this.closeActive("cancel");
    return true;
  }

  /** Control-socket drop / stop / logout: no tunnel may survive the connector. */
  closeAll(reason = "connector-stop"): void {
    this.closeActive(reason);
  }

  private async openTunnel(streamId: string, ticket: string): Promise<void> {
    const config = this.deps.config;
    const tcp = net.createConnection({ host: RFB_LOOPBACK_HOST, port: config.port });
    // Any throw below must not leak the loopback socket: openHubSocket can
    // reject after the banner was already read (hub down / bad ticket).
    // closeActive only drops this.active, so destroy explicitly on failure.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        tcp.destroy();
        reject(new Error(`RFB connect timed out after ${config.connectTimeoutMs}ms`));
      }, config.connectTimeoutMs);
      tcp.once("connect", () => {
        clearTimeout(timer);
        resolve();
      });
      tcp.once("error", (err) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
    // Re-verify ONLY the 12-byte server banner on the real tunnel socket: the
    // probe ran earlier and the port may have been rebound since. Never forward
    // non-RFB bytes — but never consume security state either: noVNC owns the
    // full handshake (client version + security negotiation) on this socket.
    // Reading past the banner here would race noVNC for the SecurityTypes.
    // Pause BEFORE reading so nothing past the banner can slip through
    // between the banner reader's removeListener and the collector below.
    tcp.pause();
    let serverBanner: Buffer;
    try {
      const banner = await readTunnelBanner(tcp, config.connectTimeoutMs);
      if (!banner) throw new Error("RFB server banner changed before tunnel start");
      serverBanner = banner;
    } catch (err) {
      tcp.destroy();
      throw err;
    }
    // Any server bytes that arrive while the hub WS dials (starting with the
    // banner noVNC must see) are buffered in order and replayed once the
    // binary plane is up. Nothing is consumed.
    const earlyChunks: Buffer[] = serverBanner.length > 0 ? [serverBanner] : [];
    tcp.on("data", (chunk: Buffer) => {
      earlyChunks.push(chunk);
    });
    const url = toBinaryWsUrl(this.deps.hubUrl, ticket);
    // Attach the error swallow SYNCHRONOUSLY with construction: `ws` may emit
    // 'error' for an upgrade rejection on a later tick, but any gap between
    // construction and the first listener is still an unhandled throw under
    // `bun test` (the rejection is attributed to the file, not the await).
    let socket: WebSocket;
    const createSocket = this.deps.createSocket ?? ((u: string) => new WebSocket(u));
    try {
      socket = await openHubSocket(createSocket, url, config.connectTimeoutMs);
    } catch (err) {
      tcp.removeAllListeners("data");
      tcp.destroy();
      throw err;
    }
    const tunnel: ActiveTunnel = { streamId, ticket, socket, tcp, closed: false };
    this.active = tunnel;
    tcp.removeAllListeners("data");
    tcp.resume();
    // Replay what the banner preflight consumed, IN ORDER, before live
    // forwarding resumes: the hub socket just opened, so forwardToWs now
    // delivers. Without this noVNC never sees "RFB 003.xxx" and both sides
    // deadlock (server waits for the client version, noVNC waits for banner).
    for (const replay of earlyChunks) {
      forwardToWs(socket, tcp, replay);
    }
    socket.on("message", (data, isBinary) => {
      if (tunnel.closed) return;
      if (!isBinary || !(data instanceof Buffer)) {
        this.closeActive("text-frame");
        return;
      }
      if (data.byteLength === 0 || data.byteLength > DESKTOP_WS_MAX_PAYLOAD_BYTES) {
        this.closeActive("oversize-frame");
        return;
      }
      const ok = tcp.write(data);
      if (!ok) socket.pause?.();
      tcp.once("drain", () => {
        try { (socket as { resume?: () => void }).resume?.(); } catch { /* gone */ }
      });
    });
    // A persistent error swallow MUST exist alongside the close handler: the
    // `ws` client emits 'error' (with a bare ErrorEvent) before 'close' on
    // every abnormal shutdown, and an 'error' with no listener throws — which
    // under `bun test` fails the entire file even when the close is handled.
    socket.on("error", () => {});
    const onSocketClose = () => this.closeActive("hub-close");
    socket.on("close", onSocketClose);
    socket.on("error", () => this.closeActive("hub-error"));
    tcp.on("data", (chunk: Buffer) => {
      if (tunnel.closed) return;
      forwardToWs(socket, tcp, chunk);
    });
    tcp.on("error", () => this.closeActive("rfb-error"));
    tcp.on("close", () => this.closeActive("rfb-close"));
  }

  private closeActive(reason: string): void {
    const tunnel = this.active;
    if (!tunnel || tunnel.closed) return;
    tunnel.closed = true;
    this.active = null;
    void reason;
    try { tunnel.tcp.destroy(); } catch { /* gone */ }
    try { tunnel.socket.close(); } catch { /* gone */ }
  }
}

function forwardToWs(socket: WebSocket, tcp: net.Socket, chunk: Buffer): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  if (socket.bufferedAmount > DESKTOP_BUFFERED_HARD_CLOSE_BYTES) {
    tcp.destroy();
    try { socket.close(); } catch { /* gone */ }
    return;
  }
  // Slice into protocol chunks so one TCP burst cannot exceed the frame gate.
  for (let offset = 0; offset < chunk.byteLength; offset += DESKTOP_TCP_CHUNK_BYTES) {
    const piece = chunk.subarray(offset, Math.min(offset + DESKTOP_TCP_CHUNK_BYTES, chunk.byteLength));
    try {
      socket.send(piece, { binary: true });
    } catch {
      tcp.destroy();
      return;
    }
  }
  if (socket.bufferedAmount > DESKTOP_BUFFERED_SOFT_PAUSE_BYTES) {
    tcp.pause();
    const resume = () => {
      if (socket.readyState !== WebSocket.OPEN) return;
      if (socket.bufferedAmount <= DESKTOP_BUFFERED_SOFT_PAUSE_BYTES) tcp.resume();
      else setTimeout(resume, 50).unref?.();
    };
    setTimeout(resume, 50).unref?.();
  }
}

/**
 * Read exactly the 12-byte RFB server banner off a connected tunnel socket.
 * Returns the banner bytes (kept for verbatim replay to noVNC) or null when
 * the peer is not speaking RFB. Never reads past byte 12: security-type bytes
 * belong to noVNC's handshake, not to this preflight.
 */
async function readTunnelBanner(tcp: net.Socket, timeoutMs: number): Promise<Buffer | null> {
  return new Promise<Buffer | null>((resolve) => {
    const chunks: Buffer[] = [];
    let done = false;
    const finish = (value: Buffer | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      tcp.removeListener("data", onData);
      tcp.pause();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), Math.min(timeoutMs, 2000));
    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      const buffered = Buffer.concat(chunks);
      if (buffered.length < 12) return;
      finish(parseBanner(new Uint8Array(buffered.subarray(0, 12))) ? buffered.subarray(0, 12) : null);
    };
    // The socket is paused by the caller, but 'data' was attached while
    // flowing semantics still apply to already-buffered kernel data: resume
    // once so the banner arrives, then finish() re-pauses immediately.
    tcp.on("data", onData);
    tcp.resume();
    // Safety: if the banner never arrives, finish(null) via the timer above.
  });
}

async function openHubSocket(createSocket: (url: string) => WebSocket, url: string, timeoutMs: number): Promise<WebSocket> {
  // Guard synchronously: if the factory itself throws (or emits 'error' on
  // the same tick before our once-listeners attach), Node treats an
  // emitter 'error' with zero listeners as a throw. Wrap construction so a
  // pre-listener emission can never escape as an unhandled file-level error.
  let socket: WebSocket;
  try {
    socket = createSocket(url);
  } catch (err) {
    throw err instanceof Error ? err : new Error(String(err));
  }
  // A temporary swallow covers the gap between construction and the
  // once-listeners below; detached on first settle.
  const guard = () => {};
  socket.on("error", guard);
  return new Promise<WebSocket>((resolve, reject) => {
    const timer = setTimeout(() => {
      try { socket.close(); } catch { /* gone */ }
      reject(new Error(`desktop hub socket timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    // One-shot listeners MUST all detach on first settle: the tunnel registers
    // its own persistent `on("error")`/`on("close")` afterwards. `ws` emits
    // BOTH error and close for an upgrade rejection, so without detach the
    // second event re-rejects an already-settled promise (unhandled).
    let settled = false;
    const detach = () => {
      clearTimeout(timer);
      socket.removeListener("error", guard);
      socket.removeListener("error", onError as (...args: unknown[]) => void);
      socket.removeListener("close", onClose);
    };
    const onError = (err: unknown) => {
      if (settled) return;
      settled = true;
      detach();
      reject(err instanceof Error ? err : new Error(describeHubSocketError(err)));
    };
    const onClose = () => {
      if (settled) return;
      settled = true;
      detach();
      reject(new Error("desktop hub socket closed before open"));
    };
    socket.once("open", () => {
      if (settled) return;
      settled = true;
      detach();
      resolve(socket);
    });
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

/**
 * Best-effort human rendering of a ws failure: the `ws` package reports
 * upgrade rejections (e.g. hub-side 4403 for a bad ticket) as a bare
 * ErrorEvent with no message, which otherwise surfaces as
 * `[object ErrorEvent]` in prepare results.
 */
function describeHubSocketError(err: unknown): string {
  if (!err || typeof err !== "object") return String(err);
  const record = err as Record<string, unknown>;
  const message = typeof record.message === "string" && record.message ? record.message : "";
  const type = typeof record.type === "string" ? record.type : "error";
  // The failed socket's URL carries the single-use connector ticket. Never echo
  // it: this string lands in the prepare result the browser displays and in
  // hub logs, and an unconsumed ticket must not travel along the control path.
  // Origin + path is enough to diagnose which listener/route refused.
  const target = (record.target as Record<string, unknown> | undefined)?.url;
  const location = typeof target === "string" ? safeSocketLocation(target) : "";
  const code = location ? ` (${location})` : "";
  return message ? `${type}: ${message}${code}` : `hub websocket ${type} during upgrade${code}`;
}

/** Origin+path only: drops the `?ticket=…` query of a ws URL. */
function safeSocketLocation(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "";
  }
}

/** Test-only surface for the ticket scrub (module-private otherwise). */
export function describeHubSocketErrorForTests(err: unknown): string {
  return describeHubSocketError(err);
}
