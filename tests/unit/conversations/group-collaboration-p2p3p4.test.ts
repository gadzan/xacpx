import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { BotService } from "../../../src/bots/bot-service";
import { GroupHandoffService } from "../../../src/conversations/group-handoff";
import { SqliteConversationStore } from "../../../src/conversations/sqlite-conversation-store";
import type { MemberTurnRecord } from "../../../src/conversations/conversation-types";
import { createEmptyState } from "../../../src/state/types";

const NOW = "2026-10-05T00:00:00.000Z";
const LEASE = "2026-10-05T01:00:00.000Z";
const snapshot = { revision: 1, capturedAt: NOW, presentation: { name: "Member" }, behavior: {},
  execution: { agent: "codex", workspace: "backend" } };

async function openStore(maxMemberTurns = 24, options: { followupChainDepthLimit?: number } = {}) {
  const path = join(mkdtempSync(join(tmpdir(), "xacpx-group-collab-")), "conversations.sqlite");
  return await SqliteConversationStore.open(path, options);
}

function acceptLeader(store: SqliteConversationStore, maxMemberTurns = 24) {
  const accepted = store.acceptRequest({ conversationId: "conversation_group", topicId: "topic_group",
    botId: "bot_a", requestId: `req-${Math.random()}`, content: "human request", profileSnapshot: snapshot,
    maxMemberTurns, now: NOW });
  const claim = store.claimNextDispatch({ owner: "owner", now: NOW, leaseExpiresAt: LEASE })!;
  const leader = store.markExecutionStarted({ dispatchId: claim.dispatch.id, owner: "owner",
    generation: claim.dispatch.generation, runId: accepted.run.id, memberTurnId: claim.memberTurn.id,
    sessionAlias: "session_a", logicalSessionId: "logical_a", sourceTurnId: "source_a", now: NOW });
  return { accepted, claim, leader };
}

function dispatch(store: SqliteConversationStore, sender: MemberTurnRecord, dispatchId: string,
  generation: number, invocationId: string, to: string, task: string) {
  return store.acceptPublicHandoff({ senderMemberTurnId: sender.id, sourceTurnId: sender.sourceTurnId!,
    dispatchId, owner: "owner", generation, invocationId, args: { to, task }, profileSnapshot: snapshot, now: NOW });
}

function claimAndStart(store: SqliteConversationStore, runId: string, turn: MemberTurnRecord,
  session: string, sourceTurn: string) {
  const claim = store.claimNextDispatch({ owner: "owner", now: NOW, leaseExpiresAt: LEASE })!;
  expect(claim.memberTurn.id).toBe(turn.id);
  return { claim, started: store.markExecutionStarted({ dispatchId: claim.dispatch.id, owner: "owner",
    generation: claim.dispatch.generation, runId, memberTurnId: turn.id,
    sessionAlias: session, logicalSessionId: `logical_${session}`, sourceTurnId: sourceTurn, now: NOW }) };
}

function settle(store: SqliteConversationStore, runId: string, turn: MemberTurnRecord,
  session: string, sourceTurn: string, content: string) {
  const { started } = claimAndStart(store, runId, turn, session, sourceTurn);
  store.completeExecution({ runId, memberTurnId: started.id, content,
    sourceTurn: { sessionAlias: session, turnId: sourceTurn }, now: NOW });
  return started;
}

const wakes = (store: SqliteConversationStore, runId: string) =>
  store.listMemberTurns(runId).filter((turn) => turn.followupSenderMemberTurnId !== undefined);

const REPORT = `Process narrative that must never reach the timeline.
最终报告：
裁决：目标已达成
结论：创建群组时，已禁用 bot 不会再出现在成员列表里。
改动：
- 群组创建对话框的成员候选逻辑
测试证据：
- 28 项测试通过
剩余项：
- 编辑模式下新增成员仍可选到已禁用 bot
尝试过的阻塞：
- 无`;

