import type {
  BotAvatarConfig,
  BotSummaryDto,
  ConversationMessageDto,
  MemberTurnSummaryDto,
} from "@ganglion/xacpx-relay-protocol";

/** One public handoff envelope: the durable identity of a dispatched bot. */
export type GroupDispatchHandoff = NonNullable<ConversationMessageDto["handoff"]>;

/** The message that carried a handoff envelope. */
export type GroupDispatchHandoffMessage = ConversationMessageDto & { handoff: GroupDispatchHandoff };

/**
 * The leader (项管) turn that issued every dispatch in one round.
 *
 * `cancellationReason` is scoped human-Stop evidence. The leader's Run and
 * turn may still read `completed` after a Stop, so the aggregate row is
 * computed from the dispatched members, never from the leader's own state.
 */
export interface GroupDispatchLeader {
  botId: string;
  /** Leader member turn that owns the dispatches; absent on older shapes. */
  memberTurnId?: string;
  /** The leader's own durable state; never decides the aggregate row. */
  state?: MemberTurnSummaryDto["state"];
  /** Set when the user stopped the leader itself. */
  cancellationReason?: "human-cancelled";
  /**
   * The run that owns the round was cancelled. A whole-round stop cancels the
   * run and its turns without writing a reason on the leader's own turn, so
   * a cancelled leader (or wake) in a cancelled run is a stopped leader too.
   */
  runCancelled?: boolean;
  /**
   * The wake turn the runtime creates for this leader once its own handoffs
   * settle. Absent when the wake has not been inserted yet: the dispatch is
   * still unsettled.
   */
  wake?: MemberTurnSummaryDto;
}

/**
 * The leader (项管) of a round, as the UI addresses it.
 *
 * `canStop` is the honest stop question, not "is the leader's own turn
 * still running": a leader ends its turn right after dispatching, so the
 * live work is its wake turn. The leader stays stoppable while its wake
 * has not settled — including the window where the dispatch has not
 * settled yet and the wake row does not exist yet.
 */
export interface GroupDispatchLeaderPresentation {
  botId: string;
  /** Display name of the leader; falls back to its id when the catalog lacks it. */
  name: string;
  /** Durable leader member turn; empty when the shape carries none. */
  memberTurnId: string;
  /** The leader (or its wake) can still be stopped. */
  canStop: boolean;
  /**
   * Durable member turn the stop action cancels: the wake turn while it is
   * queued or running, otherwise the leader's own turn.
   */
  stopMemberTurnId: string;
}

/** One dispatched bot inside a round. */
export interface GroupDispatchEntry {
  /** The handoff message that dispatched this bot. */
  message: GroupDispatchHandoffMessage;
  /** Durable member turn that carries the dispatch out. */
  memberTurn: MemberTurnSummaryDto;
}

/**
 * Durable state of a dispatched member, projected onto the aggregate row.
 *
 * `indeterminate` is kept distinct: the core seals a member whose side
 * effects are unknown, and reporting that as `failed` or `completed` would
 * invent an outcome the runtime never proved.
 */
export type GroupDispatchMemberStatus =
  | "running"
  | "queued"
  | "completed"
  | "cancelled"
  | "failed"
  | "indeterminate";

/** Aggregate outcome of the round. */
export type GroupDispatchSummary = "running" | "done" | "cancelled" | "mixed";

/** A dispatched bot as the UI renders it. */
export interface GroupDispatchMemberPresentation {
  botId: string;
  name: string;
  avatar?: BotAvatarConfig;
  driver?: string;
  status: GroupDispatchMemberStatus;
  /** True when this member can be stopped on its own (scoped cancellation). */
  canStop: boolean;
  /** One-line preview of the member's reply; empty when it has not replied. */
  replyPreview: string;
  /** Message id of the reply, for jumping; empty when there is no reply. */
  replyId: string;
  /** Durable run that owns the dispatch; the scoped stop action needs it. */
  runId: string;
  /** Durable member turn; the scoped stop action needs it. */
  memberTurnId: string;
}

/** Avatar slot of the aggregate row. */
export interface GroupDispatchAvatar {
  botId: string;
  /** Durable member turn behind this avatar: the row's identity, never the
   *  bot id — the same bot can be dispatched twice in one round. */
  memberTurnId: string;
  name: string;
  avatar?: BotAvatarConfig;
  driver?: string;
}

/** Members per status. */
export interface GroupDispatchCounts {
  running: number;
  queued: number;
  completed: number;
  cancelled: number;
  failed: number;
  indeterminate: number;
}

