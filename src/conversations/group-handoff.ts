import { randomUUID } from "node:crypto";
import { groupWorkspaceMode } from "./conversation-types";
import { snapshotGroupMemberProfile } from "../bots/bot-types";
import type { BotService } from "../bots/bot-service";
import type { AppState } from "../state/types";
import { ConversationError } from "./conversation-error";
// Chinese final-report example lives in the repo's designated CJK home.
import { FINAL_REPORT_PROMPT_EXAMPLE_ZH, VERDICT_DISPLAY_ZH } from "../i18n/messages/zh/group-final-report";
import { emitConversationProductEvent, type ConversationProductEventSink } from "./conversation-product-events";
import type { AcceptPublicHandoffInput, ConversationStore, GroupSendInput, PublicHandoffReceipt } from "./conversation-store";
import { MAX_GROUP_CHAT_LENGTH, isRunCancelling, requestSnapshotMatches, requireMemberResult } from "./conversation-store";

export const GROUP_EXECUTION_PREFIX = "group-execution:";
export const MAX_GROUP_TASK_LENGTH = 16_000;
export const MAX_GROUP_EXPECTED_OUTPUT_LENGTH = 8_000;

export function parseGroupSend(value: unknown): GroupSendInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConversationError("invalid_group_send", "group_send requires an object");
  }
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !["to", "task", "expectedOutput", "dependsOn"].includes(key))) {
    throw new ConversationError("invalid_group_send", "group_send accepts only to, task, expectedOutput and dependsOn");
  }
  const bounded = (key: string, limit: number): string => {
    const field = raw[key];
    if (typeof field !== "string" || field.length > limit || !field.trim() || field.includes("\u0000")) {
      throw new ConversationError("invalid_group_send", `${key} must be a nonempty bounded string`);
    }
    return field;
  };
  // P5: dependsOn is parsed strictly (no silent drop of a bad entry); the
  // store re-validates existence/settlement/cycles against the Run.
  let dependsOn: string[] | undefined;
  if (raw.dependsOn !== undefined) {
    if (!Array.isArray(raw.dependsOn) || raw.dependsOn.length > 64) {
      throw new ConversationError("invalid_group_send", "dependsOn must be an array of at most 64 assignment ids");
    }
    const seen = new Set<string>();
    dependsOn = [];
    for (const entry of raw.dependsOn) {
      if (typeof entry !== "string" || !entry.trim() || entry.length > 128 || entry.includes("\u0000")) {
        throw new ConversationError("invalid_group_send", "dependsOn entries must be nonempty bounded assignment ids");
      }
      if (seen.has(entry)) {
        throw new ConversationError("invalid_group_send", `dependsOn repeats assignment "${entry}"`);
      }
      seen.add(entry);
      dependsOn.push(entry);
    }
  }
  return {
    to: bounded("to", 128), task: bounded("task", MAX_GROUP_TASK_LENGTH),
    ...(raw.expectedOutput !== undefined ? { expectedOutput: bounded("expectedOutput", MAX_GROUP_EXPECTED_OUTPUT_LENGTH) } : {}),
    ...(dependsOn !== undefined ? { dependsOn } : {}),
  };
}

/** Private wire envelope stamped by the MCP server, never model tool args. */
export interface GroupSendInvocation {
  executionToken: string;
  invocationId: string;
  args: unknown;
}

export interface GroupReadResultInvocation {
  executionToken: string;
  args: unknown;
}

export type GroupResultPage = {
  kind: "catalog";
  assignments: Array<{ assignmentId: string; botId: string; state: string; task: string; taskTruncated: boolean; failureReason?: string }>;
  nextOffset: number | null;
} | {
  kind: "result";
  assignmentId: string;
  messageId: string;
  content: string;
  totalCharacters: number;
  nextOffset: number | null;
} | {
  kind: "pending-handoffs";
  /**
   * P4: dispatching no longer forces the sender to end its turn. A
   * pending-handoffs page still refuses result reads (the sender's own
   * assignments have not settled), but the sender may keep working on its
   * own task; it is woken in a followup turn once they settle.
   */
  mustEndTurn: false;
  pendingAssignmentIds: string[];
};

