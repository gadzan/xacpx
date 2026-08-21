import type { AgentMessagingErrorCode } from "./agent-messaging-error";

export interface AgentAddress {
  nodeId: string;
  endpointId: string;
}

export interface MessagingNodeIdentity {
  nodeId: string;
}

export type AgentMessageMode = "auto" | "steer" | "queue" | "interrupt";

export type AgentMessageCompletionMode = "none" | "notify" | "result";
export type AgentMessageCompletionStatus = "completed" | "failed" | "cancelled";

export interface AgentMessageCompletion {
  requestMessageId: string;
  from: AgentAddress;
  to: AgentAddress;
  status: AgentMessageCompletionStatus;
  result?: string;
  error?: string;
  completedAt: number;
}

export interface AgentCapabilities {
  receive: boolean;
  steer: boolean;
  queue: boolean;
  interrupt: boolean;
  conversation: boolean;
  completion?: boolean;
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
  sessionAlias?: string;
  state: "idle" | "running" | "unreachable";
  activity: AgentActivityView;
  capabilities: AgentCapabilities;
  /** Presentation context mirrored from the published wire DTO. Local rows are
   * derived at construction; federated rows keep exactly what the remote
   * published (absent stays absent — no synthesis). */
  endpointKind?: "logical" | "worker";
  /** Channel namespace owning the endpoint when known (e.g. "relay", "weixin"). */
  channelId?: string;
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
  completion: AgentMessageCompletionMode;
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

export interface AgentTargetSelector {
  displayName?: string;
  workspace?: string;
  agent?: string;
}

export interface AgentMessageSendInput {
  to?: string;
  selector?: AgentTargetSelector;
  content: string;
  mode?: AgentMessageMode;
  requestedMode?: AgentMessageMode;
  replyTo?: string;
  completion?: AgentMessageCompletionMode;
}

export interface PeerMessagePeer {
  handle: string;
  displayName: string;
  agent: string;
  workspace?: string;
}

export interface PeerMessageHistoryEntry {
  kind: "agent_message";
  direction: "sent" | "received";
  messageId: string;
  conversationId: string;
  replyTo?: string;
  peer: PeerMessagePeer;
  content: string;
  createdAt: number;
  status?: "sending" | "sent" | "queued" | "delivered" | "failed";
  completion?: AgentMessageCompletionMode;
  completionStatus?: AgentMessageCompletionStatus;
}
