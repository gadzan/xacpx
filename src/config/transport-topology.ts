import type { TransportConfig } from "./types";

/**
 * Transport topology fields are restart-required: the live transport object
 * (AcpxCliTransport / AcpxBridgeTransport) is constructed once in buildApp()
 * and cannot be rebuilt in place. Hot-applying a different type/command
 * would leave the persisted affinity selector (which reads the live config)
 * disagreeing with the transport that actually executes sessions.
 */
export function isRestartRequiredTransportChange(
  current: Pick<TransportConfig, "type" | "command">,
  next: Pick<TransportConfig, "type" | "command">,
): boolean {
  return (
    next.type !== current.type ||
    (next.command ?? "") !== (current.command ?? "")
  );
}
