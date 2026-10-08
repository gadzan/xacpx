import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { SqliteConversationStore } from "../../../src/conversations/sqlite-conversation-store";

const NOW = "2026-10-05T00:00:00.000Z";
const LEASE = "2026-10-05T00:01:00.000Z";
const EXPIRED = "2026-10-05T00:02:00.000Z";
const snapshot = { revision: 1, capturedAt: NOW, presentation: { name: "Member" }, behavior: {},
  execution: { agent: "codex", workspace: "backend" } };

async function sealedPendingRetry(startRetry = false) {
  const path = join(mkdtempSync(join(tmpdir(), "xacpx-retired-proof-")), "conversations.sqlite");
  const store = await SqliteConversationStore.open(path);
  const accepted = store.acceptRequest({ conversationId: "conversation_group", topicId: "topic_group",
    requestId: "request", botId: "bot_a", content: "human request", profileSnapshot: snapshot,
    maxMemberTurns: 4, primaryMember: { assignmentId: "A", task: "Task A", effect: "read-only",
      effectProvenance: "declared-enforced" }, members: [{ botId: "bot_b", profileSnapshot: snapshot,
      assignmentId: "B", task: "Task B", effect: "read-only", effectProvenance: "declared-enforced" }], now: NOW });
  const first = store.claimNextDispatch({ owner: "owner", now: NOW, leaseExpiresAt: LEASE })!;
  const a = store.markExecutionStarted({ dispatchId: first.dispatch.id, owner: "owner",
    generation: first.dispatch.generation, runId: accepted.run.id, memberTurnId: first.memberTurn.id,
    sessionAlias: "session_a", logicalSessionId: "logical_a", sourceTurnId: "retired_a", now: NOW });
  const second = store.claimNextDispatch({ owner: "owner", now: NOW,
    leaseExpiresAt: "2026-10-05T01:00:00.000Z" })!;
  const b = store.markExecutionStarted({ dispatchId: second.dispatch.id, owner: "owner",
    generation: second.dispatch.generation, runId: accepted.run.id, memberTurnId: second.memberTurn.id,
    sessionAlias: "session_b", logicalSessionId: "logical_b", sourceTurnId: "live_b", now: NOW });
  expect(store.recoverExpiredClaims(EXPIRED).map((entry) => entry.outcome)).toEqual(["requeued"]);
  expect(store.getMemberTurn(a.id)).toMatchObject({ attempt: 2, state: "queued" });
  expect(store.getMemberTurn(a.id)?.sourceTurnId).toBeUndefined();
  if (startRetry) {
    const retry = store.claimNextDispatch({ owner: "new_owner", now: EXPIRED,
      leaseExpiresAt: "2026-10-05T01:00:00.000Z" })!;
    expect(retry.memberTurn.id).toEqual(a.id);
    store.markExecutionStarted({ dispatchId: retry.dispatch.id, owner: "new_owner",
      generation: retry.dispatch.generation, runId: accepted.run.id, memberTurnId: a.id,
      sessionAlias: "new_session_a", logicalSessionId: "logical_a", sourceTurnId: "current_a", now: EXPIRED });
  }
  store.failExecution({ runId: accepted.run.id, memberTurnId: b.id, sourceTurnId: "live_b", now: EXPIRED,
    terminalState: "indeterminate", reason: "started_result_unknown" });
  return { store, path, runId: accepted.run.id, aId: a.id, bId: b.id };
}

for (const outcome of ["completed", "failed"] as const) {
  for (const reopen of [false, true]) {
    test(`current retry ${outcome} late proof preserves exact attempt evidence${reopen ? " after reopen" : ""}`, async () => {
      const execution = await sealedPendingRetry(true);
      let store = execution.store;
      const { runId, aId, bId } = execution;
      try {
        if (reopen) { store.close(); store = await SqliteConversationStore.open(execution.path); }
        expect(store.reconcileLateResult({ runId, memberTurnId: aId, outcome, content: "CURRENT A RESULT",
          reason: "CURRENT A FAILURE", sourceTurn: { sessionAlias: "new_session_a", turnId: "current_a" },
          now: EXPIRED }).reconciled).toBe(true);
        expect(store.getMemberTurn(aId)).toMatchObject({ attempt: 2, state: outcome, sourceTurnId: "current_a" });
        expect(store.getMemberResult(store.getMemberTurn(aId)!)?.content).toBe(outcome === "completed" ? "CURRENT A RESULT" : undefined);
        store.reconcileLateResult({ runId, memberTurnId: bId, outcome: "completed", content: "CURRENT B RESULT",
          sourceTurn: { sessionAlias: "session_b", turnId: "live_b" }, now: EXPIRED });
        expect(store.getRun(runId)).toMatchObject({ state: outcome, consumedMemberTurns: 3 });
        expect(store.claimNextDispatch({ owner: "next", now: EXPIRED, leaseExpiresAt: EXPIRED })).toBeUndefined();
        expect(() => store.reconcileLateResult({ runId, memberTurnId: aId, outcome, content: "RETIRED RESULT",
          sourceTurn: { sessionAlias: "session_a", turnId: "retired_a" }, now: EXPIRED })).toThrow("retired recovery attempt");
      } finally { store.close(); }
    });
  }
}

