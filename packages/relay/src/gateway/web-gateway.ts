import { randomUUID } from "node:crypto";

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
  /**
   * Best-effort detach notify when a socket loses an attachment (close /
   * backpressure / explicit unbind). Hub→connector detach is fire-and-forget;
   * attachment TTL on the connector is the backup.
   */
  onAttachmentDetached?: (info: {
    instanceId: string;
    attachmentId: string;
    viewerId: string;
  }) => void;
}

export interface TerminalAttachmentBinding {
  attachmentId: string;
  viewerId: string;
  terminalId: string;
  instanceId: string;
  socket: WebSocketLike;
}

function terminalKey(instanceId: string, terminalId: string): string {
  return `${instanceId}\0${terminalId}`;
}

/** Tracks authenticated browser sockets per account and fans events out to them. */
export class WebGateway {
  private readonly byAccount = new Map<string, Set<WebSocketLike>>();
  // Per-socket instance subscription. ABSENT from this map = "all" (a freshly-registered
  // socket, or a legacy client that never sends `subscribe`) → backward-compatible.
  private readonly subscriptions = new Map<WebSocketLike, Set<string>>();

  /** Hub-stamped viewer identity per authenticated browser socket (spec §13.2). */
  private readonly viewerBySocket = new Map<WebSocketLike, string>();
  private readonly accountBySocket = new Map<WebSocketLike, string>();
  private readonly attachmentsBySocket = new Map<WebSocketLike, Set<string>>();
  private readonly socketByAttachment = new Map<string, WebSocketLike>();
  private readonly bindingByAttachment = new Map<string, TerminalAttachmentBinding>();
  private readonly attachmentsByTerminal = new Map<string, Set<string>>();

  constructor(private readonly options: WebGatewayOptions = {}) {}

  register(accountId: string, socket: WebSocketLike): string {
    const set = this.byAccount.get(accountId) ?? new Set<WebSocketLike>();
    set.add(socket);
    this.byAccount.set(accountId, set);
    const viewerId = randomUUID();
    this.viewerBySocket.set(socket, viewerId);
    this.accountBySocket.set(socket, accountId);
    this.attachmentsBySocket.set(socket, new Set());
    this.options.logger?.debug("relay.web.connected", "web client connected", { accountId });
    startHeartbeat(socket, this.options.heartbeatIntervalMs, undefined, this.options.logger);
    socket.on("close", () => {
      this.clearSocketAttachments(socket);
      set.delete(socket);
      this.subscriptions.delete(socket);
      this.viewerBySocket.delete(socket);
      this.accountBySocket.delete(socket);
      this.attachmentsBySocket.delete(socket);
      if (set.size === 0) this.byAccount.delete(accountId);
      this.options.logger?.debug("relay.web.disconnected", "web client disconnected", { accountId });
    });
    return viewerId;
  }

  getViewerId(socket: WebSocketLike): string | undefined {
    return this.viewerBySocket.get(socket);
  }

  /** Replace a socket's instance subscription (full-set, idempotent). A socket not present
   *  in the map receives every control-event; call with [] to receive none. */
  setSubscription(socket: WebSocketLike, instanceIds: string[]): void {
    this.subscriptions.set(socket, new Set(instanceIds));
  }

  /**
   * Bind socket↔attachment↔terminal in one synchronous critical section
   * (spec §13.2 / Task 19). Replaces any prior binding for the same attachmentId.
   */
  bindAttachment(input: {
    socket: WebSocketLike;
    attachmentId: string;
    terminalId: string;
    instanceId: string;
  }): void {
    const viewerId = this.viewerBySocket.get(input.socket);
    if (!viewerId) {
      throw new Error("socket has no viewerId; register() before bindAttachment");
    }
    // Drop stale binding for this attachmentId if any.
    this.unbindAttachment(input.attachmentId, { notifyDetach: false });

    const binding: TerminalAttachmentBinding = {
      attachmentId: input.attachmentId,
      viewerId,
      terminalId: input.terminalId,
      instanceId: input.instanceId,
      socket: input.socket,
    };
    this.bindingByAttachment.set(input.attachmentId, binding);
    this.socketByAttachment.set(input.attachmentId, input.socket);
    const sockSet = this.attachmentsBySocket.get(input.socket) ?? new Set<string>();
    sockSet.add(input.attachmentId);
    this.attachmentsBySocket.set(input.socket, sockSet);
    const tKey = terminalKey(input.instanceId, input.terminalId);
    const termSet = this.attachmentsByTerminal.get(tKey) ?? new Set<string>();
    termSet.add(input.attachmentId);
    this.attachmentsByTerminal.set(tKey, termSet);
  }

