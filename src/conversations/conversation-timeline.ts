import type { ConversationMessage, ConversationRun, MemberTurnRecord } from "./conversation-types";
import { TERMINAL_MEMBER_STATES, TERMINAL_RUN_STATES } from "./conversation-types";

/**
 * The single Conversation read model (design §9).
 *
 * This module is a PURE projection: it is handed the rows a page already
 * loaded and returns the timeline. It holds no `SqlDriver`, performs no query
 * and writes nothing, so Direct and Group can only ever see one interpretation
 * of the same durable facts — no client-side owner guessing, no second
 * transcript.
 */

/** How a message was joined onto the MemberTurn that produced it. */
export type ConversationTimelineOwnership = "exact" | "inferred" | "unresolved";

export type ConversationTimelineNoticeTone = "queued" | "empty" | "failed";

export type ConversationRoundState = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface ConversationTimelineMessageEntry {
  kind: "message";
  key: string;
  anchorSeq: number;
  message: ConversationMessage;
  memberTurnId?: string;
  runId?: string;
  ownership?: ConversationTimelineOwnership;
}

export interface ConversationTimelineActivityEntry {
  kind: "activity";
  key: string;
  anchorSeq: number;
  runId: string;
  memberTurn: MemberTurnRecord;
  /** The client holds an unpersisted overlay for this turn. The server never
   *  copies live text into the projection. */
  live?: boolean;
}

export interface ConversationTimelineNoticeEntry {
  kind: "notice";
  key: string;
  anchorSeq: number;
  tone: ConversationTimelineNoticeTone;
  runId?: string;
  text: string;
}

export type ConversationTimelineEntry =
  | ConversationTimelineMessageEntry
  | ConversationTimelineActivityEntry
  | ConversationTimelineNoticeEntry;

/** RoundStrip summary for one `(runId, roundIndex)` projection. */
export interface ConversationRoundSummary {
  runId: string;
  roundIndex: number;
  rounds: number;
  speakerCount: number;
  spoken: number;
  passed: number;
  activeMemberTurnId?: string;
  state: ConversationRoundState;
}

export interface ConversationTimeline {
  conversationId: string;
  topicId: string;
  entries: ConversationTimelineEntry[];
  activeRound?: ConversationRoundSummary;
  oldestSeq?: number;
  newestSeq?: number;
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
}

/** Client-owned live overlay, keyed by member turn id. The projection only
 *  records that an overlay exists; streamed text is never persisted here. */
export type ConversationLiveTurnsByMember = Readonly<
  Record<string, { text?: string; streaming?: boolean } | undefined>
>;

export interface ProjectConversationTimelineInput {
  conversationId: string;
  topicId: string;
  /** The current page, ascending by `seq`. */
  messages: readonly ConversationMessage[];
  /** Every Run a page message names PLUS every non-terminal Run of the Topic. */
  runs: readonly ConversationRun[];
  /** Every MemberTurn of those Runs, batched by the caller. */
  memberTurns: readonly MemberTurnRecord[];
  liveTurnsByMember?: ConversationLiveTurnsByMember;
  /** `id` → `seq` for request/trigger messages outside the page, so an
   *  activity anchor is the real sequence rather than a guess. */
  messageSeqById?: Readonly<Record<string, number>>;
  /** Page-boundary facts owned by the store query, passed through unchanged. */
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
}

const ENTRY_RANK: Record<ConversationTimelineEntry["kind"], number> = {
  message: 0,
  activity: 1,
  notice: 2,
};

/** Member states that are worth an activity row when the turn wrote no public
 *  message: someone is speaking, or a turn ended without speech. A queued turn
 *  is added separately because future roundtable speakers are counts only. */
const SILENT_ACTIVITY_STATE: Record<MemberTurnRecord["state"], boolean> = {
  queued: false,
  dispatched: true,
  running: true,
  completed: false,
  failed: true,
  cancelled: true,
  indeterminate: false,
};

