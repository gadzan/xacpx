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

/** Single authoritative default for the gateway RPC timeout, shared by the server layer. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

export interface GatewaySocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "message", listener: (data: unknown) => void): unknown;
  on(event: "close", listener: () => void): unknown;
}

export interface InstanceGatewayDeps {
  instances: Pick<InstanceStore, "redeemPairingToken" | "registerInstanceForAccount" | "verifyCredential" | "touch">;
  accounts: Pick<AccountStore, "resolveLoginToken">;
  requestTimeoutMs?: number;
  onEvent?: (instanceId: string, accountId: string, envelope: RelayEnvelope) => void;
  onStatusChange?: (instanceId: string, accountId: string, online: boolean) => void;
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
  private seq = 0;

  constructor(private readonly deps: InstanceGatewayDeps) {}

  isOnline(instanceId: string): boolean {
    return this.connections.has(instanceId);
  }

  handleConnection(socket: GatewaySocket): void {
    let authed: { instanceId: string; accountId: string } | null = null;

    socket.on("message", (data) => {
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
        authed = this.handleHandshake(socket, envelope);
        if (authed) {
          this.connections.set(authed.instanceId, { socket, accountId: authed.accountId });
          this.deps.onStatusChange?.(authed.instanceId, authed.accountId, true);
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
    });

    socket.on("close", () => {
      if (authed) {
        this.connections.delete(authed.instanceId);
        for (const [id, p] of this.pending) {
          if (p.instanceId === authed.instanceId) {
            clearTimeout(p.timer);
            this.pending.delete(id);
            p.reject(new Error("instance-offline"));
          }
        }
        this.deps.onStatusChange?.(authed.instanceId, authed.accountId, false);
      }
    });
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
