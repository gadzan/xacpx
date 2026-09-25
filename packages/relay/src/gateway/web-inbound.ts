import {
  decodeEnvelope,
  isErrorPayload,
  DESKTOP_HUB_REQUEST_TIMEOUT_MS,
  MSG,
  parseTerminalEventPayload,
  parseWebClientMessage,
  type DesktopPrepareResult,
  type InstanceStateSnapshotDto,
  type PublishedAgentEndpointDto,
  type TerminalOpenResult,
  type TerminalResourceExitPayload,
  type TerminalRoleResult,
  type TerminalTerminateResult,
  type TerminalViewerEventPayload,
  type WebAgentDirectoryEndpointDto,
  type WebServerEvent,
} from "@ganglion/xacpx-relay-protocol";
import { type WebGateway, type WebSocketLike } from "./web-gateway.js";
import { TERMINAL_REQUEST_TIMEOUT_MS } from "./instance-gateway.js";

export interface WebClientDeps {
  instances: {
    getOwned(id: string, accountId: string): { id: string; capabilities?: string[] } | null;
    listByAccount(accountId: string): Array<{ id: string }>;
  };
  gateway: {
    sendEvent(instanceId: string, type: string, payload: unknown): boolean;
    sendRequest(
      instanceId: string,
      type: string,
      payload: unknown,
      options?: { timeoutMs?: number },
    ): Promise<unknown>;
    isOnline(instanceId: string): boolean;
    getPublishedEndpoints?(accountId: string): PublishedAgentEndpointDto[];
    getWebPublishedEndpoints?(accountId: string): WebAgentDirectoryEndpointDto[];
  };
  webGateway: Pick<
    WebGateway,
    | "setSubscription"
    | "send"
    | "getViewerId"
    | "bindAttachment"
    | "unbindAttachment"
    | "socketOwnsAttachment"
    | "getAttachmentBinding"
  >;
  stateSnapshot(instanceId: string): InstanceStateSnapshotDto;
  desktop?: {
    reserve(accountId: string, instanceId: string): { ok: true; streamId: string } | { ok: false; code: string; scope: "instance" | "account" };
    mintConnectorTicket(streamId: string, accountId: string, instanceId: string): { ticket: string; expiresAt: number };
    mintBrowserTicket(streamId: string, accountId: string, instanceId: string): { ticket: string; expiresAt: number };
    markReady(streamId: string, security: "vnc-auth" | "ard"): boolean;
    cancel(streamId: string, reason: string): void;
    /** Lifetime owner check: pending AND paired streams stay bound to the requesting viewer. */
    ownsStream(streamId: string, ownerViewerId: string): boolean;
    /** Bind a fresh reservation to its requesting viewer before the async prepare. */
    trackOwner(streamId: string, owner: { viewerId: string; accountId: string; instanceId: string }): void;
  };
}

function fail(
  deps: WebClientDeps,
  socket: WebSocketLike,
  requestId: string,
  instanceId: string,
  code: string,
  message: string,
): void {
  deps.webGateway.send(socket, {
    kind: "terminal-request-failed",
    requestId,
    instanceId,
    code,
    message,
  });
}

function failDesktop(
  deps: WebClientDeps,
  socket: WebSocketLike,
  requestId: string,
  instanceId: string,
  code: string,
  message: string,
): void {
  deps.webGateway.send(socket, {
    kind: "desktop-request-failed",
    requestId,
    instanceId,
    code,
    message,
  });
}

function mapConnectorError(err: unknown): { code: string; message: string } {
  if (err instanceof Error) {
    if (err.message === "instance-offline") {
      return { code: "instance-offline", message: err.message };
    }
    // New connector socket already owns the instance — not offline.
    if (err.message === "instance-reconnected") {
      return { code: "instance-reconnected", message: err.message };
    }
    if (err.message === "timeout") {
      return { code: "terminal-timeout", message: "terminal request timed out" };
    }
    return { code: "terminal-protocol-error", message: err.message };
  }
  return { code: "terminal-protocol-error", message: String(err) };
}
function mapDesktopConnectorError(err: unknown): { code: string; message: string } {
  if (err instanceof Error) {
    if (err.message === "instance-offline" || err.message === "instance-reconnected") {
      return { code: "desktop-instance-offline", message: "instance is offline" };
    }
    if (err.message === "timeout") {
      return { code: "desktop-stream-timeout", message: "desktop prepare timed out" };
    }
    return { code: "desktop-protocol-error", message: err.message.slice(0, 160) };
  }
  return { code: "desktop-protocol-error", message: String(err).slice(0, 160) };
}

