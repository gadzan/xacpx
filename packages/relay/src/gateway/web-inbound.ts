import { decodeEnvelope, MSG, parseWebClientMessage } from "@ganglion/xacpx-relay-protocol";
import type { WebSocketLike } from "./web-gateway.js";

export interface WebClientDeps {
  instances: { getOwned(id: string, accountId: string): unknown };
  gateway: { sendEvent(instanceId: string, type: string, payload: unknown): boolean };
  webGateway: { setSubscription(socket: WebSocketLike, instanceIds: string[]): void };
}

/** Decode + route a browser→hub frame. `subscribe` updates this socket's instance
 *  subscription (hub-local); terminal frames are authorized and forwarded to the connector. */
export function handleWebClientMessage(deps: WebClientDeps, accountId: string, socket: WebSocketLike, raw: string): void {
  const decoded = decodeEnvelope(raw);
  if (!decoded.ok) return;
  const msg = parseWebClientMessage(decoded.envelope);
  if (!msg) return;
  // Hub-local, inherently safe (only narrows this socket's own feed) — no ownership gate.
  if (msg.kind === "subscribe") { deps.webGateway.setSubscription(socket, msg.instanceIds); return; }
  if (!deps.instances.getOwned(msg.instanceId, accountId)) return; // ownership gate (connector actions)
  if (msg.kind === "terminal-input") deps.gateway.sendEvent(msg.instanceId, MSG.terminalInput, { terminalId: msg.terminalId, data: msg.data });
  else if (msg.kind === "terminal-resize") deps.gateway.sendEvent(msg.instanceId, MSG.terminalResize, { terminalId: msg.terminalId, cols: msg.cols, rows: msg.rows });
  else if (msg.kind === "terminal-close") deps.gateway.sendEvent(msg.instanceId, MSG.terminalClose, { terminalId: msg.terminalId });
}
