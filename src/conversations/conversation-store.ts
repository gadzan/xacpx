import type { BotProfileSnapshot } from "../bots/bot-types";
import type {
  ConversationMessage,
  ConversationRun,
  MemberTurnRecord,
  PendingDispatch,
} from "./conversation-types";

export interface ListMessagesQuery {
  conversationId: string;
  topicId: string;
  afterSeq?: number;
  beforeSeq?: number;
  limit: number;
}

export interface AcceptRequestInput {
  conversationId: string;
  topicId: string;
  requestId: string;
  botId: string;
  content: string;
  profileSnapshot: BotProfileSnapshot;
  maxMemberTurns?: number;
  now: string;
  /** Live Conversation dispatcher epoch. Stamped on the dispatch row so a later
   *  process or recovered claim cannot inherit human permission authority. */
  authorityEpoch?: string;
}

export interface AcceptRequestResult {
  reused: boolean;
  message: ConversationMessage;
  run: ConversationRun;
  memberTurn: MemberTurnRecord;
  dispatch: PendingDispatch;
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
  botId: string;
  content: string;
  sourceTurn: { sessionAlias: string; turnId?: string };
  now: string;
  completionReason?: string;
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
}

export interface ClaimFenceInput {
  dispatchId: string;
  owner: string;
  generation: number;
  now: string;
}

export interface ReleaseClaimToPendingInput extends ClaimFenceInput {}

export interface FailClaimBeforeStartInput extends ClaimFenceInput, FailExecutionInput {}

export interface CancelRunResult {
  run: ConversationRun;
  memberTurn: MemberTurnRecord;
  dispatch: PendingDispatch;
  alreadyTerminal: boolean;
  executionStarted: boolean;
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
  recoverExpiredClaims(now: string): RecoveredClaim[];
  claimNextDispatch(input: ClaimNextDispatchInput): ClaimedWork | undefined;
  hasDurableBotWork(botId: string): boolean;
  releaseClaimToPending(input: ReleaseClaimToPendingInput): PendingDispatch;
  markExecutionStarted(input: MarkExecutionStartedInput): MemberTurnRecord;
  completeExecution(input: CompleteExecutionInput): CompleteExecutionResult;
  failExecution(input: FailExecutionInput): ConversationRun;
  failClaimBeforeStart(input: FailClaimBeforeStartInput): ConversationRun;
  cancelRun(runId: string, now: string, reason?: string): CancelRunResult;
  completeCancel(runId: string, memberTurnId: string, now: string, indeterminate?: boolean): ConversationRun;
  markConversationDeleting(conversationId: string, now: string): void;
  markTopicDeleting(topicId: string, conversationId: string, now: string): void;
  isConversationDeleting(conversationId: string): boolean;
  isTopicDeleting(topicId: string): boolean;
  deleteTopicRows(conversationId: string, topicId: string): void;
  deleteConversationRows(conversationId: string): void;
  close(): void;
}