/** One retry when the connector socket was superseded mid-RPC (new conn is already online). */
async function sendConnectorRequest(
  deps: WebClientDeps,
  instanceId: string,
  type: string,
  payload: unknown,
): Promise<unknown> {
  try {
    return await deps.gateway.sendRequest(instanceId, type, payload, {
      timeoutMs: TERMINAL_REQUEST_TIMEOUT_MS,
    });
  } catch (err) {
    if (
      err instanceof Error
      && err.message === "instance-reconnected"
      && deps.gateway.isOnline(instanceId)
    ) {
      return await deps.gateway.sendRequest(instanceId, type, payload, {
        timeoutMs: TERMINAL_REQUEST_TIMEOUT_MS,
      });
    }
    throw err;
  }
}

/** Decode + route a browser→hub frame. Recoverable terminal RPCs are async. */
export function handleWebClientMessage(
  deps: WebClientDeps,
  accountId: string,
  socket: WebSocketLike,
  raw: string,
): void {
  void handleWebClientMessageAsync(deps, accountId, socket, raw);
}

async function handleWebClientMessageAsync(
  deps: WebClientDeps,
  accountId: string,
  socket: WebSocketLike,
  raw: string,
): Promise<void> {
  const decoded = decodeEnvelope(raw);
  if (!decoded.ok) return;
  const msg = parseWebClientMessage(decoded.envelope);
  if (!msg) return;

  if (msg.kind === "subscribe") {
    const ownedIds = new Set(deps.instances.listByAccount(accountId).map((instance) => instance.id));
    const instanceIds = [...new Set(msg.instanceIds)].filter((id) => ownedIds.has(id));
    deps.webGateway.setSubscription(socket, instanceIds);
    if (typeof deps.gateway.getWebPublishedEndpoints === "function") {
      deps.webGateway.send(socket, {
        kind: "agent-directory",
        endpoints: deps.gateway.getWebPublishedEndpoints(accountId),
      });
    } else if (typeof deps.gateway.getPublishedEndpoints === "function") {
      deps.webGateway.send(socket, {
        kind: "agent-directory",
        endpoints: deps.gateway.getPublishedEndpoints(accountId) as never,
      });
    }
    for (const instanceId of instanceIds) {
      deps.webGateway.send(socket, {
        kind: "state-snapshot",
        instanceId,
        ...deps.stateSnapshot(instanceId),
      });
    }
    return;
  }

  if (!deps.instances.getOwned(msg.instanceId, accountId)) return;

  if (msg.kind === "terminal-open") {
    await handleTerminalOpen(deps, accountId, socket, msg);
    return;
  }
  if (msg.kind === "terminal-stream-start") {
    const viewerId = deps.webGateway.getViewerId(socket);
    if (!viewerId || !deps.webGateway.socketOwnsAttachment(socket, msg.attachmentId)) return;
    deps.gateway.sendEvent(msg.instanceId, MSG.terminalStreamStart, {
      attachmentId: msg.attachmentId,
      viewerId,
    });
    return;
  }
  if (msg.kind === "desktop-open") {
    await handleDesktopOpen(deps, accountId, socket, msg);
    return;
  }
  if (msg.kind === "desktop-close") {
    handleDesktopClose(deps, accountId, socket, msg);
    return;
  }
  if (msg.kind === "terminal-resync") {
    await handleResync(deps, socket, msg);
    return;
  }
  if (msg.kind === "terminal-terminate") {
    await handleTerminate(deps, socket, msg);
    return;
  }
  if (msg.kind === "terminal-input" && "attachmentId" in msg) {
    const viewerId = deps.webGateway.getViewerId(socket);
    if (!viewerId || !deps.webGateway.socketOwnsAttachment(socket, msg.attachmentId)) return;
    deps.gateway.sendEvent(msg.instanceId, MSG.terminalInput, {
      attachmentId: msg.attachmentId,
      generation: msg.generation,
      viewerId,
      dataBase64: msg.dataBase64,
    });
    return;
  }
  if (msg.kind === "terminal-resize" && "attachmentId" in msg) {
    const viewerId = deps.webGateway.getViewerId(socket);
    if (!viewerId || !deps.webGateway.socketOwnsAttachment(socket, msg.attachmentId)) return;
    deps.gateway.sendEvent(msg.instanceId, MSG.terminalResize, {
      attachmentId: msg.attachmentId,
      generation: msg.generation,
      viewerId,
      cols: msg.cols,
      rows: msg.rows,
    });
    return;
  }
  if (msg.kind === "terminal-heartbeat") {
    const viewerId = deps.webGateway.getViewerId(socket);
    if (!viewerId || !deps.webGateway.socketOwnsAttachment(socket, msg.attachmentId)) return;
    deps.gateway.sendEvent(msg.instanceId, MSG.terminalHeartbeat, {
      attachmentId: msg.attachmentId,
      viewerId,
    });
    return;
  }
  if (msg.kind === "terminal-detach") {
    if (!deps.webGateway.socketOwnsAttachment(socket, msg.attachmentId)) return;
    const binding = deps.webGateway.unbindAttachment(msg.attachmentId);
    if (binding) {
      deps.gateway.sendEvent(msg.instanceId, MSG.terminalDetach, {
        attachmentId: msg.attachmentId,
        viewerId: binding.viewerId,
      });
    }
    return;
  }

  // Legacy live-PTY path
  if (msg.kind === "terminal-input" && "terminalId" in msg) {
    deps.gateway.sendEvent(msg.instanceId, MSG.terminalInput, {
      terminalId: msg.terminalId,
      data: msg.data,
    });
  } else if (msg.kind === "terminal-resize" && "terminalId" in msg) {
    deps.gateway.sendEvent(msg.instanceId, MSG.terminalResize, {
      terminalId: msg.terminalId,
      cols: msg.cols,
      rows: msg.rows,
    });
  } else if (msg.kind === "terminal-close") {
    deps.gateway.sendEvent(msg.instanceId, MSG.terminalClose, { terminalId: msg.terminalId });
  }
}