function compareTurns(left: MemberTurnRecord, right: MemberTurnRecord): number {
  return left.batch - right.batch
    || left.memberIndex - right.memberIndex
    || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

/**
 * Project one page of durable rows into the single timeline (design §9.1).
 *
 * Rules, in order:
 *  1. every message appears exactly once, ordered by `seq`;
 *  2. a bot/handoff message is owned by `member_turn_id` when present, else a
 *     unique exact legacy join, else the only same-Run/same-Bot candidate;
 *  3. `activity` exists only for a MemberTurn with no public message;
 *  4. future queued roundtable turns are never individual entries — the
 *     RoundStrip counts them;
 *  5. `notice` is synthesized for queued / all-pass / failed Runs;
 *  6. a non-terminal Run is always carried, even when its request message is
 *     outside the page;
 *  7. an anchor is the message's own `seq`, or the newest trigger/request
 *     `seq` for activity and notices;
 *  8. unresolved ownership is retained and labelled, never dropped.
 */
export function projectConversationTimeline(
  input: ProjectConversationTimelineInput,
): ConversationTimeline {
  const runs = new Map(input.runs.map((run) => [run.id, run]));
  const turnsByRun = new Map<string, MemberTurnRecord[]>();
  for (const turn of input.memberTurns) {
    // A turn of a Run outside the page can never anchor an entry here.
    if (!runs.has(turn.runId)) continue;
    const list = turnsByRun.get(turn.runId);
    if (list) list.push(turn);
    else turnsByRun.set(turn.runId, [turn]);
  }
  for (const list of turnsByRun.values()) list.sort(compareTurns);

  const seqOf = (messageId: string | undefined): number | undefined => {
    if (messageId === undefined) return undefined;
    return input.messageSeqById?.[messageId];
  };

  const entries: ConversationTimelineEntry[] = [];
  const claimed = new Set<string>();
  /** Newest public message seq each MemberTurn owns, so a later speaker's
   *  activity can never sort before an earlier speaker's speech. */
  const publicSeqByTurn = new Map<string, number>();
  const seenMessageIds = new Set<string>();
  const seenSeqs = new Set<number>();
  let oldestSeq: number | undefined;
  let newestSeq: number | undefined;

  for (const message of input.messages) {
    // Rule 1: one entry per seq, even if the caller hands us a duplicate row.
    if (seenMessageIds.has(message.id) || seenSeqs.has(message.seq)) continue;
    seenMessageIds.add(message.id);
    seenSeqs.add(message.seq);
    oldestSeq = oldestSeq === undefined ? message.seq : Math.min(oldestSeq, message.seq);
    newestSeq = newestSeq === undefined ? message.seq : Math.max(newestSeq, message.seq);

    const runTurns = message.runId === undefined ? [] : (turnsByRun.get(message.runId) ?? []);
    let memberTurnId: string | undefined;
    let ownership: ConversationTimelineOwnership | undefined;

    // 2a: the durable column.
    if (message.memberTurnId !== undefined) {
      memberTurnId = message.memberTurnId;
      ownership = "exact";
    }
    // 2b: a handoff envelope names its sender independently of sourceTurn.
    if (ownership === undefined) {
      const sender = message.handoff?.senderMemberTurnId;
      if (sender !== undefined && runTurns.some((turn) => turn.id === sender)) {
        memberTurnId = sender;
        ownership = "exact";
      }
    }
    // 2c: the legacy exact join — the SAME source turn id must match exactly
    // one MemberTurn of this Run.
    if (ownership === undefined && message.sourceTurn?.turnId !== undefined) {
      const matches = runTurns.filter((turn) => turn.sourceTurnId === message.sourceTurn?.turnId);
      if (matches.length === 1) {
        memberTurnId = matches[0]!.id;
        ownership = "exact";
      }
    }
    // 2d: the only unclaimed candidate of the same Bot in the same Run. Two
    // candidates are ambiguous, never a guess.
    if (ownership === undefined && message.role !== "human" && message.senderBotId !== undefined) {
      const candidates = runTurns.filter(
        (turn) => turn.botId === message.senderBotId && !claimed.has(turn.id),
      );
      if (candidates.length === 1) {
        memberTurnId = candidates[0]!.id;
        ownership = "inferred";
      } else if (candidates.length > 1) {
        ownership = "unresolved";
      }
    }
    // A human request has no physical execution behind it.
    if (ownership === undefined && (message.role === "human" || message.runId === undefined)) {
      ownership = undefined;
    } else if (ownership === undefined) {
      ownership = "unresolved";
    }
    // An exact/inferred owner makes this turn's speech public; an unresolved
    // row proves nothing and must not silence the activity row.
    if (memberTurnId !== undefined && ownership !== "unresolved") {
      claimed.add(memberTurnId);
      const prior = publicSeqByTurn.get(memberTurnId);
      if (prior === undefined || message.seq > prior) publicSeqByTurn.set(memberTurnId, message.seq);
    }

    entries.push({
      kind: "message",
      key: `message:${message.id}`,
      anchorSeq: message.seq,
      message,
      ...(memberTurnId !== undefined ? { memberTurnId } : {}),
      ...(message.runId !== undefined ? { runId: message.runId } : {}),
      ...(ownership !== undefined ? { ownership } : {}),
    });
  }

  for (const run of input.runs) {
    const runTurns = turnsByRun.get(run.id) ?? [];
    const requestAnchor = seqOf(run.requestMessageId) ?? 0;

    for (const turn of runTurns) {
      if (claimed.has(turn.id)) continue;
      // Rule 4: a queued roundtable speaker is a RoundStrip count, not a row.
      if (run.shape === "roundtable" && turn.state === "queued") continue;
      // `queued` non-roundtable turns are waiting; silent terminal turns are
      // the ones that ended without saying anything public.
      if (!SILENT_ACTIVITY_STATE[turn.state] && turn.state !== "queued") continue;
      // Rule 7: anchor at the newest durable position this turn follows — its
      // own trigger messages (every roundtable turn is triggered by the human
      // request, so triggers alone would sort a later speaker BEFORE the
      // earlier speaker's reply) AND any public message an earlier
      // `memberIndex` turn already wrote. With neither, fall back to the
      // request seq.
      const earlierSeqs = runTurns
        .filter((earlier) => earlier.memberIndex < turn.memberIndex)
        .map((earlier) => publicSeqByTurn.get(earlier.id))
        .filter((seq): seq is number => seq !== undefined);
      const triggerSeqs = turn.triggerMessageIds
        .map((id) => seqOf(id))
        .filter((seq): seq is number => seq !== undefined);
      const anchorCandidates = [...triggerSeqs, ...earlierSeqs];
      const anchorSeq = anchorCandidates.length > 0
        ? Math.max(...anchorCandidates)
        : requestAnchor;
      entries.push({
        kind: "activity",
        key: `activity:${turn.id}`,
        anchorSeq,
        runId: run.id,
        memberTurn: turn,
        ...(input.liveTurnsByMember?.[turn.id] !== undefined ? { live: true } : {}),
      });
    }

    // Rule 5: Run-level notices are synthesized, never persisted.
    if (run.state === "queued") {
      entries.push({
        kind: "notice",
        key: `notice:${run.id}:queued`,
        anchorSeq: requestAnchor,
        tone: "queued",
        runId: run.id,
        text: "Queued",
      });
    } else if (run.state === "completed" && run.shape === "roundtable"
      && run.completionReason === "roundtable-no-speech") {
      entries.push({
        kind: "notice",
        key: `notice:${run.id}:empty`,
        anchorSeq: requestAnchor,
        tone: "empty",
        runId: run.id,
        text: "No member added to this discussion.",
      });
    } else if (run.state === "failed" || run.state === "indeterminate") {
      entries.push({
        kind: "notice",
        key: `notice:${run.id}:failed`,
        anchorSeq: requestAnchor,
        tone: "failed",
        runId: run.id,
        text: run.state === "indeterminate"
          ? `Run outcome unknown: ${run.completionReason ?? "sealed"}`
          : `Run failed: ${run.completionReason ?? "unknown"}`,
      });
    }
  }

  // Total, input-order-independent ordering: two identical calls must produce
  // byte-identical output.
  entries.sort((left, right) => left.anchorSeq - right.anchorSeq
    || ENTRY_RANK[left.kind] - ENTRY_RANK[right.kind]
    || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));

  const activeRound = projectActiveRound(runs, turnsByRun);
  return {
    conversationId: input.conversationId,
    topicId: input.topicId,
    entries,
    ...(activeRound ? { activeRound } : {}),
    ...(oldestSeq !== undefined ? { oldestSeq } : {}),
    ...(newestSeq !== undefined ? { newestSeq } : {}),
    hasMoreBefore: input.hasMoreBefore,
    hasMoreAfter: input.hasMoreAfter,
  };
}

