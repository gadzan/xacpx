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
  /**
   * Confirmed capability snapshot at construction time. Handshake sends this
   * set as-is (missing → []); do not connect first and backfill later.
   */
  capabilities?: string[];
  onRequest: (
    envelope: RelayEnvelope,
    respond: (payload: unknown) => void,
  ) => void;
  onEvent?: (envelope: RelayEnvelope) => void;
  onReady?: () => void;
  /**
   * Fired when an authenticated hub socket drops (before reconnect). Used to
   * bulk-detach viewer attachments without releasing RMUX owner leases.
   */
  onDisconnected?: () => void;
  reconnectDelaysMs?: number[];
  /**
   * Kill the socket when no inbound traffic (the hub pings every 30s) arrives
   * within this window — detects half-open connections the connector would
   * otherwise never notice. The resulting close runs the normal reconnect path.
   */
  livenessTimeoutMs?: number;
  createSocket?: (url: string) => WebSocket;
  logger?: AppLogger;
}

const DEFAULT_DELAYS = [1_000, 2_000, 5_000, 10_000, 30_000];
/** 3x the hub's 30s heartbeat interval: tolerate two lost pings before declaring death. */
const DEFAULT_LIVENESS_TIMEOUT_MS = 90_000;
const HANDSHAKE_ID = "handshake-1";

/**
 * Upward request types a connector may issue to the Hub. The Hub answers every
 * request, so a misspelled or hijacked type must fail fast here instead of
 * reaching the Hub — keep this list minimal and deliberate.
 */
const ALLOWED_UPWARD_REQUEST_TYPES: ReadonlySet<string> = new Set([
  MSG.agentMessageRoute,
]);

/**
 * +-20% random jitter so a fleet of connectors dropped by the same hub restart
 * does not reconnect in lockstep (thundering herd).
 */
export function applyReconnectJitter(
  baseMs: number,
  random: () => number = Math.random,
): number {
  return Math.round(baseMs * (0.8 + random() * 0.4));
}

export class RelayClient {
  private socket: WebSocket | null = null;
  private attempts = 0;
  private stopped = false;
  private ready = false;

