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
import { evaluateRfbHandshake, probeLoopbackRfb, RFB_LOOPBACK_HOST } from "./rfb-probe.js";

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
    // Re-verify the banner on the real tunnel socket: the probe ran earlier and
    // the port may have been rebound since. Never forward non-RFB bytes.
    const verified = await verifyTunnelBanner(tcp, config.connectTimeoutMs);
    if (!verified) {
      tcp.destroy();
      throw new Error("RFB server banner changed before tunnel start");
    }
    const url = toBinaryWsUrl(this.deps.hubUrl, ticket);
    const socket = (this.deps.createSocket ?? ((u: string) => new WebSocket(u)))(url);
    const tunnel: ActiveTunnel = { streamId, ticket, socket, tcp, closed: false };
    this.active = tunnel;
    let handshakePrefix = verified;
    socket.on("open", () => {
      if (handshakePrefix.length > 0) {
        // The bytes consumed for verification belong to noVNC, not the probe.
        forwardToWs(socket, tcp, handshakePrefix);
        handshakePrefix = Buffer.alloc(0);
      }
    });
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

async function verifyTunnelBanner(tcp: net.Socket, timeoutMs: number): Promise<Buffer | null> {
  return new Promise<Buffer | null>((resolve) => {
    const chunks: Buffer[] = [];
    let done = false;
    const finish = (value: Buffer | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      tcp.removeListener("data", onData);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), Math.min(timeoutMs, 2000));
    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      const bytes = new Uint8Array(Buffer.concat(chunks));
      const verdict = evaluateRfbHandshake(bytes);
      if (verdict === null) return;
      if (!verdict.ok) {
        finish(null);
        return;
      }
      finish(Buffer.concat(chunks));
    };
    tcp.on("data", onData);
  });
}
