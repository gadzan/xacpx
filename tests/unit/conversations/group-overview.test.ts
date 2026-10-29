import { expect, test } from "bun:test";
import { buildGroupOverview } from "../../../src/conversations/group-overview";
import type { ConversationRun, MemberTurnRecord } from "../../../src/conversations/conversation-types";

function run(id: string, state: ConversationRun["state"]): ConversationRun {
  return { id, conversationId: "conversation_group", topicId: "topic_group", requestMessageId: "msg_req",
    state, mode: "explicit", createdAt: "2026-10-05T00:00:00.000Z" } as unknown as ConversationRun;
}

function turn(runId: string, botId: string, state: MemberTurnRecord["state"], task?: string,
  verdict?: MemberTurnRecord["finalReportVerdict"], summary?: string, assignmentId?: string,
  batch = 1, memberIndex = 0, id = `turn-${botId}-${memberIndex}`, origin?: MemberTurnRecord["origin"]) {
  return { id, batch, memberIndex, origin, runId, botId, state, task, finalReportVerdict: verdict,
    ...(summary ? { finalReport: { summary } } : {}), assignmentId } as unknown as MemberTurnRecord;
}

test("P5 overview: latest Run only, running beats stuck beats done, stuck counts but busy does not", () => {
  const oldRun = run("run_old", "completed");
  const latest = run("run_new", "running");
  const overview = buildGroupOverview({ conversationId: "conversation_group", topicId: "topic_group",
    leadBotId: "bot_a", memberBotIds: ["bot_a", "bot_b", "bot_c"],
    runs: [oldRun, latest],
    memberTurns: [
      turn("run_old", "bot_b", "failed", "old stuck work"),
      turn("run_new", "bot_a", "running", "leading the work", undefined, undefined, undefined, 1, 0, "t-a"),
      // Fix1-7: the failed turn is LAST in Run order, so it is unresolved.
      turn("run_new", "bot_b", "completed", "earlier step done", "achieved", "过滤已完成。", "handoff_1", 1, 1, "t-b1"),
      turn("run_new", "bot_c", "completed", "done step", "achieved", "影响面已确认。", "handoff_2", 1, 2, "t-c"),
      turn("run_new", "bot_b", "failed", "review crashed", undefined, undefined, undefined, 1, 3, "t-b2"),
    ] });
  expect(overview.leadBotId).toBe("bot_a");
  expect(overview.inProgressCount).toBe(1);
  expect(overview.stuckCount).toBe(1);
  expect(overview.needsUserCount).toBe(1);
  expect(overview.nothingNeedsUser).toBe(false);
  expect(overview.members.map((m) => `${m.botId}:${m.state}`)).toEqual(
    ["bot_a:running", "bot_b:stuck", "bot_c:done"]);
  // Fix1-2: only the Run's final answer, and the last terminal turn here
  // is a failed turn — a stop, not an answer — so no final answer is listed.
  expect(overview.finalAnswers).toEqual([]);
});

test("Fix1-2 overview: only the Run's final answer is listed, not every member conclusion", () => {
  const overview = buildGroupOverview({ conversationId: "conversation_group", memberBotIds: ["bot_a", "bot_b"],
    runs: [run("run_f", "completed")],
    memberTurns: [
      turn("run_f", "bot_a", "completed", "first step", "achieved", "第一步完成。", "handoff_1", 1, 0, "t-1"),
      turn("run_f", "bot_b", "completed", "final summary", "achieved", "全部完成。", "handoff_2", 1, 1, "t-2", "followup"),
    ] });
  expect(overview.finalAnswers).toEqual([
    { runId: "run_f", assignmentId: "handoff_2", botId: "bot_b", verdict: "achieved", conclusion: "全部完成。" },
  ]);
});

test("Fix5 overview: a failure followed by a completed turn on a DIFFERENT task still counts as needs-you", () => {
  // Fix-round-5 replaces Fix1-7: an unrelated success is not a remedy.
  // A login failure is not cleared by a styling success that merely
  // sorts after it, even though the Run itself is completed.
  const overview = buildGroupOverview({ conversationId: "conversation_group", memberBotIds: ["bot_a", "bot_b"],
    runs: [run("run_r", "completed")],
    memberTurns: [
      turn("run_r", "bot_a", "failed", "implement login", undefined, undefined, undefined, 1, 0, "t-fail"),
      turn("run_r", "bot_b", "completed", "restyle page", "achieved", "已恢复完成。", "handoff_r", 1, 1, "t-ok"),
    ] });
  expect(overview.stuckCount).toBe(1);
  expect(overview.needsUserCount).toBe(1);
  expect(overview.nothingNeedsUser).toBe(false);
  expect(overview.noOverallConclusion).toBe(true);
  expect(overview.finalAnswers).toEqual([]);
  expect(overview.members.map((m) => `${m.botId}:${m.state}`)).toEqual(["bot_a:stuck", "bot_b:done"]);
});