async function handleTerminalOpen(
  deps: WebClientDeps,
  accountId: string,
  socket: WebSocketLike,
  msg: { requestId: string; instanceId: string; sessionAlias: string; cols: number; rows: number },
): Promise<void> {
  const viewerId = deps.webGateway.getViewerId(socket);
  if (!viewerId) {
    fail(deps, socket, msg.requestId, msg.instanceId, "terminal-protocol-error", "missing viewer identity");
    return;
  }
  if (!deps.gateway.isOnline(msg.instanceId)) {
    fail(deps, socket, msg.requestId, msg.instanceId, "instance-offline", "instance is offline");
    return;
  }

  let payload: unknown;
  try {
    payload = await sendConnectorRequest(
      deps,
      msg.instanceId,
      MSG.terminalOpen,
      {
        chatKey: `relay:${accountId}`,
        sessionAlias: msg.sessionAlias,
        viewerId,
        cols: msg.cols,
        rows: msg.rows,
      },
    );
  } catch (err) {
    const mapped = mapConnectorError(err);
    fail(deps, socket, msg.requestId, msg.instanceId, mapped.code, mapped.message);
    return;
  }

  if (isErrorPayload(payload)) {
    fail(deps, socket, msg.requestId, msg.instanceId, payload.error.code, payload.error.message);
    return;
  }

  const result = payload as TerminalOpenResult;
  if (
    !result ||
    typeof result.terminalId !== "string" ||
    typeof result.generation !== "string" ||
    typeof result.attachmentId !== "string"
  ) {
    fail(deps, socket, msg.requestId, msg.instanceId, "terminal-protocol-error", "malformed open result");
    return;
  }

  if (deps.webGateway.getViewerId(socket) !== viewerId) {
    detachConnectorAttachment(deps, msg.instanceId, result.attachmentId, viewerId);
    fail(deps, socket, msg.requestId, msg.instanceId, "terminal-unavailable", "viewer disconnected");
    return;
  }

  try {
    deps.webGateway.bindAttachment({
      socket,
      attachmentId: result.attachmentId,
      terminalId: result.terminalId,
      instanceId: msg.instanceId,
    });
  } catch {
    detachConnectorAttachment(deps, msg.instanceId, result.attachmentId, viewerId);
    fail(deps, socket, msg.requestId, msg.instanceId, "terminal-unavailable", "viewer disconnected");
    return;
  }

  const sent = deps.webGateway.send(socket, {
    kind: "terminal-opened",
    requestId: msg.requestId,
    instanceId: msg.instanceId,
    terminalId: result.terminalId,
    generation: result.generation,
    attachmentId: result.attachmentId,
    role: result.role,
    viewerCount: result.viewerCount,
  });
  if (!sent) {
    deps.webGateway.unbindAttachment(result.attachmentId);
    detachConnectorAttachment(deps, msg.instanceId, result.attachmentId, viewerId);
  }
}
async function handleDesktopOpen(
  deps: WebClientDeps,
  accountId: string,
  socket: WebSocketLike,
  msg: { requestId: string; instanceId: string },
): Promise<void> {
  if (!deps.desktop) {
    failDesktop(deps, socket, msg.requestId, msg.instanceId, "desktop-protocol-error", "desktop is not enabled on this hub");
    return;
  }
  const ownerViewerId = deps.webGateway.getViewerId(socket);
  if (!ownerViewerId) {
    failDesktop(deps, socket, msg.requestId, msg.instanceId, "desktop-protocol-error", "missing viewer identity");
    return;
  }
  const owned = deps.instances.getOwned(msg.instanceId, accountId);
  if (!owned) return;
  if (!deps.gateway.isOnline(msg.instanceId)) {
    failDesktop(deps, socket, msg.requestId, msg.instanceId, "desktop-instance-offline", "instance is offline");
    return;
  }
  if (!owned.capabilities?.includes("desktop.rfb.v1")) {
    failDesktop(deps, socket, msg.requestId, msg.instanceId, "desktop-disabled", "desktop is not enabled on this instance");
    return;
  }
  const reserved = deps.desktop.reserve(accountId, msg.instanceId);
  if (!reserved.ok) {
    failDesktop(deps, socket, msg.requestId, msg.instanceId, reserved.code, reserved.scope === "account"
      ? "too many active desktop viewers on this account"
      : "another desktop viewer is active");
    return;
  }
  const streamId = reserved.streamId;
  // Bind the pending prepare to the requesting control socket BEFORE the
  // async connector RPC: a close during prepare must cancel this exact
  // stream, never a successor that reused the instance slot.
  deps.desktop.trackOwner(streamId, { viewerId: ownerViewerId, accountId, instanceId: msg.instanceId });
  const failWith = (code: string, message: string): void => {
    deps.desktop?.cancel(streamId, code);
    failDesktop(deps, socket, msg.requestId, msg.instanceId, code, message);
  };
  const connectorTicket = deps.desktop.mintConnectorTicket(streamId, accountId, msg.instanceId);
  let payload: unknown;
  try {
    payload = await deps.gateway.sendRequest(msg.instanceId, MSG.desktopPrepare, {
      streamId,
      ticket: connectorTicket.ticket,
      expiresAt: connectorTicket.expiresAt,
    }, { timeoutMs: DESKTOP_HUB_REQUEST_TIMEOUT_MS });
  } catch (err) {
    const mapped = mapDesktopConnectorError(err);
    failWith(mapped.code, mapped.message);
    return;
  }
  if (isErrorPayload(payload)) {
    failWith(payload.error.code, payload.error.message);
    return;
  }
  const result = payload as DesktopPrepareResult;
  if (!result || result.streamId !== streamId || (result.security !== "vnc-auth" && result.security !== "ard")) {
    failWith("desktop-protocol-error", "malformed prepare result");
    return;
  }
  if (result.security !== "vnc-auth") {
    failWith("desktop-auth-unsupported", "Apple Remote Desktop auth needs Phase B");
    return;
  }
  // The requesting socket may have closed (or been superseded) during the
  // connector RPC. Re-validate ownership BEFORE minting the browser ticket:
  // an ownerless ticket would hand a live remote-control stream to nobody.
  if (deps.webGateway.getViewerId(socket) !== ownerViewerId || !deps.desktop.ownsStream(streamId, ownerViewerId)) {
    failWith("desktop-stream-timeout", "requesting viewer disconnected");
    return;
  }
  if (!deps.desktop.markReady(streamId, result.security)) {
    failWith("desktop-stream-timeout", "desktop stream expired");
    return;
  }
  const browserTicket = deps.desktop.mintBrowserTicket(streamId, accountId, msg.instanceId);
  const sent = deps.webGateway.send(socket, {
    kind: "desktop-opened",
    requestId: msg.requestId,
    instanceId: msg.instanceId,
    streamId,
    wsPath: `/desktop/observe?ticket=${browserTicket.ticket}`,
    expiresAt: browserTicket.expiresAt,
    security: result.security,
  });
  if (!sent) {
    failWith("desktop-stream-timeout", "requesting viewer disconnected");
    return;
  }
  // Success keeps the lifetime binding: the same viewer owns the paired
  // binary session, so its control-socket close still cancels the stream
  // and other viewers' desktop-close frames are rejected.
}

