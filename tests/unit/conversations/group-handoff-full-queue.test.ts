import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { MAX_QUEUED_RUNS_PER_TOPIC } from "../../../src/conversations/conversation-store";
import { SqliteConversationStore } from "../../../src/conversations/sqlite-conversation-store";

const NOW = "2026-10-05T00:00:00.000Z";
const LEASE = "2026-10-05T01:00:00.000Z";
const snapshot = { revision: 1, capturedAt: NOW, presentation: { name: "Member" }, behavior: {},
  execution: { agent: "codex", workspace: "backend" } };

async function fullQueue(maxMemberTurns = 4) {
  const path = join(mkdtempSync(join(tmpdir(), "xacpx-handoff-full-queue-")), "conversations.sqlite");
  const store = await SqliteConversationStore.open(path);
  const request = { conversationId: "conversation_group", topicId: "topic_group", botId: "bot_a",
    content: "human request", profileSnapshot: snapshot, maxMemberTurns, now: NOW };
  const accepted = store.acceptRequest({ ...request, requestId: "active" });
  const claim = store.claimNextDispatch({ owner: "owner", now: NOW, leaseExpiresAt: LEASE })!;
  const member = store.markExecutionStarted({ dispatchId: claim.dispatch.id, owner: "owner",
    generation: claim.dispatch.generation, runId: accepted.run.id, memberTurnId: claim.memberTurn.id,
    sessionAlias: "session_a", logicalSessionId: "logical_a", sourceTurnId: "source_a", now: NOW });
  for (let i = 1; i < MAX_QUEUED_RUNS_PER_TOPIC; i++) {
    store.acceptRequest({ ...request, requestId: `queued-${i}` });
  }
  const handoff = { senderMemberTurnId: member.id, sourceTurnId: "source_a", dispatchId: claim.dispatch.id,
    owner: "owner", generation: claim.dispatch.generation, invocationId: "handoff",
    args: { to: "bot_b", task: "finish the active Run" }, profileSnapshot: snapshot, now: NOW };
  return { store, path, request, accepted, member, handoff };
}

for (const reopen of [false, true]) {
  test(`a full Topic queue permits bounded handoff in its existing Run${reopen ? " after reopen" : ""}`, async () => {
    const execution = await fullQueue();
    let store = execution.store;
    const { request, accepted, member, handoff } = execution;
    try {
      if (reopen) { store.close(); store = await SqliteConversationStore.open(execution.path); }
      expect(() => store.acceptRequest({ ...request, requestId: "overflow" })).toThrow("already has 64 nonterminal runs");
      const receipt = store.acceptPublicHandoff(handoff);
      expect(receipt.reused).toBe(false);
      expect(receipt.run.id).toBe(accepted.run.id);
      expect(receipt.memberTurn).toMatchObject({ state: "queued", origin: "handoff", botId: "bot_b" });
      expect(receipt.memberTurn.triggerMessageIds).toEqual([accepted.message.id, receipt.message.id]);
      const replay = store.acceptPublicHandoff(handoff);
      expect(replay.reused).toBe(true);
      expect(replay.memberTurn.id).toBe(receipt.memberTurn.id);
      expect(store.listMemberTurns(accepted.run.id)).toHaveLength(2);
      expect(store.listDispatchesForRun(accepted.run.id)).toHaveLength(2);
      expect(store.listRuns(request.conversationId, request.topicId)).toHaveLength(MAX_QUEUED_RUNS_PER_TOPIC);
      expect(() => store.acceptRequest({ ...request, requestId: "overflow" })).toThrow("already has 64 nonterminal runs");
      // The handoff uses the current Run's dispatch order before every queued
      // request; completing it releases precisely one slot for new admission.
      store.completeExecution({ runId: accepted.run.id, memberTurnId: member.id, content: "A done",
        sourceTurn: { sessionAlias: "session_a", turnId: "source_a" }, now: NOW });
      const targetClaim = store.claimNextDispatch({ owner: "owner", now: NOW, leaseExpiresAt: LEASE })!;
      expect(targetClaim.memberTurn.id).toBe(receipt.memberTurn.id);
      const target = store.markExecutionStarted({ dispatchId: targetClaim.dispatch.id, owner: "owner",
        generation: targetClaim.dispatch.generation, runId: accepted.run.id, memberTurnId: targetClaim.memberTurn.id,
        sessionAlias: "session_b", logicalSessionId: "logical_b", sourceTurnId: "source_b", now: NOW });
      store.completeExecution({ runId: accepted.run.id, memberTurnId: target.id, content: "B done",
        sourceTurn: { sessionAlias: "session_b", turnId: "source_b" }, now: NOW });
      expect(store.getRun(accepted.run.id)).toMatchObject({ state: "completed", consumedMemberTurns: 2 });
      expect(store.acceptRequest({ ...request, requestId: "after-completion" }).reused).toBe(false);
    } finally { store.close(); }
  });
}

for (const barrier of ["conversation", "topic"] as const) {
  test(`full queue handoff still respects the ${barrier} delete barrier`, async () => {
    const { store, request, accepted, handoff } = await fullQueue();
    try {
      if (barrier === "conversation") store.markConversationDeleting(request.conversationId, NOW);
      else store.markTopicDeleting(request.topicId, request.conversationId, NOW);
      expect(() => store.acceptPublicHandoff(handoff)).toThrow(`${barrier} "${barrier === "conversation" ? request.conversationId : request.topicId}" is deleting`);
      expect(store.listMemberTurns(accepted.run.id)).toHaveLength(1);
      expect(store.listDispatchesForRun(accepted.run.id)).toHaveLength(1);
      expect(store.getPublicHandoff("source_a", "handoff", handoff.args)).toBeUndefined();
    } finally { store.close(); }
  });
}

test("a full Topic queue never bypasses the existing Run's handoff budget", async () => {
  const { store, accepted, member, handoff } = await fullQueue(1);
  try {
    expect(() => store.acceptPublicHandoff(handoff)).toThrow("Run work budget is exhausted");
    expect(store.listMemberTurns(accepted.run.id)).toHaveLength(1);
    store.completeExecution({ runId: accepted.run.id, memberTurnId: member.id, content: "A done",
      sourceTurn: { sessionAlias: "session_a", turnId: "source_a" }, now: NOW });
    expect(store.getRun(accepted.run.id)).toMatchObject({ state: "failed", completionReason: "budget-exhausted" });
  } finally { store.close(); }
});