test("Fix5 overview: the same task completed later — by another bot — clears the failure", () => {
  const overview = buildGroupOverview({ conversationId: "conversation_group", memberBotIds: ["bot_a", "bot_b"],
    runs: [run("run_s", "running")],
    memberTurns: [
      turn("run_s", "bot_a", "failed", "implement login", undefined, undefined, undefined, 1, 0, "t-fail"),
      turn("run_s", "bot_b", "completed", "implement login", "achieved", "登录已完成。", "handoff_s", 1, 1, "t-ok"),
    ] });
  expect(overview.stuckCount).toBe(0);
  expect(overview.needsUserCount).toBe(0);
  expect(overview.nothingNeedsUser).toBe(true);
  expect(overview.noOverallConclusion).toBe(false);
});

test("Fix5 overview: whitespace-only task differences still count as the same task; rewording does not", () => {
  const recovered = buildGroupOverview({ conversationId: "conversation_group", memberBotIds: ["bot_a", "bot_b"],
    runs: [run("run_w", "running")],
    memberTurns: [
      turn("run_w", "bot_a", "failed", "implement   login", undefined, undefined, undefined, 1, 0, "t-fail"),
      turn("run_w", "bot_b", "completed", " implement login ", "achieved", "登录已完成。", "handoff_w", 1, 1, "t-ok"),
    ] });
  expect(recovered.stuckCount).toBe(0);
  const reworded = buildGroupOverview({ conversationId: "conversation_group", memberBotIds: ["bot_a", "bot_b"],
    runs: [run("run_w2", "running")],
    memberTurns: [
      turn("run_w2", "bot_a", "failed", "implement login", undefined, undefined, undefined, 1, 0, "t-fail"),
      turn("run_w2", "bot_b", "completed", "implement login page", "achieved", "登录页已完成。", "handoff_w2", 1, 1, "t-ok"),
    ] });
  expect(reworded.stuckCount).toBe(1);
  expect(reworded.needsUserCount).toBe(1);
});

test("Fix5 overview: a taskless failure is never cleared by a later completed turn", () => {
  const overview = buildGroupOverview({ conversationId: "conversation_group", memberBotIds: ["bot_a", "bot_b"],
    runs: [run("run_n", "running")],
    memberTurns: [
      turn("run_n", "bot_a", "failed", undefined, undefined, undefined, undefined, 1, 0, "t-fail"),
      turn("run_n", "bot_b", "completed", "anything at all", "achieved", "已完成。", "handoff_n", 1, 1, "t-ok"),
    ] });
  expect(overview.stuckCount).toBe(1);
});

test("Fix5 overview: a real final summary closes earlier failures and is the only final answer", () => {
  const overview = buildGroupOverview({ conversationId: "conversation_group", memberBotIds: ["bot_a", "bot_b"],
    runs: [run("run_sum", "completed")],
    memberTurns: [
      turn("run_sum", "bot_a", "failed", "implement login", undefined, undefined, undefined, 1, 0, "t-fail"),
      turn("run_sum", "bot_b", "completed", "final summary", "achieved", "全部完成，失败已在剩余项交代。", "handoff_sum", 1, 1, "t-sum", "followup"),
    ] });
  expect(overview.stuckCount).toBe(0);
  expect(overview.needsUserCount).toBe(0);
  expect(overview.noOverallConclusion).toBe(false);
  expect(overview.nothingNeedsUser).toBe(true);
  expect(overview.finalAnswers).toEqual([
    { runId: "run_sum", assignmentId: "handoff_sum", botId: "bot_b", verdict: "achieved", conclusion: "全部完成，失败已在剩余项交代。" },
  ]);
});

test("Fix5 overview: a running Run whose last terminal turn failed has no final answer", () => {
  const overview = buildGroupOverview({ conversationId: "conversation_group", memberBotIds: ["bot_a", "bot_b"],
    runs: [run("run_run", "running")],
    memberTurns: [
      turn("run_run", "bot_a", "completed", "dev done", "achieved", "开发完成。", "handoff_d", 1, 0, "t-d"),
      turn("run_run", "bot_b", "failed", "review crashed", undefined, undefined, undefined, 1, 1, "t-f"),
    ] });
  expect(overview.finalAnswers).toEqual([]);
  expect(overview.stuckCount).toBe(1);
  expect(overview.noOverallConclusion).toBe(false);
});