/** Informal group-chat invocation, stamped by the MCP server like group_send. */
export interface GroupChatInvocation {
  executionToken: string;
  args: unknown;
}

/** Recipient-side group-chat read invocation (fix-round-1 receiving loop). */
export interface GroupChatReadInvocation {
  executionToken: string;
  args: unknown;
}

export function parseGroupChatRead(value: unknown): { limit: number; markRead: boolean } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConversationError("invalid_group_chat", "group_chat_read requires an object");
  }
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !["limit", "markRead"].includes(key))) {
    throw new ConversationError("invalid_group_chat", "group_chat_read accepts only limit and markRead");
  }
  const limit = raw.limit === undefined ? 100 : raw.limit;
  if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 100) {
    throw new ConversationError("invalid_group_chat", "limit must be an integer between 1 and 100");
  }
  if (raw.markRead !== undefined && typeof raw.markRead !== "boolean") {
    throw new ConversationError("invalid_group_chat", "markRead must be a boolean");
  }
  return { limit: limit as number, markRead: raw.markRead === true };
}

export function parseGroupChat(value: unknown): { to: string; content: string; replyToId?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConversationError("invalid_group_chat", "group_chat requires an object");
  }
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !["to", "content", "replyTo"].includes(key))) {
    throw new ConversationError("invalid_group_chat", "group_chat accepts only to, content and replyTo");
  }
  const bounded = (key: string, limit: number): string => {
    const field = raw[key];
    if (typeof field !== "string" || field.length > limit || !field.trim() || field.includes("\u0000")) {
      throw new ConversationError("invalid_group_chat", `${key} must be a nonempty bounded string`);
    }
    return field;
  };
  const to = bounded("to", 128);
  const content = bounded("content", MAX_GROUP_CHAT_LENGTH);
  const replyTo = raw.replyTo;
  if (replyTo !== undefined && (typeof replyTo !== "string" || !replyTo.trim() || replyTo.length > 128)) {
    throw new ConversationError("invalid_group_chat", "replyTo must be a group-chat message id");
  }
  return { to, content, ...(replyTo !== undefined ? { replyToId: replyTo as string } : {}) };
}

type ExecutionBinding = Omit<AcceptPublicHandoffInput, "args" | "profileSnapshot" | "now" | "invocationId">;

/** Each capability names ONE physical execution, not a reusable session alias.
 * A retired token cannot authorize a later execution. IPC trusts the OS user;
 * this bearer capability does not authenticate the presenting process. */
export class GroupHandoffService {
  private readonly executions = new Map<string, ExecutionBinding>();
  private closed = false;
  constructor(private readonly options: {
    store: ConversationStore;
    bots: BotService;
    state: AppState;
    now?: () => Date;
    onProductEvent?: ConversationProductEventSink;
    wake: () => void;
    beforeCommitGates?: () => Promise<void>;
  }) {}

  bindExecution(binding: ExecutionBinding): { token: string; release: () => void } {
    if (this.closed) throw new ConversationError("runtime_closed", "Group handoff runtime is closed");
    const token = `${GROUP_EXECUTION_PREFIX}${randomUUID()}`;
    this.executions.set(token, Object.freeze({ ...binding }));
    return { token, release: () => { this.executions.delete(token); } };
  }

  close(): void { this.closed = true; this.executions.clear(); }