// ---------------------------------------------------------------- P2: timeline projection
test("P2: a structured report is stored on the member turn and projected on the timeline, raw output intact", async () => {
  const store = await openStore();
  try {
    const { accepted, leader } = acceptLeader(store);
    const runId = accepted.run.id;
    store.completeExecution({ runId, memberTurnId: leader.id, content: REPORT,
      sourceTurn: { sessionAlias: "session_a", turnId: "source_a" }, now: NOW });
    const turn = store.getMemberTurn(leader.id)!;
    expect(turn.finalReportVerdict).toBe("achieved");
    expect(turn.finalReport?.summary).toBe("创建群组时，已禁用 bot 不会再出现在成员列表里。");
    expect(turn.finalReport?.changes).toEqual(["群组创建对话框的成员候选逻辑"]);
    expect(turn.finalReport?.testEvidence).toEqual(["28 项测试通过"]);
    const result = store.getMemberResult(turn)!;
    // Raw output is the detail record; the timeline projection is separate.
    expect(result.content).toBe(REPORT);
    expect(result.timelineContent).toContain("结论：目标已达成");
    expect(result.timelineContent).toContain("创建群组时，已禁用 bot 不会再出现在成员列表里。");
    expect(result.timelineContent).not.toContain("Process narrative");
  } finally { store.close(); }
});

test("P2: no report means a stop notice on the timeline and no guessed verdict", async () => {
  const store = await openStore();
  try {
    const { accepted, leader } = acceptLeader(store);
    const runId = accepted.run.id;
    store.completeExecution({ runId, memberTurnId: leader.id, content: "did some steps, no conclusion section",
      sourceTurn: { sessionAlias: "session_a", turnId: "source_a" }, now: NOW });
    const turn = store.getMemberTurn(leader.id)!;
    expect(turn.finalReport).toBeUndefined();
    expect(turn.finalReportVerdict).toBeUndefined();
    const result = store.getMemberResult(turn)!;
    expect(result.content).toBe("did some steps, no conclusion section");
    expect(result.timelineContent).toContain("无结论");
    expect(result.timelineContent).not.toContain("did some steps");
  } finally { store.close(); }
});

test("P2: a corrupt stored report reads as no report instead of breaking member listing", async () => {
  const store = await openStore();
  try {
    const { accepted, leader } = acceptLeader(store);
    store.completeExecution({ runId: accepted.run.id, memberTurnId: leader.id, content: REPORT,
      sourceTurn: { sessionAlias: "session_a", turnId: "source_a" }, now: NOW });
    store.directWriteForTest("member_turns", leader.id, { final_report_json: "{not json" });
    const turn = store.getMemberTurn(leader.id)!;
    expect(turn.finalReport).toBeUndefined();
    expect(store.listMemberTurns(accepted.run.id)).toHaveLength(1);
  } finally { store.close(); }
});

// ---------------------------------------------------------------- P4: followup chain
/** Leader dispatches one assignment; returns the settled assignment + its wake, started. */
async function leaderWake(store: SqliteConversationStore, runId: string, leader: MemberTurnRecord,
  claim: { dispatch: { id: string; generation: number } }, to = "bot_b", task = "work one") {
  const assignment = dispatch(store, leader, claim.dispatch.id, claim.dispatch.generation, "handoff-1", to, task).memberTurn;
  store.completeExecution({ runId, memberTurnId: leader.id, content: "A dispatched",
    sourceTurn: { sessionAlias: "session_a", turnId: "source_a" }, now: NOW });
  settle(store, runId, assignment, "session_b", "source_b", "B done");
  const wake = wakes(store, runId).find((turn) => turn.followupSenderMemberTurnId === leader.id)!;
  expect(wake).toBeDefined();
  return { assignment, wake };
}

test("P4: a followup turn can dispatch after reading its settled results", async () => {
  const store = await openStore();
  try {
    const { accepted, claim, leader } = acceptLeader(store);
    const runId = accepted.run.id;
    const { assignment, wake } = await leaderWake(store, runId, leader, claim);
    const { claim: wakeClaim, started: wakeStarted } = claimAndStart(store, runId, wake, "session_a", "source_wake1");
    store.recordGroupResultRead(wakeStarted.id, assignment.assignmentId!);
    const receipt = dispatch(store, wakeStarted, wakeClaim.dispatch.id, wakeClaim.dispatch.generation,
      "wake-handoff-1", "bot_c", "followup work");
    expect(receipt.memberTurn.botId).toBe("bot_c");
  } finally { store.close(); }
});

