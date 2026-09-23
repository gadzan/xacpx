import type { BotProfileSnapshot } from "../bots/bot-types";

export type ConversationKind = "bot" | "group";
export type ConversationLifecycle = "active" | "deleting";
export type ConversationTopicStatus = "active" | "archived" | "deleting";
export type ConversationMessageRole = "human" | "bot" | "system";

export type ConversationRunMode = "explicit" | "automatic";

export type WorkspaceIsolationPolicy = "shared" | "shared-single-writer" | "worktree-per-member";

export interface ExecutionTarget {
  workspace: string;
  cwd?: string;
  isolation: WorkspaceIsolationPolicy;
}
export type ConversationRunState =
  | "queued"
  | "running"
  | "waiting-human"
  | "completed"
  | "failed"
  | "cancelled"
  | "indeterminate";

/** Durable MemberTurn provenance: WHO caused this turn. Distinct from the
 *  permission-interaction origin (human vs orchestration), which is derived
 *  per-dispatch from authorityEpoch + human ingress. Fresh orchestration work
 *  (Router-selected, handoff, followup) is NEVER "recovery": recovery means a
 *  prior claim existed and is being redriven after failure/expiry. */
export type MemberTurnOrigin = "human-explicit" | "router" | "handoff" | "followup" | "retry" | "recovery";

export type MemberTurnState =
  | "queued"
  | "dispatched"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "indeterminate";

export type PendingDispatchState = "pending" | "claimed" | "completed";

/** Declared side-effect capability of one MemberTurn. PR6 input only: no
 *  dispatcher in this PR schedules on it yet. PR7 explicit routing attaches
 *  this to each assignment; the scheduler (§9.6) serializes turns that are
 *  not enforceably read-only under shared-single-writer. Never inferred from
 *  Bot name/description — the caller must prove read-only capability. */
export type MemberTurnEffect = "unknown" | "read-only" | "mutating";

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
  /** Effective work target for this Topic. Absent on pre-Group rows: readers
   *  must treat absence as unknown, never as a default policy. Writers always
   *  persist it on Group Topics; direct Topics resolve execution from the
   *  owning Bot profile instead. */
  executionTarget?: ExecutionTarget;
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
  /** Currently executing batch. Absent (direct legacy) means batch 1. */
  activeBatch?: number;
  maxMemberTurns: number;
  consumedMemberTurns: number;
  /** Member Bot ids that failed in the current batch (aggregate progress). */
  failedBotIds: string[];
  /** Member Bot ids unavailable for the current batch (aggregate progress). */
  unavailableBotIds: string[];
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
  /** Accepted execution snapshot for THIS member. Absent on pre-multi-member
   *  rows: readers fall back to the Run's profileSnapshot for migration
   *  compatibility (direct single-member accepts). */
  profileSnapshot?: BotProfileSnapshot;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  /** Group assignment identity. Absent on direct (single-member) turns. */
  assignmentId?: string;
  /** Concrete work instruction for this assignment. */
  task?: string;
  /** Expected output description for this assignment. */
  expectedOutput?: string;
  /** Assignment ids this turn depends on (Router dependsOn). */
  dependsOn?: string[];
  /** Machine-readable terminal failure reason (failed only). Durable audit
   *  evidence: preserved per-member so a sibling's unknown/cancel can never
   *  erase which member failed and why. */
  failureReason?: string;
}

/** Server-derived authenticated human ingress. Clients cannot mint this. */
export interface HumanIngressContext {
  chatKey: string;
  senderId: string;
  accountId?: string;
  senderName?: string;
  isOwner?: boolean;
}

export interface PendingDispatch {
  id: string;
  runId: string;
  memberTurnId: string;
  generation: number;
  state: PendingDispatchState;
  owner?: string;
  leaseExpiresAt?: string;
  /** Live dispatcher epoch that accepted this work. Matching claim keeps human
   *  permission authority; mismatch or revoked epoch is recovery/orchestration. */
  authorityEpoch?: string;
  /** Trusted permission return route bound to authorityEpoch. Discarded on recovery. */
  humanIngress?: HumanIngressContext;
  createdAt: string;
  claimedAt?: string;
  completedAt?: string;
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
