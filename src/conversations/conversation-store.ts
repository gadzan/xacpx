import type { BotProfileSnapshot } from "../bots/bot-types";
import type {
  ConversationMessage,
  ConversationRun,
  HumanIngressContext,
  MemberTurnOrigin,
  MemberTurnRecord,
  PendingDispatch,
} from "./conversation-types";

export interface ListMessagesQuery {
  conversationId: string;
  topicId: string;
  afterSeq?: number;
  beforeSeq?: number;
  limit: number;
  direction?: "oldest-first" | "newest-first";
}

export interface AcceptMemberInput {
  botId: string;
  profileSnapshot: BotProfileSnapshot;
  /** Durable provenance for this member. Defaults to human-explicit on
   *  human-ingress accepts, orchestration-fresh "followup" otherwise;
   *  PR7/PR8 pass router/handoff explicitly. Never inferred from names. */
  provenance?: MemberTurnOrigin;
  /** Group assignment identity. Absent on direct (single-member) accepts. */
  assignmentId?: string;
  /** Concrete work instruction for this assignment. */
  task?: string;
  /** Expected output description for this assignment. */
  expectedOutput?: string;
  /** Assignment ids this member depends on. */
  dependsOn?: string[];
}

export interface AcceptRequestInput {
  conversationId: string;
  topicId: string;
  requestId: string;
  botId: string;
  content: string;
  profileSnapshot: BotProfileSnapshot;
  mode?: ConversationRun["mode"];
  maxMemberTurns?: number;
  now: string;
  /** Extra members accepted in the same transaction: one MemberTurn plus one
   *  pending dispatch intent each, in durable member_index order. The legacy
   *  single `botId/profileSnapshot` is always the first member (members[0]).
   *  Direct accepts omit this. A `primaryMember` overlay (same botId as the
   *  legacy singular) carries assignment/provenance metadata for members[0],
   *  so PR7 explicit assignments and router-selected first members do not
   *  need another Store API change. */
  members?: AcceptMemberInput[];
  /** Assignment/provenance overlay for members[0], which is always the
   *  legacy singular botId/profileSnapshot by construction (the type omits
   *  both, so the overlay cannot diverge the durable order). Absent ⇒
   *  members[0] is a plain direct accept. */
  primaryMember?: Omit<AcceptMemberInput, "botId" | "profileSnapshot">;
  /** Live Conversation dispatcher epoch. Stamped on the dispatch row so a later
   *  process or recovered claim cannot inherit human permission authority. */
  authorityEpoch?: string;
  /** Trusted human ingress bound to `authorityEpoch`. Absent ⇒ orchestration. */
  humanIngress?: HumanIngressContext;
}

export interface AcceptRequestResult {
  reused: boolean;
  message: ConversationMessage;
  run: ConversationRun;
  memberTurn: MemberTurnRecord;
  dispatch: PendingDispatch;
  /** Every accepted member in durable order (first entry mirrors the legacy
   *  singular `memberTurn`/`dispatch`). Single-member accepts hold one. */
  memberTurns: MemberTurnRecord[];
  /** One pending dispatch intent per member, same order as `memberTurns`. */
  dispatches: PendingDispatch[];
}

export interface ClaimNextDispatchInput {
  now: string;
  owner: string;
  leaseExpiresAt: string;
  /** Current process authority epoch. Compared to the dispatch row, never to generation. */
  authorityEpoch: string;
  /** Topics deferred for this drain pass after a pre-start failure. */
  skipTopicIds?: readonly string[];
}

export interface ClaimedWork {
  dispatch: PendingDispatch;
  run: ConversationRun;
  memberTurn: MemberTurnRecord;
  /** Accepted execution snapshot for THIS member. Falls back to the Run's
   *  profileSnapshot for pre-multi-member rows (direct legacy). Dispatch
   *  must use this, never the first member's snapshot. */
  memberSnapshot: BotProfileSnapshot;
}

export interface RecoveredClaim {
  dispatch: PendingDispatch;
  run: ConversationRun;
  memberTurn: MemberTurnRecord;
  outcome: "requeued" | "indeterminate";
}

