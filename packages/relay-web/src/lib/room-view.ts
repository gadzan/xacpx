import type {
  BotAvatarConfig,
  ConversationMessageDto,
  ConversationRoundSummaryDto,
  ConversationRunDto,
  ConversationTimelineDto,
  ConversationTimelineEntryDto,
} from "@ganglion/xacpx-relay-protocol";

/**
 * The room every conversation pane renders (design §4.2, §8).
 *
 * Direct and Group are the same product: one timeline, one composer, one status
 * bar. They differ only in `kind` and `participants` — Direct is the
 * single-participant case. A Room is the read model of a Topic; it is never
 * persisted.
 */
export type RoomKind = "direct" | "group";

/** One member as the timeline needs to draw it. Display metadata only: routing
 *  remains the server's decision, so a missing row renders a neutral name
 *  instead of inventing a member. */
export interface RoomParticipant {
  botId: string;
  name: string;
  role?: string;
  /** Agent driver for the BotAvatar brand glyph. */
  driver?: string;
  avatar?: BotAvatarConfig;
  enabled: boolean;
  retired?: boolean;
  /** The Group's lead member. Direct rooms omit it (there is one participant). */
  lead?: boolean;
}

/** Capabilities that decide which shell renders. Both come from the instance's
 *  advertised capability list; an old daemon advertises neither, so the pane
 *  keeps the legacy transcript and hides the discussion entry. */
export interface RoomCapability {
  /** `conversations.timeline.v1`: `control.conversation.timeline` exists. */
  timelineV1: boolean;
  /** `conversations.roundtable.v1`: a roundtable target is accepted. */
  roundtableV1: boolean;
}

export interface RoomView {
  kind: RoomKind;
  instanceId: string | null;
  conversationId: string | null;
  topicId: string | null;
  participants: RoomParticipant[];
  leadBotId?: string;
  /** The Run that currently owns the Topic, when one does. */
  run?: ConversationRunDto | null;
  capability: RoomCapability;
}

/**
 * A client-owned live overlay for one MemberTurn. Streamed text is never
 * persisted here; the durable message replaces the overlay the moment it lands
 * (design §4.3 invariant 7).
 */
export interface TimelineLiveTurn {
  memberTurnId: string;
  botId?: string;
  text: string;
  status: "working" | "streaming";
  /** Monotonic revision so the scroller re-pins on in-place stream growth. */
  revision?: number;
}

export type TimelineMessageEntry = Extract<ConversationTimelineEntryDto, { kind: "message" }>;
export type TimelineActivityEntry = Extract<ConversationTimelineEntryDto, { kind: "activity" }>;
export type TimelineNoticeEntry = Extract<ConversationTimelineEntryDto, { kind: "notice" }>;

/** One rendered row of the timeline. Message rows are the durable speech, an
 *  activity row is a speaking position (optionally carrying live text), and a
 *  notice is a light one-line status. */
export type TimelineRow =
  | { kind: "message"; key: string; anchorSeq: number; entry: TimelineMessageEntry }
  | { kind: "activity"; key: string; anchorSeq: number; entry: TimelineActivityEntry; live?: TimelineLiveTurn }
  | { kind: "notice"; key: string; anchorSeq: number; entry: TimelineNoticeEntry };

const ENTRY_RANK: Record<ConversationTimelineEntryDto["kind"], number> = {
  message: 0,
  activity: 1,
  notice: 2,
};

/** A settled MemberTurn that ended with nothing public keeps an empty evidence
 *  row so its result can still be resolved. That row is not speech: drawing it
 *  would show an empty bubble and hide the member's own activity row. The read
 *  model keeps the row; the renderer drops it (design §8.1, P1b item 1). */
export function isSuppressedEvidence(message: ConversationMessageDto): boolean {
  return message.role === "bot"
    && message.handoff === undefined
    && message.content.trim() === ""
    && (message.attachments?.length ?? 0) === 0;
}

/** Rows that claim a MemberTurn's speech. An exact/inferred owner proves the
 *  turn said something public; an `unresolved` row proves nothing and must not
 *  silence the activity row. A suppressed evidence row claims nothing. */
function claimedTurnIds(entries: readonly ConversationTimelineEntryDto[]): Set<string> {
  const claimed = new Set<string>();
  for (const entry of entries) {
    if (entry.kind !== "message") continue;
    // A suppressed evidence row is not speech: it must not silence the turn's
    // own activity row.
    if (isSuppressedEvidence(entry.message)) continue;
    if (entry.memberTurnId !== undefined && entry.ownership !== "unresolved") {
      claimed.add(entry.memberTurnId);
    }
  }
  return claimed;
}

/**
 * Build the render rows (design §8.1, §9.1).
 *
 * Input is the durable projection plus the client's live overlay:
 *  - the empty settlement evidence bubble is suppressed;
 *  - an activity row exists only for a turn without durable speech; future
 *    queued roundtable turns are counts, never rows;
 *  - a live overlay attaches to its own activity row and disappears as soon as a
 *    durable message claims that MemberTurn, so the same speech is never drawn
 *    twice;
 *  - notices stay one light line each.
 */