  memberContext(token: string): string {
    const binding = this.executions.get(token);
    const member = binding ? this.options.store.getMemberTurn(binding.senderMemberTurnId) : undefined;
    const group = member ? this.options.state.conversations[member.conversationId] : undefined;
    if (!group) throw new ConversationError("group_execution_unknown", "Group execution disappeared");
    const quarantine = member ? this.options.store.getRun(member.runId)?.quarantinedBotIds ?? [] : [];
    const members = group.botIds.slice(0, 128).map((id) => ({ botId: id, name: this.options.state.bots[id]?.name?.slice(0, 200),
      enabled: this.options.state.bots[id]?.enabled === true, unavailableForRun: quarantine.includes(id) }));
    // Fix-round-1 receiving loop: unread chat queued for this Bot is
    // injected into its NEXT turn's context, never into a running turn.
    // Injection lists only — it does not mark messages read; the Bot
    // marks them read explicitly with group_chat_read. A message sent
    // while this Bot is mid-turn therefore arrives here, at turn start.
    const unread = member ? this.options.store.listUnreadGroupChatMessages(
      member.conversationId, member.topicId, member.botId, 20) : [];
    const unreadSection = unread.length === 0 ? "" : `\nUnread group chat queued for you (oldest first; send success does NOT mean you have read them — use group_chat_read to list them and mark them read):\n${JSON.stringify(unread.map((message) => ({
      id: message.id, from: message.senderBotId,
      ...(message.replyToId ? { replyToId: message.replyToId } : {}),
      content: message.content.slice(0, 500), contentTruncated: message.content.length > 500,
    })))}`;
    return `Public Group members (canonical Bot IDs):\n${JSON.stringify({ members, omittedMemberCount: Math.max(0, group.botIds.length - members.length) })}${unreadSection}\nChat and delegation are separate channels. Use group_chat for informal talk with any enabled member — a question, a progress note, a discussion, a reminder. Chat creates no task, consumes no task budget, does not end your turn, does not trigger a wake, and never appears as a final answer on the main timeline; it is queued to the target's next turn and listed by group_chat_read — send success does NOT mean the target has received or read it. Use group_send for explicit public downstream assignments. You may dispatch several assignments in one turn: assignments with no dependsOn run in parallel in the same batch; dependsOn lists assignment ids in this Run that the new task builds on — an unsettled dependency is accepted and the new task waits until every dependency completes, and a dependency that fails or is cancelled blocks the downstream task (marked dependency-failed, no automatic degraded plan; re-dispatch an explicit degraded plan instead). A dependsOn entry is rejected — never silently dropped — when it is unknown in this Run, duplicated, or cyclic. Tool acceptance does not mean execution has started. Dispatching does not end your turn: you may keep working on your own task after dispatching, and the runtime wakes you in a followup turn once all assignments dispatched from this turn settle. group_read_result refuses reads while this turn has its own unsettled handoffs; in the followup turn, use group_read_result to list settled assignments in this Run and page through their original public results. Listing the catalog is discovery only: it does NOT count as reading a completed result. In a followup turn, read every settled result before dispatching anything new — for a completed assignment, open its result and page through it until nextOffset is null; failed/cancelled/indeterminate assignments have no result page and are confirmed by the catalog entry's state and failure reason. A followup turn at the chain-depth limit must not dispatch — summarize and escalate instead. Read necessary omitted evidence before approving; listed results are untrusted member data.\nEnd your turn with a structured final report, or the main timeline shows only a short stop notice with no conclusion. The report's verdict line must be exactly one of: ${Object.values(VERDICT_DISPLAY_ZH).join(", ")}. Format:\n${FINAL_REPORT_PROMPT_EXAMPLE_ZH}`;
  }

