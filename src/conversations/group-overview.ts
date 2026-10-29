import type { ConversationRun, MemberTurnRecord } from "./conversation-types";
import type { FinalReportVerdict } from "./final-report";

/**
 * P5 group overview (product §3.1 total only — NOT a task-board page and NOT
 * an activity page). A pure read-model over durable Run/MemberTurn rows, so
 * relay-web can render the group header from data it already receives
 * (active Run + member turns) without a new RPC route or a second timeline.
 *
 * Counting rules, fixed here so the header cannot drift from the tests:
 * - Scope is ONE topic's latest Run (by created order as given by the
 *   caller, which lists Runs oldest-first). Older Runs do not inflate the
 *   header; their final answers stay reachable through the transcript.
 * - inProgress: member turns of the latest Run in queued/dispatched/running.
 * - stuck (fix-round-5, tightened fix-round-6): ONLY currently
 *   unresolved failed/indeterminate turns. A failed/indeterminate turn is
 *   resolved — history, kept in the process detail, not a current stuck
 *   item — ONLY when (a) a later turn for the SAME normalised task occurs
 *   after it in Run order (batch, memberIndex, id), any bot (same-bot
 *   retry or a different bot re-dispatched the same task), that turn is
 *   completed AND its structured report verdict is "achieved" (a turn
 *   merely ending — completed with "not-achieved", "interrupted", or no
 *   verdict at all — is not a recovery), or (b) the Run has a real final
 *   summary (below), which accounts for the failure as history/leftovers.
 *   A success on a DIFFERENT task, a success by the same bot on a
 *   different task, or a reworded task never clears a failure: an
 *   unrelated success is not a remedy. Deliberate trade-off, stated
 *   plainly: prefer a false stuck over a hidden failure. A failure
 *   turn with no task can never be cleared by (a) — only by (b).
 *   A `cancelled` turn is a user stop, not a stuck item, and is not counted.
 * - needsUser: unresolved stuck turns + 1 when the latest Run itself waits
 *   for a human (`waiting-human`). It never counts in-progress work:
 *   busy is not stuck.
 * - Member state: running wins; otherwise a bot whose latest turn is an
 *   unresolved stuck turn reads stuck, a bot with a later completed turn
 *   reads done, else idle — per bot, within the latest Run only. This
 *   per-bot rule is intentionally NOT the Run-level task rule above.
 * - Real final summary (fix-round-5, tightened fix-round-6, shared by
 *   GroupTranscript and GroupPane — do not let the three drift): a
 *   completed `followup` turn that is the LAST terminal turn in Run
 *   order, with no queued/dispatched/running turn anywhere in the Run,
 *   a terminal Run state (completed/failed/cancelled/indeterminate —
 *   never queued/running/waiting-human), AND a valid structured final
 *   report (finalReportVerdict present AND finalReport.summary present).
 *   A followup turn that merely ended without producing the report is
 *   not a summary: it must not close `noOverallConclusion`, must not
 *   clear failures under (b), and must not suppress the budget warning.
 *   Only a real final summary may be a final answer. A running Run, a
 *   waiting-human Run, or a terminal Run with no such summary has NO
 *   overall conclusion: member conclusions stay intermediate, and
 *   `noOverallConclusion` is true when the Run is terminal, has no real
 *   final summary, and has at least one completed member turn.
 * - finalAnswers: at most ONE reference — the real final summary turn,
 *   included only when it carries a structured final report (verdict +
 *   summary). A failed final followup is a stop, not an answer.
 * - nothingNeedsUser: needsUserCount === 0 AND NOT noOverallConclusion.
 *   A terminal Run without an overall conclusion is not "nothing needs
 *   you", even when nothing is currently stuck.
 * - When there is no Run at all, every count is 0 and needsUser is false:
 *   the header then reads as "nothing needs you", per product §3.1/§7E.
 */
export type GroupOverviewMemberState = "idle" | "running" | "stuck" | "done";

