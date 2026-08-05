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
  // Per-socket instance subscription. ABSENT from this map = "all" (a freshly-registered
  // socket, or a legacy client that never sends `subscribe`) → backward-compatible.
  private readonly subscriptions = new Map<WebSocketLike, Set<string>>();

  constructor(private readonly options: WebGatewayOptions = {}) {}

  register(accountId: string, socket: WebSocketLike): void {
    const set = this.byAccount.get(accountId) ?? new Set<WebSocketLike>();
    set.add(socket);
    this.byAccount.set(accountId, set);
    this.options.logger?.debug("relay.web.connected", "web client connected", { accountId });
    startHeartbeat(socket, this.options.heartbeatIntervalMs, undefined, this.options.logger);
    socket.on("close", () => {
      set.delete(socket);
      this.subscriptions.delete(socket);
      if (set.size === 0) this.byAccount.delete(accountId);
      this.options.logger?.debug("relay.web.disconnected", "web client disconnected", { accountId });
    });
  }

  /** Replace a socket's instance subscription (full-set, idempotent). A socket not present
   *  in the map receives every control-event; call with [] to receive none. */
  setSubscription(socket: WebSocketLike, instanceIds: string[]): void {
    this.subscriptions.set(socket, new Set(instanceIds));
  }

  /** Send one ordered event to a specific browser socket. Used for subscription
   *  snapshots so the authoritative state is sequenced before later broadcasts. */
  send(socket: WebSocketLike, event: WebServerEvent): boolean {
    return this.sendEncoded(socket, encodeEnvelope(webEventEnvelope(event)));
  }

  private sendEncoded(socket: WebSocketLike, data: string, accountId?: string): boolean {
    if (typeof socket.readyState === "number" && socket.readyState !== WS_OPEN) return false;
    if (typeof socket.bufferedAmount === "number" && socket.bufferedAmount > BACKPRESSURE_MAX) {
      this.options.logger?.info("relay.web.backpressure_evict", "evicting slow web client", {
        ...(accountId ? { accountId } : {}),
        bufferedAmount: socket.bufferedAmount,
      });
      try { socket.terminate?.(); } catch { /* already gone */ }
      return false;
    }
    try {
      socket.send(data);
      return true;
    } catch (err) {
      this.options.logger?.error("relay.web.broadcast_failed", "web event send failed", { error: String(err) });
      return false;
    }
  }

  broadcast(accountId: string, event: WebServerEvent): void {
    const set = this.byAccount.get(accountId);
    if (!set) return;
    const data = encodeEnvelope(webEventEnvelope(event));
    // control-events are scoped to the socket's instance subscription; a socket with no
    // subscription (absent from the map) receives all. instance-status / notice are
    // account-wide (the global instance list needs them regardless of the active instance).
    const scoped = event.kind === "control-event" || event.kind === "state-snapshot";
    for (const socket of set) {
      if (scoped) {
        const sub = this.subscriptions.get(socket);
        if (sub && !sub.has(event.instanceId)) continue;
      }
      // One dead/throwing socket must not starve the remaining dashboards.
      this.sendEncoded(socket, data, accountId);
    }
  }
}
