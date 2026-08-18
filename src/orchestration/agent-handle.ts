import type { AgentAddress } from "./agent-messaging-types";

const HANDLE_PREFIX = "agent";
const MAX_SEGMENT_LENGTH = 128;
const SEGMENT_PATTERN = /^[A-Za-z0-9_-]+$/;

export function encodeAgentHandle(address: AgentAddress): string {
  assertHandleSegment(address.nodeId, "nodeId");
  assertHandleSegment(address.endpointId, "endpointId");
  return [HANDLE_PREFIX, address.nodeId, address.endpointId].join(":");
}

export function decodeAgentHandle(value: string): AgentAddress | null {
  const [prefix, nodeId, endpointId, extra] = value.split(":");
  if (
    prefix !== HANDLE_PREFIX ||
    extra !== undefined ||
    !isHandleSegment(nodeId) ||
    !isHandleSegment(endpointId)
  ) {
    return null;
  }
  return { nodeId, endpointId };
}

function assertHandleSegment(value: string, name: string): void {
  if (!isHandleSegment(value)) {
    throw new Error(name + " must be a non-empty opaque agent-address segment");
  }
}

function isHandleSegment(value: string | undefined): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_SEGMENT_LENGTH &&
    SEGMENT_PATTERN.test(value)
  );
}
