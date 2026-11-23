import type {
  ConversationRunDto,
  MemberTurnSummaryDto,
} from "@ganglion/xacpx-relay-protocol";
import { isRunActive } from "./room-view";

/** The guardrail counters a Run already carries. The drawer never invents a
 *  budget: absent fields stay absent (older wire shapes). */
export interface RunBudgetView {
  consumed?: number;
  max?: number;
  epoch?: number;
  activeBatch?: number;
}

export function runBudgetOf(run: ConversationRunDto): RunBudgetView | undefined {
  const budget: RunBudgetView = {};
  if (run.consumedMemberTurns !== undefined) budget.consumed = run.consumedMemberTurns;
  if (run.maxMemberTurns !== undefined) budget.max = run.maxMemberTurns;
  if (run.budgetEpoch !== undefined) budget.epoch = run.budgetEpoch;
  if (run.activeBatch !== undefined) budget.activeBatch = run.activeBatch;
  return Object.keys(budget).length > 0 ? budget : undefined;
}

/** The translation key for a MemberTurn's origin. Display only: routing stays
 *  the server's decision. */
export function memberOriginKey(origin: MemberTurnSummaryDto["origin"]): string {
  switch (origin) {
    case "human-explicit": return "conversation.runDetail.origin.humanExplicit";
    case "human": return "conversation.runDetail.origin.human";
    case "router": return "conversation.runDetail.origin.router";
    case "handoff": return "conversation.runDetail.origin.handoff";
    case "followup": return "conversation.runDetail.origin.followup";
    case "retry": return "conversation.runDetail.origin.retry";
    case "recovery": return "conversation.runDetail.origin.recovery";
    case "roundtable": return "conversation.runDetail.origin.roundtable";
  }
}

/** Known terminal outcomes get a sentence. An unrecognised code is shown
 *  verbatim: the drawer is evidence, not a friendly-only summary. */
export function runReasonKey(reason: string | undefined): string | undefined {
  switch (reason) {
    case "members-completed": return "conversation.runDetail.reason.membersCompleted";
    case "execution-failed": return "conversation.runDetail.reason.executionFailed";
    case "budget-exhausted": return "conversation.runDetail.reason.budgetExhausted";
    case "human-cancelled": return "conversation.runDetail.reason.humanCancelled";
    case "roundtable-no-speech": return "conversation.runDetail.reason.roundtableNoSpeech";
    case "started_result_unknown": return "conversation.runDetail.reason.startedResultUnknown";
    default: return undefined;
  }
}

/** Durable accept order inside the Run. Roundtable carries memberIndex; older
 *  fanout shapes fall back to batch/attempt and finally insertion time. */
export function compareMemberTurns(
  left: MemberTurnSummaryDto,
  right: MemberTurnSummaryDto,
): number {
  const leftIndex = left.memberIndex ?? left.batch;
  const rightIndex = right.memberIndex ?? right.batch;
  if (leftIndex !== rightIndex) return leftIndex - rightIndex;
  if (left.attempt !== right.attempt) return left.attempt - right.attempt;
  const byTime = left.createdAt.localeCompare(right.createdAt);
  return byTime !== 0 ? byTime : left.id.localeCompare(right.id);
}

/** Whether the drawer may offer a scoped Stop for this member.
 *
 *  Fanout only: a roundtable never exposes a per-member Stop (design §8.4),
 *  and a Direct/single Run has no sibling to protect. The core must advertise
 *  `runs.cancel-member.v1`, the Run must still be the active owner, and the
 *  member must still be claimable or executing. */
export function canStopMemberInDrawer(input: {
  run: ConversationRunDto;
  member: MemberTurnSummaryDto | undefined;
  cancelMemberCapability: boolean;
}): boolean {
  if (!input.cancelMemberCapability) return false;
  const run = input.run;
  if (run.shape !== "fanout") return false;
  if (!isRunActive(run) || run.state === "paused") return false;
  const member = input.member;
  return member !== undefined
    && (member.state === "queued" || member.state === "dispatched" || member.state === "running");
}