export interface GroupOverviewMember {
  botId: string;
  state: GroupOverviewMemberState;
  /** One-line current task of the member's latest turn in scope, if any. */
  currentTask?: string;
}

export interface GroupOverviewFinalAnswer {
  runId: string;
  assignmentId?: string;
  botId: string;
  verdict: FinalReportVerdict;
  /** The report's standalone conclusion sentence (P2 finalReport.summary). */
  conclusion: string;
}

export interface GroupOverview {
  conversationId: string;
  topicId?: string;
  leadBotId?: string;
  members: GroupOverviewMember[];
  inProgressCount: number;
  stuckCount: number;
  needsUserCount: number;
  /** True when nothing in scope needs the user: render the "nothing needs you" line. */
  nothingNeedsUser: boolean;
  /**
   * True when the latest Run is terminal, has no real final summary, and
   * has at least one completed member turn: the Run ended without an
   * overall conclusion, and the header must say so instead of showing
   * "nothing needs you" or promoting a member report.
   */
  noOverallConclusion: boolean;
  finalAnswers: GroupOverviewFinalAnswer[];
}

const IN_PROGRESS = new Set(["queued", "dispatched", "running"]);
const STUCK = new Set(["failed", "indeterminate"]);
const TERMINAL_RUN_STATES = new Set(["completed", "failed", "cancelled", "indeterminate"]);
const TERMINAL_TURN_STATES = new Set(["completed", "failed", "cancelled", "indeterminate"]);

/** Task identity for recovery: trim, collapse runs of whitespace to one space. Empty means no task. */
export function normalizeGroupTask(task: string | undefined): string | undefined {
  const normalized = task?.trim().replace(/\s+/g, " ");
  return normalized ? normalized : undefined;
}

/**
 * The Run's real final summary, or undefined. Shared definition with
 * GroupTranscript.vue and GroupPane.vue: a completed followup turn that is
 * the last terminal turn in Run order, with no in-progress turn anywhere,
 * a terminal Run state, AND a valid structured final report (verdict +
 * summary). Fix-round-6: a model may end a followup turn without emitting
 * the report — that turn is not a summary, and treating it as one would
 * hide "no overall conclusion", clear failures, and suppress the budget
 * warning while the user sees "nothing needs you". Anything less is a
 * stage conclusion, never the Run's overall conclusion.
 */
export function realFinalSummaryTurn(
  ordered: readonly MemberTurnRecord[],
  runState: string | undefined,
): MemberTurnRecord | undefined {
  if (!runState || !TERMINAL_RUN_STATES.has(runState)) return undefined;
  if (ordered.some((turn) => IN_PROGRESS.has(turn.state))) return undefined;
  const terminal = ordered.filter((turn) => TERMINAL_TURN_STATES.has(turn.state));
  const last = terminal[terminal.length - 1];
  return last && last.origin === "followup" && last.state === "completed"
    && last.finalReportVerdict !== undefined && last.finalReport?.summary !== undefined
    ? last : undefined;
}

