// packages/relay/src/gateway/desktop-stream-gateway.ts
// Binary desktop stream broker: pairs one browser `/desktop/observe` socket
// with one connector `/desktop/instance` socket per stream and forwards raw
// binary frames. The hub never parses framebuffer bytes; text frames, oversize
// payloads, ticket reuse, and cross account/instance use fail closed.

import {
  DESKTOP_BUFFERED_HARD_CLOSE_BYTES,
  DESKTOP_WS_MAX_PAYLOAD_BYTES,
  type DesktopSecurityKind,
} from "@ganglion/xacpx-relay-protocol";

import type { RelayLogger } from "../logging.js";
import { createNoopRelayLogger } from "../logging.js";
import { DesktopTicketStore } from "./desktop-ticket-store.js";
import { DesktopStreamRegistry } from "./desktop-stream-registry.js";

export interface DesktopBinarySocket {
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  readonly bufferedAmount: number;
  on(event: "message", listener: (data: unknown, isBinary: boolean) => void): unknown;
  on(event: "close", listener: () => void): unknown;
}

interface PairedSockets {
  browser?: DesktopBinarySocket;
  connector?: DesktopBinarySocket;
  security?: DesktopSecurityKind;
}

export interface DesktopStreamGatewayOptions {
  tickets?: DesktopTicketStore;
  streams?: DesktopStreamRegistry;
  logger?: RelayLogger;
  maxPayloadBytes?: number;
  hardCloseBufferedBytes?: number;
  onStreamClosed?: (streamId: string) => void;
}

export class DesktopStreamGateway {
  private readonly tickets: DesktopTicketStore;
  private readonly streams: DesktopStreamRegistry;
  private readonly logger: RelayLogger;
  private readonly maxPayloadBytes: number;
  private readonly hardCloseBufferedBytes: number;
  private readonly onStreamClosed?: (streamId: string) => void;
  private readonly paired = new Map<string, PairedSockets>();

  constructor(options: DesktopStreamGatewayOptions = {}) {
    this.tickets = options.tickets ?? new DesktopTicketStore();
    this.streams = options.streams ?? new DesktopStreamRegistry();
    this.logger = options.logger ?? createNoopRelayLogger();
    this.maxPayloadBytes = options.maxPayloadBytes ?? DESKTOP_WS_MAX_PAYLOAD_BYTES;
    this.hardCloseBufferedBytes = options.hardCloseBufferedBytes ?? DESKTOP_BUFFERED_HARD_CLOSE_BYTES;
    this.onStreamClosed = options.onStreamClosed;
  }

  get ticketStore(): DesktopTicketStore {
    return this.tickets;
  }

  get streamRegistry(): DesktopStreamRegistry {
    return this.streams;
  }

  attachBrowser(ticket: string, socket: DesktopBinarySocket): { ok: true; streamId: string } | { ok: false; reason: string } {
    const record = this.tickets.consume(ticket, "browser");
    if (!record) return this.reject(socket, "unknown-or-reused-ticket");
    return this.pair(record.streamId, "browser", socket);
  }

  attachConnector(ticket: string, socket: DesktopBinarySocket): { ok: true; streamId: string } | { ok: false; reason: string } {
    const record = this.tickets.consume(ticket, "connector");
    if (!record) return this.reject(socket, "unknown-or-reused-ticket");
    return this.pair(record.streamId, "connector", socket);
  }

  /** Connector reported its RFB probe outcome; only `vnc-auth` streams go live. */
  reportConnectorReady(streamId: string, security: DesktopSecurityKind): boolean {
    const record = this.streams.get(streamId);
    if (!record || record.state === "closed") return false;
    if (security !== "vnc-auth") return false;
    const pair = this.paired.get(streamId) ?? {};
    pair.security = security;
    this.paired.set(streamId, pair);
    this.streams.setState(streamId, pair.browser && pair.connector ? "active" : "waiting-browser");
    return true;
  }

  closeStream(streamId: string, reason = "closed"): void {
    const pair = this.paired.get(streamId);
    const known = pair !== undefined || this.streams.get(streamId) !== undefined;
    this.paired.delete(streamId);
    this.streams.close(streamId);
    this.tickets.revokeForStream(streamId);
    if (!known) return;
    // Never log ticket material: stream ids + reason only.
    this.logger.info("relay.desktop.stream_closed", "desktop stream closed", { streamId, reason });
    try { pair?.browser?.close(1000, reason); } catch { /* already gone */ }
    try { pair?.connector?.close(1000, reason); } catch { /* already gone */ }
    this.onStreamClosed?.(streamId);
  }

  closeForInstance(instanceId: string, reason = "instance-offline"): void {
    for (const record of this.streams.closeForInstance(instanceId)) {
      this.closeStream(record.streamId, reason);
    }
  }

  private pair(
    streamId: string,
    side: "browser" | "connector",
    socket: DesktopBinarySocket,
  ): { ok: true; streamId: string } | { ok: false; reason: string } {
    const record = this.streams.get(streamId);
    if (!record || record.state === "closed") return this.reject(socket, "stream-closed");
    const pair = this.paired.get(streamId) ?? {};
    if (pair[side]) return this.reject(socket, "side-already-attached");
    pair[side] = socket;
    this.paired.set(streamId, pair);
    socket.on("message", (data, isBinary) => this.onFrame(streamId, side, socket, data, isBinary));
    socket.on("close", () => this.closeStream(streamId, `${side}-close`));
    if (pair.browser && pair.connector && pair.security) {
      this.streams.setState(streamId, "active");
    }
    return { ok: true, streamId };
  }

  private onFrame(
    streamId: string,
    from: "browser" | "connector",
    socket: DesktopBinarySocket,
    data: unknown,
    isBinary: boolean,
  ): void {
    const record = this.streams.get(streamId);
    const pair = this.paired.get(streamId);
    const peer = from === "browser" ? pair?.connector : pair?.browser;
    if (!record || record.state === "closed" || !pair || !peer) {
      return;
    }
    if (!isBinary || !(data instanceof Uint8Array)) {
      this.logger.warn("relay.desktop.text_frame", "desktop text frame rejected", { streamId });
      this.closeStream(streamId, "text-frame");
      return;
    }
    if (data.byteLength === 0 || data.byteLength > this.maxPayloadBytes) {
      this.logger.warn("relay.desktop.oversize_frame", "desktop oversize frame rejected", {
        streamId,
        bytes: data.byteLength,
      });
      this.closeStream(streamId, "oversize-frame");
      return;
    }
    if (peer.bufferedAmount > this.hardCloseBufferedBytes || socket.bufferedAmount > this.hardCloseBufferedBytes) {
      this.logger.warn("relay.desktop.backpressure_close", "slow desktop peer evicted", { streamId });
      this.closeStream(streamId, "backpressure");
      return;
    }
    try {
      peer.send(data);
    } catch {
      this.closeStream(streamId, "send-failed");
    }
  }

  private reject(socket: DesktopBinarySocket, reason: string): { ok: false; reason: string } {
    try { socket.close(4403, reason); } catch { /* already gone */ }
    return { ok: false, reason };
  }
}
