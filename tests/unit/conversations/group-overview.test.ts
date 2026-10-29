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

test("Fix1-7 overview: a failure followed by a completed turn in the same Run no longer counts as needs-you", () => {
  const overview = buildGroupOverview({ conversationId: "conversation_group", memberBotIds: ["bot_a", "bot_b"],
    runs: [run("run_r", "completed")],
    memberTurns: [
      turn("run_r", "bot_a", "failed", "build crashed", undefined, undefined, undefined, 1, 0, "t-fail"),
      turn("run_r", "bot_b", "completed", "recovered step", "achieved", "已恢复完成。", "handoff_r", 1, 1, "t-ok"),
    ] });
  expect(overview.stuckCount).toBe(0);
  expect(overview.needsUserCount).toBe(0);
  expect(overview.nothingNeedsUser).toBe(true);
  expect(overview.members.map((m) => `${m.botId}:${m.state}`)).toEqual(["bot_a:stuck", "bot_b:done"]);
  // Note: per-bot state keeps bot_a stuck (its own turn never recovered);
  // the Run-level needs-you count is what clears, because the Run moved on.
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
