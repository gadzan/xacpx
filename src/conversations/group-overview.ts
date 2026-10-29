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
 * - stuck (fix-round-1): ONLY currently unresolved failed/indeterminate
 *   turns. A failed/indeterminate turn is resolved — history, kept in the
 *   process detail, not a current stuck item — when a completed turn
 *   occurs after it in Run order (batch, memberIndex, id). History
 *   failure alone must never keep "needs you" lit after recovery.
 *   A `cancelled` turn is a user stop, not a stuck item, and is not counted.
 * - needsUser: unresolved stuck turns + 1 when the latest Run itself waits
 *   for a human (`waiting-human`). It never counts in-progress work:
 *   busy is not stuck.
 * - Member state: running wins; otherwise a bot whose latest turn is an
 *   unresolved stuck turn reads stuck, a bot with a later completed turn
 *   reads done, else idle — per bot, within the latest Run only.
 * - finalAnswers (fix-round-1): at most ONE reference — the Run's final
 *   answer, by the same rule as GroupTranscript: the last terminal
 *   followup turn, else the last terminal member turn, included only
 *   when it is completed and carries a structured final report. Earlier
 *   member conclusions are intermediate, not final answers.
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
  finalAnswers: GroupOverviewFinalAnswer[];
}

const IN_PROGRESS = new Set(["queued", "dispatched", "running"]);
const STUCK = new Set(["failed", "indeterminate"]);

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
  const lastCompletedPos = ordered.reduce((max, turn, i) => (turn.state === "completed" ? i : max), -1);
  const isUnresolvedStuck = (turn: MemberTurnRecord, pos: number): boolean =>
    STUCK.has(turn.state) && pos > lastCompletedPos;
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
  // One final answer per Run, by the GroupTranscript rule: last terminal
  // followup, else last terminal turn — included only when completed with
  // a structured final report. A failed final followup is a stop, not an
  // answer, so it yields no finalAnswers entry (and never promotes an
  // earlier, superseded member conclusion into one). Fix-round-1: when
  // the budget ran out before a final summary could be created, there is
  // NO overall conclusion — the last member report must not stand in.
  const terminal = ordered.filter((turn) =>
    ["completed", "failed", "cancelled", "indeterminate"].includes(turn.state));
  let finalTurn: MemberTurnRecord | undefined;
  for (let i = terminal.length - 1; i >= 0; i--) {
    if (terminal[i]!.origin === "followup") { finalTurn = terminal[i]; break; }
  }
  finalTurn ??= terminal[terminal.length - 1];
  const hasFinalSummary = terminal.some((turn) => turn.origin === "followup" && turn.state === "completed");
  const budgetExhaustedNoSummary = Boolean(latest?.followupBudgetExhausted) && !hasFinalSummary;
  const finalAnswers: GroupOverviewFinalAnswer[] = (!budgetExhaustedNoSummary && finalTurn?.state === "completed"
    && finalTurn.finalReportVerdict && finalTurn.finalReport?.summary)
    ? [{
      runId: finalTurn.runId,
      ...(finalTurn.assignmentId ? { assignmentId: finalTurn.assignmentId } : {}),
      botId: finalTurn.botId,
      verdict: finalTurn.finalReportVerdict!,
      conclusion: finalTurn.finalReport!.summary,
    }]
    : [];
  return {
    conversationId: input.conversationId,
    ...(input.topicId ? { topicId: input.topicId } : {}),
    ...(input.leadBotId ? { leadBotId: input.leadBotId } : {}),
    members,
    inProgressCount,
    stuckCount,
    needsUserCount,
    nothingNeedsUser: needsUserCount === 0,
    finalAnswers,
  };
}