/** What the UI may offer as a stop action. */
export interface GroupDispatchCapability {
  /** Per-row ■ is available: the core supports scoped MemberTurn cancellation. */
  canStopMember: boolean;
  /** Stopping the leader: only the leader (new core) or the whole run (old core). */
  leaderStopAction: "leader-only" | "stop-all";
  /** At least one member is still active, so a "stop all" action applies. */
  anyActive: boolean;
}

export interface GroupDispatchPresentation {
  /** The round's dispatch text: the task of the round's first handoff. */
  instructions: string;
  members: GroupDispatchMemberPresentation[];
  counts: GroupDispatchCounts;
  summary: GroupDispatchSummary;
  /** The leader was stopped by the user; the row still reports the members. */
  leaderStopped: boolean;
  capability: GroupDispatchCapability;
  avatars: { items: GroupDispatchAvatar[]; overflow: number };
  /** The leader of the round, as the UI addresses it. */
  leader: GroupDispatchLeaderPresentation;
  /** Durable run that owns the round; the stop actions need it. */
  runId: string;
}

export interface GroupDispatchPresentationInput {
  leader: GroupDispatchLeader;
  /** Dispatches of this round, in dispatch order. */
  dispatches: GroupDispatchEntry[];
  /** Bot catalog of the instance, for display names and avatars. */
  bots?: BotSummaryDto[];
  /** Driver per bot id (agent driver), for the avatar glyph. */
  drivers?: Record<string, string>;
  /** The core supports `control.runs.cancelMember`. */
  supportsCancelMember: boolean;
  /** Every message of the conversation; used to resolve the members' replies. */
  messages?: ConversationMessageDto[];
}

/** At most this many avatars are shown; the rest collapse into a counter. */
export const GROUP_DISPATCH_AVATAR_LIMIT = 4;

/** Longest reply preview kept for one member row. */
const REPLY_PREVIEW_MAX = 120;

/** Durable member states that end a member turn for good. */
const TERMINAL_MEMBER_STATES: Record<MemberTurnSummaryDto["state"], boolean> = {
  queued: false,
  dispatched: false,
  running: false,
  completed: true,
  failed: true,
  cancelled: true,
  indeterminate: true,
};

/** Project a durable member state onto the aggregate row's status. */
function dispatchStatus(state: MemberTurnSummaryDto["state"]): GroupDispatchMemberStatus {
  switch (state) {
    case "queued":
    case "dispatched":
      return "queued";
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "cancelled":
      return "cancelled";
    case "failed":
      return "failed";
    case "indeterminate":
      return "indeterminate";
  }
}

/**
 * The dispatched member's own reply, matched through the member turn's prompt
 * identity.
 *
 * Identity, never position: a reply belongs to the member only when it
 * carries that member turn's prompt request id inside the same run, and
 * exactly one candidate qualifies. Ambiguity yields no reply — a guessed
 * jump target would move the reader to another bot's answer.
 */
function resolveMemberReply(
  entry: GroupDispatchEntry,
  messages: ConversationMessageDto[],
): { id: string; content: string } | null {
  const promptRequestId = entry.memberTurn.promptRequestId;
  if (!promptRequestId) return null;
  const message = entry.message;
  const matches = messages.filter((candidate) => candidate.role === "bot"
    && !candidate.handoff
    && candidate.conversationId === message.conversationId
    && candidate.topicId === message.topicId
    && candidate.runId === message.runId
    && candidate.senderBotId === entry.memberTurn.botId
    && candidate.promptRequestId === promptRequestId
    && candidate.seq > message.seq
    && candidate.content.trim().length > 0);
  return matches.length === 1 ? { id: matches[0]!.id, content: matches[0]!.content } : null;
}

/**
 * Aggregate one leader round of dispatches into a single display model.
 *
 * Pure: every input is explicit, nothing is read from a store. The leader's
 * own state never decides the row — a stopped leader still reports the
 * members' proven outcomes — so `summary` follows the dispatched members
 * only.
 */