export interface MarkExecutionStartedInput {
  dispatchId: string;
  owner: string;
  generation: number;
  runId: string;
  memberTurnId: string;
  sessionAlias: string;
  logicalSessionId: string;
  sourceTurnId: string;
  queueItemId?: string;
  now: string;
}

export interface CompleteExecutionInput {
  runId: string;
  memberTurnId: string;
  /** Legacy caller echo; ignored for attribution. The transcript sender
   *  always derives from the member turn. Kept optional for wire compat. */
  botId?: string;
  content: string;
  sourceTurn: { sessionAlias: string; turnId?: string };
  now: string;
  completionReason?: string;
  /** Whole-Run human cancel path: settle the batch to its terminal outcome
   *  even on automatic Runs (which otherwise stay running for the Router). */
  forceRunTerminalOnSettle?: boolean;
}

export interface CompleteExecutionResult {
  run: ConversationRun;
  memberTurn: MemberTurnRecord;
  assistantMessage?: ConversationMessage;
  resurrected: boolean;
}

export interface FailExecutionInput {
  runId: string;
  memberTurnId: string;
  now: string;
  reason: string;
  terminalState?: Extract<ConversationRun["state"], "failed" | "cancelled" | "indeterminate">;
  /** Whole-Run human cancel path: settle the batch to its terminal outcome
   *  even on automatic Runs (which otherwise stay running for the Router). */
  forceRunTerminalOnSettle?: boolean;
}

export interface ClaimFenceInput {
  dispatchId: string;
  owner: string;
  generation: number;
  now: string;
}

/** One member's observed physical cancel result for batch settlement. */
export interface CancelMemberOutcome {
  memberTurnId: string;
  outcome: "completed" | "failed" | "cancelled" | "unknown";
  /** Proven completion text (completed only). */
  content?: string;
  /** Proven completion correlation (completed only). */
  sourceTurn?: { sessionAlias: string; turnId?: string };
  /** Failure reason (failed only). */
  reason?: string;
}

export interface SettleCancelBatchInput {
  runId: string;
  outcomes: CancelMemberOutcome[];
  now: string;
  /** Evidence-only settlement: persist member rows but skip Run aggregation.
   *  Used when a sibling physical cancel threw — the Run outcome is
   *  re-derived on retry from complete member evidence. */
  deferRunAggregate?: boolean;
}
export interface SettledCancelMember {
  member: MemberTurnRecord;
  outcome: CancelMemberOutcome["outcome"];
  message?: ConversationMessage;
}

export interface SettleCancelBatchResult {
  run: ConversationRun;
  settled: SettledCancelMember[];
}

export interface ReleaseClaimToPendingInput extends ClaimFenceInput {}

export interface FailClaimBeforeStartInput extends ClaimFenceInput, FailExecutionInput {}

export interface AssertLiveDispatchForMaterializeInput extends ClaimFenceInput {
  runId: string;
  memberTurnId: string;
  conversationId: string;
  topicId: string;
}

export interface CancelRunResult {
  run: ConversationRun;
  memberTurn: MemberTurnRecord;
  dispatch: PendingDispatch;
  alreadyTerminal: boolean;
  executionStarted: boolean;
  /** Every started-but-unsettled member at cancel time (durable order).
   *  Empty when nothing was executing. The dispatcher cancels each exactly. */
  activeMembers: MemberTurnRecord[];
}

/**
 * §21 durable-store guardrail: one Topic may hold at most this many
 * nonterminal Runs (active + queued). Later accepts fail `topic_queue_full`;
 * idempotent replays of already-accepted requests always succeed.
 */
export const MAX_QUEUED_RUNS_PER_TOPIC = 64;

/**
 * §14.2 automatic-Run member-turn budget: a guardrail against runaway Router
 * loops, not a completion definition. Automatic Runs default to this cap when
 * the caller does not pass an explicit smaller budget; explicit Runs are
 * bounded by their accepted member list and are not subject to this cap.
 */
export const MAX_AUTOMATIC_MEMBER_TURNS = 24;

/** Result of routing a late provider settlement into the store (§14.3):
 *  `reconciled` is true only when an indeterminate seal was reclassified by
 *  the proven outcome; every other Run state is an evidence no-op. */