export function buildTimelineRows(input: {
  entries: readonly ConversationTimelineEntryDto[];
  liveOverlay?: readonly TimelineLiveTurn[];
  /** Scope for a synthetic activity row created from an overlay alone. */
  conversationId?: string | null;
  topicId?: string | null;
}): TimelineRow[] {
  const claimed = claimedTurnIds(input.entries);
  const liveByTurn = new Map<string, TimelineLiveTurn>();
  for (const live of input.liveOverlay ?? []) liveByTurn.set(live.memberTurnId, live);

  const rows: TimelineRow[] = [];
  const renderedTurns = new Set<string>();
  let newestAnchor = 0;

  for (const entry of input.entries) {
    newestAnchor = Math.max(newestAnchor, entry.anchorSeq);
    if (entry.kind === "message") {
      if (isSuppressedEvidence(entry.message)) continue;
      rows.push({ kind: "message", key: entry.key, anchorSeq: entry.anchorSeq, entry });
      continue;
    }
    if (entry.kind === "notice") {
      rows.push({ kind: "notice", key: entry.key, anchorSeq: entry.anchorSeq, entry });
      continue;
    }
    // Activity: the durable speech of this turn (if any) already draws it.
    if (claimed.has(entry.memberTurn.id)) continue;
    renderedTurns.add(entry.memberTurn.id);
    const live = liveByTurn.get(entry.memberTurn.id);
    // A queued turn is a speaking position, not a speaker yet; the server never
    // projects one for a roundtable, and any other queued turn is covered by the
    // Run's queued notice.
    if (entry.memberTurn.state === "queued" && !live) continue;
    rows.push({
      kind: "activity",
      key: entry.key,
      anchorSeq: entry.anchorSeq,
      entry,
      ...(live ? { live } : {}),
    });
  }

  // A live overlay for a turn the projection did not surface (e.g. the page was
  // fetched before the turn row was visible) still deserves its speaking row,
  // unless durable speech already claimed the turn.
  for (const live of liveByTurn.values()) {
    if (renderedTurns.has(live.memberTurnId) || claimed.has(live.memberTurnId)) continue;
    rows.push({
      kind: "activity",
      key: `activity:${live.memberTurnId}`,
      anchorSeq: newestAnchor,
      entry: {
        kind: "activity",
        key: `activity:${live.memberTurnId}`,
        anchorSeq: newestAnchor,
        runId: "",
        memberTurn: {
          id: live.memberTurnId,
          runId: "",
          conversationId: input.conversationId ?? "",
          topicId: input.topicId ?? "",
          botId: live.botId ?? "",
          batch: 1,
          attempt: 1,
          origin: "human-explicit",
          state: live.status === "streaming" ? "running" : "dispatched",
          createdAt: "",
        },
        live: true,
      },
      live,
    });
    renderedTurns.add(live.memberTurnId);
  }

  // The server already orders rows; a synthetic overlay row lands at the end.
  return rows;
}

/** Stable row ordering used by both the feed's incremental merge and the
 *  renderer, mirroring the projection's total order. */
export function compareTimelineEntries(
  left: ConversationTimelineEntryDto,
  right: ConversationTimelineEntryDto,
): number {
  return left.anchorSeq - right.anchorSeq
    || ENTRY_RANK[left.kind] - ENTRY_RANK[right.kind]
    || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
}

export function participantFor(room: RoomView | null, botId: string | undefined): RoomParticipant | undefined {
  if (!room || !botId) return undefined;
  return room.participants.find((member) => member.botId === botId);
}

/** True when a Run currently owns the Topic and can still speak. */
export function isRunActive(run: ConversationRunDto | null | undefined): boolean {
  const state = run?.state;
  return state === "queued" || state === "running" || state === "waiting-human" || state === "paused";
}

/** The RoundStrip shows only for a multi-speaker Run: Direct and single-member
 *  fanout never mount it (design §8.2). */
export function showsRoundStrip(round: ConversationRoundSummaryDto | undefined): boolean {
  return round !== undefined && round.speakerCount > 1;
}

/** The current speaking member for the status bar: the round's active turn,
 *  else the first running/dispatched member turn of the active Run. */
export function activeSpeakerTurnId(
  round: ConversationRoundSummaryDto | undefined,
  memberTurns: readonly { id: string; state: string }[],
): string | undefined {
  if (round?.activeMemberTurnId) return round.activeMemberTurnId;
  return memberTurns.find((turn) => turn.state === "running" || turn.state === "dispatched")?.id;
}

/** `hasMoreBefore`/`hasMoreAfter` live on the DTO; this keeps callers from
 *  reaching into a nullable timeline for a boolean. */
export function timelineHasMoreBefore(timeline: ConversationTimelineDto | null): boolean {
  return timeline?.hasMoreBefore === true;
}