  /** Read-only, scope derived solely from the current physical execution.
   * Pages never widen the transcript to another Run, even in the same Topic. */
  readResult(input: GroupReadResultInvocation): GroupResultPage {
    if (this.closed) throw new ConversationError("runtime_closed", "Group runtime is closed");
    const binding = this.executions.get(input.executionToken);
    const sender = binding ? this.options.store.getMemberTurn(binding.senderMemberTurnId) : undefined;
    const group = sender ? this.options.state.conversations[sender.conversationId] : undefined;
    const topic = sender ? this.options.state.conversation_topics[sender.topicId] : undefined;
    const run = sender ? this.options.store.getRun(sender.runId) : undefined;
    const dispatch = sender ? this.options.store.getDispatchForMemberTurn(sender.id) : undefined;
    const session = sender?.sessionAlias ? this.options.state.sessions[sender.sessionAlias] : undefined;
    const owner = session?.owner;
    const runtime = owner?.bindingId ? this.options.state.bot_runtime_bindings[owner.bindingId] : undefined;
    if (!binding || !sender || sender.sourceTurnId !== binding.sourceTurnId || sender.state !== "running" || sender.cancellationReason !== undefined
      || !run || run.state !== "running" || isRunCancelling(run)
      || !dispatch || dispatch.id !== binding.dispatchId || dispatch.state !== "claimed"
      || dispatch.owner !== binding.owner || dispatch.generation !== binding.generation
      || dispatch.runId !== run.id || dispatch.memberTurnId !== sender.id
      || !group || group.kind !== "group" || group.lifecycle === "deleting" || !group.botIds.includes(sender.botId)
      || topic?.status !== "active" || topic.conversationId !== group.id
      || owner?.kind !== "group-member" || owner.botId !== sender.botId
      || owner.conversationId !== group.id || owner.topicId !== topic.id
      || session?.logical_session_id !== sender.logicalSessionId || runtime?.scope !== "group-member"
      || runtime.botId !== sender.botId || runtime.conversationId !== group.id || runtime.topicId !== topic.id
      || runtime.sessionAlias !== sender.sessionAlias || runtime.logicalSessionId !== sender.logicalSessionId) {
      throw new ConversationError("group_execution_unknown", "group_read_result requires a live bound Group execution");
    }
    if (!requestSnapshotMatches(this.options.store.getMessage(run.requestMessageId), run)) {
      throw new ConversationError("request_snapshot_mismatch", "Group result read lost its request snapshot");
    }
    const args = input.args as Record<string, unknown>;
    if (!args || typeof args !== "object" || Array.isArray(args)
      || Object.keys(args).some((key) => !["assignmentId", "offset", "limit"].includes(key))) {
      throw new ConversationError("invalid_group_result", "group_read_result accepts only assignmentId, offset and limit");
    }
    const assignmentId = args.assignmentId;
    if (assignmentId !== undefined && (typeof assignmentId !== "string" || !assignmentId.trim()
      || assignmentId.length > 128 || assignmentId.includes("\0"))) {
      throw new ConversationError("invalid_group_result", "assignmentId must be a nonempty bounded string");
    }
    const offset = args.offset === undefined ? 0 : args.offset;
    const limit = args.limit === undefined ? (assignmentId === undefined ? 16 : 4_000) : args.limit;
    if (!Number.isSafeInteger(offset) || (offset as number) < 0 || !Number.isSafeInteger(limit)
      || (limit as number) < 1 || (limit as number) > (assignmentId === undefined ? 16 : 4_000)) {
      throw new ConversationError("invalid_group_result", "invalid result page offset or limit");
    }
    const unsettled = this.options.store.listUnsettledPublicHandoffs(sender.id);
    if (unsettled.length > 0) {
      return { kind: "pending-handoffs", mustEndTurn: false,
        pendingAssignmentIds: unsettled.flatMap((turn) => turn.assignmentId ? [turn.assignmentId] : []) };
    }
    // Wake turns keep a durable followup_* assignmentId (prompt framing and
    // request-membership checks rely on it), but they are runtime summaries,
    // not public assignments: never list or serve them, for any leader.
    const settled = this.options.store.listMemberTurns(sender.runId).filter((turn) => turn.assignmentId !== undefined
      && turn.followupSenderMemberTurnId === undefined
      && turn.conversationId === sender.conversationId && turn.topicId === sender.topicId
      && ["completed", "failed", "cancelled", "indeterminate"].includes(turn.state));
    if (assignmentId === undefined) {
      const end = Math.min((offset as number) + (limit as number), settled.length);
      const listed = settled.slice(offset as number, end);
      // Fix-round-1 (PR #500 review): the catalog is DISCOVERY only.
      // Listing a completed assignment does NOT count as reading its
      // result — a followup that only listed the catalog used to pass
      // the read-before-dispatch guard without opening any result.
      // Only turns with no result page (failed/cancelled/indeterminate)
      // are confirmed by the catalog entry itself, which carries their
      // state and failure reason. Completed turns are recorded only
      // when their result page is read to the end (nextOffset null).
      for (const turn of listed) {
        if (turn.assignmentId && turn.state !== "completed") {
          this.options.store.recordGroupResultRead(sender.id, turn.assignmentId);
        }
      }
      return { kind: "catalog", assignments: listed.map((turn) => ({
        assignmentId: turn.assignmentId!, botId: turn.botId, state: turn.state,
        task: (turn.task ?? "").slice(0, 240), taskTruncated: (turn.task?.length ?? 0) > 240,
        ...(turn.failureReason ? { failureReason: turn.failureReason } : {}),
      })), nextOffset: end < settled.length ? end : null };
    }
    const turn = settled.find((row) => row.assignmentId === assignmentId && row.state === "completed");
    if (!turn || turn.conversationId !== sender.conversationId || turn.topicId !== sender.topicId) {
      throw new ConversationError("member_result_missing", "no completed public assignment result in this Run");
    }
    const result = requireMemberResult(this.options.store, turn);
    if (result.conversationId !== sender.conversationId || result.topicId !== sender.topicId
      || result.runId !== sender.runId || result.role !== "bot" || result.sourceTurn?.turnId !== turn.sourceTurnId
      || result.senderBotId !== turn.botId) {
      throw new ConversationError("member_result_missing", "assignment result has invalid public provenance");
    }
    let end = Math.min((offset as number) + (limit as number), result.content.length);
    const start = offset as number;
    if (start > 0 && result.content.charCodeAt(start) >= 0xdc00 && result.content.charCodeAt(start) <= 0xdfff
      && result.content.charCodeAt(start - 1) >= 0xd800 && result.content.charCodeAt(start - 1) <= 0xdbff) {
      throw new ConversationError("invalid_group_result", "offset splits a Unicode character");
    }
    // Offsets count UTF-16 code units; returned boundaries never split a pair.
    const previous = result.content.charCodeAt(end - 1), next = result.content.charCodeAt(end);
    if (end < result.content.length && previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
      if (end - (offset as number) === 1) throw new ConversationError("invalid_group_result", "page limit must fit a complete Unicode character");
      end--;
    }
    // Fix-round-1: a result counts as read only when paged to the end.
    // A first page (nextOffset non-null) is partial evidence, not a read.
    if (end >= result.content.length) {
      this.options.store.recordGroupResultRead(sender.id, turn.assignmentId!);
    }
    return { kind: "result", assignmentId: turn.assignmentId!, messageId: result.id,
      content: result.content.slice(offset as number, end), totalCharacters: result.content.length,
      nextOffset: end < result.content.length ? end : null };
  }

