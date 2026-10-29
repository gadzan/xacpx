import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { SqliteConversationStore } from "../../../src/conversations/sqlite-conversation-store";
import type { MemberTurnRecord } from "../../../src/conversations/conversation-types";
import { buildGroupOverview } from "../../../src/conversations/group-overview";

const NOW = "2026-10-05T00:00:00.000Z";
const LEASE = "2026-10-05T01:00:00.000Z";
const snapshot = { revision: 1, capturedAt: NOW, presentation: { name: "Member" }, behavior: {},
  execution: { agent: "codex", workspace: "backend" } };

async function openStore() {
  const path = join(mkdtempSync(join(tmpdir(), "xacpx-group-collab-e2e-")), "conversations.sqlite");
  return await SqliteConversationStore.open(path, { followupChainDepthLimit: 3 });
}

function acceptLeader(store: SqliteConversationStore) {
  const accepted = store.acceptRequest({ conversationId: "conversation_group", topicId: "topic_group",
    botId: "bot_a", requestId: `req-${Math.random()}`, content: "human request", profileSnapshot: snapshot,
    maxMemberTurns: 24, now: NOW });
  const claim = store.claimNextDispatch({ owner: "owner", now: NOW, leaseExpiresAt: LEASE })!;
  const leader = store.markExecutionStarted({ dispatchId: claim.dispatch.id, owner: "owner",
    generation: claim.dispatch.generation, runId: accepted.run.id, memberTurnId: claim.memberTurn.id,
    sessionAlias: "session_a", logicalSessionId: "logical_a", sourceTurnId: "source_a", now: NOW });
  return { accepted, claim, leader };
}

function dispatch(store: SqliteConversationStore, sender: MemberTurnRecord, dispatchId: string,
  generation: number, invocationId: string, to: string, task: string, dependsOn?: string[]) {
  return store.acceptPublicHandoff({ senderMemberTurnId: sender.id, sourceTurnId: sender.sourceTurnId!,
    dispatchId, owner: "owner", generation, invocationId,
    args: { to, task, ...(dependsOn !== undefined ? { dependsOn } : {}) },
    profileSnapshot: snapshot, now: NOW });
}

function claimAndStart(store: SqliteConversationStore, runId: string, turn: MemberTurnRecord,
  session: string, sourceTurn: string) {
  const claim = store.claimNextDispatch({ owner: "owner", now: NOW, leaseExpiresAt: LEASE })!;
  expect(claim.memberTurn.id).toBe(turn.id);
  const started = store.markExecutionStarted({ dispatchId: claim.dispatch.id, owner: "owner",
    generation: claim.dispatch.generation, runId, memberTurnId: turn.id,
    sessionAlias: session, logicalSessionId: `logical_${session}`, sourceTurnId: sourceTurn, now: NOW });
  return { claim, started };
}

function complete(store: SqliteConversationStore, runId: string, turn: MemberTurnRecord,
  session: string, sourceTurn: string, content: string) {
  store.completeExecution({ runId, memberTurnId: turn.id, content,
    sourceTurn: { sessionAlias: session, turnId: sourceTurn }, now: NOW });
}

function report(summary: string, verdict: "目标已达成" | "目标未达成" = "目标已达成") {
  return `Process narrative that must never reach the timeline.\n最终报告：\n裁决：${verdict}\n结论：${summary}\n改动：\n- src/feature.ts\n测试证据：\n- 单元测试通过\n剩余项：\n- 无\n尝试过的阻塞：\n- 无`;
}

const wakesFor = (store: SqliteConversationStore, runId: string, senderId: string) =>
  store.listMemberTurns(runId).filter((turn) => turn.followupSenderMemberTurnId === senderId);