function handleDesktopClose(
  deps: WebClientDeps,
  accountId: string,
  socket: WebSocketLike,
  msg: { instanceId: string; streamId: string },
): void {
  if (!deps.desktop) return;
  // Lifetime ownership gate: the requesting viewer owns the stream from
  // reserve through the paired binary session. A stale/forged close from
  // another tab must not kill someone's viewer.
  if (!deps.desktop.ownsStream(msg.streamId, deps.webGateway.getViewerId(socket) ?? "")) return;
  deps.gateway.sendEvent(msg.instanceId, MSG.desktopCancel, { streamId: msg.streamId });
  deps.desktop.cancel(msg.streamId, "browser-close");
}

function detachConnectorAttachment(
  deps: WebClientDeps,
  instanceId: string,
  attachmentId: string,
  viewerId: string,
): void {
  deps.gateway.sendEvent(instanceId, MSG.terminalDetach, {
    attachmentId,
    viewerId,
  });
}

async function handleTakeControl(
  deps: WebClientDeps,
  socket: WebSocketLike,
  msg: { requestId: string; instanceId: string; attachmentId: string; generation: string },
): Promise<void> {
  const viewerId = deps.webGateway.getViewerId(socket);
  if (!viewerId || !deps.webGateway.socketOwnsAttachment(socket, msg.attachmentId)) {
    fail(deps, socket, msg.requestId, msg.instanceId, "terminal-attachment-not-found", "attachment not bound");
    return;
  }
  try {
    const payload = await sendConnectorRequest(
      deps,
      msg.instanceId,
      MSG.terminalTakeControl,
      { attachmentId: msg.attachmentId, generation: msg.generation, viewerId },
    );
    if (isErrorPayload(payload)) {
      fail(deps, socket, msg.requestId, msg.instanceId, payload.error.code, payload.error.message);
      return;
    }
    const result = payload as TerminalRoleResult;
    deps.webGateway.send(socket, {
      kind: "terminal-opened",
      requestId: msg.requestId,
      instanceId: msg.instanceId,
      terminalId: result.terminalId,
      generation: result.generation,
      attachmentId: result.attachmentId,
      role: result.role,
      viewerCount: result.viewerCount,
    });
  } catch (err) {
    const mapped = mapConnectorError(err);
    fail(deps, socket, msg.requestId, msg.instanceId, mapped.code, mapped.message);
  }
}