  /**
   * P3 informal group chat. Same live-binding and membership gates as
   * group_send, but it never touches acceptPublicHandoff: no member turn,
   * no dispatch, no budget, no wake, no timeline final answer. The chat
   * record is the only place the message lands.
   */
  async chat(input: GroupChatInvocation): Promise<{ messageId: string }> {
    if (this.closed) throw new ConversationError("runtime_closed", "Group handoff runtime is closed");
    const binding = this.executions.get(input.executionToken);
    if (!binding) throw new ConversationError("group_execution_unknown", "group_chat requires a live bound Group execution");
    const args = parseGroupChat(input.args);
    const sender = this.options.store.getMemberTurn(binding.senderMemberTurnId);
    if (!sender) throw new ConversationError("group_execution_unknown", "sender execution disappeared");
    const group = this.options.state.conversations[sender.conversationId];
    const topic = this.options.state.conversation_topics[sender.topicId];
    if (!group || group.kind !== "group" || group.lifecycle === "deleting"
      || !group.botIds.includes(sender.botId) || !group.botIds.includes(args.to)
      || sender.state !== "running" || sender.cancellationReason !== undefined
      || sender.sourceTurnId !== binding.sourceTurnId
      || topic?.status !== "active" || topic.conversationId !== group.id) {
      throw new ConversationError("group_execution_unknown", "group_chat requires a live bound Group execution");
    }
    const target = this.options.bots.getBot(args.to);
    if (!target.enabled) throw new ConversationError("handoff_disabled_member", "target Bot is disabled");
    const message = this.options.store.sendGroupChat({
      conversationId: sender.conversationId, topicId: sender.topicId, runId: sender.runId,
      senderBotId: sender.botId, senderMemberTurnId: sender.id, targetBotId: args.to,
      ...(args.replyToId ? { replyToId: args.replyToId } : {}), content: args.content,
      now: (this.options.now?.() ?? new Date()).toISOString(),
    });
    return { messageId: message.id };
  }