test("P4: a followup turn that has not read its settled results is refused with the missing assignments", async () => {
  const store = await openStore();
  try {
    const { accepted, claim, leader } = acceptLeader(store);
    const runId = accepted.run.id;
    const { assignment, wake } = await leaderWake(store, runId, leader, claim);
    const { claim: wakeClaim, started: wakeStarted } = claimAndStart(store, runId, wake, "session_a", "source_wake1");
    expect(() => dispatch(store, wakeStarted, wakeClaim.dispatch.id, wakeClaim.dispatch.generation,
      "wake-handoff-1", "bot_c", "followup work")).toThrow("read every settled result");
    expect(() => dispatch(store, wakeStarted, wakeClaim.dispatch.id, wakeClaim.dispatch.generation,
      "wake-handoff-1", "bot_c", "followup work")).toThrow(assignment.assignmentId!);
  } finally { store.close(); }
});

test("P4: the chain stops at depth 3 — the depth-3 wake is summary-only and no wake 4 is created", async () => {
  const store = await openStore();
  try {
    const { accepted, claim, leader } = acceptLeader(store);
    const runId = accepted.run.id;
    const { assignment: a1, wake: wake1 } = await leaderWake(store, runId, leader, claim);
    expect(wake1.followupChainDepth).toBe(1);
    expect(wake1.task).toContain("followup 1 of 3");
    // Wake 1 dispatches, settles, wakes wake 2.
    const w1 = claimAndStart(store, runId, wake1, "session_a", "source_wake1");
    store.recordGroupResultRead(w1.started.id, a1.assignmentId!);
    const a2 = dispatch(store, w1.started, w1.claim.dispatch.id, w1.claim.dispatch.generation,
      "wake1-handoff", "bot_c", "second generation work").memberTurn;
    store.completeExecution({ runId, memberTurnId: w1.started.id, content: "wake1 summary",
      sourceTurn: { sessionAlias: "session_a", turnId: "source_wake1" }, now: NOW });
    settle(store, runId, a2, "session_c", "source_c", "C done");
    const wake2 = wakes(store, runId).find((turn) => turn.followupSenderMemberTurnId === wake1.id)!;
    expect(wake2.followupChainDepth).toBe(2);
    // Wake 2 dispatches, settles, wakes wake 3 (summary-only).
    const w2 = claimAndStart(store, runId, wake2, "session_a", "source_wake2");
    store.recordGroupResultRead(w2.started.id, a2.assignmentId!);
    const a3 = dispatch(store, w2.started, w2.claim.dispatch.id, w2.claim.dispatch.generation,
      "wake2-handoff", "bot_b", "third generation work").memberTurn;
    store.completeExecution({ runId, memberTurnId: w2.started.id, content: "wake2 summary",
      sourceTurn: { sessionAlias: "session_a", turnId: "source_wake2" }, now: NOW });
    settle(store, runId, a3, "session_b", "source_b3", "B3 done");
    const wake3 = wakes(store, runId).find((turn) => turn.followupSenderMemberTurnId === wake2.id)!;
    expect(wake3.followupChainDepth).toBe(3);
    expect(wake3.task).toContain("final followup");
    const w3 = claimAndStart(store, runId, wake3, "session_a", "source_wake3");
    store.recordGroupResultRead(w3.started.id, a3.assignmentId!);
    expect(() => dispatch(store, w3.started, w3.claim.dispatch.id, w3.claim.dispatch.generation,
      "wake3-handoff", "bot_c", "fourth generation work")).toThrow("chain depth limit");
    store.completeExecution({ runId, memberTurnId: w3.started.id, content: "wake3 final summary",
      sourceTurn: { sessionAlias: "session_a", turnId: "source_wake3" }, now: NOW });
    expect(wakes(store, runId)).toHaveLength(3);
    expect(store.getRun(runId)?.state).toBe("completed");
  } finally { store.close(); }
});

