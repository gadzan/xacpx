import type { BotProfileSnapshot } from "../bots/bot-types";

export type ConversationKind = "bot" | "group";
export type ConversationLifecycle = "active" | "deleting";
export type ConversationTopicStatus = "active" | "archived" | "deleting";
export type ConversationMessageRole = "human" | "bot" | "system";

export type GroupTurnOrigin = "human-explicit" | "controller" | "handoff" | "recovery";
export type GroupTurnState = "queued" | "running" | "completed" | "failed" | "cancelled";

export type ConversationRunMode = "explicit";
export type ConversationRunState =
  | "queued"
  | "running"
  | "waiting-human"
  | "completed"
  | "failed"
  | "cancelled"
  | "indeterminate";

export type MemberTurnOrigin = "human" | "followup" | "retry";
export type MemberTurnState =
  | "queued"
  | "dispatched"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "indeterminate";

export type PendingDispatchState = "pending" | "claimed" | "completed";

export interface ConversationRecord {
  id: string;
  kind: ConversationKind;
  title: string;
  description?: string;
  botIds: string[];
  leadBotId?: string;
  /** Bounded AppState lifecycle flag. SQLite conversation_lifecycle is authoritative for dispatch. */
  lifecycle?: ConversationLifecycle;
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
  seq: number;
  role: ConversationMessageRole;
  senderBotId?: string;
  recipients?: string[];
  content: string;
  replyTo?: string;
  runId?: string;
  createdAt: string;
  sourceTurn?: {
    sessionAlias: string;
    turnId?: string;
  };
}

export interface ConversationRun {
  id: string;
  conversationId: string;
  topicId: string;
  requestMessageId: string;
  requestId: string;
  mode: ConversationRunMode;
  state: ConversationRunState;
  completionReason?: string;
  generation: number;
  maxMemberTurns: number;
  consumedMemberTurns: number;
  profileRevision: number;
  profileSnapshot: BotProfileSnapshot;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface MemberTurnRecord {
  id: string;
  runId: string;
  conversationId: string;
  topicId: string;
  botId: string;
  sessionAlias?: string;
  logicalSessionId?: string;
  sourceTurnId?: string;
  queueItemId?: string;
  batch: number;
  attempt: number;
  origin: MemberTurnOrigin;
  state: MemberTurnState;
  triggerMessageIds: string[];
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface PendingDispatch {
  id: string;
  runId: string;
  memberTurnId: string;
  generation: number;
  state: PendingDispatchState;
  owner?: string;
  leaseExpiresAt?: string;
  createdAt: string;
  claimedAt?: string;
  completedAt?: string;
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

export const ACTIVE_RUN_STATES: readonly ConversationRunState[] = ["running", "waiting-human"];
export const TERMINAL_RUN_STATES: readonly ConversationRunState[] = [
  "completed",
  "failed",
  "cancelled",
  "indeterminate",
];
export const TERMINAL_MEMBER_STATES: readonly MemberTurnState[] = [
  "completed",
  "failed",
  "cancelled",
  "indeterminate",
];
