import type { PromptAttachmentRef } from "@ganglion/xacpx-relay-protocol";
import type { BotProfileSnapshot } from "../bots/bot-types";

export type ConversationKind = "bot" | "group";
export type ConversationLifecycle = "active" | "deleting";
export type ConversationTopicStatus = "active" | "archived" | "deleting";
export type ConversationMessageRole = "human" | "bot" | "system";

export type ConversationRunMode = "explicit" | "automatic";
export type WorkspaceIsolationPolicy = "shared" | "shared-single-writer" | "worktree-per-member";
/**
 * Where a Group's members execute. Chosen once at Group creation and never
 * patched afterwards: member snapshots and sessions accepted under one mode
 * stay valid under it, so flipping the axis later would silently re-target
 * accepted work.
 *
 * - `shared`: the Topic owns the work target (`executionTarget.workspace`);
 *   every member of a Topic runs in that one directory.
 * - `per-member`: the Group has no work target at all. Each member runs in
 *   its own Bot workspace, exactly like a Direct session, and Group Topics
 *   carry no `executionTarget`.
 *
 * Absent means `shared` (pre-Group rows and every older writer).
 */
export type GroupWorkspaceMode = "shared" | "per-member";

/** Effective workspace mode of a Group. Direct conversations have none. */
export function groupWorkspaceMode(conversation: Pick<ConversationRecord, "kind" | "workspaceMode">): GroupWorkspaceMode {
  return conversation.kind === "group" && conversation.workspaceMode === "per-member" ? "per-member" : "shared";
}
/** PR7 structured explicit Group target. IDs are authority; display names
 *  never route. `automatic` is a durable-mode reservation (PR8) rejected by
 *  the PR7 explicit accept path. */
export type ConversationTarget =
  | { mode: "members"; botIds: string[] }
  | { mode: "everyone" };

export interface ExecutionTarget {
  workspace: string;
  cwd?: string;
  isolation: WorkspaceIsolationPolicy;
}
export type ConversationRunState =
  | "queued"
  | "running"
  | "waiting-human"
  /**
   * Durable human pause. A paused Run keeps its Topic and its queued work but
   * claims nothing: only an authorized resume makes it runnable again. It is
   * non-terminal — never sealed, never replayed.
   */
  | "paused"
  | "completed"
  | "failed"
  | "cancelled"
  | "indeterminate";

/**
 * PR8 automatic Run routing substate (design §12 / plan §11.4). Durable and
 * per-Run, covering only `mode="automatic"` Runs; explicit Runs always read
 * `idle` because they never route.
 *
 * `queued`        durable accepted, awaiting the first route
 * `routing`       a routing decision is being computed (lease-style: the
 *                 durable marker proves intent; a crash mid-route simply
 *                 re-routes, because deciding has no side effects)
 * `dispatching`   the Router committed work: durable MemberTurns exist and
 *                 own the Run until they terminal
 *
 * Restart rule: any non-terminal routing state re-derives from durable
 * evidence (no in-flight memory). `dispatching` waits for MemberTurns;
 * `routing`/`queued` recomputes the decision. Termination only moves
 * `routing` to `done` alongside a terminal Run state — it never reopens it.
 */
export type ConversationRoutingState = "queued" | "routing" | "dispatching" | "done";

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

/** Execution effect frozen at accept. Only the server-owned restricted runtime
 *  can prove read-only; omitted policy is unproven. Identity/text never prove it. */
export type MemberTurnEffect = "unknown" | "read-only" | "mutating";

/** Server-owned enforced capability proof, rechecked before execution.
 *  Absence means unproven. Never supplied by a model or public client. */
export type MemberTurnEffectProvenance = "declared-enforced";

export interface ConversationRecord {
  id: string;
  kind: ConversationKind;
  title: string;
  description?: string;
  botIds: string[];
  leadBotId?: string;
  /** Group execution mode, fixed at creation. Absent means `shared`; never
   *  present on Direct conversations. */
  workspaceMode?: GroupWorkspaceMode;
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
  /**
   * Context generation. Absent means 1. Clearing the default topic bumps it
   * and keeps the same id. Bindings from an older generation are not reused.
   */
  contextGeneration?: number;
  /**
   * Last lifecycle mutation time for the default topic. Absent means the
   * public clock is still the owning Bot's createdAt.
   */
  managedAt?: string;
  /** Creation-time physical admission cap; absent preserves legacy scheduling. */
  maxConcurrentMemberTurns?: number;
  /** Core-private peer scope. Never accessible through public Topic APIs. */
  peerScope?: { sourceConversationId: string; sourceTopicId: string; sourceBotId: string };
  /** Effective work target for this Topic. Absent on pre-Group rows: readers
   *  must treat absence as unknown, never as a default policy. Writers always
   *  persist it on Group Topics; direct Topics resolve execution from the
   *  owning Bot profile instead. */
  executionTarget?: ExecutionTarget;
}