test("P4: a followup dispatch that leaves no followup slot is refused as budget-exhausted", async () => {
  const store = await openStore(4);
  try {
    const { accepted, claim, leader } = acceptLeader(store, 4);
    const runId = accepted.run.id;
    const { assignment, wake } = await leaderWake(store, runId, leader, claim);
    const { claim: wakeClaim, started: wakeStarted } = claimAndStart(store, runId, wake, "session_a", "source_wake1");
    store.recordGroupResultRead(wakeStarted.id, assignment.assignmentId!);
    // Leader + assignment + wake = 3 of 4 slots: one more assignment would
    // leave no room for its own followup turn.
    expect(() => dispatch(store, wakeStarted, wakeClaim.dispatch.id, wakeClaim.dispatch.generation,
      "wake-handoff-1", "bot_c", "followup work")).toThrow("Run work budget is exhausted");
  } finally { store.close(); }
});

test("P4: a budget-skipped wake is flagged explicitly instead of silently dropped", async () => {
  const store = await openStore(3);
  try {
    const { accepted, claim, leader } = acceptLeader(store, 3);
    const runId = accepted.run.id;
    const a = dispatch(store, leader, claim.dispatch.id, claim.dispatch.generation, "h-1", "bot_b", "work b").memberTurn;
    const b = dispatch(store, leader, claim.dispatch.id, claim.dispatch.generation, "h-2", "bot_c", "work c").memberTurn;
    store.completeExecution({ runId, memberTurnId: leader.id, content: "A dispatched",
      sourceTurn: { sessionAlias: "session_a", turnId: "source_a" }, now: NOW });
    settle(store, runId, a, "session_b", "source_b", "B done");
    settle(store, runId, b, "session_c", "source_c", "C done");
    expect(wakes(store, runId)).toHaveLength(0);
    const run = store.getRun(runId)!;
    expect(run.followupBudgetExhausted).toBe(true);
    expect(run.state).toBe("completed");
  } finally { store.close(); }
});

test("P4: the same task to the same member in one turn is a duplicate; a different task text is a retry", async () => {
  const store = await openStore();
  try {
    const { accepted, claim, leader } = acceptLeader(store);
    const runId = accepted.run.id;
    dispatch(store, leader, claim.dispatch.id, claim.dispatch.generation, "h-1", "bot_b", "same task");
    expect(() => dispatch(store, leader, claim.dispatch.id, claim.dispatch.generation,
      "h-2", "bot_b", "same task")).toThrow("already dispatched");
    const retry = dispatch(store, leader, claim.dispatch.id, claim.dispatch.generation,
      "h-3", "bot_b", "same task, different method after failure: try the other directory");
    expect(retry.memberTurn.botId).toBe("bot_b");
    void runId;
  } finally { store.close(); }
});

test("P4: any member that dispatched and completed earns a wake, not only the leader", async () => {
  const store = await openStore();
  try {
    const { accepted, claim, leader } = acceptLeader(store);
    const runId = accepted.run.id;
    const memberB = dispatch(store, leader, claim.dispatch.id, claim.dispatch.generation, "h-1", "bot_b", "work b").memberTurn;
    store.completeExecution({ runId, memberTurnId: leader.id, content: "A dispatched",
      sourceTurn: { sessionAlias: "session_a", turnId: "source_a" }, now: NOW });
    const { claim: bClaim, started: bStarted } = claimAndStart(store, runId, memberB, "session_b", "source_b");
    const memberC = dispatch(store, bStarted, bClaim.dispatch.id, bClaim.dispatch.generation, "h-b1", "bot_c", "work c").memberTurn;
    store.completeExecution({ runId, memberTurnId: bStarted.id, content: "B dispatched",
      sourceTurn: { sessionAlias: "session_b", turnId: "source_b" }, now: NOW });
    settle(store, runId, memberC, "session_c", "source_c", "C done");
    const wakeForB = wakes(store, runId).find((turn) => turn.followupSenderMemberTurnId === memberB.id);
    expect(wakeForB).toBeDefined();
    expect(wakeForB?.botId).toBe("bot_b");
  } finally { store.close(); }
});

