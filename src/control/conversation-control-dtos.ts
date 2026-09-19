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
  /** True once the Bot materialized a direct runtime. Agent/workspace edits and
   *  delete are then backend fail-closed; teardown/rebind is a later lifecycle
   *  surface, so PR5 treats used Bots as identity-locked, not rebindable. */
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

export interface TopicSummaryDto {
  id: string;
  conversationId: string;
  title: string;
  status: ConversationTopic["status"];
  createdAt: string;
  updatedAt: string;
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
  id: string;
  conversationId: string;
  topicId: string;
  requestMessageId: string;
  requestId: string;
  mode: ConversationRun["mode"];
  state: ConversationRun["state"];
  completionReason?: string;
  profileRevision: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface ConversationRunDetailDto extends ConversationRunDto {
  profileSnapshot?: BotProfileSnapshot;
  memberTurns: MemberTurnSummaryDto[];
}

export interface MemberTurnSummaryDto {
  id: string;
  runId: string;
  conversationId: string;
  topicId: string;
  botId: string;
  batch: number;
  attempt: number;
  origin: MemberTurnRecord["origin"];
  state: MemberTurnRecord["state"];
  /** Exact join onto turn-started.promptRequestId / Control promptRequestId. */
  promptRequestId?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface ConversationPromptRequestDto {
  conversationId: string;
  topicId: string;
  requestId: string;
  text: string;
  /** Optional Direct target. Server validates it matches the Conversation's Bot. */
  target?: { botId: string };
}

export interface ConversationPromptResponseDto {
  reused: boolean;
  conversationId: string;
  topicId: string;
  requestId: string;
  run: ConversationRunDto;
  message: ConversationMessageDto;
  memberTurn: MemberTurnSummaryDto;
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
    id: topic.id,
    conversationId: topic.conversationId,
    title: topic.title,
    status: topic.status,
    createdAt: topic.createdAt,
    updatedAt: topic.updatedAt,
  };
}

export function toConversationSummary(
  conversation: ConversationRecord,
  defaultTopicId?: string,
): ConversationSummaryDto {
  const botId = conversation.botIds[0];
  if (conversation.kind !== "bot" || !botId) {
    throw new Error("conversation is not a Direct Bot conversation");
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
    createdAt: run.createdAt,
    ...(run.completionReason ? { completionReason: run.completionReason } : {}),
    ...(run.startedAt ? { startedAt: run.startedAt } : {}),
    ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
  };
}

export function toMemberTurnSummary(turn: MemberTurnRecord): MemberTurnSummaryDto {
  return {
    id: turn.id,
    runId: turn.runId,
    conversationId: turn.conversationId,
    topicId: turn.topicId,
    botId: turn.botId,
    batch: turn.batch,
    attempt: turn.attempt,
    origin: turn.origin,
    state: turn.state,
    createdAt: turn.createdAt,
    ...(turn.sourceTurnId ? { promptRequestId: turn.sourceTurnId } : {}),
    ...(turn.startedAt ? { startedAt: turn.startedAt } : {}),
    ...(turn.finishedAt ? { finishedAt: turn.finishedAt } : {}),
  };
}

export function toRunDetail(run: ConversationRun, memberTurns: MemberTurnRecord[]): ConversationRunDetailDto {
  return {
    ...toConversationRun(run),
    profileSnapshot: run.profileSnapshot,
    memberTurns: memberTurns.map(toMemberTurnSummary),
  };
}