export interface ConversationMessage {
  inputMetadata?: import("./direct-input-metadata").DirectInputMetadata;
  id: string;
  conversationId: string;
  topicId: string;
  seq: number;
  role: ConversationMessageRole;
  senderBotId?: string;
  recipients?: string[];
  content: string;
  /**
   * Executable upload refs for a human request (daemon filePath + preview).
   * Persisted atomically with accept; execution re-derives from this row.
   * Display projections strip filePath and expose only AttachmentMetadata.
   */
  media?: PromptAttachmentRef[];
  /** Public structured assignment; never a private message or a model identity. */
  handoff?: PublicHandoffEnvelope;
  replyTo?: string;
  runId?: string;
  createdAt: string;
  sourceTurn?: {
    sessionAlias: string;
    turnId?: string;
  };
}

export interface PublicHandoffEnvelope {
  senderMemberTurnId: string;
  to: string;
  assignmentId: string;
  memberTurnId: string;
  task: string;
  expectedOutput?: string;
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
  /** Durable Router question, projected only for automatic waiting-human Runs. */
  waitingQuestion?: string;
  generation: number;
  /**
   * PR8 automatic-Run routing substate. Automatic Runs only; explicit Runs
   * always read absent and never route. Durable so restart behavior is derived
   * from rows alone (see ConversationRoutingState).
   */
  routingState?: ConversationRoutingState;
  /** Store-owned CAS token for automatic routing, independent of dispatch generation. */
  routingGeneration?: number;
  /** Human-readable rationale of the latest routing decision (who was
   *  dispatched to and why, or the fallback cause). Automatic Runs only;
   *  durable so the UI shows the same reason after reconnect/restart. */
  routingReason?: string;
  /** Currently executing batch. Absent (direct legacy) means batch 1. */
  activeBatch?: number;
  maxMemberTurns: number;
  consumedMemberTurns: number;
  /** Member Bot ids that failed in the current batch (aggregate progress). */
  failedBotIds: string[];
  /** Member Bot ids unavailable for the current batch (aggregate progress). */
  unavailableBotIds: string[];
  /** Durable Run-local quarantine, independent of current-batch aggregates. */
  quarantinedBotIds?: string[];
  profileRevision: number;
  profileSnapshot: BotProfileSnapshot;
  createdAt: string;
  startedAt?: string;
  /**
   * Durable pause intent. Set while physical attempts from the running Run are
   * still settling (design §7 drain): the Run stays `running`, but no new work
   * is claimed. The Run becomes `paused` once every started attempt settled.
   */
  pauseRequestedAt?: string;
  pauseReason?: string;
  /** Set when the Run actually entered `paused`; absent during drain. */
  pausedAt?: string;
  /** CAS token for control mutations (pause/resume). Bumped once per applied
   *  control request, never by drain settlement. */
  controlRevision: number;
  /** Durable progress counter for stale-async fences (claim/settle). */
  progressRevision: number;
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
  /** Durable accept order within the batch (0-based). Replaces created_at/id
   *  tiebreaks so reopen/replay ordering is stable and dispatches align. */
  memberIndex: number;
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
  /** User cancellation intent scoped to this member, never its siblings. */
  cancellationReason?: "human-cancelled";
  /** Set exactly on the single wake turn the runtime creates for a leader
   *  member turn whose own public handoffs have all settled. It names the
   *  leader turn whose assignments this wake summarizes. Absent on every
   *  other turn — including ordinary orchestration-accepted members, whose
   *  `followup` origin does NOT identify a handoff wake. */
  followupSenderMemberTurnId?: string;
  /** Durable causal edge for a public handoff child: the sender's physical
   *  execution identity when it dispatched this assignment. The logical work
   *  parent is derived from it; it is never model- or client-supplied. */
  handoffSourceTurnId?: string;
  /** Declared side-effect capability for scheduling. Persisted at durable
   *  accept from AcceptMemberInput.effect; absent (pre-effect rows) reads as
   *  `unknown`. PR7 always persists `unknown`: no read-only capability is
   *  enforceably proven yet, so the scheduler serializes under
   *  shared-single-writer. */
  effect?: MemberTurnEffect;
  /** How `effect` was established. Present exactly when `effect` was
   *  explicitly declared; absent means unproven (`unknown`). */
  effectProvenance?: MemberTurnEffectProvenance;
  /**
   * PR8 structured blocked-step evidence for an automatic MemberTurn that
   * cannot proceed because the next step needs human-origin authority
   * (design §16 "[Start this step myself]"). Durable so the UX survives
   * reconnect/restart. Never an authority upgrade: the turn keeps its
   * orchestration origin and the human creates a NEW explicit request.
   * Absent means the turn is not permission-blocked. */
  blockedReason?: "human-authority-required" | "human-authority-unknown";
}

/** Server-derived authenticated human ingress. Clients cannot mint this. */
export interface HumanIngressContext {
  chatKey: string;
  senderId: string;
  accountId?: string;
  senderName?: string;
  isOwner?: boolean;
  /**
   * The channel's own report of route privacy.
   *
   * REQUIRED by the M1 renderer contract: only `"direct"` may render a form, and
   * `undefined` is treated as unproven rather than direct. Absent here means a
   * destination that never reported one, which a privacy-preserving renderer must
   * refuse. The relay web ingress stamps `"direct"` because a conversation pane is
   * an authenticated single-human view.
   */
  chatType?: "direct" | "group";
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
