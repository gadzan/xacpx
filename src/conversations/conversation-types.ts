export type ConversationKind = "bot" | "group";
export type ConversationTopicStatus = "active" | "archived";
export type ConversationMessageRole = "human" | "bot" | "system";

export type GroupTurnOrigin = "human-explicit" | "controller" | "handoff" | "recovery";
export type GroupTurnState = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface ConversationRecord {
  id: string;
  kind: ConversationKind;
  title: string;
  description?: string;
  botIds: string[];
  leadBotId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationTopic {
  id: string;
  conversationId: string;
  title: string;
  status: ConversationTopicStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationMessage {
  id: string;
  conversationId: string;
  topicId: string;
  role: ConversationMessageRole;
  senderBotId?: string;
  recipients?: string[];
  content: string;
  replyTo?: string;
  createdAt: string;
  sourceTurn?: {
    sessionAlias: string;
    turnId?: string;
  };
}

export interface GroupTurnRecord {
  id: string;
  conversationId: string;
  topicId: string;
  botId: string;
  sessionAlias: string;
  triggerMessageIds: string[];
  origin: GroupTurnOrigin;
  state: GroupTurnState;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}