test("P4: a second batch earns the same sender a second wake", async () => {
  const store = await openStore();
  try {
    const { accepted, claim, leader } = acceptLeader(store);
    const runId = accepted.run.id;
    const { wake: wake1 } = await leaderWake(store, runId, leader, claim);
    expect(wake1.batch).toBe(1);
    // Simulate the router advancing the Run to batch 2, then the same
    // sender dispatching again in that batch (its first wake's dispatch is
    // repointed at the sender for this simulation; the point under test is
    // the per-(sender, batch) wake uniqueness, not the router advance).
    store.directWriteForTest("runs", runId, { active_batch: "2" });
    store.directWriteForTest("member_turns", leader.id, { state: "running" });
    const wakeDispatch = store.getDispatchForMemberTurn(wake1.id)!;
    const leaderDispatch = store.getDispatchForMemberTurn(leader.id)!;
    // pending_dispatches is UNIQUE(run_id, member_turn_id): swap the two
    // rows' owners via a placeholder so no intermediate state collides.
    store.directWriteForTest("pending_dispatches", leaderDispatch.id, { member_turn_id: "swap-placeholder" });
    store.directWriteForTest("pending_dispatches", wakeDispatch.id,
      { member_turn_id: leader.id, state: "claimed", owner: "owner", generation: String(wakeDispatch.generation) });
    store.directWriteForTest("pending_dispatches", leaderDispatch.id, { member_turn_id: wake1.id });
    const second = dispatch(store, store.getMemberTurn(leader.id)!, wakeDispatch.id, wakeDispatch.generation,
      "batch2-handoff", "bot_c", "second batch work").memberTurn;
    expect(second.batch).toBe(2);
    store.completeExecution({ runId, memberTurnId: leader.id, content: "A dispatched again",
      sourceTurn: { sessionAlias: "session_a", turnId: "source_a" }, now: NOW });
    settle(store, runId, second, "session_c", "source_c2", "C2 done");
    const leaderWakes = wakes(store, runId).filter((turn) => turn.followupSenderMemberTurnId === leader.id);
    expect(leaderWakes.map((turn) => turn.batch).sort()).toEqual([1, 2]);
  } finally { store.close(); }
});

test("P4: a user-cancelled sender earns no wake, and an indeterminate assignment seals without one", async () => {
  const store = await openStore();
  try {
    const { accepted, claim, leader } = acceptLeader(store);
    const runId = accepted.run.id;
    const assignment = dispatch(store, leader, claim.dispatch.id, claim.dispatch.generation, "h-1", "bot_b", "work b").memberTurn;
    store.cancelMemberTurn(runId, leader.id, NOW);
    store.completeCancel(runId, leader.id, NOW);
    settle(store, runId, assignment, "session_b", "source_b", "B done");
    expect(wakes(store, runId)).toHaveLength(0);
  } finally { store.close(); }
  const store2 = await openStore();
  try {
    const { accepted, claim, leader } = acceptLeader(store2);
    const runId = accepted.run.id;
    const assignment = dispatch(store2, leader, claim.dispatch.id, claim.dispatch.generation, "h-1", "bot_b", "work b").memberTurn;
    store2.completeExecution({ runId, memberTurnId: leader.id, content: "A dispatched",
      sourceTurn: { sessionAlias: "session_a", turnId: "source_a" }, now: NOW });
    const { started } = claimAndStart(store2, runId, assignment, "session_b", "source_b");
    store2.completeCancel(runId, started.id, NOW, true);
    expect(store2.getRun(runId)?.state).toBe("indeterminate");
    expect(wakes(store2, runId)).toHaveLength(0);
  } finally { store2.close(); }
});

