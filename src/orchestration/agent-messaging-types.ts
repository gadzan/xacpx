import type { AgentMessagingErrorCode } from "./agent-messaging-error";

export interface AgentAddress {
  nodeId: string;
  endpointId: string;
}

export interface MessagingNodeIdentity {
  nodeId: string;
}

export type AgentMessageMode = "auto" | "steer" | "queue" | "interrupt";

export interface AgentCapabilities {
  receive: boolean;
  steer: boolean;
  queue: boolean;
  interrupt: boolean;
}

export interface AgentEndpointView {
  address: AgentAddress;
  handle: string;
  node: string;
  agent: string;
  workspace?: string;
  displayName?: string;
  state: "idle" | "running" | "unreachable";
  capabilities: AgentCapabilities;
}

export interface AgentSenderBinding {
  coordinatorSession: string;
  sourceHandle?: string;
}

export interface AgentMessage {
  id: string;
  from: AgentAddress;
  to: AgentAddress;
  content: string;
  replyTo?: string;
  requestedMode: AgentMessageMode;
  createdAt: number;
  expiresAt?: number;
}

export interface AgentMessageReceipt {
  messageId: string;
  status: "injected" | "queued" | "failed";
  modeUsed?: "steer" | "queue" | "interrupt" | "prompt";
  route: "local" | "relay";
  targetState?: "idle" | "running";
  deduplicated?: boolean;
  errorCode?: AgentMessagingErrorCode;
}

export interface AgentMessageSendInput {
  to: string;
  content: string;
  mode?: AgentMessageMode;
  replyTo?: string;
}
