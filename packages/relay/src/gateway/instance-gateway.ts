import {
  MSG,
  RELAY_PROTOCOL_VERSION,
  decodeEnvelope,
  encodeEnvelope,
  errorPayload,
  normalizeCapabilities,
  type InstanceAuthPayload,
  type InstanceRegisterPayload,
  type RelayEnvelope,
} from "@ganglion/xacpx-relay-protocol";

import type { AccountStore } from "../stores/accounts.js";
import type { InstanceStore } from "../stores/instances.js";
import { createNoopRelayLogger, type RelayLogger } from "../logging.js";
import { startHeartbeat } from "./heartbeat.js";

/** Single authoritative default for the gateway RPC timeout, shared by the server layer. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
export const REQUEST_RESPONSE_RESERVE_MS = 15_000;

export interface GatewaySocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  /** Optional (real `ws` sockets have them): enables the keepalive heartbeat. */
  ping?(): void;
  terminate?(): void;
  on(event: "message", listener: (data: unknown) => void): unknown;
  on(event: "close", listener: () => void): unknown;
  on(event: "pong", listener: () => void): unknown;
}

export interface InstanceGatewayDeps {
  instances: Pick<InstanceStore, "redeemPairingToken" | "registerInstanceForAccount" | "verifyCredential" | "touch">;
  accounts: Pick<AccountStore, "resolveLoginToken">;
  requestTimeoutMs?: number;
  /** Keepalive ping cadence; overridable for tests. Defaults to HEARTBEAT_INTERVAL_MS. */
  heartbeatIntervalMs?: number;
  onEvent?: (instanceId: string, accountId: string, envelope: RelayEnvelope) => void;
  onStatusChange?: (instanceId: string, accountId: string, online: boolean) => void;
  logger?: RelayLogger;
}

interface PendingRequest {
  resolve: (payload: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  instanceId: string;
  /** The socket the request was sent over — a response must come from THAT socket,
   *  not a different (even legitimately-authed) instance socket. */
  socket: GatewaySocket;
  /** The RPC type — the response envelope must echo it. */
  type: string;
}

export class InstanceGateway {
  private readonly connections = new Map<string, { socket: GatewaySocket; accountId: string }>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly logger: RelayLogger;
  private seq = 0;

  constructor(private readonly deps: InstanceGatewayDeps) {
    this.logger = deps.logger ?? createNoopRelayLogger();
  }

  isOnline(instanceId: string): boolean {
    return this.connections.has(instanceId);
  }

  handleConnection(socket: GatewaySocket): void {
    let authed: { instanceId: string; accountId: string } | null = null;
    startHeartbeat(socket, this.deps.heartbeatIntervalMs, undefined, this.logger);

    socket.on("message", (data) => {
      // A single bad frame (or a throwing onEvent consumer, e.g. a DB write) must
      // not propagate out of the listener and tear down the whole connection.
      try {
        this.handleMessage(socket, data, authed, (identity) => {
          authed = identity;
        });
      } catch (err) {
        this.logger.error("relay.instance.message_failed", "message handling failed", { error: String(err) });
      }
    });

    socket.on("close", () => {
      if (!authed) return;
      // Only the socket that currently owns the map entry may take the instance
      // offline. A superseded socket's late close (see handleMessage) would
      // otherwise evict the NEW connection and reject its in-flight requests; a
      // REVOKED socket (disconnect() already dropped the entry) likewise no-ops.
      const current = this.connections.get(authed.instanceId);
      if (current?.socket !== socket) return;
      this.dropConnection(authed.instanceId, authed.accountId);
      this.logger.info("relay.instance.offline", "instance disconnected", { instanceId: authed.instanceId, accountId: authed.accountId });
    });
  }

  /** Remove the instance's connection entry, reject its in-flight requests, and
   *  notify the offline transition. Shared by the close handler and disconnect(). */
  private dropConnection(instanceId: string, accountId: string): void {
    this.connections.delete(instanceId);
    for (const [id, p] of this.pending) {
      if (p.instanceId === instanceId) {
        clearTimeout(p.timer);
        this.pending.delete(id);
        p.reject(new Error("instance-offline"));
      }
    }
    this.deps.onStatusChange?.(instanceId, accountId, false);
  }