test("Fix5 overview: budget exhaustion after a stage followup leaves no final answer and no overall conclusion", () => {
  // Stage followup completed, then a re-review fix completed, but the
  // budget ran out before the next summary could be created. The old
  // "any completed followup" check would have hidden the budget warning
  // and promoted the stage conclusion; the real-summary check does not.
  const exhausted = run("run_b", "completed") as ConversationRun & { followupBudgetExhausted?: boolean };
  exhausted.followupBudgetExhausted = true;
  const overview = buildGroupOverview({ conversationId: "conversation_group", memberBotIds: ["bot_a", "bot_b"],
    runs: [exhausted],
    memberTurns: [
      turn("run_b", "bot_a", "completed", "dev done", "achieved", "开发完成。", "handoff_d", 1, 0, "t-d"),
      turn("run_b", "bot_b", "completed", "stage summary", "achieved", "阶段汇总。", "handoff_s", 2, 0, "t-s", "followup"),
      turn("run_b", "bot_a", "completed", "re-review fix", "achieved", "修复完成。", "handoff_f", 3, 0, "t-f"),
    ] });
  expect(overview.finalAnswers).toEqual([]);
  expect(overview.noOverallConclusion).toBe(true);
  expect(overview.nothingNeedsUser).toBe(false);
});

test("Fix5 overview: a terminal Run with completed members but no summary reports no overall conclusion", () => {
  const overview = buildGroupOverview({ conversationId: "conversation_group", memberBotIds: ["bot_a", "bot_b"],
    runs: [run("run_nosum", "completed")],
    memberTurns: [
      turn("run_nosum", "bot_a", "completed", "dev done", "achieved", "开发完成。", "handoff_d", 1, 0, "t-d"),
      turn("run_nosum", "bot_b", "completed", "other work", "achieved", "其他完成。", "handoff_o", 1, 1, "t-o"),
    ] });
  expect(overview.finalAnswers).toEqual([]);
  expect(overview.noOverallConclusion).toBe(true);
  expect(overview.nothingNeedsUser).toBe(false);
});

test("Fix1-4 overview: a budget-exhausted Run with no final summary lists no final answer", () => {
  const exhausted = run("run_e", "completed") as ConversationRun & { followupBudgetExhausted?: boolean };
  exhausted.followupBudgetExhausted = true;
  const overview = buildGroupOverview({ conversationId: "conversation_group", memberBotIds: ["bot_a"],
    runs: [exhausted],
    memberTurns: [
      turn("run_e", "bot_a", "completed", "member work", "achieved", "成员结论。", "handoff_e", 1, 0, "t-e"),
    ] });
  expect(overview.finalAnswers).toEqual([]);
});

test("Fix1-7 overview: a failure with no later completed turn still counts as needs-you", () => {
  const overview = buildGroupOverview({ conversationId: "conversation_group", memberBotIds: ["bot_a"],
    runs: [run("run_u", "running")],
    memberTurns: [
      turn("run_u", "bot_a", "failed", "build crashed", undefined, undefined, undefined, 1, 0, "t-fail"),
    ] });
  expect(overview.stuckCount).toBe(1);
  expect(overview.needsUserCount).toBe(1);
  expect(overview.nothingNeedsUser).toBe(false);
});

test("P5 overview: waiting-human adds one needs-user item; no Run means nothing needs you", () => {
  const waiting = buildGroupOverview({ conversationId: "conversation_group", memberBotIds: ["bot_a"],
    runs: [run("run_w", "waiting-human")], memberTurns: [] });
  expect(waiting.needsUserCount).toBe(1);
  expect(waiting.nothingNeedsUser).toBe(false);
  const empty = buildGroupOverview({ conversationId: "conversation_group", memberBotIds: ["bot_a"],
    runs: [], memberTurns: [] });
  expect(empty).toMatchObject({ inProgressCount: 0, stuckCount: 0, needsUserCount: 0,
    nothingNeedsUser: true, finalAnswers: [] });
  expect(empty.members).toEqual([{ botId: "bot_a", state: "idle" }]);
});

