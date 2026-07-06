import { encodeEnvelope, webEventEnvelope, type WebServerEvent } from "@ganglion/xacpx-relay-protocol";

import type { RelayLogger } from "../logging.js";
import { startHeartbeat } from "./heartbeat.js";

/** ws readyState OPEN (avoid importing the ws package for one constant). */
const WS_OPEN = 1;

export interface WebSocketLike {
  send(data: string): void;
  close?(code?: number, reason?: string): void;
  /** Optional (real `ws` sockets have them): enables the keepalive heartbeat. */
  ping?(): void;
  terminate?(): void;
  readyState?: number;
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
      try {
        socket.send(data);
      } catch (err) {
        this.options.logger?.error("relay.web.broadcast_failed", "broadcast send failed", { error: String(err) });
      }
    }
  }
}