  private readonly pendingRequests = new Map<
    string,
    {
      resolve: (payload: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private requestSeq = 0;

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

  sendEvent(
    type: string,
    payload: unknown,
    onFlush?: (error?: Error) => void,
  ): void {
    if (!this.isReady()) {
      // Report the drop to senders that asked: an unconfirmed send must not be
      // treated as delivered (e.g. state sync keeps its finished-offline FIFO).
      onFlush?.(new Error("not-ready"));
      return; // phase 2: drop while disconnected (no offline queue)
    }
    // isReady() already established socket !== null && OPEN; TS just can't narrow
    // the mutable field through the method call. The optional ws completion
    // callback fires on flush OR error after the frame left the process — a send
    // into a half-open socket surfaces there, not silently.
    this.socket!.send(
      encodeEnvelope({
        protocolVersion: RELAY_PROTOCOL_VERSION,
        kind: "event",
        type,
        payload,
      }),
      onFlush,
    );
  }
  async sendRequest<T = unknown>(
    type: string,
    payload: unknown,
    options?: { timeoutMs?: number },
  ): Promise<T> {
    if (!ALLOWED_UPWARD_REQUEST_TYPES.has(type)) {
      throw new Error(`request type not allowed upward: ${type}`);
    }
    if (!this.isReady()) {
      throw new Error("relay-offline");
    }
    const id = `client-req-${++this.requestSeq}`;
    const timeoutMs = options?.timeoutMs ?? 30_000;
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error("timeout"));
      }, timeoutMs);
      this.pendingRequests.set(id, {
        resolve: (res) => resolve(res as T),
        reject,
        timer,
      });
      this.socket!.send(
        encodeEnvelope({
          protocolVersion: RELAY_PROTOCOL_VERSION,
          kind: "req",
          id,
          type,
          payload,
        }),
        (err) => {
          if (err) {
            clearTimeout(timer);
            this.pendingRequests.delete(id);
            reject(err);
          }
        },
      );
    });
  }

  /** True only while authenticated with an open socket — the window in which
   *  sendEvent actually delivers (used by the state mirror's offline routing). */
  isReady(): boolean {
    return (
      this.ready &&
      this.socket !== null &&
      this.socket.readyState === WebSocket.OPEN
    );
  }

  private connect(): void {
    if (this.stopped) return;
    const socket = (
      this.options.createSocket ?? ((url: string) => new WebSocket(url))
    )(this.options.url);
    this.socket = socket;
    this.ready = false;

    // Liveness watchdog: the hub pings on a 30s cadence, so prolonged silence
    // means the connection is half-open. terminate() forces the close event,
    // which runs the normal reconnect path below. (`ws` answers pings with
    // pongs automatically; we only need to notice their absence.)
    let livenessTimer: ReturnType<typeof setTimeout> | null = null;
    const clearLiveness = () => {
      if (livenessTimer) clearTimeout(livenessTimer);
      livenessTimer = null;
    };
    const armLiveness = () => {
      clearLiveness();
      livenessTimer = setTimeout(() => {
        void this.options.logger?.error(
          "relay.connection_stalled",
          "no traffic from relay within the liveness window; terminating half-open socket",
          {},
        );
        if (typeof socket.terminate === "function") socket.terminate();
        else socket.close();
      }, this.options.livenessTimeoutMs ?? DEFAULT_LIVENESS_TIMEOUT_MS);
      (livenessTimer as unknown as { unref?: () => void }).unref?.();
    };

    socket.on("open", () => {
      armLiveness();
      this.sendHandshake(socket);
    });
    socket.on("ping", armLiveness);
    socket.on("message", (data) => {
      armLiveness();
      this.handleMessage(socket, String(data));
    });
    socket.on("error", () => {
      // close event follows; reconnect is handled there
    });
    socket.on("close", () => {
      clearLiveness();
      const wasReady = this.ready;
      this.ready = false;
      if (wasReady) {
        try {
          this.options.onDisconnected?.();
        } catch (err) {
          void this.options.logger?.error(
            "relay.disconnect_handler_failed",
            `onDisconnected threw: ${err instanceof Error ? err.message : String(err)}`,
            {},
          );
        }
      }
      if (this.stopped) return;
      const delays = this.options.reconnectDelaysMs ?? DEFAULT_DELAYS;
      for (const [id, pending] of this.pendingRequests) {
        clearTimeout(pending.timer);
        pending.reject(new Error("relay-offline"));
      }
      this.pendingRequests.clear();
      const delay =
        delays[Math.min(this.attempts, delays.length - 1)] ?? 30_000;
      this.attempts += 1;
      setTimeout(() => this.connect(), applyReconnectJitter(delay));
    });
  }

  private sendHandshake(socket: WebSocket): void {
    const capabilities = this.options.capabilities ?? [];
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
            capabilities,
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
            capabilities,
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
      const detail = isErrorPayload(p)
        ? `${p.error.code}: ${p.error.message}`
        : "protocol error";
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
      try {
        this.options.onEvent?.(envelope);
      } catch (err) {
        void this.options.logger?.error(
          "relay.event_dispatch_failed",
          `inbound event handler threw; swallowing to protect socket: ${err instanceof Error ? err.message : String(err)}`,
          {
            error: err instanceof Error ? err.message : String(err),
            detail: envelope.type,
          },
        );
      }
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
    if (
      envelope.kind === "res" &&
      envelope.id &&
      envelope.id !== HANDSHAKE_ID
    ) {
      const pending = this.pendingRequests.get(envelope.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(envelope.id);
        if (isErrorPayload(envelope.payload)) {
          const err = new Error(envelope.payload.error.code);
          (err as Error & { code?: string }).code = envelope.payload.error.code;
          pending.reject(err);
        } else {
          pending.resolve(envelope.payload);
        }
        return;
      }
    }

    if (envelope.kind === "req") {
      const respond = (payload: unknown) => {
        // Handlers may respond long after the request arrived (async control
        // dispatch); the socket can be gone by then. Sending on a closed socket
        // throws, which would surface as an unhandledRejection in callers like
        // control-bridge's catch-path respond — drop the response instead.
        if (socket.readyState !== WebSocket.OPEN) {
          void this.options.logger?.debug(
            "relay.response_dropped",
            `dropping response for ${envelope.type}: socket is no longer open`,
            { type: envelope.type, id: envelope.id ?? "" },
          );
          return;
        }
        try {
          socket.send(
            encodeEnvelope({
              protocolVersion: RELAY_PROTOCOL_VERSION,
              kind: "res",
              id: envelope.id,
              type: envelope.type,
              payload,
            }),
          );
        } catch (err) {
          void this.options.logger?.error(
            "relay.response_send_failed",
            `sending response for ${envelope.type} failed: ${err instanceof Error ? err.message : String(err)}`,
            { type: envelope.type },
          );
        }
      };
      this.options.onRequest(envelope, respond);
    }
  }
}