test("P5 overview: cancelled turns are a user stop, not stuck", () => {
  const overview = buildGroupOverview({ conversationId: "conversation_group", memberBotIds: ["bot_a"],
    runs: [run("run_c", "cancelled")],
    memberTurns: [turn("run_c", "bot_a", "cancelled", "stopped work")] });
  expect(overview.stuckCount).toBe(0);
  expect(overview.needsUserCount).toBe(0);
  expect(overview.nothingNeedsUser).toBe(true);
  expect(overview.members[0]!.state).toBe("idle");
});

test("Fix6 overview: a followup turn that ended with no structured report is not a final summary", () => {
  // The followup completed, but the model never emitted a verdict/summary:
  // it must not close "no overall conclusion", must not clear the earlier
  // failure under (b), and — with the budget exhausted — must leave the
  // budget warning's precondition (no final answer) intact, never a
  // "nothing needs you" header over an unconcluded Run.
  const exhausted = run("run_norep", "completed") as ConversationRun & { followupBudgetExhausted?: boolean };
  exhausted.followupBudgetExhausted = true;
  const overview = buildGroupOverview({ conversationId: "conversation_group", memberBotIds: ["bot_a", "bot_b"],
    runs: [exhausted],
    memberTurns: [
      turn("run_norep", "bot_a", "failed", "implement login", undefined, undefined, undefined, 1, 0, "t-fail"),
      turn("run_norep", "bot_b", "completed", "followup without report", undefined, undefined, "handoff_nr", 1, 1, "t-nr", "followup"),
    ] });
  expect(overview.finalAnswers).toEqual([]);
  expect(overview.noOverallConclusion).toBe(true);
  expect(overview.nothingNeedsUser).toBe(false);
  expect(overview.stuckCount).toBe(1);
  expect(overview.needsUserCount).toBe(1);
});

test("Fix6 overview: a followup turn with a verdict but no summary text is not a final summary", () => {
  // Verdict alone is not a structured report on the backend: the summary
  // sentence is what the final answer renders, so both are required.
  const overview = buildGroupOverview({ conversationId: "conversation_group", memberBotIds: ["bot_a"],
    runs: [run("run_verdict_only", "completed")],
    memberTurns: [
      turn("run_verdict_only", "bot_a", "completed", "followup verdict only", "achieved", undefined, "handoff_vo", 1, 0, "t-vo", "followup"),
    ] });
  expect(overview.finalAnswers).toEqual([]);
  expect(overview.noOverallConclusion).toBe(true);
});

test("Fix6 overview: the same task completed but not achieved does not clear a failure", () => {
  const overview = buildGroupOverview({ conversationId: "conversation_group", memberBotIds: ["bot_a", "bot_b"],
    runs: [run("run_na", "running")],
    memberTurns: [
      turn("run_na", "bot_a", "failed", "implement login", undefined, undefined, undefined, 1, 0, "t-fail"),
      turn("run_na", "bot_b", "completed", "implement login", "not-achieved", "登录仍未达成。", "handoff_na", 1, 1, "t-na"),
    ] });
  expect(overview.stuckCount).toBe(1);
  expect(overview.needsUserCount).toBe(1);
});

test("Fix6 overview: the same task completed with no verdict does not clear a failure", () => {
  const overview = buildGroupOverview({ conversationId: "conversation_group", memberBotIds: ["bot_a", "bot_b"],
    runs: [run("run_nv", "running")],
    memberTurns: [
      turn("run_nv", "bot_a", "failed", "implement login", undefined, undefined, undefined, 1, 0, "t-fail"),
      turn("run_nv", "bot_b", "completed", "implement login", undefined, "轮次结束了。", "handoff_nv", 1, 1, "t-nv"),
    ] });
  expect(overview.stuckCount).toBe(1);
});

test("Fix6 overview: the same task completed and achieved still clears a failure", () => {
  // The fix-round-5 recovery path survives the fix-round-6 tightening:
  // only the verdict requirement is new, and "achieved" satisfies it.
  const overview = buildGroupOverview({ conversationId: "conversation_group", memberBotIds: ["bot_a", "bot_b"],
    runs: [run("run_ok", "running")],
    memberTurns: [
      turn("run_ok", "bot_a", "failed", "implement login", undefined, undefined, undefined, 1, 0, "t-fail"),
      turn("run_ok", "bot_b", "completed", "implement login", "achieved", "登录已完成。", "handoff_ok", 1, 1, "t-ok"),
    ] });
  expect(overview.stuckCount).toBe(0);
  expect(overview.needsUserCount).toBe(0);
});