// ---------------------------------------------------------------- Fix-round-5 item 4: fake-runner auto-review chain
// Store/dispatcher-level only, like Fix1-9 above: no agent model executes
// any turn here, and the lead-seat review sentence is a prompt, not a
// guarantee. Real-model verification (a real model autonomously inviting
// an independent reviewer, fixing, and re-reviewing) remains unverified.
test("Fix5: builder -> independent reviewer (dependsOn dev) -> fix -> same reviewer re-review -> lead final summary", async () => {
  const store = await openStore();
  try {
    const { accepted, claim, leader } = acceptLeader(store);
    const runId = accepted.run.id;
    const builder = "bot_b";
    const reviewer = "bot_c";
    expect(reviewer).not.toBe(builder);

    const dev = dispatch(store, leader, claim.dispatch.id, claim.dispatch.generation,
      "fix5-1", builder, "implement login").memberTurn;
    const review = dispatch(store, leader, claim.dispatch.id, claim.dispatch.generation,
      "fix5-2", reviewer, "review login implementation", [dev.assignmentId!]).memberTurn;
    expect(review.dependsOn).toContain(dev.assignmentId!);
    const { started: devStarted } = claimAndStart(store, runId, dev, "session_b", "source_b");
    complete(store, runId, devStarted, "session_b", "source_b", report("登录实现完成。"));
    const { started: reviewStarted } = claimAndStart(store, runId, review, "session_c", "source_c");
    complete(store, runId, reviewStarted, "session_c", "source_c",
      report("审查发现问题：密码未做长度校验。", "目标未达成"));
    complete(store, runId, leader, "session_a", "source_a", "Leader dispatched");

    const wake1 = wakesFor(store, runId, leader.id)[0]!;
    const { claim: wake1Claim, started: wake1Started } = claimAndStart(store, runId, wake1, "session_a", "source_wake1");
    store.recordGroupResultRead(wake1Started.id, dev.assignmentId!);
    store.recordGroupResultRead(wake1Started.id, review.assignmentId!);
    const fix = dispatch(store, wake1Started, wake1Claim.dispatch.id, wake1Claim.dispatch.generation,
      "fix5-3", builder, "add password length validation").memberTurn;
    const rereview = dispatch(store, wake1Started, wake1Claim.dispatch.id, wake1Claim.dispatch.generation,
      "fix5-4", reviewer, "re-review login implementation", [fix.assignmentId!]).memberTurn;
    expect(rereview.botId).toBe(reviewer);
    const { started: fixStarted } = claimAndStart(store, runId, fix, "session_b", "source_b2");
    complete(store, runId, fixStarted, "session_b", "source_b2", report("长度校验已补。"));
    const { started: rereviewStarted } = claimAndStart(store, runId, rereview, "session_c", "source_c2");
    complete(store, runId, rereviewStarted, "session_c", "source_c2", report("复审通过。"));
    complete(store, runId, wake1Started, "session_a", "source_wake1", "Followup 1 dispatched fix and re-review");

    const wake2 = wakesFor(store, runId, wake1.id)[0]!;
    const { started: wake2Started } = claimAndStart(store, runId, wake2, "session_a", "source_wake2");
    store.recordGroupResultRead(wake2Started.id, fix.assignmentId!);
    store.recordGroupResultRead(wake2Started.id, rereview.assignmentId!);
    complete(store, runId, wake2Started, "session_a", "source_wake2", report("最终汇总：登录已实现并通过独立复审。"));

    const turns = store.listMemberTurns(runId);
    expect(store.getRun(runId)?.state).toBe("completed");
    const ordered = [...turns].sort((a, b) => a.batch - b.batch
      || (a.memberIndex ?? 0) - (b.memberIndex ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const terminal = ordered.filter((t) => ["completed", "failed", "cancelled", "indeterminate"].includes(t.state));
    expect(terminal[terminal.length - 1]!.id).toBe(wake2.id);
    expect(wake2.origin).toBe("followup");
    const overview = buildGroupOverview({ conversationId: "conversation_group", topicId: "topic_group",
      leadBotId: "bot_a", memberBotIds: ["bot_a", "bot_b", "bot_c"],
      runs: [store.getRun(runId)!], memberTurns: turns });
    expect(overview.finalAnswers).toHaveLength(1);
    expect(overview.finalAnswers[0]).toMatchObject({ botId: "bot_a", verdict: "achieved", conclusion: "最终汇总：登录已实现并通过独立复审。" });
    expect(overview.stuckCount).toBe(0);
    expect(overview.needsUserCount).toBe(0);
    expect(overview.noOverallConclusion).toBe(false);
    expect(overview.nothingNeedsUser).toBe(true);
  } finally { store.close(); }
});

// ---------------------------------------------------------------- Fix-round-1 item 9: fake-runner end-to-end
// This is a store/dispatcher-level fake-runner scenario, NOT a real-model
// end-to-end run: no agent model executes any turn here. Real-model
// verification remains an unverified item in the fix-round report.
test("Fix1-9: develop -> review finds problem -> fix -> re-review -> final summary, timeline and final answer consistent", async () => {
  const store = await openStore();
  try {
    const { accepted, claim, leader } = acceptLeader(store);
    const runId = accepted.run.id;

    // Develop + review, where review waits on develop (dependency waiting).
    const dev = dispatch(store, leader, claim.dispatch.id, claim.dispatch.generation,
      "e2e-1", "bot_b", "implement feature").memberTurn;
    const review = dispatch(store, leader, claim.dispatch.id, claim.dispatch.generation,
      "e2e-2", "bot_c", "review implementation", [dev.assignmentId!]).memberTurn;
    // The fence serves develop first: review is not claimable yet.
    const { started: devStarted } = claimAndStart(store, runId, dev, "session_b", "source_b");
    complete(store, runId, devStarted, "session_b", "source_b", report("开发完成。"));
    const { started: reviewStarted } = claimAndStart(store, runId, review, "session_c", "source_c");
    complete(store, runId, reviewStarted, "session_c", "source_c",
      report("发现问题：边界条件未处理。", "目标未达成"));
    complete(store, runId, leader, "session_a", "source_a", "Leader dispatched");

    // Followup 1 (depth 1): read both results, then dispatch fix + re-review.
    const wake1 = wakesFor(store, runId, leader.id)[0]!;
    expect(wake1.followupChainDepth).toBe(1);
    const { claim: wake1Claim, started: wake1Started } = claimAndStart(store, runId, wake1, "session_a", "source_wake1");
    store.recordGroupResultRead(wake1Started.id, dev.assignmentId!);
    store.recordGroupResultRead(wake1Started.id, review.assignmentId!);
    const fix = dispatch(store, wake1Started, wake1Claim.dispatch.id, wake1Claim.dispatch.generation,
      "e2e-3", "bot_b", "fix boundary handling").memberTurn;
    const rereview = dispatch(store, wake1Started, wake1Claim.dispatch.id, wake1Claim.dispatch.generation,
      "e2e-4", "bot_c", "re-review fixed implementation", [fix.assignmentId!]).memberTurn;
    const { started: fixStarted } = claimAndStart(store, runId, fix, "session_b", "source_b2");
    complete(store, runId, fixStarted, "session_b", "source_b2", report("修复完成。"));
    const { started: rereviewStarted } = claimAndStart(store, runId, rereview, "session_c", "source_c2");
    complete(store, runId, rereviewStarted, "session_c", "source_c2", report("复审通过。"));
    complete(store, runId, wake1Started, "session_a", "source_wake1", "Followup 1 dispatched fix and re-review");

    // Followup 2 (depth 2): the final summary.
    const wake2 = wakesFor(store, runId, wake1.id)[0]!;
    expect(wake2.followupChainDepth).toBe(2);
    const { started: wake2Started } = claimAndStart(store, runId, wake2, "session_a", "source_wake2");
    store.recordGroupResultRead(wake2Started.id, fix.assignmentId!);
    store.recordGroupResultRead(wake2Started.id, rereview.assignmentId!);
    complete(store, runId, wake2Started, "session_a", "source_wake2", report("最终汇总：功能已实现并通过复审。"));

    // Post-refresh consistency: every turn terminal, Run completed, and the
    // final answer is the last followup — not the first followup, not a
    // member conclusion, and its timeline projection carries no process text.
    const turns = store.listMemberTurns(runId);
    expect(turns.every((turn) => ["completed", "failed", "cancelled", "indeterminate"].includes(turn.state))).toBe(true);
    expect(store.getRun(runId)?.state).toBe("completed");
    const terminal = [...turns].sort((a, b) => a.batch - b.batch
      || (a.memberIndex ?? 0) - (b.memberIndex ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    let finalTurn: MemberTurnRecord | undefined;
    for (let i = terminal.length - 1; i >= 0; i--) {
      if (terminal[i]!.origin === "followup") { finalTurn = terminal[i]; break; }
    }
    expect(finalTurn!.id).toBe(wake2.id);
    expect(finalTurn!.finalReport?.summary).toBe("最终汇总：功能已实现并通过复审。");
    const timeline = store.getMemberResult(finalTurn!)!;
    expect(timeline.timelineContent).toContain("最终汇总：功能已实现并通过复审。");
    expect(timeline.timelineContent).not.toContain("Process narrative");
    expect(timeline.content).toContain("Process narrative"); // raw output intact
    const overview = buildGroupOverview({ conversationId: "conversation_group", topicId: "topic_group",
      leadBotId: "bot_a", memberBotIds: ["bot_a", "bot_b", "bot_c"],
      runs: [store.getRun(runId)!], memberTurns: turns });
    expect(overview.finalAnswers).toHaveLength(1);
    expect(overview.finalAnswers[0]).toMatchObject({ botId: "bot_a", verdict: "achieved", conclusion: "最终汇总：功能已实现并通过复审。" });
    expect(overview.stuckCount).toBe(0);
    expect(overview.needsUserCount).toBe(0);
  } finally { store.close(); }
});