  private handleMessage(
    socket: GatewaySocket,
    data: unknown,
    authed: { instanceId: string; accountId: string } | null,
    setAuthed: (identity: { instanceId: string; accountId: string }) => void,
  ): void {
    const decoded = decodeEnvelope(String(data));
    if (!decoded.ok) {
      socket.send(encodeEnvelope({
        protocolVersion: RELAY_PROTOCOL_VERSION, kind: "event", type: "relay.protocol-error",
        payload: errorPayload(decoded.error, decoded.detail ?? "invalid envelope"),
      }));
      if (!authed) socket.close(4400, decoded.error);
      return;
    }
    const envelope = decoded.envelope;

    if (!authed) {
      const identity = this.handleHandshake(socket, envelope);
      if (identity) {
        setAuthed(identity);
        // A reconnect can race the old (often half-open) socket: replace the map
        // entry FIRST, then close the old socket, whose close handler no-ops
        // because the entry no longer points at it.
        const existing = this.connections.get(identity.instanceId);
        this.connections.set(identity.instanceId, { socket, accountId: identity.accountId });
        if (existing && existing.socket !== socket) {
          this.logger.info("relay.instance.superseded", "reconnect superseded old socket", { instanceId: identity.instanceId });
          // The old socket's pending RPCs can never be answered (their responses are
          // fenced out) — reject them NOW instead of letting the HTTP call wait out
          // the full request timeout. No offline transition: the new socket owns the
          // instance.
          this.rejectPendingForSocket(existing.socket, "instance-reconnected");
          try {
            existing.socket.close(4409, "superseded");
          } catch (err) {
            this.logger.error("relay.instance.superseded_close_failed", "closing superseded instance socket failed", { error: String(err) });
          }
        }
        this.deps.onStatusChange?.(identity.instanceId, identity.accountId, true);
        this.logger.info("relay.instance.online", "instance connected", { instanceId: identity.instanceId, accountId: identity.accountId });
      }
      return;
    }

    // Socket ownership fencing: only the socket that CURRENTLY owns the instance's
    // map entry may deliver messages. A revoked socket (disconnect() dropped the
    // entry) or a superseded one (a reconnect replaced it) must not keep feeding
    // events/state-syncs into onEvent — a late `turn-finished` after a persist-failed
    // disconnect would persist + ack, bypassing the reconnect/resync retry, and a
    // late state sync from a superseded socket could clobber the newer connection's
    // recovered state.
    const current = this.connections.get(authed.instanceId);
    if (current?.socket !== socket) {
      this.logger.debug("relay.instance.stale_socket", "dropped message from a revoked/superseded socket", { instanceId: authed.instanceId });
      return;
    }

    if (envelope.kind === "res" && envelope.id) {
      const waiting = this.pending.get(envelope.id);
      // Response ownership: the id alone is not enough — request ids are sequential
      // and guessable, so a DIFFERENT (even legitimately-authed) instance socket
      // could spoof another instance's pending RPC and make the hub trust a forged
      // result (markQueued, history deletion, output rows...). The response must come
      // from the SAME instance + SAME socket the request went out on, and echo the
      // request type.
      if (!waiting || waiting.instanceId !== authed.instanceId || waiting.socket !== socket || waiting.type !== envelope.type) {
        this.logger.warn("relay.instance.response_mismatch", "dropped RPC response that does not match its pending request", {
          instanceId: authed.instanceId,
          envelopeType: envelope.type,
        });
        return;
      }
      clearTimeout(waiting.timer);
      this.pending.delete(envelope.id);
      waiting.resolve(envelope.payload);
      return;
    }
    if (envelope.kind === "event") {
      this.deps.instances.touch(authed.instanceId);
      this.deps.onEvent?.(authed.instanceId, authed.accountId, envelope);
    }
  }

  /** Returns the authed identity, or null (after replying/closing) when the handshake fails. */
  private handleHandshake(
    socket: GatewaySocket,
    envelope: RelayEnvelope,
  ): { instanceId: string; accountId: string } | null {
    const respond = (payload: unknown) => {
      socket.send(encodeEnvelope({
        protocolVersion: RELAY_PROTOCOL_VERSION, kind: "res",
        id: envelope.id ?? "handshake", type: envelope.type, payload,
      }));
    };
    if (envelope.kind !== "req") {
      this.logger.info("relay.instance.handshake_failed", "handshake rejected", { reason: "not-a-request" });
      socket.close(4401, "unauthenticated");
      return null;
    }
    if (envelope.type === MSG.instanceRegister) {
      const payload = envelope.payload as InstanceRegisterPayload;
      const presented = payload?.pairingToken ?? "";
      const viaLogin = this.deps.accounts.resolveLoginToken(presented);
      let result;
      if (viaLogin) {
        result = this.deps.instances.registerInstanceForAccount(viaLogin.account.id, payload?.name, payload?.coreVersion);
      } else {
        const redeemed = this.deps.instances.redeemPairingToken(presented, payload?.coreVersion);
        if (!redeemed) {
          this.logger.info("relay.instance.handshake_failed", "handshake rejected", { reason: "pairing-failed" });
          respond(errorPayload("pairing-failed", "token is invalid, expired, or already used"));
          return null;
        }
        result = redeemed;
      }
      respond({ instanceId: result.instanceId, credential: result.credential });
      this.deps.instances.touch(result.instanceId, payload?.coreVersion, normalizeCapabilities(payload?.capabilities));
      return { instanceId: result.instanceId, accountId: result.accountId };
    }
    if (envelope.type === MSG.instanceAuth) {
      const payload = envelope.payload as InstanceAuthPayload;
      const instance = this.deps.instances.verifyCredential(payload?.instanceId ?? "", payload?.credential ?? "");
      if (!instance) {
        this.logger.info("relay.instance.handshake_failed", "handshake rejected", { reason: "auth-failed" });
        respond(errorPayload("auth-failed", "unknown instance or bad credential"));
        socket.close(4403, "auth-failed");
        return null;
      }
      respond({ ok: true });
      this.deps.instances.touch(instance.id, payload?.coreVersion, normalizeCapabilities(payload?.capabilities));
      return { instanceId: instance.id, accountId: instance.accountId };
    }
    this.logger.info("relay.instance.handshake_failed", "handshake rejected", { reason: "unknown-message-type" });
    socket.close(4401, "unauthenticated");
    return null;
  }

