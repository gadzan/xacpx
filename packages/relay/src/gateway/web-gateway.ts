import { encodeEnvelope, webEventEnvelope, type WebServerEvent } from "@ganglion/xacpx-relay-protocol";

import type { RelayLogger } from "../logging.js";
import { startHeartbeat } from "./heartbeat.js";

/** ws readyState OPEN (avoid importing the ws package for one constant). */
const WS_OPEN = 1;

/** Terminate a web socket whose send buffer exceeds this — a genuinely stalled client.
 *  A healthy client drains to ~0, so this never false-positives on transient bursts. The
 *  evicted client reconnects and re-attaches, replaying the bounded terminal scrollback. */
const BACKPRESSURE_MAX = 4 * 1024 * 1024;

export interface WebSocketLike {
  send(data: string): void;
  close?(code?: number, reason?: string): void;
  /** Optional (real `ws` sockets have them): enables the keepalive heartbeat. */
  ping?(): void;
  terminate?(): void;
  readyState?: number;
  /** Optional (real `ws` sockets have it): bytes queued but not yet flushed to the OS. */
  bufferedAmount?: number;
  on(event: "close", listener: () => void): unknown;
  on(event: "pong", listener: () => void): unknown;
}

export interface WebGatewayOptions {
  /** Keepalive ping cadence; overridable for tests. Defaults to HEARTBEAT_INTERVAL_MS. */
  heartbeatIntervalMs?: number;
  logger?: RelayLogger;
}

/** Tracks authenticated browser sockets per account and fans events out to them. */
export class WebGateway {
  private readonly byAccount = new Map<string, Set<WebSocketLike>>();

  constructor(private readonly options: WebGatewayOptions = {}) {}

  register(accountId: string, socket: WebSocketLike): void {
    const set = this.byAccount.get(accountId) ?? new Set<WebSocketLike>();
    set.add(socket);
    this.byAccount.set(accountId, set);
    this.options.logger?.debug("relay.web.connected", "web client connected", { accountId });
    startHeartbeat(socket, this.options.heartbeatIntervalMs, undefined, this.options.logger);
    socket.on("close", () => {
      set.delete(socket);
      if (set.size === 0) this.byAccount.delete(accountId);
      this.options.logger?.debug("relay.web.disconnected", "web client disconnected", { accountId });
    });
  }

  broadcast(accountId: string, event: WebServerEvent): void {
    const set = this.byAccount.get(accountId);
    if (!set) return;
    const data = encodeEnvelope(webEventEnvelope(event));
    for (const socket of set) {
      // One dead/throwing socket must not starve the remaining dashboards.
      if (typeof socket.readyState === "number" && socket.readyState !== WS_OPEN) continue;
      // Backpressure: a stalled client's send buffer grows without bound. Evict it (it
      // reconnects and re-attaches, replaying the bounded scrollback) rather than OOM the hub.
      if (typeof socket.bufferedAmount === "number" && socket.bufferedAmount > BACKPRESSURE_MAX) {
        this.options.logger?.info("relay.web.backpressure_evict", "evicting slow web client", { accountId, bufferedAmount: socket.bufferedAmount });
        try { socket.terminate?.(); } catch { /* already gone */ }
        continue;
      }
      try {
        socket.send(data);
      } catch (err) {
        this.options.logger?.error("relay.web.broadcast_failed", "broadcast send failed", { error: String(err) });
      }
    }
  }
}
