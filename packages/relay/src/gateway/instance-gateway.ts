import {
  MSG,
  RELAY_PROTOCOL_VERSION,
  decodeEnvelope,
  encodeEnvelope,
  errorPayload,
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
      // otherwise evict the NEW connection and reject its in-flight requests.
      const current = this.connections.get(authed.instanceId);
      if (current?.socket !== socket) return;
      this.connections.delete(authed.instanceId);
      for (const [id, p] of this.pending) {
        if (p.instanceId === authed.instanceId) {
          clearTimeout(p.timer);
          this.pending.delete(id);
          p.reject(new Error("instance-offline"));
        }
      }
      this.deps.onStatusChange?.(authed.instanceId, authed.accountId, false);
    });
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
          try {
            existing.socket.close(4409, "superseded");
          } catch (err) {
            this.logger.error("relay.instance.superseded_close_failed", "closing superseded instance socket failed", { error: String(err) });
          }
        }
        this.deps.onStatusChange?.(identity.instanceId, identity.accountId, true);
      }
      return;
    }

    if (envelope.kind === "res" && envelope.id) {
      const waiting = this.pending.get(envelope.id);
      if (waiting) {
        clearTimeout(waiting.timer);
        this.pending.delete(envelope.id);
        waiting.resolve(envelope.payload);
      }
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
          respond(errorPayload("pairing-failed", "token is invalid, expired, or already used"));
          return null;
        }
        result = redeemed;
      }
      respond({ instanceId: result.instanceId, credential: result.credential });
      this.deps.instances.touch(result.instanceId);
      return { instanceId: result.instanceId, accountId: result.accountId };
    }
    if (envelope.type === MSG.instanceAuth) {
      const payload = envelope.payload as InstanceAuthPayload;
      const instance = this.deps.instances.verifyCredential(payload?.instanceId ?? "", payload?.credential ?? "");
      if (!instance) {
        respond(errorPayload("auth-failed", "unknown instance or bad credential"));
        socket.close(4403, "auth-failed");
        return null;
      }
      respond({ ok: true });
      this.deps.instances.touch(instance.id, payload?.coreVersion);
      return { instanceId: instance.id, accountId: instance.accountId };
    }
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

  async sendRequest(instanceId: string, type: string, payload: unknown): Promise<unknown> {
    const connection = this.connections.get(instanceId);
    if (!connection) {
      throw new Error("instance-offline");
    }
    const id = `relay-${++this.seq}`;
    const timeoutMs = this.deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("timeout"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, instanceId });
      connection.socket.send(encodeEnvelope({
        protocolVersion: RELAY_PROTOCOL_VERSION, kind: "req", id, type, payload,
      }));
    });
  }
}