// ---------------------------------------------------------------- P3: group chat
async function chatHarness() {
  const store = await openStore();
  const state = createEmptyState();
  for (const id of ["bot_a", "bot_b", "bot_c"]) {
    state.bots[id] = { id, name: id, agent: "codex", workspace: "backend", enabled: true,
      profileRevision: 1, createdAt: NOW, updatedAt: NOW };
  }
  const bots = new BotService({ agents: {}, workspaces: {} }, state, { async save() {} });
  state.conversations.group = { id: "group", kind: "group", title: "Group", botIds: ["bot_a", "bot_b", "bot_c"],
    createdAt: NOW, updatedAt: NOW };
  state.conversation_topics.topic = { id: "topic", conversationId: "group", title: "Topic", status: "active",
    executionTarget: { workspace: "backend", isolation: "shared-single-writer" }, createdAt: NOW, updatedAt: NOW };
  const accepted = store.acceptRequest({ conversationId: "group", topicId: "topic", requestId: "request",
    botId: "bot_a", content: "Delegate and review", profileSnapshot: snapshot, maxMemberTurns: 8, now: NOW });
  const claim = store.claimNextDispatch({ owner: "owner", authorityEpoch: "epoch", now: NOW, leaseExpiresAt: LEASE })!;
  const sender = store.markExecutionStarted({ dispatchId: claim.dispatch.id, owner: "owner", generation: claim.dispatch.generation,
    runId: accepted.run.id, memberTurnId: claim.memberTurn.id, sessionAlias: "session", logicalSessionId: "logical",
    sourceTurnId: "source", now: NOW });
  state.sessions.session = { alias: "session", agent: "codex", workspace: "backend", transport_session: "transport",
    logical_session_id: "logical", owner: { kind: "group-member", bindingId: "binding", botId: "bot_a",
      conversationId: "group", topicId: "topic" }, created_at: NOW, last_used_at: NOW };
  state.bot_runtime_bindings.binding = { id: "binding", scope: "group-member", botId: "bot_a", conversationId: "group",
    topicId: "topic", sessionAlias: "session", logicalSessionId: "logical", createdAt: NOW, updatedAt: NOW };
  const handoffs = new GroupHandoffService({ store, bots, state, now: () => new Date(NOW), wake() {} });
  const capability = handoffs.bindExecution({ senderMemberTurnId: sender.id, sourceTurnId: "source",
    dispatchId: claim.dispatch.id, owner: "owner", generation: claim.dispatch.generation });
  return { store, handoffs, sender, accepted, state,
    chat: (args: unknown) => handoffs.chat({ executionToken: capability.token, args }) };
}

test("P3: group chat records a threaded message without creating a turn, dispatch, or budget use", async () => {
  const h = await chatHarness();
  try {
    const before = h.store.listMemberTurns(h.accepted.run.id).length;
    const first = await h.chat({ to: "bot_b", content: "quick question: is the filter done?" });
    const second = await h.chat({ to: "bot_b", content: "following up", replyTo: first.messageId });
    const messages = h.store.listGroupChatMessages("group", "topic");
    expect(messages).toHaveLength(2);
    // Both messages share one created_at in this harness, so order by id
    // is not insertion order: match by content instead.
    const followup = messages.find((message) => message.content === "following up")!;
    expect(followup).toMatchObject({ senderBotId: "bot_a", targetBotId: "bot_b" });
    expect(followup.replyToId).toBe(first.messageId);
    expect(h.store.listMemberTurns(h.accepted.run.id)).toHaveLength(before);
    expect(h.store.claimNextDispatch({ owner: "owner", now: NOW, leaseExpiresAt: LEASE })).toBeUndefined();
    expect(h.store.getMemberTurn(h.sender.id)?.state).toBe("running");
    expect(h.store.getRun(h.accepted.run.id)?.consumedMemberTurns).toBe(0);
  } finally { h.handoffs.close(); h.store.close(); }
});

test("P3: group chat refuses self-targets, disabled targets, and foreign replyTo ids", async () => {
  const h = await chatHarness();
  try {
    await expect(h.chat({ to: "bot_a", content: "to myself" })).rejects.toThrow("another Group member");
    await expect(h.chat({ to: "bot_b", content: "x", replyTo: "no-such-chat" })).rejects.toThrow("replyTo");
    h.state.bots.bot_b!.enabled = false;
    await expect(h.chat({ to: "bot_b", content: "hello" })).rejects.toThrow("disabled");
    h.state.bots.bot_b!.enabled = true;
    const ok = await h.chat({ to: "bot_b", content: "hello again" });
    expect(ok.messageId.length).toBeGreaterThan(0);
  } finally { h.handoffs.close(); h.store.close(); }
});