export function presentGroupDispatch(input: GroupDispatchPresentationInput): GroupDispatchPresentation {
  // The leader's own turn: `active` means it has not ended yet. A queued or
  // dispatched leader has not finished its turn either — it simply has not
  // started running.
  const leaderMemberTurnId = input.leader.memberTurnId ?? "";
  const leaderState = input.leader.state;
  const leaderActive = leaderState === "queued" || leaderState === "dispatched" || leaderState === "running";
  const leaderCancellationReason = input.leader.cancellationReason;
  // The wake turn the runtime creates for a leader whose own handoffs have
  // all settled. It may not exist yet: the dispatch is still unsettled, and
  // the wake row is inserted only afterwards.
  const wake = input.leader.wake;
  const wakeStatus = wake ? dispatchStatus(wake.state) : undefined;
  // A wake that is queued (or merely dispatched) or running is live work.
  const wakeLive = wakeStatus === "queued" || wakeStatus === "running";
  const wakeSettled = wake !== undefined && TERMINAL_MEMBER_STATES[wake.state] === true;
  // The leader can be stopped while its own turn runs, or — once that turn
  // ended — while its wake has not settled and the leader itself was never
  // stopped. A missing wake row is unsettled work, not a finished round.
  // Only a completed leader hands off to a wake: a failed or indeterminate
  // leader never gets one, so once it ended there is nothing left to stop.
  const leaderCanStop =
    leaderActive || (leaderState === "completed" && leaderCancellationReason === undefined && !wakeSettled);
  // Stop the live wake when there is one; otherwise stop the leader's own turn.
  const leaderStopMemberTurnId = wakeLive && wake ? wake.id : leaderMemberTurnId;
  const botById = new Map<string, BotSummaryDto>();
  for (const bot of input.bots ?? []) botById.set(bot.id, bot);
  const messages = input.messages ?? [];

  const members: GroupDispatchMemberPresentation[] = input.dispatches.map((entry) => {
    const botId = entry.memberTurn.botId || entry.message.handoff.to;
    const bot = botById.get(botId);
    const status = dispatchStatus(entry.memberTurn.state);
    const active = status === "running" || status === "queued";
    const reply = resolveMemberReply(entry, messages);
    const content = reply
      ? reply.content.split("\n").map((part) => part.trim()).find((part) => part.length > 0) ?? ""
      : "";
    const collapsed = content.replace(/\s+/g, " ");
    return {
      botId,
      name: bot?.name ?? botId,
      ...(bot?.avatar ? { avatar: bot.avatar } : {}),
      ...(input.drivers?.[botId] ? { driver: input.drivers[botId] } : {}),
      status,
      canStop: input.supportsCancelMember && active,
      replyPreview: collapsed.length > REPLY_PREVIEW_MAX ? `${collapsed.slice(0, REPLY_PREVIEW_MAX)}…` : collapsed,
      replyId: reply?.id ?? "",
      runId: entry.memberTurn.runId,
      memberTurnId: entry.memberTurn.id,
    };
  });

  const counts: GroupDispatchCounts = {
    running: 0,
    queued: 0,
    completed: 0,
    cancelled: 0,
    failed: 0,
    indeterminate: 0,
  };
  for (const member of members) counts[member.status]++;

  const total = members.length;
  let summary: GroupDispatchSummary;
  if (counts.running > 0 || counts.queued > 0) summary = "running";
  // A round with no dispatch has no outstanding work and no proven failure:
  // "done" is the vacuous all-complete reading, never "mixed".
  else if (total === 0 || counts.completed === total) summary = "done";
  else if (counts.cancelled === total) summary = "cancelled";
  else summary = "mixed";

  return {
    instructions: input.dispatches[0]?.message.handoff.task.trim() ?? "",
    members,
    counts,
    summary,
    // Stop evidence on EITHER side: the leader's own turn or its wake, or —
    // after a whole-round stop, which leaves no reason on the turns — a
    // cancelled leader or wake inside a cancelled run.
    leaderStopped: leaderCancellationReason !== undefined || wake?.cancellationReason !== undefined
      || (input.leader.runCancelled === true && (leaderState === "cancelled" || wake?.state === "cancelled")),
    capability: {
      canStopMember: input.supportsCancelMember,
      // Scoped leader stop needs BOTH the core capability and a durable
      // member turn to cancel (the wake while it lives, the leader
      // otherwise): without that id there is nothing to cancel, so the
      // round-level stop is the only honest action.
      leaderStopAction: input.supportsCancelMember && leaderStopMemberTurnId ? "leader-only" : "stop-all",
      anyActive: members.some((member) => member.status === "running" || member.status === "queued"),
    },
    avatars: {
      items: members.slice(0, GROUP_DISPATCH_AVATAR_LIMIT).map((member) => ({
        botId: member.botId,
        memberTurnId: member.memberTurnId,
        name: member.name,
        ...(member.avatar ? { avatar: member.avatar } : {}),
        ...(member.driver ? { driver: member.driver } : {}),
      })),
      overflow: Math.max(0, members.length - GROUP_DISPATCH_AVATAR_LIMIT),
    },
    leader: {
      botId: input.leader.botId,
      name: botById.get(input.leader.botId)?.name ?? input.leader.botId,
      memberTurnId: leaderMemberTurnId,
      canStop: leaderCanStop,
      stopMemberTurnId: leaderStopMemberTurnId,
    },
    runId: input.dispatches[0]?.memberTurn.runId ?? input.dispatches[0]?.message.runId ?? "",
  };
}
