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
import { DesktopTicketStore, type DesktopTicket } from "./desktop-ticket-store.js";
import { DesktopStreamRegistry, type DesktopStreamRecord } from "./desktop-stream-registry.js";

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

/** Pre-consumed connector ticket: identity already validated at upgrade time. */
export interface DesktopTicketClaim {
  streamId: string;
  accountId: string;
  instanceId: string;
}
export interface DesktopStreamGatewayOptions {
  tickets?: DesktopTicketStore;
  streams?: DesktopStreamRegistry;
  logger?: RelayLogger;
  maxPayloadBytes?: number;
  hardCloseBufferedBytes?: number;
  onStreamClosed?: (streamId: string) => void;
}

const PRE_ATTACH_MAX_STREAMS = 64;
const PRE_ATTACH_MAX_BYTES_PER_STREAM = 64 * 1024;

export class DesktopStreamGateway {
  private readonly tickets: DesktopTicketStore;
  private readonly streams: DesktopStreamRegistry;
  private readonly paired = new Map<string, PairedSockets>();
  /**
   * Frames that arrive before BOTH binary sides are paired (normally the
   * connector's RFB banner: the connector always attaches during prepare,
   * the browser only after desktop-opened). Without this the replayed banner
   * is dropped by onFrame's no-peer guard and both ends deadlock (server
   * waits for the client version, noVNC waits for the banner). Bounded per
   * stream; flushed in order once both sides are present; dropped on close
   * or reservation expiry.
   */
  private readonly preAttach = new Map<string, { chunks: Uint8Array[]; bytes: number }>();
  private readonly logger: RelayLogger;
  private readonly maxPayloadBytes: number;
  private readonly hardCloseBufferedBytes: number;
  private readonly onStreamClosed?: (streamId: string) => void;

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

  /**
   * Sole reservation entry point: expired preparing/waiting-browser streams
   * terminate through closeStream (paired sockets, pre-attach buffers,
   * tickets, owner notification) instead of the registry silently dropping
   * the record and orphaning a live connector tunnel. Synchronous, so the
   * sweep + check + insert stay atomic within one hub event-loop turn.
   */
  reserve(input: { accountId: string; instanceId: string; ttlMs: number }):
    | { ok: true; record: DesktopStreamRecord }
    | { ok: false; code: "desktop-busy"; scope: "instance" | "account" } {
    this.sweepExpired();
    return this.streams.reserve(input);
  }

  /**
   * Terminate every TTL-expired preparing/waiting-browser stream through the
   * single closeStream path. Called by reserve() and by the hub's periodic
   * sweep timer (covers the quiescent case: no new reserve ever arrives).
   */
  sweepExpired(): number {
    const expired = this.streams.sweepExpired();
    for (const record of expired) {
      this.closeStream(record.streamId, "stream-expired");
    }
    if (expired.length > 0) this.streams.pruneClosed();
    // No caller ever swept stale single-use tickets: bound the map here.
    this.tickets.sweepExpired();
    return expired.length;
  }

  /**
   * Mint the browser ticket for a stream that just passed its RFB probe, and
   * align the stream's deadline with it.
   *
   * The reservation TTL started at reserve() time, but the connector prepare
   * (probe + TCP handshake) runs AFTER that, so the stream's original deadline
   * can expire before its own browser ticket does. Two directions matter:
   * the sweep killing a stream whose ticket is still valid, and ( worse) the
   * sweep missing between ticks so `pair()` resurrects an expired record as
   * `active`. Extending to `max(current, ticket.expiresAt)` makes the ticket's
   * TTL the single authoritative deadline for the stream.
   */
  mintBrowserTicket(input: { streamId: string; accountId: string; instanceId: string }): DesktopTicket {
    const ticket = this.tickets.mintTicket({ ...input, side: "browser" });
    this.streams.extendExpiry(ticket.streamId, ticket.expiresAt);
    return ticket;
  }

  attachBrowser(ticket: string, socket: DesktopBinarySocket, authenticatedAccountId?: string): { ok: true; streamId: string } | { ok: false; reason: string } {
    const record = this.tickets.consume(ticket, "browser", authenticatedAccountId);
    if (!record) return this.reject(socket, "unknown-or-reused-ticket");
    return this.pair(record, "browser", socket);
  }
  /**
   * Consume a connector ticket BEFORE the WS handshake completes, returning an
   * opaque single-use claim. The HTTP-upgrade layer calls this synchronously
   * on the request line (both merged and dedicated listeners) so a raw TCP
   * prober that never finishes the handshake still burns the ticket — and a
   * later connector `open` event then implies hub acceptance of this ticket.
   */
  precheckConnectorTicket(ticket: string): { ok: true; claim: DesktopTicketClaim } | { ok: false; reason: string } {
    const record = this.tickets.consume(ticket, "connector");
    if (!record) return { ok: false, reason: "unknown-or-reused-ticket" };
    const registryRecord = this.streams.get(record.streamId);
    // Same liveness semantics as pair(): an expired-but-unswept reservation
    // must not reserve a tunnel slot on the connector.
    if (!this.streams.isLive(registryRecord)) return { ok: false, reason: "stream-expired" };
    if (registryRecord.accountId !== record.accountId || registryRecord.instanceId !== record.instanceId) {
      return { ok: false, reason: "ticket-identity-mismatch" };
    }
    return { ok: true, claim: { streamId: record.streamId, accountId: record.accountId, instanceId: record.instanceId } };
  }

