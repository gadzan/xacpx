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
  conversation: boolean;
}

export interface AgentActivityView {
  status: "idle" | "working" | "waiting";
  summary?: string;
}

export interface AgentEndpointView {
  address: AgentAddress;
  handle: string;
  node: string;
  agent: string;
  workspace?: string;
  displayName?: string;
  state: "idle" | "running" | "unreachable";
  activity: AgentActivityView;
  capabilities: AgentCapabilities;
}

export interface AgentSenderBinding {
  coordinatorSession: string;
  sourceHandle?: string;
}

export interface MessageContext {
  messageId: string;
  conversationId: string;
  depth: number;
  from: AgentAddress;
  to: AgentAddress;
  createdAt: number;
  expiresAt: number;
}

export interface AgentMessage {
  id: string;
  conversationId: string;
  depth: number;
  from: AgentAddress;
  to: AgentAddress;
  content: string;
  replyTo?: string;
  requestedMode: AgentMessageMode;
  createdAt: number;
  expiresAt?: number;
}

export interface AgentMessageTraceRecord {
  messageId: string;
  conversationId: string;
  depth: number;
  replyTo?: string;
  from: AgentAddress;
  to: AgentAddress;
  route: "local" | "relay";
  createdAt: number;
  deliveredAt?: number;
  status: "injected" | "queued" | "failed";
  modeUsed?: "steer" | "queue" | "interrupt" | "prompt";
  deduplicated?: boolean;
  errorCode?: AgentMessagingErrorCode;
  contentLength: number;
  contentHash: string;
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