for (const outcome of ["completed", "failed"] as const) {
  for (const reopen of [false, true]) {
    test(`retired ${outcome} late proof cannot settle a sealed pending retry${reopen ? " after reopen" : ""}`, async () => {
      const execution = await sealedPendingRetry();
      let store = execution.store;
      const { runId, aId, bId } = execution;
      try {
        if (reopen) { store.close(); store = await SqliteConversationStore.open(execution.path); }
        const beforeRun = store.getRun(runId);
        const beforeMember = store.getMemberTurn(aId);
        const beforeDispatches = store.listDispatchesForRun(runId);
        const beforeMessages = store.listMessages({ conversationId: "conversation_group", topicId: "topic_group", limit: 100 });
        expect(() => store.reconcileLateResult({ runId, memberTurnId: aId, outcome,
          content: "RETIRED RESULT", reason: "RETIRED FAILURE",
          sourceTurn: { sessionAlias: "session_a", turnId: "retired_a" }, now: EXPIRED })).toThrow("retired recovery attempt");
        expect(store.getRun(runId)).toEqual(beforeRun);
        expect(store.getMemberTurn(aId)).toEqual(beforeMember);
        expect(store.listDispatchesForRun(runId)).toEqual(beforeDispatches);
        expect(store.listMessages({ conversationId: "conversation_group", topicId: "topic_group", limit: 100 })).toEqual(beforeMessages);
        // Exact proof for the still-current sibling remains durable. The
        // unstarted retry is cancelled, not labeled unknown, and its absence
        // cannot be reported as a successful Run.
        expect(store.reconcileLateResult({ runId, memberTurnId: bId, outcome: "completed", content: "B CURRENT RESULT",
          sourceTurn: { sessionAlias: "session_b", turnId: "live_b" }, now: EXPIRED }).reconciled).toBe(true);
        expect(store.getMemberTurn(aId)).toMatchObject({ attempt: 2, state: "cancelled" });
        expect(store.getMemberTurn(aId)?.startedAt).toBeUndefined();
        expect(store.getRun(runId)).toMatchObject({
          state: "cancelled", completionReason: "execution-cancelled", consumedMemberTurns: 2,
        });
        expect(store.getMemberResult(store.getMemberTurn(bId)!)?.content).toBe("B CURRENT RESULT");
        expect(store.getMemberResult(store.getMemberTurn(aId)!)).toBeUndefined();
        expect(store.claimNextDispatch({ owner: "next", now: EXPIRED, leaseExpiresAt: EXPIRED })).toBeUndefined();
      } finally { store.close(); }
    });
  }
}

for (const outcome of ["completed", "failed"] as const) {
  test(`unstarted sealed retry ignores uncorrelated ${outcome} evidence`, async () => {
    const { store, runId, aId } = await sealedPendingRetry();
    try {
      const beforeMember = store.getMemberTurn(aId);
      const beforeRun = store.getRun(runId);
      const result = store.reconcileLateResult({ runId, memberTurnId: aId, outcome, content: "NO PHYSICAL EXECUTION",
        reason: "NO PHYSICAL EXECUTION", sourceTurn: { sessionAlias: "session_a" }, now: EXPIRED });
      expect(result.reconciled).toBe(false);
      expect(store.getMemberTurn(aId)).toEqual(beforeMember);
      expect(store.getRun(runId)).toEqual(beforeRun);
      expect(store.listMessages({ conversationId: "conversation_group", topicId: "topic_group", limit: 100 })).toHaveLength(1);
    } finally { store.close(); }
  });
}
