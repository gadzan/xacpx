import type { BotProfile, BotProfileSnapshot } from "../bots/bot-types";
import type {
  ConversationMessage,
  ConversationRecord,
  ConversationRun,
  ConversationTopic,
  MemberTurnRecord,
} from "../conversations/conversation-types";

/** Exact join from a live turn event onto ConversationRun / MemberTurn. */
export interface ConversationTurnCorrelation {
  conversationId: string;
  topicId: string;
  botId: string;
  runId: string;
  memberTurnId: string;
}

export interface BotSummaryDto {
  id: string;
  name: string;
  avatar?: string;
  role?: string;
  agent: string;
  workspace: string;
  model?: string;
  effort?: string;
  enabled: boolean;
  updatedAt: string;
  /** Monotonic per-Bot revision, bumped on every update. Lets the Web order
   *  summary snapshots against cached details: a summary with a newer
   *  revision than the cached detail proves the detail is stale (including
   *  instructions-only updates that change no other summary field).
   *  Optional to stay wire-compatible with older connectors that predate
   *  it; the Web treats a missing revision as unknown (field comparison
   *  still applies). */
  profileRevision?: number;
  /** True once the Bot materialized any runtime (direct or group-member).
   *  Agent changes lock on this; workspace-default changes lock only on
   *  direct runtime (Group Topics always carry an explicit workspace). A
   *  persisted Direct Conversation alone keeps delete fail-closed via
   *  bot_in_use but does not lock identity. */
  hasRuntime?: boolean;
}

export interface BotDetailDto extends BotSummaryDto {
  instructions?: string;
  profileRevision: number;
  createdAt: string;
}

export interface BotCreateRequestDto {
  name: string;
  avatar?: string;
  role?: string;
  instructions?: string;
  agent: string;
  workspace: string;
  model?: string;
  effort?: string;
  enabled?: boolean;
}

export interface BotUpdateRequestDto {
  name?: string;
  avatar?: string | null;
  role?: string | null;
  instructions?: string | null;
  agent?: string;
  workspace?: string;
  model?: string | null;
  effort?: string | null;
  enabled?: boolean | null;
}

export interface ExecutionTargetDto {
  workspace: string;
  cwd?: string;
  /** PR7 supports the two shared policies only; worktree-per-member has no
 *  provisioning lifecycle (PR10) and every Run on it would be unexecutable. */
  isolation: "shared" | "shared-single-writer";
}

export interface TopicSummaryDto {
  maxConcurrentMemberTurns?: number;
  id: string;
  conversationId: string;
  title: string;
  status: ConversationTopic["status"];
  createdAt: string;
  updatedAt: string;
  executionTarget?: ConversationTopic["executionTarget"];
}

export interface GroupSummaryDto {
  id: string;
  kind: "group";
  title: string;
  description?: string;
  botIds: string[];
  leadBotId?: string;
  defaultTopicId?: string;
  lifecycle?: ConversationRecord["lifecycle"];
  createdAt: string;
  updatedAt: string;
}

export interface GroupDetailDto extends GroupSummaryDto {
  topics: TopicSummaryDto[];
}

export interface ConversationSummaryDto {
  id: string;
  kind: "bot";
  title: string;
  botId: string;
  defaultTopicId?: string;
  lifecycle?: ConversationRecord["lifecycle"];
  createdAt: string;
  updatedAt: string;
}

export interface ConversationDetailDto extends ConversationSummaryDto {
  description?: string;
  topics: TopicSummaryDto[];
}

export interface ConversationMessageDto {
  handoff?: ConversationMessage["handoff"];
  id: string;
  conversationId: string;
  topicId: string;
  seq: number;
  role: ConversationMessage["role"];
  senderBotId?: string;
  content: string;
  replyTo?: string;
  runId?: string;
  createdAt: string;
  /** Join onto live turn-started.promptRequestId when this message came from a MemberTurn. */
  promptRequestId?: string;
}