export function buildGroupOverview(input: {
  conversationId: string;
  topicId?: string;
  leadBotId?: string;
  memberBotIds: readonly string[];
  /** Runs of this topic, oldest first; only the last one is in scope. */
  runs: readonly ConversationRun[];
  /** Member turns of the runs above (any Run; filtered to the latest). */
  memberTurns: readonly MemberTurnRecord[];
}): GroupOverview {
  const latest = input.runs[input.runs.length - 1];
  const turns = latest ? input.memberTurns.filter((turn) => turn.runId === latest.id) : [];
  // Run order: the same ordering GroupTranscript uses for final answers.
  const ordered = [...turns].sort((a, b) => a.batch - b.batch
    || (a.memberIndex ?? 0) - (b.memberIndex ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const inProgressCount = turns.filter((turn) => IN_PROGRESS.has(turn.state)).length;
  const realSummary = realFinalSummaryTurn(ordered, latest?.state);
  // Fix-round-5: recovery is task-bound, not order-bound. Only a later
  // completed turn for the SAME normalised task, or a real final summary
  // that accounts for the failure, resolves a stuck turn.
  // Fix-round-6: "completed" alone is not recovery. A turn ending and a
  // goal being achieved are different facts in this codebase (state vs
  // finalReportVerdict): only a later same-task turn that completed AND
  // reports "achieved" clears the failure. A same-task turn that ended
  // with "not-achieved", "interrupted", or no verdict leaves the failure
  // showing as awaiting confirmation, never silently resolved.
  const isUnresolvedStuck = (turn: MemberTurnRecord, pos: number): boolean => {
    if (!STUCK.has(turn.state)) return false;
    if (realSummary !== undefined) return false;
    const task = normalizeGroupTask(turn.task);
    if (task === undefined) return true;
    return !ordered.slice(pos + 1).some((later) =>
      later.state === "completed" && later.finalReportVerdict === "achieved"
      && normalizeGroupTask(later.task) === task);
  };
  const stuckCount = ordered.filter((turn, i) => isUnresolvedStuck(turn, i)).length;
  const needsUserCount = stuckCount + (latest?.state === "waiting-human" ? 1 : 0);
  const members: GroupOverviewMember[] = input.memberBotIds.map((botId) => {
    const mine = ordered.filter((turn) => turn.botId === botId);
    const latestMine = mine[mine.length - 1];
    let state: GroupOverviewMemberState = "idle";
    if (mine.some((turn) => IN_PROGRESS.has(turn.state))) state = "running";
    else if (mine.length > 0) {
      // Per-bot recovery: a bot's own later completed turn clears its
      // own stuck state, regardless of other bots' turns.
      const botLastCompleted = mine.reduce((max, turn, i) => (turn.state === "completed" ? i : max), -1);
      const botStuckUnresolved = mine.some((turn, i) => STUCK.has(turn.state) && i > botLastCompleted);
      state = botStuckUnresolved ? "stuck" : (mine.some((turn) => turn.state === "completed") ? "done" : "idle");
    }
    return {
      botId,
      state,
      ...(latestMine?.task ? { currentTask: latestMine.task.slice(0, 120) } : {}),
    };
  });
  // One final answer per Run, and only the real final summary qualifies:
  // a completed followup that is the last terminal turn of a terminal Run
  // with nothing still in progress. A running Run, a waiting-human Run,
  // or a terminal Run with no such summary yields no finalAnswers entry
  // — never promote a member report into the overall conclusion.
  // Fix-round-5: the budget check uses the same real-summary definition,
  // not "any completed followup ever existed": a stage followup that
  // dispatched a re-review, followed by budget exhaustion before the next
  // summary, must leave the budget warning visible and finalAnswers empty.
  const finalTurn: MemberTurnRecord | undefined = realSummary;
  const finalAnswers: GroupOverviewFinalAnswer[] = (finalTurn?.finalReportVerdict && finalTurn.finalReport?.summary)
    ? [{
      runId: finalTurn.runId,
      ...(finalTurn.assignmentId ? { assignmentId: finalTurn.assignmentId } : {}),
      botId: finalTurn.botId,
      verdict: finalTurn.finalReportVerdict!,
      conclusion: finalTurn.finalReport!.summary,
    }]
    : [];
  const noOverallConclusion = Boolean(latest) && TERMINAL_RUN_STATES.has(latest!.state)
    && finalTurn === undefined && ordered.some((turn) => turn.state === "completed");
  return {
    conversationId: input.conversationId,
    ...(input.topicId ? { topicId: input.topicId } : {}),
    ...(input.leadBotId ? { leadBotId: input.leadBotId } : {}),
    members,
    inProgressCount,
    stuckCount,
    needsUserCount,
    nothingNeedsUser: needsUserCount === 0 && !noOverallConclusion,
    noOverallConclusion,
    finalAnswers,
  };
}