  /** Fire-and-forget downward event to a connector. No pending/timeout. Returns false if offline. */
  sendEvent(instanceId: string, type: string, payload: unknown): boolean {
    const connection = this.connections.get(instanceId);
    if (!connection) return false;
    connection.socket.send(encodeEnvelope({ protocolVersion: RELAY_PROTOCOL_VERSION, kind: "event", type, payload }));
    return true;
  }

  /** Force-close the instance's current socket (e.g. after a failed recovery
   *  persistence transaction). The connector reconnects with backoff and re-sends its
   *  `instance.state.sync` on auth, so the entry that failed to persist gets another
   *  chance instead of sitting in the connector's FIFO until eviction.
   *
   *  The connection is REVOKED FIRST (map entry dropped, in-flight requests rejected,
   *  offline transition fired) and the socket closed only afterwards — the close
   *  handshake is async, and a socket that stayed in the map during it could keep
   *  delivering events (e.g. a late `turn-finished` that persists + acks, bypassing
   *  the reconnect/resync this disconnect was meant to force). The ownership check in
   *  handleMessage drops anything that still arrives on the revoked socket. */
  disconnect(instanceId: string): void {
    const connection = this.connections.get(instanceId);
    if (!connection) return;
    this.dropConnection(instanceId, connection.accountId);
    this.logger.info("relay.instance.disconnected", "instance connection revoked (persist-failed)", { instanceId, accountId: connection.accountId });
    try {
      connection.socket.close(4408, "persist-failed");
    } catch (err) {
      this.logger.debug("relay.instance.disconnect_failed", "closing revoked instance socket failed", { instanceId, error: String(err) });
    }
  }

  async sendRequest(
    instanceId: string,
    type: string,
    payload: unknown,
    options?: { timeoutMs?: number },
  ): Promise<unknown> {
    const connection = this.connections.get(instanceId);
    if (!connection) {
      throw new Error("instance-offline");
    }
    const id = `relay-${++this.seq}`;
    const timeoutMs = options?.timeoutMs ?? this.deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const requestBudgetMs = Math.max(timeoutMs - REQUEST_RESPONSE_RESERVE_MS, 1);
    // This is the mutation work cutoff, not the Hub response timer. Keeping the
    // reserve in both representations prevents delivery latency from consuming it.
    const requestDeadlineAt = Date.now() + requestBudgetMs;
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("timeout"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, instanceId, socket: connection.socket, type });
      connection.socket.send(encodeEnvelope({
        protocolVersion: RELAY_PROTOCOL_VERSION,
        kind: "req",
        id,
        type,
        payload,
        requestDeadlineAt,
        requestBudgetMs,
      }));
    });
  }

  /** Reject every pending RPC that went out over `socket` (used when the socket is
   *  superseded by a reconnect — the old connection's responses will never arrive, and
   *  waiting out the full request timeout would hang the HTTP call). Does NOT fire the
   *  offline transition: the new connection has already taken over the instance. */
  private rejectPendingForSocket(socket: GatewaySocket, reason: string): void {
    for (const [id, p] of this.pending) {
      if (p.socket === socket) {
        clearTimeout(p.timer);
        this.pending.delete(id);
        p.reject(new Error(reason));
      }
    }
  }
}

/** Default timeout for recoverable terminal open/take-control/resync/terminate (spec §14). */
export const TERMINAL_REQUEST_TIMEOUT_MS = 10_000;