export interface ConversationRunDto {
  quarantinedBotIds?: string[];
  id: string;
  conversationId: string;
  topicId: string;
  requestMessageId: string;
  requestId: string;
  mode: ConversationRun["mode"];
  state: ConversationRun["state"];
  completionReason?: string;
  profileRevision: number;
  activeBatch?: number;
  /**
   * PR8 automatic-Run routing substate. Present on automatic Runs only;
   * explicit Runs omit it entirely (they never route). The Web uses it to
   * show "deciding next step" without inventing client-side state, and it is
   * durable so the presentation survives reconnect/restart.
   */
  routingState?: ConversationRun["routingState"];
  waitingQuestion?: string;
  maxMemberTurns: number;
  consumedMemberTurns: number;
  failedBotIds: string[];
  unavailableBotIds: string[];
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface ConversationRunDetailDto extends ConversationRunDto {
  profileSnapshot?: BotProfileSnapshot;
  memberTurns: MemberTurnSummaryDto[];
}

export interface MemberTurnSummaryDto {
  effect?: MemberTurnRecord["effect"];
  effectProvenance?: MemberTurnRecord["effectProvenance"];
  id: string;
  runId: string;
  conversationId: string;
  topicId: string;
  botId: string;
  batch: number;
  memberIndex: number;
  attempt: number;
  origin: MemberTurnRecord["origin"];
  state: MemberTurnRecord["state"];
  /** Exact join onto turn-started.promptRequestId / Control promptRequestId. */
  promptRequestId?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  /** Group assignment identity. Absent on direct (single-member) turns. */
  assignmentId?: string;
  /** Concrete work instruction for this assignment. */
  task?: string;
  /** Expected output description for this assignment. */
  expectedOutput?: string;
  /** Assignment ids this turn depends on. */
  dependsOn?: string[];
  /** Machine-readable terminal failure reason (failed only). */
  failureReason?: string;
  /**
   * PR8 structured blocked-step evidence (design §16): set when an automatic
   * MemberTurn cannot proceed because the next step needs human-origin
   * authority. Durable so the "[Start this step myself]" action survives
   * reconnect. Never an origin upgrade — the action creates a NEW explicit
   * human request referencing this turn.
   */
  blockedReason?: MemberTurnRecord["blockedReason"];
}

/** Explicit Group routing target. IDs are authority; display names are
 * presentation only and never route. `members` requires UNIQUE Bot IDs —
 * duplicates are rejected with invalid-target — and preserves caller order;
 * `everyone` expands at accept to the current eligible members
 * (live Group membership with enabled Bots), so a disabled member is skipped
 * while a deliberately disabled Group member keeps its seat. `automatic` is a
 * durable-mode reservation (PR8) and is rejected by the PR7 explicit accept
 * path. */
export type ConversationTarget =
  | { botId: string }
  | { mode: "members"; botIds: string[] }
  | { mode: "everyone" }
  | { mode: "automatic" };

export interface ConversationPromptRequestDto {
  conversationId: string;
  topicId: string;
  requestId: string;
  text: string;
  /** Direct legacy `{ botId }` or explicit Group structured target.
   *  Server validates against current membership. */
  target?: ConversationTarget;
}

export interface ConversationPromptResponseDto {
  reused: boolean;
  conversationId: string;
  topicId: string;
  requestId: string;
  run: ConversationRunDto;
  message: ConversationMessageDto;
  /** Absent on an automatic accept/replay with zero durable members. */
  memberTurn?: MemberTurnSummaryDto;
  /** Every durable member in order. Automatic responses always include this
   *  array (possibly empty); legacy single-member responses may omit it. */
  memberTurns?: MemberTurnSummaryDto[];
  /** Topic-wide authoritative owner as of accept (executing, else oldest
   *  queued). Lets the caller adopt the true owner without a second
   *  runs.list round trip: an HTTP accept proves only the accepted Run is
   *  durable, never that it owns the Topic. Optional for wire compat with
   *  older connectors; when absent the caller must treat the accepted Run
   *  as unconfirmed and re-run discovery before cancelling it. */
  activeRunId?: string;
  activeRun?: ConversationRunDto;
}

/** A distinct operation is required: old daemons must reject, never ignore a safety request. */
export interface ConversationPolicyPromptRequestDto extends ConversationPromptRequestDto {
  memberPolicies: import("../conversations/conversation-effect-request").ConversationMemberPolicy[];
}

export interface ConversationHistoryRequestDto {
  conversationId: string;
  topicId: string;
  afterSeq?: number;
  beforeSeq?: number;
  limit?: number;
  direction?: "oldest-first" | "newest-first";
}

export interface ConversationHistoryResponseDto {
  conversationId: string;
  topicId: string;
  messages: ConversationMessageDto[];
  oldestSeq?: number;
  newestSeq?: number;
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
}

export function toBotSummary(bot: BotProfile, hasRuntime?: boolean): BotSummaryDto {
  return {
    id: bot.id,
    name: bot.name,
    agent: bot.agent,
    workspace: bot.workspace,
    enabled: bot.enabled,
    updatedAt: bot.updatedAt,
    profileRevision: bot.profileRevision ?? 1,
    ...(bot.avatar ? { avatar: bot.avatar } : {}),
    ...(bot.role ? { role: bot.role } : {}),
    ...(bot.model ? { model: bot.model } : {}),
    ...(bot.effort ? { effort: bot.effort } : {}),
    ...(hasRuntime ? { hasRuntime: true as const } : {}),
  };
}

export function toBotDetail(bot: BotProfile, hasRuntime?: boolean): BotDetailDto {
  return {
    ...toBotSummary(bot, hasRuntime),
    profileRevision: bot.profileRevision,
    createdAt: bot.createdAt,
    ...(bot.instructions ? { instructions: bot.instructions } : {}),
  };
}

export function toTopicSummary(topic: ConversationTopic): TopicSummaryDto {
  return {
    ...(topic.maxConcurrentMemberTurns !== undefined ? { maxConcurrentMemberTurns: topic.maxConcurrentMemberTurns } : {}),
    id: topic.id,
    conversationId: topic.conversationId,
    title: topic.title,
    status: topic.status,
    createdAt: topic.createdAt,
    updatedAt: topic.updatedAt,
    ...(topic.executionTarget ? { executionTarget: { ...topic.executionTarget } } : {}),
  };
}

export function toGroupSummary(
  conversation: ConversationRecord,
  defaultTopicId?: string,
): GroupSummaryDto {
  if (conversation.kind !== "group") {
    throw new Error("conversation is not a Group conversation");
  }
  return {
    id: conversation.id,
    kind: "group",
    title: conversation.title,
    ...(conversation.description ? { description: conversation.description } : {}),
    botIds: [...conversation.botIds],
    ...(conversation.leadBotId ? { leadBotId: conversation.leadBotId } : {}),
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    ...(defaultTopicId ? { defaultTopicId } : {}),
    ...(conversation.lifecycle ? { lifecycle: conversation.lifecycle } : {}),
  };
}

export function toConversationSummary(
  conversation: ConversationRecord,
  defaultTopicId?: string,
): ConversationSummaryDto {
  const botId = conversation.botIds[0];
  if (conversation.kind !== "bot" || !botId) {
    // Stable domain code (never bare Error): the Relay bridge maps .code to
    // the wire error instead of "internal". Matches the run-service
    // conversation_not_direct boundary (same value, same trigger: a Group
    // id on the Direct-only read path).
    throw Object.assign(
      new Error("conversation is not a Direct Bot conversation"),
      { code: "conversation_not_direct" },
    );
  }
  return {
    id: conversation.id,
    kind: "bot",
    title: conversation.title,
    botId,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    ...(defaultTopicId ? { defaultTopicId } : {}),
    ...(conversation.lifecycle ? { lifecycle: conversation.lifecycle } : {}),
  };
}

export function toConversationMessage(message: ConversationMessage): ConversationMessageDto {
  return {
    id: message.id,
    conversationId: message.conversationId,
    topicId: message.topicId,
    seq: message.seq,
    role: message.role,
    content: message.content,
    ...(message.handoff ? { handoff: { ...message.handoff } } : {}),
    createdAt: message.createdAt,
    ...(message.senderBotId ? { senderBotId: message.senderBotId } : {}),
    ...(message.replyTo ? { replyTo: message.replyTo } : {}),
    ...(message.runId ? { runId: message.runId } : {}),
    ...(message.sourceTurn?.turnId ? { promptRequestId: message.sourceTurn.turnId } : {}),
  };
}

export function toConversationRun(run: ConversationRun): ConversationRunDto {
  return {
    id: run.id,
    conversationId: run.conversationId,
    topicId: run.topicId,
    requestMessageId: run.requestMessageId,
    requestId: run.requestId,
    mode: run.mode,
    state: run.state,
    profileRevision: run.profileRevision,
    // PR8: automatic Runs project their routing substate; explicit Runs never
    // carry one, so the field stays absent rather than lying with a default.
    ...(run.mode === "automatic" && run.routingState !== undefined
      ? { routingState: run.routingState }
      : {}),
    ...(run.mode === "automatic" && run.state === "waiting-human" && run.waitingQuestion !== undefined
      ? { waitingQuestion: run.waitingQuestion } : {}),
    ...(run.activeBatch !== undefined ? { activeBatch: run.activeBatch } : {}),
    maxMemberTurns: run.maxMemberTurns,
    consumedMemberTurns: run.consumedMemberTurns,
    failedBotIds: [...run.failedBotIds],
    unavailableBotIds: [...run.unavailableBotIds],
    ...(run.quarantinedBotIds ? { quarantinedBotIds: [...run.quarantinedBotIds] } : {}),
    createdAt: run.createdAt,
    ...(run.completionReason ? { completionReason: run.completionReason } : {}),
    ...(run.startedAt ? { startedAt: run.startedAt } : {}),
    ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
  };
}

export function toMemberTurnSummary(turn: MemberTurnRecord): MemberTurnSummaryDto {
  return {
    ...(turn.effect ? { effect: turn.effect } : {}),
    ...(turn.effectProvenance ? { effectProvenance: turn.effectProvenance } : {}),
    id: turn.id,
    runId: turn.runId,
    conversationId: turn.conversationId,
    topicId: turn.topicId,
    botId: turn.botId,
    batch: turn.batch,
    memberIndex: turn.memberIndex,
    attempt: turn.attempt,
    origin: turn.origin,
    state: turn.state,
    createdAt: turn.createdAt,
    ...(turn.sourceTurnId ? { promptRequestId: turn.sourceTurnId } : {}),
    ...(turn.startedAt ? { startedAt: turn.startedAt } : {}),
    ...(turn.finishedAt ? { finishedAt: turn.finishedAt } : {}),
    ...(turn.assignmentId ? { assignmentId: turn.assignmentId } : {}),
    ...(turn.task ? { task: turn.task } : {}),
    ...(turn.expectedOutput ? { expectedOutput: turn.expectedOutput } : {}),
    ...(turn.dependsOn && turn.dependsOn.length > 0 ? { dependsOn: [...turn.dependsOn] } : {}),
    ...(turn.failureReason ? { failureReason: turn.failureReason } : {}),
    ...(turn.blockedReason ? { blockedReason: turn.blockedReason } : {}),
  };
}

export function toRunDetail(run: ConversationRun, memberTurns: MemberTurnRecord[]): ConversationRunDetailDto {
  return {
    ...toConversationRun(run),
    profileSnapshot: run.profileSnapshot,
    memberTurns: memberTurns.map(toMemberTurnSummary),
  };
}