async function handleResync(
  deps: WebClientDeps,
  socket: WebSocketLike,
  msg: { requestId: string; instanceId: string; attachmentId: string; generation: string },
): Promise<void> {
  const viewerId = deps.webGateway.getViewerId(socket);
  if (!viewerId || !deps.webGateway.socketOwnsAttachment(socket, msg.attachmentId)) {
    fail(deps, socket, msg.requestId, msg.instanceId, "terminal-attachment-not-found", "attachment not bound");
    return;
  }
  try {
    const payload = await sendConnectorRequest(
      deps,
      msg.instanceId,
      MSG.terminalResync,
      { attachmentId: msg.attachmentId, generation: msg.generation, viewerId },
    );
    if (isErrorPayload(payload)) {
      fail(deps, socket, msg.requestId, msg.instanceId, payload.error.code, payload.error.message);
      return;
    }
    // Correlate requestId (no dedicated resync-ack in WebServerEvent).
    deps.webGateway.send(socket, {
      kind: "terminal-request-failed",
      requestId: msg.requestId,
      instanceId: msg.instanceId,
      code: "ok",
      message: "resync-accepted",
    });
  } catch (err) {
    const mapped = mapConnectorError(err);
    fail(deps, socket, msg.requestId, msg.instanceId, mapped.code, mapped.message);
  }
}

