import { decodeEnvelope, MSG, parseWebClientMessage, type InstanceStateSnapshotDto, type WebServerEvent } from "@ganglion/xacpx-relay-protocol";
import type { WebSocketLike } from "./web-gateway.js";

export interface WebClientDeps {
  instances: {
    getOwned(id: string, accountId: string): unknown;
    listByAccount(accountId: string): Array<{ id: string }>;
  };
  gateway: { sendEvent(instanceId: string, type: string, payload: unknown): boolean };
  webGateway: {
    setSubscription(socket: WebSocketLike, instanceIds: string[]): void;
    send(socket: WebSocketLike, event: WebServerEvent): boolean;
  };
  stateSnapshot(instanceId: string): InstanceStateSnapshotDto;
}

/** Decode + route a browser→hub frame. `subscribe` updates this socket's instance
 *  subscription (hub-local); terminal frames are authorized and forwarded to the connector. */
export function handleWebClientMessage(deps: WebClientDeps, accountId: string, socket: WebSocketLike, raw: string): void {
  const decoded = decodeEnvelope(raw);
  if (!decoded.ok) return;
  const msg = parseWebClientMessage(decoded.envelope);
  if (!msg) return;
  if (msg.kind === "subscribe") {
    // Snapshot delivery reads instance-scoped state, so filter the requested ids through
    // the same ownership gate as connector actions. De-duplicate to avoid repeated frames.
    const ownedIds = new Set(deps.instances.listByAccount(accountId).map((instance) => instance.id));
    const instanceIds = [...new Set(msg.instanceIds)].filter((id) => ownedIds.has(id));
    deps.webGateway.setSubscription(socket, instanceIds);
    // setSubscription, snapshot reads and send() are deliberately synchronous. Any later
    // control-event broadcast is therefore queued after this authoritative frame on the
    // same socket, eliminating the old HTTP-snapshot/live-WS race.
    for (const instanceId of instanceIds) {
      deps.webGateway.send(socket, { kind: "state-snapshot", instanceId, ...deps.stateSnapshot(instanceId) });
    }
    return;
  }
  if (!deps.instances.getOwned(msg.instanceId, accountId)) return; // ownership gate (connector actions)
  // Legacy live-PTY frames carry terminalId. Recoverable RMUX frames (attachmentId) are
  // additive and routed in a later task; ignore them here so mixed clients stay safe.
  if (msg.kind === "terminal-input" && "terminalId" in msg) {
    deps.gateway.sendEvent(msg.instanceId, MSG.terminalInput, { terminalId: msg.terminalId, data: msg.data });
  } else if (msg.kind === "terminal-resize" && "terminalId" in msg) {
    deps.gateway.sendEvent(msg.instanceId, MSG.terminalResize, { terminalId: msg.terminalId, cols: msg.cols, rows: msg.rows });
  } else if (msg.kind === "terminal-close") {
    deps.gateway.sendEvent(msg.instanceId, MSG.terminalClose, { terminalId: msg.terminalId });
  }
}
