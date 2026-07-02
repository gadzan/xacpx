import { decodeEnvelope, MSG, parseWebClientMessage } from "@ganglion/xacpx-relay-protocol";

export interface WebClientDeps {
  instances: { getOwned(id: string, accountId: string): unknown };
  gateway: { sendEvent(instanceId: string, type: string, payload: unknown): boolean };
}

/** Decode + authorize + forward a browser→hub terminal frame as a connector event. */
export function handleWebClientMessage(deps: WebClientDeps, accountId: string, raw: string): void {
  const decoded = decodeEnvelope(raw);
  if (!decoded.ok) return;
  const msg = parseWebClientMessage(decoded.envelope);
  if (!msg) return;
  if (!deps.instances.getOwned(msg.instanceId, accountId)) return; // ownership gate
  if (msg.kind === "terminal-input") deps.gateway.sendEvent(msg.instanceId, MSG.terminalInput, { terminalId: msg.terminalId, data: msg.data });
  else if (msg.kind === "terminal-resize") deps.gateway.sendEvent(msg.instanceId, MSG.terminalResize, { terminalId: msg.terminalId, cols: msg.cols, rows: msg.rows });
  else if (msg.kind === "terminal-close") deps.gateway.sendEvent(msg.instanceId, MSG.terminalClose, { terminalId: msg.terminalId });
}