async function handleTerminate(
  deps: WebClientDeps,
  socket: WebSocketLike,
  msg: { requestId: string; instanceId: string; terminalId: string; generation: string },
): Promise<void> {
  try {
    const payload = await sendConnectorRequest(
      deps,
      msg.instanceId,
      MSG.terminalTerminate,
      { terminalId: msg.terminalId, generation: msg.generation },
    );
    if (isErrorPayload(payload)) {
      fail(deps, socket, msg.requestId, msg.instanceId, payload.error.code, payload.error.message);
      return;
    }
    const result = payload as TerminalTerminateResult;
    deps.webGateway.send(socket, {
      kind: "terminal-exit",
      instanceId: msg.instanceId,
      terminalId: msg.terminalId,
      generation: msg.generation,
      reason: result.status === "cleanup-pending" ? "cleanup-pending" : "terminated",
    });
    deps.webGateway.send(socket, {
      kind: "terminal-request-failed",
      requestId: msg.requestId,
      instanceId: msg.instanceId,
      code: result.status,
      message: result.status,
    });
  } catch (err) {
    const mapped = mapConnectorError(err);
    fail(deps, socket, msg.requestId, msg.instanceId, mapped.code, mapped.message);
  }
}

/** Map connector→hub terminal viewer/resource events onto targeted web pushes. */
export function handleConnectorTerminalEvent(
  webGateway: Pick<WebGateway, "sendToAttachment" | "fanoutTerminalExit">,
  instanceId: string,
  envelopeType: string,
  payload: unknown,
): boolean {
  if (envelopeType === MSG.terminalViewerEvent) {
    const parsed = parseTerminalEventPayload(MSG.terminalViewerEvent, payload);
    if (!parsed) return true; // drop malformed/oversized at hub trust boundary
    const p = parsed as TerminalViewerEventPayload;
    if (!p?.viewerId || !p?.attachmentId || !p?.event) return true;
    const inner = p.event;
    let event: WebServerEvent | null = null;
    switch (inner.kind) {
      case "terminal-rebase-start":
        event = {
          kind: "terminal-rebase-start",
          instanceId,
          attachmentId: p.attachmentId,
          generation: inner.generation,
          epoch: inner.epoch,
          nextSequence: inner.nextSequence,
          cols: inner.cols,
          rows: inner.rows,
          alternate: inner.alternate,
          totalBytes: inner.totalBytes,
          chunkCount: inner.chunkCount,
        };
        break;
      case "terminal-rebase-chunk":
        event = {
          kind: "terminal-rebase-chunk",
          instanceId,
          attachmentId: p.attachmentId,
          generation: inner.generation,
          epoch: inner.epoch,
          index: inner.index,
          dataBase64: inner.dataBase64,
        };
        break;
      case "terminal-rebase-end":
        event = {
          kind: "terminal-rebase-end",
          instanceId,
          attachmentId: p.attachmentId,
          generation: inner.generation,
          epoch: inner.epoch,
        };
        break;
      case "terminal-bytes":
        event = {
          kind: "terminal-bytes",
          instanceId,
          attachmentId: p.attachmentId,
          generation: inner.generation,
          epoch: inner.epoch,
          sequence: inner.sequence,
          dataBase64: inner.dataBase64,
        };
        break;
      case "terminal-role-changed":
        event = {
          kind: "terminal-role-changed",
          instanceId,
          attachmentId: p.attachmentId,
          terminalId: inner.terminalId,
          role: inner.role,
          viewerCount: inner.viewerCount,
        };
        break;
      case "terminal-request-failed":
        event = {
          kind: "terminal-request-failed",
          requestId: inner.requestId ?? "",
          instanceId,
          code: inner.code,
          message: inner.message,
        };
        break;
      case "terminal-recovery-failed":
        event = {
          kind: "terminal-recovery-failed",
          instanceId,
          attachmentId: p.attachmentId,
          generation: inner.generation,
          code: inner.code,
          message: inner.message,
        };
        break;
      default:
        return true;
    }
    if (event) webGateway.sendToAttachment(p.viewerId, p.attachmentId, event);
    return true;
  }

  if (envelopeType === MSG.terminalResourceExit) {
    const parsed = parseTerminalEventPayload(MSG.terminalResourceExit, payload);
    if (!parsed) return true;
    const p = parsed as TerminalResourceExitPayload;
    if (!p?.terminalId || !p?.generation) return true;
    webGateway.fanoutTerminalExit(instanceId, p.terminalId, {
      kind: "terminal-exit",
      instanceId,
      terminalId: p.terminalId,
      generation: p.generation,
      reason: p.reason,
      ...(p.code !== undefined ? { code: p.code } : {}),
    });
    return true;
  }

  return false;
}
