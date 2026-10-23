import type {
  BotAvatarConfig,
  BotSummaryDto,
  ConversationMessageDto,
  MemberTurnSummaryDto,
} from "@ganglion/xacpx-relay-protocol";

/** One public handoff envelope: the durable identity of a dispatched bot. */
export type GroupDispatchHandoff = NonNullable<ConversationMessageDto["handoff"]>;

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
}

/** One dispatched bot inside a round. */
export interface GroupDispatchEntry {
  /** Public handoff envelope of this dispatch. */
  handoff: GroupDispatchHandoff;
  /** Durable member turn that carries the dispatch out. */
  memberTurn: MemberTurnSummaryDto;
  /** The member's reply, when it already answered. */
  reply?: { id: string; content: string } | null;
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
  /** The round's dispatch text. Shown once for the whole row. */
  instructions: string;
  members: GroupDispatchMemberPresentation[];
  counts: GroupDispatchCounts;
  summary: GroupDispatchSummary;
  /** The leader was stopped by the user; the row still reports the members. */
  leaderStopped: boolean;
  capability: GroupDispatchCapability;
  avatars: { items: GroupDispatchAvatar[]; overflow: number };
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
}

/** At most this many avatars are shown; the rest collapse into a counter. */
export const GROUP_DISPATCH_AVATAR_LIMIT = 4;

/** Longest reply preview kept for one member row. */
const REPLY_PREVIEW_MAX = 120;

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

/** The round's dispatch text, one line per distinct task, in dispatch order. */
function dispatchInstructions(entries: GroupDispatchEntry[]): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const entry of entries) {
    const task = entry.handoff.task.trim();
    if (!task || seen.has(task)) continue;
    seen.add(task);
    parts.push(task);
  }
  return parts.join("\n");
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
  const botById = new Map<string, BotSummaryDto>();
  for (const bot of input.bots ?? []) botById.set(bot.id, bot);

  const members: GroupDispatchMemberPresentation[] = input.dispatches.map((entry) => {
    const botId = entry.memberTurn.botId || entry.handoff.to;
    const bot = botById.get(botId);
    const status = dispatchStatus(entry.memberTurn.state);
    const active = status === "running" || status === "queued";
    const reply = entry.reply ?? null;
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
    instructions: dispatchInstructions(input.dispatches),
    members,
    counts,
    summary,
    leaderStopped: input.leader.cancellationReason === "human-cancelled",
    capability: {
      canStopMember: input.supportsCancelMember,
      leaderStopAction: input.supportsCancelMember ? "leader-only" : "stop-all",
      anyActive: members.some((member) => member.status === "running" || member.status === "queued"),
    },
    avatars: {
      items: members.slice(0, GROUP_DISPATCH_AVATAR_LIMIT).map((member) => ({
        botId: member.botId,
        name: member.name,
        ...(member.avatar ? { avatar: member.avatar } : {}),
        ...(member.driver ? { driver: member.driver } : {}),
      })),
      overflow: Math.max(0, members.length - GROUP_DISPATCH_AVATAR_LIMIT),
    },
  };
}