/**
 * The RoundStrip summary: the newest non-terminal roundtable Run's current
 * round. Absent for Direct and single-speaker work, which never show a strip.
 */
function projectActiveRound(
  runs: ReadonlyMap<string, ConversationRun>,
  turnsByRun: ReadonlyMap<string, readonly MemberTurnRecord[]>,
): ConversationRoundSummary | undefined {
  const live = [...runs.values()]
    .filter((run) => run.shape === "roundtable" && !TERMINAL_RUN_STATES.includes(run.state))
    .sort((left, right) => (left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : 0)
      || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const run = live[live.length - 1];
  if (!run) return undefined;

  const turns = turnsByRun.get(run.id) ?? [];
  const roundIndexes = turns
    .map((turn) => turn.roundIndex)
    .filter((index): index is number => index !== undefined);
  const current = turns.find(
    (turn) => turn.roundIndex !== undefined && !TERMINAL_MEMBER_STATES.includes(turn.state),
  )?.roundIndex;
  const roundIndex = current ?? (roundIndexes.length > 0 ? Math.max(...roundIndexes) : 1);
  const roundTurns = turns.filter((turn) => turn.roundIndex === roundIndex);

  const active = roundTurns.find((turn) => turn.state === "running" || turn.state === "dispatched");
  const anyFailed = roundTurns.some((turn) => turn.state === "failed")
    || (run.state === "failed" && roundTurns.length === 0);
  const anyCancelled = roundTurns.some((turn) => turn.state === "cancelled")
    || run.state === "cancelled";
  const state: ConversationRoundState = anyFailed
    ? "failed"
    : anyCancelled
      ? "cancelled"
      : active
        ? "running"
        : roundTurns.length > 0 && roundTurns.every((turn) => TERMINAL_MEMBER_STATES.includes(turn.state))
          ? "completed"
          : "queued";

  return {
    runId: run.id,
    roundIndex,
    rounds: run.rounds ?? 1,
    speakerCount: roundTurns.length,
    spoken: roundTurns.filter(
      (turn) => turn.state === "completed" && turn.speechOutcome !== "pass",
    ).length,
    passed: roundTurns.filter((turn) => turn.speechOutcome === "pass").length,
    ...(active ? { activeMemberTurnId: active.id } : {}),
    state,
  };
}