  attachConnector(ticketOrClaim: string | DesktopTicketClaim, socket: DesktopBinarySocket): { ok: true; streamId: string } | { ok: false; reason: string } {
    if (typeof ticketOrClaim !== "string") return this.pair(ticketOrClaim, "connector", socket);
    const record = this.tickets.consume(ticketOrClaim, "connector");
    if (!record) return this.reject(socket, "unknown-or-reused-ticket");
    return this.pair(record, "connector", socket);
  }

  /** Connector reported its RFB probe outcome; only `vnc-auth` streams go live. */
  reportConnectorReady(streamId: string, security: DesktopSecurityKind): boolean {
    const record = this.streams.get(streamId);
    if (!record || record.state === "closed") return false;
    if (security !== "vnc-auth") return false;
    const pair = this.paired.get(streamId) ?? {};
    pair.security = security;
    this.paired.set(streamId, pair);
    if (pair.browser && pair.connector) {
      this.streams.setState(streamId, "active");
      this.flushPreAttach(streamId);
    } else {
      this.streams.setState(streamId, "waiting-browser");
    }
    return true;
  }
  closeStream(streamId: string, reason = "closed"): void {
    const pair = this.paired.get(streamId);
    const record = this.streams.get(streamId);
    // Idempotent: close() leaves a terminal `closed` record so late binary
    // upgrades fail closed. A second call (e.g. the socket `close` listener
    // re-entering synchronously from the close() below) must NOT refire
    // onStreamClosed or re-close peers — only a live pair or a non-closed
    // record counts as a real termination.
    const known = pair !== undefined || (record !== undefined && record.state !== "closed");
    this.paired.delete(streamId);
    this.preAttach.delete(streamId);
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
    record: { streamId: string; accountId: string; instanceId: string },
    side: "browser" | "connector",
    socket: DesktopBinarySocket,
  ): { ok: true; streamId: string } | { ok: false; reason: string } {
    const streamId = record.streamId;
    const registryRecord = this.streams.get(streamId);
    // Defense in depth: the ticket's account/instance binding must match the
    // registry's authoritative stream identity. A ticket minted for stream X
    // must never attach to stream Y, even if both ids are somehow valid.
    // Liveness includes the admission deadline: an expiry that lands between
    // sweep ticks must fail closed here rather than let a stale reservation
    // pair and start a session its own deadline forbids. (This guards
    // admission only — `pair()` is not how a live `active` session ends.)
    if (!this.streams.isLive(registryRecord)) return this.reject(socket, "stream-expired");
    if (registryRecord.accountId !== record.accountId || registryRecord.instanceId !== record.instanceId) {
      return this.reject(socket, "ticket-identity-mismatch");
    }
    const pair = this.paired.get(streamId) ?? {};
    if (pair[side]) return this.reject(socket, "side-already-attached");
    pair[side] = socket;
    this.paired.set(streamId, pair);
    socket.on("message", (data, isBinary) => this.onFrame(streamId, side, socket, data, isBinary));
    socket.on("close", () => this.closeStream(streamId, `${side}-close`));
    if (pair.browser && pair.connector && pair.security) {
      this.streams.setState(streamId, "active");
      this.flushPreAttach(streamId);
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
    if (!record || record.state === "closed" || !pair) {
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
    const peer = from === "browser" ? pair.connector : pair.browser;
    if (!peer) {
      // Peer not attached yet (connector replayed the RFB banner before the
      // browser opened /desktop/observe). Buffer boundedly and flush in
      // order once both sides + security coincide; drop on overflow.
      this.bufferPreAttach(streamId, data);
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

  private bufferPreAttach(streamId: string, data: Uint8Array): void {
    const existing = this.preAttach.get(streamId);
    const bytes = (existing?.bytes ?? 0) + data.byteLength;
    if (bytes > PRE_ATTACH_MAX_BYTES_PER_STREAM) {
      this.logger.warn("relay.desktop.preattach_overflow", "pre-attach desktop buffer overflow", { streamId });
      this.closeStream(streamId, "preattach-overflow");
      return;
    }
    if (!existing && this.preAttach.size >= PRE_ATTACH_MAX_STREAMS) {
      this.logger.warn("relay.desktop.preattach_overflow", "too many pre-attach desktop streams", { streamId });
      this.closeStream(streamId, "preattach-overflow");
      return;
    }
    const entry = existing ?? { chunks: [], bytes: 0 };
    entry.chunks.push(data);
    entry.bytes = bytes;
    this.preAttach.set(streamId, entry);
  }

  private flushPreAttach(streamId: string): void {
    const entry = this.preAttach.get(streamId);
    if (!entry) return;
    this.preAttach.delete(streamId);
    const pair = this.paired.get(streamId);
    const peer = pair?.browser;
    if (!peer || pair?.connector === undefined) return;
    for (const chunk of entry.chunks) {
      try {
        peer.send(chunk);
      } catch {
        this.closeStream(streamId, "send-failed");
        return;
      }
    }
  }
}
