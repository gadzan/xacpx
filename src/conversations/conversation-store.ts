import type { BotProfileSnapshot } from "../bots/bot-types";
import { ConversationError } from "./conversation-error";
import type {
  ConversationMessage,
  ConversationRun,
  ConversationRoutingState,
  HumanIngressContext,
  MemberTurnEffect,
  MemberTurnEffectProvenance,
  MemberTurnOrigin,
  MemberTurnRecord,
  PendingDispatch,
} from "./conversation-types";

/** A completion reason on runnable work is durable cancel intent, not routing work. */
export function isRunCancelling(run: ConversationRun): boolean {
  return (run.state === "queued" || run.state === "running") && run.completionReason !== undefined;
}

/** A completed assignment's successful evidence must exist; empty content is valid. */
export function requireMemberResult(store: Pick<ConversationStore, "getMemberResult">, turn: MemberTurnRecord): ConversationMessage {
  const result = store.getMemberResult(turn);
  if (!result) {
    throw new ConversationError("member_result_missing", `completed member turn "${turn.id}" lost its exact public result`);
  }
  return result;
}

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
  /** Declared side-effect capability. Only an explicitly proven `read-only`
   *  (effect + effectProvenance "declared-enforced") counts as safe for
   *  concurrent execution; everything else persists as `unknown`. Absent ⇒
   *  `unknown` (PR7: no enforceable read-only proof exists yet). */
  effect?: MemberTurnEffect;
  effectProvenance?: MemberTurnEffectProvenance;
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

/**
 * Unified request-snapshot referential contract (one check, three consumers:
 * claim execution, idempotent accept replay, and transcript composition).
 * The request message must exist and belong to the Run's Conversation AND
 * Topic with the human role — a corrupted `runs.request_message_id` pointing
 * at another message must fail closed, never feed another message's content
 * into a prompt. `runId` IS checked: the human-request writer persists the
 * message with its own Run's id (same statement that inserts it), so a same-
 * Topic foreign run's request — which otherwise satisfies conversation, topic,
 * and role — is rejected. A human request row without `run_id` has no writer
 * path (none ever did, including the store's first schema) and is corruption:
 * fail closed rather than guess.
 */
export function requestSnapshotMatches(
  message: ConversationMessage | undefined,
  run: ConversationRun,
): boolean {
  return message !== undefined
    && message.conversationId === run.conversationId
    && message.topicId === run.topicId
    && message.role === "human"
    && message.runId === run.id;
}

