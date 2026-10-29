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
 * - stuck: member turns of the latest Run in failed/indeterminate. A
 *   `cancelled` turn is a user stop, not a stuck item, and is not counted.
 * - needsUser: stuck turns + 1 when the latest Run itself waits for a human
 *   (`waiting-human`). It never counts in-progress work: busy is not stuck.
 * - Member state: running wins over stuck wins over done wins over idle,
 *   per bot, within the latest Run only.
 * - finalAnswers: one reference per completed member turn of the latest Run
 *   that carries a structured final report (P2). The reference is
 *   (runId, assignmentId, botId, verdict, conclusion): the full report text
 *   already travels on the message timelineContent, so this DTO carries no
 *   process text and no second copy of the report.
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
  const inProgressCount = turns.filter((turn) => IN_PROGRESS.has(turn.state)).length;
  const stuckCount = turns.filter((turn) => STUCK.has(turn.state)).length;
  const needsUserCount = stuckCount + (latest?.state === "waiting-human" ? 1 : 0);
  const members: GroupOverviewMember[] = input.memberBotIds.map((botId) => {
    const mine = turns.filter((turn) => turn.botId === botId);
    const latestMine = mine[mine.length - 1];
    let state: GroupOverviewMemberState = "idle";
    if (mine.some((turn) => IN_PROGRESS.has(turn.state))) state = "running";
    else if (mine.some((turn) => STUCK.has(turn.state))) state = "stuck";
    else if (mine.some((turn) => turn.state === "completed")) state = "done";
    return {
      botId,
      state,
      ...(latestMine?.task ? { currentTask: latestMine.task.slice(0, 120) } : {}),
    };
  });
  const finalAnswers: GroupOverviewFinalAnswer[] = turns
    .filter((turn) => turn.state === "completed" && turn.finalReportVerdict && turn.finalReport?.summary)
    .map((turn) => ({
      runId: turn.runId,
      ...(turn.assignmentId ? { assignmentId: turn.assignmentId } : {}),
      botId: turn.botId,
      verdict: turn.finalReportVerdict!,
      conclusion: turn.finalReport!.summary,
    }));
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