export interface ReconcileLateResult {
  run: ConversationRun;
  memberTurn: MemberTurnRecord;
  message?: ConversationMessage;
  reconciled: boolean;
}

export interface ConversationStore {
  acceptRequest(input: AcceptRequestInput): AcceptRequestResult;
  getRun(runId: string): ConversationRun | undefined;
  getRunByRequestId(conversationId: string, topicId: string, requestId: string): ConversationRun | undefined;
  getAcceptedRequest(conversationId: string, topicId: string, requestId: string): AcceptRequestResult | undefined;
  listRuns(conversationId: string, topicId?: string): ConversationRun[];
  getMessage(messageId: string): ConversationMessage | undefined;
  listMessages(query: ListMessagesQuery): ConversationMessage[];
  getMemberTurn(memberTurnId: string): MemberTurnRecord | undefined;
  listMemberTurns(runId: string): MemberTurnRecord[];
  getDispatchForRun(runId: string): PendingDispatch | undefined;
  getDispatchForMemberTurn(memberTurnId: string): PendingDispatch | undefined;
  listDispatchesForRun(runId: string): PendingDispatch[];
  recoverExpiredClaims(now: string): RecoveredClaim[];
  claimNextDispatch(input: ClaimNextDispatchInput): ClaimedWork | undefined;
  hasDurableBotWork(botId: string): boolean;
  /** True when any durable rows exist for a Group Conversation (runs,
   *  messages, dispatches, lifecycle, or seq allocation). Guards Group
   *  metadata delete against orphaning history the Group row is needed to
   *  interpret. */
  hasDurableGroupWork(conversationId: string): boolean;
  releaseClaimToPending(input: ReleaseClaimToPendingInput): PendingDispatch;
  markExecutionStarted(input: MarkExecutionStartedInput): MemberTurnRecord;
  assertLiveDispatchForMaterialize(input: AssertLiveDispatchForMaterializeInput): void;
  completeExecution(input: CompleteExecutionInput): CompleteExecutionResult;
  failExecution(input: FailExecutionInput): ConversationRun;
  failClaimBeforeStart(input: FailClaimBeforeStartInput): ConversationRun;
  cancelRun(runId: string, now: string, reason?: string): CancelRunResult;
  completeCancel(runId: string, memberTurnId: string, now: string, indeterminate?: boolean, forceRunTerminal?: boolean): ConversationRun;
  /** Two-phase cancel settlement: persist every member's observed physical
   *  cancel outcome as member evidence first (completed evidence, failed
   *  state, cancelled, unknown), then aggregate the Run once. Proven member
   *  outcomes are never overwritten by a sibling's unknown. */
  settleCancelBatch(input: SettleCancelBatchInput): SettleCancelBatchResult;
  /** Indeterminate reconciliation for a late provider result: persists the
   *  proven outcome as durable evidence and reclassifies an indeterminate
   *  seal (member + Run) to its proven terminal state. Never resurrects
   *  scheduling — cancelled/live/proven Runs are no-ops. */
  reconcileLateResult(input: {
    runId: string;
    memberTurnId: string;
    outcome: "completed" | "failed";
    content?: string;
    reason?: string;
    sourceTurn: { sessionAlias: string; turnId?: string };
    now: string;
  }): ReconcileLateResult;
  /** True when a nonterminal MemberTurn in this Conversation references the
   *  Bot. Membership removal must wait until that work terminals (PR6
   *  freeze: removed-member durable work has no correct interpretation). */
  hasNonterminalGroupMemberWork(conversationId: string, botId: string): boolean;
  /** Distinct nonterminal (conversation, topic) roots. Activation validates
   *  each still has a live Group/Topic or Direct-plan authority before the
   *  first kick; a missing root is fail-closed actionable recovery. */
  listNonterminalRunRoots(): Array<{ conversationId: string; topicId: string }>;
  markConversationDeleting(conversationId: string, now: string): void;
  markTopicDeleting(topicId: string, conversationId: string, now: string): void;
  isConversationDeleting(conversationId: string): boolean;
  isTopicDeleting(topicId: string): boolean;
  deleteTopicRows(conversationId: string, topicId: string): void;
  deleteConversationRows(conversationId: string): void;
  close(): void;
}
