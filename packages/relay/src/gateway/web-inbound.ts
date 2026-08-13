import {
  decodeEnvelope,
  isErrorPayload,
  MSG,
  parseTerminalEventPayload,
  parseWebClientMessage,
  type InstanceStateSnapshotDto,
  type TerminalOpenResult,
  type TerminalResourceExitPayload,
  type TerminalRoleResult,
  type TerminalTerminateResult,
  type TerminalViewerEventPayload,
  type WebServerEvent,
} from "@ganglion/xacpx-relay-protocol";

import { TERMINAL_REQUEST_TIMEOUT_MS } from "./instance-gateway.js";
import type { WebGateway, WebSocketLike } from "./web-gateway.js";

export interface WebClientDeps {
  instances: {
    getOwned(id: string, accountId: string): unknown;
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

function mapConnectorError(err: unknown): { code: string; message: string } {
  if (err instanceof Error) {
    if (err.message === "instance-offline" || err.message === "instance-reconnected") {
      return { code: "instance-offline", message: err.message };
    }
    if (err.message === "timeout") {
      return { code: "terminal-timeout", message: "terminal request timed out" };
    }
    return { code: "terminal-protocol-error", message: err.message };
  }
  return { code: "terminal-protocol-error", message: String(err) };
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
  if (msg.kind === "terminal-take-control") {
    await handleTakeControl(deps, socket, msg);
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
    payload = await deps.gateway.sendRequest(
      msg.instanceId,
      MSG.terminalOpen,
      {
        chatKey: `relay:${accountId}`,
        sessionAlias: msg.sessionAlias,
        viewerId,
        cols: msg.cols,
        rows: msg.rows,
      },
      { timeoutMs: TERMINAL_REQUEST_TIMEOUT_MS },
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
    const payload = await deps.gateway.sendRequest(
      msg.instanceId,
      MSG.terminalTakeControl,
      { attachmentId: msg.attachmentId, generation: msg.generation, viewerId },
      { timeoutMs: TERMINAL_REQUEST_TIMEOUT_MS },
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
    const payload = await deps.gateway.sendRequest(
      msg.instanceId,
      MSG.terminalResync,
      { attachmentId: msg.attachmentId, generation: msg.generation, viewerId },
      { timeoutMs: TERMINAL_REQUEST_TIMEOUT_MS },
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
    const payload = await deps.gateway.sendRequest(
      msg.instanceId,
      MSG.terminalTerminate,
      { terminalId: msg.terminalId, generation: msg.generation },
      { timeoutMs: TERMINAL_REQUEST_TIMEOUT_MS },
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