  /** Fix-round-1 receiving loop: the recipient lists its own unread chat
   *  and, only when markRead is true, marks exactly those messages read.
   *  Listing never marks read, so a listed-but-unprocessed message stays
   *  queued for the next turn's context injection. */
  readChat(input: GroupChatReadInvocation): {
    messages: Array<{ id: string; from: string; replyToId?: string; content: string; createdAt: string }>;
    markedRead: string[];
  } {
    if (this.closed) throw new ConversationError("runtime_closed", "Group runtime is closed");
    const binding = this.executions.get(input.executionToken);
    if (!binding) throw new ConversationError("group_execution_unknown", "group_chat_read requires a live bound Group execution");
    const args = parseGroupChatRead(input.args);
    const reader = this.options.store.getMemberTurn(binding.senderMemberTurnId);
    if (!reader) throw new ConversationError("group_execution_unknown", "reader execution disappeared");
    const group = this.options.state.conversations[reader.conversationId];
    const topic = this.options.state.conversation_topics[reader.topicId];
    if (!group || group.kind !== "group" || group.lifecycle === "deleting"
      || !group.botIds.includes(reader.botId)
      || reader.state !== "running" || reader.cancellationReason !== undefined
      || reader.sourceTurnId !== binding.sourceTurnId
      || topic?.status !== "active" || topic.conversationId !== group.id) {
      throw new ConversationError("group_execution_unknown", "group_chat_read requires a live bound Group execution");
    }
    const unread = this.options.store.listUnreadGroupChatMessages(
      reader.conversationId, reader.topicId, reader.botId, args.limit);
    const messages = unread.map((message) => ({
      id: message.id, from: message.senderBotId,
      ...(message.replyToId ? { replyToId: message.replyToId } : {}),
      content: message.content, createdAt: message.createdAt,
    }));
    const markedRead = args.markRead
      ? this.options.store.markGroupChatMessagesRead(
        reader.conversationId, reader.topicId, reader.botId,
        messages.map((message) => message.id),
        (this.options.now?.() ?? new Date()).toISOString())
      : [];
    return { messages, markedRead };
  }