  /**
   * Remove one attachment binding. When `notifyDetach` is true (default), invokes
   * `onAttachmentDetached` so the hub can best-effort detach on the connector.
   */
  unbindAttachment(
    attachmentId: string,
    opts: { notifyDetach?: boolean } = {},
  ): TerminalAttachmentBinding | undefined {
    const binding = this.bindingByAttachment.get(attachmentId);
    if (!binding) return undefined;
    this.bindingByAttachment.delete(attachmentId);
    this.socketByAttachment.delete(attachmentId);
    this.attachmentsBySocket.get(binding.socket)?.delete(attachmentId);
    const tKey = terminalKey(binding.instanceId, binding.terminalId);
    const termSet = this.attachmentsByTerminal.get(tKey);
    if (termSet) {
      termSet.delete(attachmentId);
      if (termSet.size === 0) this.attachmentsByTerminal.delete(tKey);
    }
    if (opts.notifyDetach !== false) {
      this.options.onAttachmentDetached?.({
        instanceId: binding.instanceId,
        attachmentId: binding.attachmentId,
        viewerId: binding.viewerId,
      });
    }
    return binding;
  }

  getAttachmentBinding(attachmentId: string): TerminalAttachmentBinding | undefined {
    return this.bindingByAttachment.get(attachmentId);
  }

  /** True iff this socket currently owns the attachment (input/resize/heartbeat gate). */
  socketOwnsAttachment(socket: WebSocketLike, attachmentId: string): boolean {
    return this.socketByAttachment.get(attachmentId) === socket;
  }

  /**
   * Targeted send: re-validates (viewerId, attachmentId) still map to the same
   * live socket before writing. Stale connector frames are dropped.
   */
  sendToAttachment(viewerId: string, attachmentId: string, event: WebServerEvent): boolean {
    const binding = this.bindingByAttachment.get(attachmentId);
    if (!binding) return false;
    if (binding.viewerId !== viewerId) return false;
    if (this.socketByAttachment.get(attachmentId) !== binding.socket) return false;
    return this.send(binding.socket, event);
  }

  /** Fanout resource-exit only to attachments currently bound to that terminal. */
  fanoutTerminalExit(
    instanceId: string,
    terminalId: string,
    event: Extract<WebServerEvent, { kind: "terminal-exit" }>,
  ): void {
    const ids = this.attachmentsByTerminal.get(terminalKey(instanceId, terminalId));
    if (!ids) return;
    for (const attachmentId of [...ids]) {
      const binding = this.bindingByAttachment.get(attachmentId);
      if (!binding) continue;
      this.send(binding.socket, event);
      // Resource is gone — drop local binding without connector detach (already exiting).
      this.unbindAttachment(attachmentId, { notifyDetach: false });
    }
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
      // Evict only this viewer; clear attachments first so other viewers on the
      // same terminal keep their bindings.
      this.clearSocketAttachments(socket);
      try { socket.terminate?.(); } catch { /* already gone */ }
      return false;
    }
    try {
      socket.send(data);
    } catch (err) {
      this.options.logger?.error("relay.web.broadcast_failed", "web event send failed", { error: String(err) });
      return false;
    }
    return true;
  }

  private clearSocketAttachments(socket: WebSocketLike): void {
    const ids = [...(this.attachmentsBySocket.get(socket) ?? [])];
    for (const attachmentId of ids) {
      this.unbindAttachment(attachmentId, { notifyDetach: true });
    }
  }

  broadcast(accountId: string, event: WebServerEvent): void {
    const set = this.byAccount.get(accountId);
    if (!set) return;
    const data = encodeEnvelope(webEventEnvelope(event));
    // control-events are scoped to the socket's instance subscription; a socket with no
    // subscription (absent from the map) receives all. instance-status / notice are
    // account-wide (the global instance list needs them regardless of the active instance).
    // Recoverable terminal streams never use this path (Task 19).
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
