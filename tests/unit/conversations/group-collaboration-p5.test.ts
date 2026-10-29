import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { parseGroupSend } from "../../../src/conversations/group-handoff";
import { validateGroupSendDependencies } from "../../../src/conversations/conversation-store";
import type { MemberTurnRecord } from "../../../src/conversations/conversation-types";
import { SqliteConversationStore } from "../../../src/conversations/sqlite-conversation-store";
import { buildXacpxMcpToolRegistry } from "../../../src/mcp/xacpx-mcp-tools";
import { createMemoryTransport } from "../../../src/mcp/xacpx-mcp-transport";

const NOW = "2026-10-05T00:00:00.000Z";
const LEASE = "2026-10-05T01:00:00.000Z";
const snapshot = { revision: 1, capturedAt: NOW, presentation: { name: "Member" }, behavior: {},
  execution: { agent: "codex", workspace: "backend" } };

async function openStore(maxMemberTurns = 24) {
  const path = join(mkdtempSync(join(tmpdir(), "xacpx-group-collab-p5-")), "conversations.sqlite");
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

function fakeTurn(assignmentId: string, state: MemberTurnRecord["state"], dependsOn: string[] = []) {
  return { id: `turn-${assignmentId}`, assignmentId, state, dependsOn } as unknown as MemberTurnRecord;
}

// ---------------------------------------------------------------- parse
test("P5: parseGroupSend accepts dependsOn and rejects bad entries instead of dropping them", () => {
  expect(parseGroupSend({ to: "bot_b", task: "work", dependsOn: ["a_1", "a_2"] }).dependsOn)
    .toEqual(["a_1", "a_2"]);
  expect(parseGroupSend({ to: "bot_b", task: "work" }).dependsOn).toBeUndefined();
  expect(() => parseGroupSend({ to: "bot_b", task: "work", dependsOn: ["a_1", "a_1"] })).toThrow("repeats");
  expect(() => parseGroupSend({ to: "bot_b", task: "work", dependsOn: "a_1" })).toThrow("dependsOn must be an array");
  expect(() => parseGroupSend({ to: "bot_b", task: "work", dependsOn: [""] })).toThrow("nonempty");
  expect(() => parseGroupSend({ to: "bot_b", task: "work", dependsOn: ["a_1", 7] })).toThrow("nonempty");
  expect(() => parseGroupSend({ to: "bot_b", task: "work", dependsOn: Array.from({ length: 65 }, (_, i) => `a_${i}`) }))
    .toThrow("at most 64");
});

// ---------------------------------------------------------------- pure validation
test("P5: validateGroupSendDependencies rejects unknown, duplicate, and cyclic entries — unsettled is accepted (Fix1-6 dependency waiting)", () => {
  const settled = [fakeTurn("a_1", "completed"), fakeTurn("a_2", "failed")];
  expect(() => validateGroupSendDependencies(settled, ["a_1", "a_2"])).not.toThrow();
  expect(() => validateGroupSendDependencies(settled, ["missing"])).toThrow("names unknown assignment");
  // Unsettled dependencies are the normal "dispatch first, auto-wait" case.
  expect(() => validateGroupSendDependencies([...settled, fakeTurn("a_3", "running")], ["a_3"])).not.toThrow();
  expect(() => validateGroupSendDependencies([...settled, fakeTurn("a_3", "queued")], ["a_3"])).not.toThrow();
  expect(() => validateGroupSendDependencies(settled, ["a_1", "a_1"])).toThrow("repeats assignment");
  const cyclic = [fakeTurn("a_1", "completed", ["a_2"]), fakeTurn("a_2", "completed", ["a_1"])];
  expect(() => validateGroupSendDependencies(cyclic, ["a_1"])).toThrow("cycle through assignment");
  // Cycle detection covers the pending graph too, not only settled turns.
  const pendingCyclic = [fakeTurn("a_1", "queued", ["a_2"]), fakeTurn("a_2", "queued", ["a_1"])];
  expect(() => validateGroupSendDependencies(pendingCyclic, ["a_1"])).toThrow("cycle through assignment");
});

// ---------------------------------------------------------------- store: parallel + dependent
test("P5: one turn may dispatch several independent assignments in the same batch, both claimable", async () => {
  const store = await openStore();
  try {
    const { accepted, claim, leader } = acceptLeader(store);
    const runId = accepted.run.id;
    const a = dispatch(store, leader, claim.dispatch.id, claim.dispatch.generation, "h-1", "bot_b", "work b").memberTurn;
    const b = dispatch(store, leader, claim.dispatch.id, claim.dispatch.generation, "h-2", "bot_c", "work c").memberTurn;
    expect(a.batch).toBe(b.batch);
    expect(a.dependsOn ?? []).toEqual([]);
    expect(b.dependsOn ?? []).toEqual([]);
    // Neither blocks the other: both are claimable in accept order.
    claimAndStart(store, runId, a, "session_b", "source_b");
    claimAndStart(store, runId, b, "session_c", "source_c");
  } finally { store.close(); }
});

test("P5: a followup dispatch on a settled assignment persists dependsOn and is claimable", async () => {
  const store = await openStore();
  try {
    const { accepted, claim, leader } = acceptLeader(store);
    const runId = accepted.run.id;
    const assignment = dispatch(store, leader, claim.dispatch.id, claim.dispatch.generation,
      "handoff-1", "bot_b", "work one").memberTurn;
    store.completeExecution({ runId, memberTurnId: leader.id, content: "A dispatched",
      sourceTurn: { sessionAlias: "session_a", turnId: "source_a" }, now: NOW });
    settle(store, runId, assignment, "session_b", "source_b", "B done");
    const wake = store.listMemberTurns(runId).find((turn) => turn.followupSenderMemberTurnId === leader.id)!;
    expect(wake).toBeDefined();
    const { claim: wakeClaim, started: wakeStarted } = claimAndStart(store, runId, wake, "session_a", "source_wake1");
    store.recordGroupResultRead(wakeStarted.id, assignment.assignmentId!);
    const receipt = dispatch(store, wakeStarted, wakeClaim.dispatch.id, wakeClaim.dispatch.generation,
      "wake-handoff-1", "bot_c", "build on B", [assignment.assignmentId!]);
    expect(receipt.memberTurn.dependsOn).toEqual([assignment.assignmentId]);
    expect(receipt.message.content).toContain("Depends on:");
    expect(receipt.message.content).toContain(assignment.assignmentId!);
    // The dependent turn is claimable once its (settled) dependency is satisfied.
    claimAndStart(store, runId, receipt.memberTurn, "session_c", "source_c");
    // Idempotent replay with the same dependsOn returns the old receipt.
    const replay = dispatch(store, wakeStarted, wakeClaim.dispatch.id, wakeClaim.dispatch.generation,
      "wake-handoff-1", "bot_c", "build on B", [assignment.assignmentId!]);
    expect(replay.reused).toBe(true);
    expect(replay.memberTurn.id).toBe(receipt.memberTurn.id);
  } finally { store.close(); }
});

test("P5: unknown dependsOn is rejected and writes no turn", async () => {
  const store = await openStore();
  try {
    const { accepted, claim, leader } = acceptLeader(store);
    const runId = accepted.run.id;
    const before = store.listMemberTurns(runId).length;
    expect(() => dispatch(store, leader, claim.dispatch.id, claim.dispatch.generation,
      "h-bad-1", "bot_b", "build on nothing", ["no_such_assignment"]))
      .toThrow("names unknown assignment");
    expect(store.listMemberTurns(runId)).toHaveLength(before);
  } finally { store.close(); }
});

test("Fix1-6: an unsettled dependency is accepted, blocks claiming until it completes, then releases", async () => {
  const store = await openStore();
  try {
    const { accepted, claim, leader } = acceptLeader(store);
    const runId = accepted.run.id;
    const upstream = dispatch(store, leader, claim.dispatch.id, claim.dispatch.generation,
      "h-1", "bot_b", "work one").memberTurn;
    const downstream = dispatch(store, leader, claim.dispatch.id, claim.dispatch.generation,
      "h-2", "bot_c", "build on work one", [upstream.assignmentId!]).memberTurn;
    expect(downstream.state).toBe("queued");
    // The fence serves the upstream turn first, never the waiting downstream.
    const first = store.claimNextDispatch({ owner: "owner", now: NOW, leaseExpiresAt: LEASE })!;
    expect(first.memberTurn.id).toBe(upstream.id);
    // After the upstream completes, the downstream becomes claimable.
    const startedUpstream = store.markExecutionStarted({ dispatchId: first.dispatch.id, owner: "owner",
      generation: first.dispatch.generation, runId, memberTurnId: upstream.id,
      sessionAlias: "session_b", logicalSessionId: "logical_session_b", sourceTurnId: "source_b", now: NOW });
    expect(startedUpstream.id).toBe(upstream.id);
    store.completeExecution({ runId, memberTurnId: upstream.id, content: "B done",
      sourceTurn: { sessionAlias: "session_b", turnId: "source_b" }, now: NOW });
    claimAndStart(store, runId, downstream, "session_c", "source_c");
  } finally { store.close(); }
});

test("Fix1-6: a failed dependency blocks the downstream turn as dependency-failed, without quarantining its Bot", async () => {
  const store = await openStore();
  try {
    const { accepted, claim, leader } = acceptLeader(store);
    const runId = accepted.run.id;
    const upstream = dispatch(store, leader, claim.dispatch.id, claim.dispatch.generation,
      "h-1", "bot_b", "work one").memberTurn;
    const downstream = dispatch(store, leader, claim.dispatch.id, claim.dispatch.generation,
      "h-2", "bot_c", "build on work one", [upstream.assignmentId!]).memberTurn;
    // The followup belongs to a completed sender, so complete the leader
    // turn before its assignments settle (the leaderWake pattern).
    store.completeExecution({ runId, memberTurnId: leader.id, content: "Leader dispatched",
      sourceTurn: { sessionAlias: "session_a", turnId: "source_a" }, now: NOW });
    const { started } = claimAndStart(store, runId, upstream, "session_b", "source_b");
    store.failExecution({ runId, memberTurnId: started.id, now: NOW, reason: "build broke" });
    const blocked = store.getMemberTurn(downstream.id)!;
    expect(blocked.state).toBe("failed");
    expect(blocked.failureReason).toBe(`dependency_failed: ${upstream.assignmentId} failed`);
    // The downstream Bot never ran, so it is not quarantined for the Run.
    expect(store.getRun(runId)?.quarantinedBotIds ?? []).not.toContain("bot_c");
    // The leader's followup sees the blocked downstream as settled.
    const wake = store.listMemberTurns(runId).find((turn) => turn.followupSenderMemberTurnId === leader.id);
    expect(wake).toBeDefined();
  } finally { store.close(); }
});

test("Fix1-6: a dependency that already failed at accept time blocks the new turn immediately", async () => {
  const store = await openStore();
  try {
    const { accepted, claim, leader } = acceptLeader(store);
    const runId = accepted.run.id;
    const upstream = dispatch(store, leader, claim.dispatch.id, claim.dispatch.generation,
      "h-1", "bot_b", "work one").memberTurn;
    const { started } = claimAndStart(store, runId, upstream, "session_b", "source_b");
    store.failExecution({ runId, memberTurnId: started.id, now: NOW, reason: "build broke" });
    const receipt = dispatch(store, leader, claim.dispatch.id, claim.dispatch.generation,
      "h-2", "bot_c", "build on failed work", [upstream.assignmentId!]);
    expect(receipt.memberTurn.state).toBe("failed");
    expect(receipt.memberTurn.failureReason).toBe(`dependency_failed: ${upstream.assignmentId} failed`);
  } finally { store.close(); }
});

test("P5: replay with different dependsOn conflicts instead of silently reusing", async () => {
  const store = await openStore();
  try {
    const { accepted, claim, leader } = acceptLeader(store);
    const runId = accepted.run.id;
    const assignment = dispatch(store, leader, claim.dispatch.id, claim.dispatch.generation,
      "handoff-1", "bot_b", "work one").memberTurn;
    store.completeExecution({ runId, memberTurnId: leader.id, content: "A dispatched",
      sourceTurn: { sessionAlias: "session_a", turnId: "source_a" }, now: NOW });
    settle(store, runId, assignment, "session_b", "source_b", "B done");
    const wake = store.listMemberTurns(runId).find((turn) => turn.followupSenderMemberTurnId === leader.id)!;
    const { claim: wakeClaim, started: wakeStarted } = claimAndStart(store, runId, wake, "session_a", "source_wake1");
    store.recordGroupResultRead(wakeStarted.id, assignment.assignmentId!);
    dispatch(store, wakeStarted, wakeClaim.dispatch.id, wakeClaim.dispatch.generation,
      "wake-handoff-1", "bot_c", "build on B", [assignment.assignmentId!]);
    expect(() => dispatch(store, wakeStarted, wakeClaim.dispatch.id, wakeClaim.dispatch.generation,
      "wake-handoff-1", "bot_c", "build on B", []))
      .toThrow("already committed with different arguments");
  } finally { store.close(); }
});

// ---------------------------------------------------------------- MCP schema
test("P5: group_send MCP schema accepts dependsOn and forwards it verbatim", async () => {
  const calls: unknown[] = [];
  const receipt = { runId: "run", assignmentId: "assignment", memberTurnId: "member", messageId: "message" };
  const transport = {
    ...createMemoryTransport(async () => ({ taskId: "unused", status: "running" })),
    async groupSend(input: unknown) { calls.push(input); return receipt; },
  };
  const registry = buildXacpxMcpToolRegistry({ transport, coordinatorSession: "group-execution:live",
    sourceHandle: "group-execution:live" });
  const send = registry.find((tool) => tool.name === "group_send")!;
  expect(send.description).toContain("dependsOn");
  expect(send.inputSchema.safeParse({ to: "bot_b", task: "work", dependsOn: ["a_1"] }).success).toBe(true);
  expect(send.inputSchema.safeParse({ to: "bot_b", task: "work", dependsOn: ["a_1", "a_1"] }).success).toBe(true);
  expect(send.inputSchema.safeParse({ to: "bot_b", task: "work", dependsOn: "a_1" }).success).toBe(false);
  expect(send.inputSchema.safeParse({ to: "bot_b", task: "work", dependsOn: Array.from({ length: 65 }, (_, i) => `a_${i}`) }).success).toBe(false);
  await send.handler({ to: "bot_b", task: "work", dependsOn: ["a_1"] }, { invocationId: "call" });
  expect(calls).toEqual([{ executionToken: "group-execution:live", invocationId: "call",
    args: { to: "bot_b", task: "work", dependsOn: ["a_1"] } }]);
});
