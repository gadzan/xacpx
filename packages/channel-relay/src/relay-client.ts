import WebSocket from "ws";

import {
  MSG,
  RELAY_PROTOCOL_VERSION,
  decodeEnvelope,
  encodeEnvelope,
  isErrorPayload,
  type InstanceRegisterResult,
  type RelayEnvelope,
} from "@ganglion/xacpx-relay-protocol";
import type { AppLogger } from "xacpx/plugin-api";

import type { CredentialStore, RelayCredential } from "./credential-store.js";

export interface RelayClientOptions {
  url: string;
  credentialStore: Pick<CredentialStore, "load" | "save" | "clear">;
  pairingToken?: string;
  instanceName?: string;
  coreVersion?: string;
  onRequest: (envelope: RelayEnvelope, respond: (payload: unknown) => void) => void;
  onEvent?: (envelope: RelayEnvelope) => void;
  onReady?: () => void;
  reconnectDelaysMs?: number[];
  createSocket?: (url: string) => WebSocket;
  logger?: AppLogger;
}

const DEFAULT_DELAYS = [1_000, 2_000, 5_000, 10_000, 30_000];
const HANDSHAKE_ID = "handshake-1";

export class RelayClient {
  private socket: WebSocket | null = null;
  private attempts = 0;
  private stopped = false;
  private ready = false;

  constructor(private readonly options: RelayClientOptions) {}

  start(abortSignal: AbortSignal): void {
    abortSignal.addEventListener("abort", () => this.stop(), { once: true });
    if (!abortSignal.aborted) this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.socket?.close();
    this.socket = null;
  }

  sendEvent(type: string, payload: unknown): void {
    if (!this.ready || !this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return; // phase 2: drop while disconnected (no offline queue)
    }
    this.socket.send(
      encodeEnvelope({ protocolVersion: RELAY_PROTOCOL_VERSION, kind: "event", type, payload }),
    );
  }

  private connect(): void {
    if (this.stopped) return;
    const socket = (this.options.createSocket ?? ((url: string) => new WebSocket(url)))(this.options.url);
    this.socket = socket;
    this.ready = false;

    socket.on("open", () => this.sendHandshake(socket));
    socket.on("message", (data) => this.handleMessage(socket, String(data)));
    socket.on("error", () => {
      // close event follows; reconnect is handled there
    });
    socket.on("close", () => {
      this.ready = false;
      if (this.stopped) return;
      const delays = this.options.reconnectDelaysMs ?? DEFAULT_DELAYS;
      const delay = delays[Math.min(this.attempts, delays.length - 1)] ?? 30_000;
      this.attempts += 1;
      setTimeout(() => this.connect(), delay);
    });
  }

  private sendHandshake(socket: WebSocket): void {
    const credential = this.options.credentialStore.load();
    if (credential) {
      socket.send(
        encodeEnvelope({
          protocolVersion: RELAY_PROTOCOL_VERSION,
          kind: "req",
          id: HANDSHAKE_ID,
          type: MSG.instanceAuth,
          payload: {
            instanceId: credential.instanceId,
            credential: credential.credential,
            coreVersion: this.options.coreVersion,
          },
        }),
      );
      return;
    }
    if (this.options.pairingToken) {
      socket.send(
        encodeEnvelope({
          protocolVersion: RELAY_PROTOCOL_VERSION,
          kind: "req",
          id: HANDSHAKE_ID,
          type: MSG.instanceRegister,
          payload: {
            pairingToken: this.options.pairingToken,
            name: this.options.instanceName,
            coreVersion: this.options.coreVersion,
          },
        }),
      );
      return;
    }
    void this.options.logger?.error(
      "relay.no_credentials",
      "relay channel has neither credential nor pairing token",
      {},
    );
    this.stopped = true;
    socket.close();
  }

  private handleMessage(socket: WebSocket, raw: string): void {
    const decoded = decodeEnvelope(raw);
    if (!decoded.ok) {
      void this.options.logger?.error(
        "relay.decode_failed",
        `relay sent an undecodable message: ${decoded.error}`,
        { error: decoded.error, detail: decoded.detail ?? "" },
      );
      if (decoded.error === "version-mismatch") {
        // Relay is newer than this connector; reconnecting cannot help. Operator must upgrade.
        this.stopped = true;
        socket.close();
      }
      return;
    }
    const envelope = decoded.envelope;

    if (envelope.kind === "event" && envelope.type === "relay.protocol-error") {
      const p = envelope.payload;
      const detail = isErrorPayload(p) ? `${p.error.code}: ${p.error.message}` : "protocol error";
      void this.options.logger?.error(
        "relay.protocol_error",
        `relay reported a protocol error: ${detail}`,
        {},
      );
      // Fatal: relay rejected our protocol. Operator action required.
      this.stopped = true;
      socket.close();
      return;
    }

    if (envelope.kind === "event") {
      this.options.onEvent?.(envelope);
      return;
    }

    if (envelope.kind === "res" && envelope.id === HANDSHAKE_ID) {
      if (isErrorPayload(envelope.payload)) {
        void this.options.logger?.error(
          "relay.handshake_rejected",
          "relay rejected the handshake; not retrying",
          {
            code: envelope.payload.error.code,
            message: envelope.payload.error.message,
          },
        );
        // Fatal: stale credential or used/expired pairing token — operator action required.
        this.stopped = true;
        socket.close();
        return;
      }
      if (envelope.type === MSG.instanceRegister) {
        const result = envelope.payload as InstanceRegisterResult;
        const credential: RelayCredential = {
          instanceId: result.instanceId,
          credential: result.credential,
          relayUrl: this.options.url,
        };
        this.options.credentialStore.save(credential);
      }
      this.ready = true;
      this.attempts = 0;
      this.options.onReady?.();
      return;
    }

    if (envelope.kind === "req") {
      const respond = (payload: unknown) => {
        socket.send(
          encodeEnvelope({
            protocolVersion: RELAY_PROTOCOL_VERSION,
            kind: "res",
            id: envelope.id,
            type: envelope.type,
            payload,
          }),
        );
      };
      this.options.onRequest(envelope, respond);
    }
  }
}
