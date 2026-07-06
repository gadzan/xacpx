/** Ping cadence for hub-side sockets (instance connectors and web dashboards). */
export const HEARTBEAT_INTERVAL_MS = 30_000;
/** Consecutive unanswered pings tolerated before the socket is declared dead. */
export const HEARTBEAT_MAX_MISSED_PONGS = 2;

/**
 * Structural subset of a `ws` socket the heartbeat needs. `ping`/`terminate` are
 * optional so unit-test fakes (and any non-ws transport) opt out gracefully.
 */
export interface HeartbeatSocket {
  ping?(): void;
  terminate?(): void;
  close?(code?: number, reason?: string): void;
  on(event: "pong", listener: () => void): unknown;
  on(event: "close", listener: () => void): unknown;
}

/**
 * Application-level keepalive that kills half-open TCP connections: ping every
 * `intervalMs`; once `maxMissed` pings in a row go unanswered, terminate the
 * socket so its close handler runs (offline broadcast on the hub, reconnect on
 * the peer). No-op for sockets without `ping` (unit-test fakes).
 */
export function startHeartbeat(
  socket: HeartbeatSocket,
  intervalMs = HEARTBEAT_INTERVAL_MS,
  maxMissed = HEARTBEAT_MAX_MISSED_PONGS,
): void {
  if (typeof socket.ping !== "function") return;
  let missed = 0;
  socket.on("pong", () => {
    missed = 0;
  });
  const timer = setInterval(() => {
    if (missed >= maxMissed) {
      clearInterval(timer);
      try {
        if (typeof socket.terminate === "function") socket.terminate();
        else socket.close?.(4408, "heartbeat-timeout");
      } catch (err) {
        console.error("[relay] heartbeat terminate failed:", err);
      }
      return;
    }
    missed += 1;
    try {
      socket.ping!();
    } catch (err) {
      console.error("[relay] heartbeat ping failed:", err);
    }
  }, intervalMs);
  (timer as unknown as { unref?: () => void }).unref?.();
  socket.on("close", () => clearInterval(timer));
}
