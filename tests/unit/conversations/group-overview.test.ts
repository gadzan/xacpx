import { expect, test } from "bun:test";
import { buildGroupOverview } from "../../../src/conversations/group-overview";
import type { ConversationRun, MemberTurnRecord } from "../../../src/conversations/conversation-types";

function run(id: string, state: ConversationRun["state"]): ConversationRun {
  return { id, conversationId: "conversation_group", topicId: "topic_group", requestMessageId: "msg_req",
    state, mode: "explicit", createdAt: "2026-10-05T00:00:00.000Z" } as unknown as ConversationRun;
}

function turn(runId: string, botId: string, state: MemberTurnRecord["state"], task?: string,
  verdict?: MemberTurnRecord["finalReportVerdict"], summary?: string, assignmentId?: string) {
  return { runId, botId, state, task, finalReportVerdict: verdict,
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
      turn("run_new", "bot_a", "running", "leading the work"),
      turn("run_new", "bot_b", "failed", "review crashed"),
      turn("run_new", "bot_b", "completed", "earlier step done", "achieved", "过滤已完成。", "handoff_1"),
      turn("run_new", "bot_c", "completed", "done step", "achieved", "影响面已确认。", "handoff_2"),
    ] });
  expect(overview.leadBotId).toBe("bot_a");
  expect(overview.inProgressCount).toBe(1);
  expect(overview.stuckCount).toBe(1);
  expect(overview.needsUserCount).toBe(1);
  expect(overview.nothingNeedsUser).toBe(false);
  expect(overview.members.map((m) => `${m.botId}:${m.state}`)).toEqual(
    ["bot_a:running", "bot_b:stuck", "bot_c:done"]);
  expect(overview.finalAnswers).toEqual([
    { runId: "run_new", assignmentId: "handoff_1", botId: "bot_b", verdict: "achieved", conclusion: "过滤已完成。" },
    { runId: "run_new", assignmentId: "handoff_2", botId: "bot_c", verdict: "achieved", conclusion: "影响面已确认。" },
  ]);
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