export interface AcceptRequestResult {
  reused: boolean;
  message: ConversationMessage;
  run: ConversationRun;
  memberTurn?: MemberTurnRecord;
  dispatch?: PendingDispatch;
  /** Every durable member in order. Automatic accepts may hold zero, with
   *  singular fields absent; later replay can include Router-created batches. */
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
  /** Restrict the claim to one Run's dispatches: the same-batch sibling
   *  cohort. Unset claims globally (previous sequencing). */
  runId?: string;
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
  /** Physical attempt identity. Required after a started recovery retry. */
  sourceTurnId?: string;
  now: string;
  reason: string;
  blockedReason?: MemberTurnRecord["blockedReason"];
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

export interface RenewHeldClaimInput extends ClaimFenceInput {
  leaseExpiresAt: string;
}

export interface FailClaimBeforeStartInput extends ClaimFenceInput, FailExecutionInput {}

export interface AssertLiveDispatchForMaterializeInput extends ClaimFenceInput {
  runId: string;
  memberTurnId: string;
  conversationId: string;
  topicId: string;
}

export interface CancelRunResult {
  run: ConversationRun;
  memberTurn?: MemberTurnRecord;
  dispatch?: PendingDispatch;
  alreadyTerminal: boolean;
  executionStarted: boolean;
  /** Every started-but-unsettled member at cancel time (durable order).
   *  Empty when nothing was executing. The dispatcher cancels each exactly. */
  activeMembers: MemberTurnRecord[];
}

/** One validated Router assignment, as committed durably by
 *  `applyRoutingDecision`. Structure was validated by the Router gate;
 *  membership/dependency/budget were validated against the live Run state. */
export interface RoutingAssignmentInput {
  id: string;
  botId: string;
  task: string;
  expectedOutput?: string;
  dependsOn?: string[];
  triggerMessageIds: string[];
  /** Accepted execution snapshot for THIS member, derived at routing time from
   *  the live Bot profile and the Topic's ExecutionTarget (the same seam
   *  `snapshotGroupMemberProfile` provides for explicit accepts). Required:
   *  a router-selected member must execute against the Bot it was actually
   *  assigned to, never the Run's snapshot carrier. */
  profileSnapshot: BotProfileSnapshot;
}

export interface ApplyRoutingDecisionInput {
  runId: string;
  /** Ownership of the routing cycle, minted durably before calling Router. */
  routingGeneration: number;
  now: string;
  decision:
    | {
        type: "dispatch";
        mode: "single" | "parallel" | "sequential";
        assignments: RoutingAssignmentInput[];
      }
    | { type: "need-human"; question: string }
    | { type: "complete"; reason: string; synthesisBotId?: string };
  /** Live Conversation request boundary for this Run (newest seq). Every
   *  assignment's `triggerMessageIds` are validated against public rows of
   *  this Conversation+Topic before any durable write. */
  requestMessageId: string;
}

export interface ApplyRoutingDecisionResult {
  run: ConversationRun;
  memberTurns: MemberTurnRecord[];
  dispatches: PendingDispatch[];
  /** Terminal Run states applied by this call (`waiting-human` for need-human,
   *  `completed` for complete). Absent for dispatch — that stays nonterminal. */
  terminal?: ConversationRun["state"];
}

export interface RoutingDecisionRecord {
  runId: string;
  decisionType: "dispatch" | "need-human" | "complete";
  mode?: "single" | "parallel" | "sequential";
  question?: string;
  reason?: string;
  assignmentIds: string[];
  at: string;
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
 *  `reconciled` is true when proven evidence persisted — either by
 *  reclassifying an indeterminate seal (member + Run) or by recording member
 *  evidence under durable cancel intent for the pending batch settlement.
 *  Every other Run state is an evidence no-op. */
export interface ReconcileLateResult {
  run: ConversationRun;
  memberTurn: MemberTurnRecord;
  message?: ConversationMessage;
  reconciled: boolean;
}

export interface ConversationStore {
  /** Internal trusted execution input. No public caller supplies its identity. */
  acceptPublicHandoff(input: AcceptPublicHandoffInput): PublicHandoffReceipt;
  getPublicHandoff(sourceTurnId: string, invocationId: string, args: GroupSendInput): PublicHandoffReceipt | undefined;
  acceptRequest(input: AcceptRequestInput): AcceptRequestResult;
  getRun(runId: string): ConversationRun | undefined;
  getRunByRequestId(conversationId: string, topicId: string, requestId: string): ConversationRun | undefined;
  getAcceptedRequest(conversationId: string, topicId: string, requestId: string): AcceptRequestResult | undefined;
  listRuns(conversationId: string, topicId?: string): ConversationRun[];
  getMessage(messageId: string): ConversationMessage | undefined;
  listMessages(query: ListMessagesQuery): ConversationMessage[];
  getMemberTurn(memberTurnId: string): MemberTurnRecord | undefined;
  listMemberTurns(runId: string): MemberTurnRecord[];
  /** Exact public result join using the minted durable execution identity. */
  getMemberResult(turn: MemberTurnRecord): ConversationMessage | undefined;
  getDispatchForRun(runId: string): PendingDispatch | undefined;
  getDispatchForMemberTurn(memberTurnId: string): PendingDispatch | undefined;
  listDispatchesForRun(runId: string): PendingDispatch[];
  recoverExpiredClaims(now: string): RecoveredClaim[];
  /** Converge `claimed` dispatches whose owner can no longer be alive: the
   *  startup handoff after acquiring the exclusive consumer lock, before the
   *  first drain. Any `claimed` row whose owner differs from the live
   *  dispatcher's owner id belongs to a previous process (graceful shutdown
   *  retires its own holds, so survivors are crash orphans or failed-retire
   *  leftovers) — the lock is stronger death evidence than lease expiry, so
   *  foreign rows converge immediately instead of waiting out their old lease:
   *  unstarted members return to `pending` with owner cleared, keeping
   *  generation/authorityEpoch/humanIngress/origin/attempt verbatim (an
   *  orderly handoff, never the recovery rewrite); started members seal to
   *  `indeterminate` with `started_result_unknown` and the aggregate
   *  converges in the same transaction (unproven side effects — never
   *  re-executed); members of terminal Runs finish their dispatch (already
   *  finished business, identical to the normal recovery path). Returns one
   *  entry per converged row. Pending cancellation with an already-settled
   *  batch also classifies here, before the new consumer resumes scheduling. */
  convergePreviousOwnerClaims(owner: string, now: string): RecoveredClaim[];
  /** Retire `claimed` dispatches whose owner can no longer be alive, WITHOUT
   *  touching provenance — the unstarted-only seam of
   *  convergePreviousOwnerClaims, kept for direct unit coverage of the
   *  orderly-handoff branch. Started members are skipped (converged to
   *  indeterminate by convergePreviousOwnerClaims); members of terminal Runs
   *  are skipped identically (finished by convergePreviousOwnerClaims).
   *  Returns the retired dispatch ids. */
  retirePreviousOwnerClaims(owner: string): string[];
  claimNextDispatch(input: ClaimNextDispatchInput): ClaimedWork | undefined;
  hasDurableBotWork(botId: string): boolean;
  /** True when any durable rows exist for a Group Conversation (runs,
   *  messages, dispatches, lifecycle, or seq allocation). Guards Group
   *  metadata delete against orphaning history the Group row is needed to
   *  interpret. */
  hasDurableGroupWork(conversationId: string): boolean;
  /** Extend the lease on a writer-slot-held claim WITHOUT touching anything
   *  else: same owner, same generation, same authorityEpoch/humanIngress. The
   *  fence rejects anything that is not our live unstarted claim (stale owner,
   *  wrong generation, already started, or already recovered) with
   *  `stale_claim`, so a lost race can never extend a lease it no longer owns.
   *  Scheduling waits must never look like crash recovery. */
  renewHeldClaim(input: RenewHeldClaimInput): PendingDispatch;
  /** Retire one unstarted held claim at graceful shutdown WITHOUT touching
   *  provenance: the dispatch returns to `pending` with owner cleared and a
   *  FRESH lease window, but authorityEpoch/humanIngress, generation, member
   *  origin and attempt are preserved verbatim. Unlike lease recovery (which
   *  rewrites origin to `recovery` and bumps attempt) this is an orderly
   *  handoff: the next consumer claims it as ordinary pending work and the
   *  member executes on its original human route. Fenced like renewal — only
   *  our live unstarted claim retires; anything else rejects `stale_claim`. */
  retireHeldClaim(input: ClaimFenceInput): PendingDispatch;
  releaseClaimToPending(input: ReleaseClaimToPendingInput): PendingDispatch;
  markExecutionStarted(input: MarkExecutionStartedInput): MemberTurnRecord;
  assertLiveDispatchForMaterialize(input: AssertLiveDispatchForMaterializeInput): void;
  completeExecution(input: CompleteExecutionInput): CompleteExecutionResult;
  failExecution(input: FailExecutionInput): ConversationRun;
  failClaimBeforeStart(input: FailClaimBeforeStartInput): ConversationRun;
  /**
   * PR8: settle a whole automatic Run to a terminal state with a durable
   * completion reason, independent of any single member (used when routing
   * itself fails, when the Router is rejected, or budget is exhausted).
   * Terminal Runs and non-automatic Runs are refused.
   */
  failRun(runId: string, reason: string, state: "failed", now: string, routingGeneration?: number): ConversationRun;
  cancelRun(runId: string, now: string, reason?: string): CancelRunResult;
  /**
   * Acquire the next automatic routing generation (state must be routing).
   * Refuses terminal/waiting/deleting Runs, unsettled members and earlier
   * Topic owners. Decision commit owns dispatching/done transitions.
   */
  markRoutingState(runId: string, state: ConversationRoutingState, now: string): ConversationRun;
  /**
   * Commit one validated Router decision durably (plan §11.4/§11.5):
   * `dispatch` inserts one MemberTurn + one pending dispatch per assignment in
   * the next batch (origin `router`, orchestration provenance — never human),
   * `need-human` settles the Run as `waiting-human`, and `complete` settles it
   * `completed`. Rejects assignments that do not map to the Run's public
   * transcript, unknown Bots, duplicate assignment ids, budget overruns, and
   * a stale routing generation on ALL decision variants. Re-acquiring routing
   * after a crash mints a new generation, fencing every older model call.
   */
  applyRoutingDecision(input: ApplyRoutingDecisionInput): ApplyRoutingDecisionResult;
  /** Durable audit of each Router decision taken for this Run (audit only;
   *  never read for scheduling decisions). */
  listRoutingDecisions(runId: string): RoutingDecisionRecord[];
  /**
   * PR8: automatic Runs that durable rows prove still owe a routing decision —
   * nonterminal, mode automatic, no other Run holding the Topic, and no
   * unsettled member in the Run's ACTIVE batch (a batch that is still
   * executing routes from its own settle hook, not from recovery). Consumed
   * at activation so a crash between "Router asked" and "decision committed"
   * re-derives from rows alone.
   */
  automaticRunsAwaitingRouting(): Array<{ run: ConversationRun; batchMembers: MemberTurnRecord[] }>;
  completeCancel(runId: string, memberTurnId: string, now: string, indeterminate?: boolean, forceRunTerminal?: boolean, sourceTurnId?: string): ConversationRun;
  /** Two-phase cancel settlement: persist every member's observed physical
   *  cancel outcome as member evidence first (completed evidence, failed
   *  state, cancelled, unknown), then aggregate the Run once. Proven member
   *  outcomes are never overwritten by a sibling's unknown — including a
   *  late proof that landed mid-fan-out: members already terminal keep their
   *  evidence and outcome via the idempotent fence (no double progress). */
  settleCancelBatch(input: SettleCancelBatchInput): SettleCancelBatchResult;
  /** Late provider proof reconciliation (§14.3) across two windows: (a) an
   *  indeterminate-sealed Run reclassifies the sealed member and re-derives
   *  the Run; (b) a live Run under durable cancel intent persists MEMBER
   *  EVIDENCE ONLY (no Run aggregate) so the pending batch settlement reads
   *  it from fresh member states. Never resurrects scheduling — clean
   *  cancelled Runs, Runs without cancel intent, and already-proven members
   *  are no-ops. */
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

/** Entire model-visible contract. Strict decoding rejects every other field. */
export interface GroupSendInput {
  to: string;
  task: string;
  expectedOutput?: string;
}

export interface AcceptPublicHandoffInput {
  senderMemberTurnId: string;
  sourceTurnId: string;
  dispatchId: string;
  owner: string;
  generation: number;
  invocationId: string;
  args: GroupSendInput;
  profileSnapshot: BotProfileSnapshot;
  now: string;
}

export interface PublicHandoffReceipt {
  reused: boolean;
  run: ConversationRun;
  memberTurn: MemberTurnRecord;
  message: ConversationMessage;
}