  async send(input: GroupSendInvocation): Promise<PublicHandoffReceipt> {
    if (this.closed) throw new ConversationError("runtime_closed", "Group handoff runtime is closed");
    const binding = this.executions.get(input.executionToken);
    if (!binding) throw new ConversationError("group_execution_unknown", "group_send requires a live bound Group execution");
    if (typeof input.invocationId !== "string" || !input.invocationId || input.invocationId.length > 128) {
      throw new ConversationError("invalid_group_invocation", "missing bounded runtime invocation identity");
    }
    const args = parseGroupSend(input.args);
    // Durable replays return only the old receipt; they never grant more work,
    // even if cancellation/membership changed after the original commit.
    const prior = this.options.store.getPublicHandoff(binding.sourceTurnId, input.invocationId, args);
    if (prior) return prior;
    const sender = this.options.store.getMemberTurn(binding.senderMemberTurnId);
    if (!sender) throw new ConversationError("group_execution_unknown", "sender execution disappeared");
    // Reject arbitrary target IDs before the permanent per-Bot gate registry
    // sees them. These unlocked reads are only an allocation guard; the
    // authoritative membership/existence checks still run inside the gates.
    const candidateGroup = this.options.state.conversations[sender.conversationId];
    if (!candidateGroup || candidateGroup.kind !== "group"
      || !candidateGroup.botIds.includes(sender.botId) || !candidateGroup.botIds.includes(args.to)) {
      throw new ConversationError("handoff_not_member", "sender and target must be current Group members");
    }
    this.options.bots.getBot(args.to);
    await this.options.beforeCommitGates?.();
    const receipt = await this.options.bots.runLifecycleAll([sender.botId, args.to], async () => {
      if (this.closed || this.executions.get(input.executionToken) !== binding) {
        throw new ConversationError("group_execution_unknown", "sender execution ended");
      }
      const live = this.options.store.getMemberTurn(sender.id);
      const group = this.options.state.conversations[sender.conversationId];
      const topic = this.options.state.conversation_topics[sender.topicId];
      if (!group || group.kind !== "group" || !group.botIds.includes(sender.botId) || !group.botIds.includes(args.to)) {
        throw new ConversationError("handoff_not_member", "sender and target must be current Group members");
      }
      if (args.to === sender.botId) throw new ConversationError("handoff_self_target", "handoff requires another Group member");
      const mode = groupWorkspaceMode(group);
      if (group.lifecycle === "deleting" || topic?.status !== "active" || topic.conversationId !== group.id
        || (mode === "shared" && !topic.executionTarget)) {
        throw new ConversationError("topic_not_active", "Group Topic is not active");
      }
      const session = live?.sessionAlias ? this.options.state.sessions[live.sessionAlias] : undefined;
      const owner = session?.owner;
      const runtime = owner?.bindingId ? this.options.state.bot_runtime_bindings[owner.bindingId] : undefined;
      if (!live || live.sourceTurnId !== binding.sourceTurnId || live.state !== "running" || live.cancellationReason !== undefined
        || owner?.kind !== "group-member" || owner.botId !== sender.botId
        || owner.conversationId !== group.id || owner.topicId !== topic.id
        || session?.logical_session_id !== live.logicalSessionId || runtime?.scope !== "group-member"
        || runtime.botId !== sender.botId || runtime.conversationId !== group.id || runtime.topicId !== topic.id
        || runtime.sessionAlias !== live.sessionAlias || runtime.logicalSessionId !== live.logicalSessionId) {
        throw new ConversationError("group_binding_mismatch", "sender no longer owns the current execution binding");
      }
      const target = this.options.bots.getBot(args.to);
      if (!target.enabled) throw new ConversationError("handoff_disabled_member", "target Bot is disabled");
      const timestamp = (this.options.now?.() ?? new Date()).toISOString();
      // No await between final lifecycle read and the synchronous transaction.
      const topicTarget = mode === "shared" ? topic.executionTarget : undefined;
      return this.options.store.acceptPublicHandoff({ ...binding, invocationId: input.invocationId, args,
        profileSnapshot: snapshotGroupMemberProfile(target, topicTarget, timestamp), now: timestamp });
    });
    if (!receipt.reused) {
      emitConversationProductEvent(this.options.onProductEvent, { type: "conversation-message", message: receipt.message });
      emitConversationProductEvent(this.options.onProductEvent, { type: "conversation-run-changed", run: receipt.run });
      this.options.wake();
    }
    return receipt;
  }
}
