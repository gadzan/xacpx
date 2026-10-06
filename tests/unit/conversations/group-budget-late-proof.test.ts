import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { SqliteConversationStore } from "../../../src/conversations/sqlite-conversation-store";

const NOW = "2026-10-05T00:00:00.000Z";
const snapshot = { revision: 1, capturedAt: NOW, presentation: { name: "Sender" }, behavior: {},
  execution: { agent: "codex", workspace: "backend" } };

async function exhaustedExecution(withPendingSibling = false) {
  const path = join(mkdtempSync(join(tmpdir(), "xacpx-budget-proof-")), "conversations.sqlite");
  const store = await SqliteConversationStore.open(path);
  const accepted = store.acceptRequest({ conversationId: "conversation_group", topicId: "topic_group",
    requestId: "request", botId: "bot_sender", content: "human request", profileSnapshot: snapshot,
    maxMemberTurns: withPendingSibling ? 2 : 1,
    ...(withPendingSibling ? { members: [{ botId: "bot_sibling", profileSnapshot: snapshot }] } : {}), now: NOW });
  const claim = store.claimNextDispatch({ owner: "owner", now: NOW, leaseExpiresAt: "2026-10-05T00:01:00.000Z" })!;
  const member = store.markExecutionStarted({ dispatchId: claim.dispatch.id, owner: "owner",
    generation: claim.dispatch.generation, runId: accepted.run.id, memberTurnId: claim.memberTurn.id,
    sessionAlias: "session", logicalSessionId: "logical", sourceTurnId: "source", now: NOW });
  expect(() => store.acceptPublicHandoff({ senderMemberTurnId: member.id, sourceTurnId: "source",
    dispatchId: claim.dispatch.id, owner: "owner", generation: claim.dispatch.generation,
    invocationId: "handoff", args: { to: "bot_target", task: "handoff task" },
    profileSnapshot: snapshot, now: NOW })).toThrow("Run work budget is exhausted");
  return { store, path, runId: accepted.run.id, memberId: member.id };
}

for (const proofPath of ["completeExecution", "failExecution", "reconcile-completed", "reconcile-failed"] as const) {
  for (const reopen of [false, true]) {
    test(`budget rejection survives sealed ${proofPath} proof${reopen ? " after reopen" : ""}`, async () => {
      const execution = await exhaustedExecution();
      let store = execution.store;
      const { runId, memberId } = execution;
      try {
        expect(store.failExecution({ runId, memberTurnId: memberId, sourceTurnId: "source", now: NOW,
          terminalState: "indeterminate", reason: "started_result_unknown" }).state).toBe("indeterminate");
        if (reopen) { store.close(); store = await SqliteConversationStore.open(execution.path); }
        const completed = proofPath === "completeExecution" || proofPath === "reconcile-completed";
        if (proofPath === "completeExecution") {
          store.completeExecution({ runId, memberTurnId: memberId, content: "proven result",
            sourceTurn: { sessionAlias: "session", turnId: "source" }, now: NOW });
        } else if (proofPath === "failExecution") {
          store.failExecution({ runId, memberTurnId: memberId, sourceTurnId: "source", reason: "proven failure", now: NOW });
        } else {
          store.reconcileLateResult({ runId, memberTurnId: memberId, outcome: completed ? "completed" : "failed",
            content: "proven result", reason: "proven failure", sourceTurn: { sessionAlias: "session", turnId: "source" }, now: NOW });
        }
        expect(store.getRun(runId)).toMatchObject({ state: "failed", completionReason: "budget-exhausted", consumedMemberTurns: 1 });
        const member = store.getMemberTurn(memberId)!;
        expect(member.state).toBe(completed ? "completed" : "failed");
        expect(store.getMemberResult(member)?.content).toBe(completed ? "proven result" : undefined);
        expect(store.getDispatchForMemberTurn(memberId)?.state).toBe("completed");
        expect(store.listMemberTurns(runId)).toHaveLength(1);
        expect(store.claimNextDispatch({ owner: "next", now: NOW, leaseExpiresAt: NOW })).toBeUndefined();
        store.close(); store = await SqliteConversationStore.open(execution.path);
        expect(store.getRun(runId)).toMatchObject({ state: "failed", completionReason: "budget-exhausted", consumedMemberTurns: 1 });
      } finally { store.close(); }
    });
  }
}

test("budget rejection keeps unproven execution indeterminate", async () => {
  const { store, runId, memberId } = await exhaustedExecution();
  try {
    store.failExecution({ runId, memberTurnId: memberId, sourceTurnId: "source", now: NOW,
      terminalState: "indeterminate", reason: "started_result_unknown" });
    expect(store.getRun(runId)).toMatchObject({ state: "indeterminate", completionReason: "started_result_unknown" });
  } finally { store.close(); }
});

for (const withPendingSibling of [false, true]) {
  for (const humanStop of [false, true]) {
    for (const reopen of [false, true]) {
      test(`budget rejection with execution cancellation preserves ${humanStop ? "live human" : "budget"} priority${withPendingSibling ? " and pending sibling" : ""}${reopen ? " after reopen" : ""}`, async () => {
        const execution = await exhaustedExecution(withPendingSibling);
        let store = execution.store;
        const { runId, memberId } = execution;
        try {
          if (humanStop) store.cancelRun(runId, NOW);
          if (reopen) { store.close(); store = await SqliteConversationStore.open(execution.path); }
          store.completeCancel(runId, memberId, NOW, false, true, "source");
          const expected = { state: humanStop ? "cancelled" : "failed",
            completionReason: humanStop ? "human-cancelled" : "budget-exhausted", consumedMemberTurns: 1 };
          expect(store.getRun(runId)).toMatchObject(expected);
          const members = store.listMemberTurns(runId);
          expect(members.map((member) => member.state)).toEqual(withPendingSibling ? ["cancelled", "cancelled"] : ["cancelled"]);
          for (const member of members) expect(store.getDispatchForMemberTurn(member.id)?.state).toBe("completed");
          expect(store.getRun(runId)?.quarantinedBotIds ?? []).toEqual([]);
          store.completeCancel(runId, memberId, NOW, false, true, "source");
          expect(store.getRun(runId)).toMatchObject(expected);
          store.close(); store = await SqliteConversationStore.open(execution.path);
          expect(store.getRun(runId)).toMatchObject(expected);
          expect(store.claimNextDispatch({ owner: "next", now: NOW, leaseExpiresAt: NOW })).toBeUndefined();
          expect(store.automaticRunsAwaitingRouting()).toEqual([]);
        } finally { store.close(); }
      });
    }
  }
}

for (const proof of ["completed", "failed"] as const) {
  test(`execution cancellation plus budget rejection keeps unknown sealed until late ${proof} proof`, async () => {
    const execution = await exhaustedExecution(true);
    let store = execution.store;
    const { runId, memberId } = execution;
    try {
      const claim = store.claimNextDispatch({ owner: "owner", now: NOW, leaseExpiresAt: "2026-10-05T00:01:00.000Z" })!;
      const sibling = store.markExecutionStarted({ dispatchId: claim.dispatch.id, owner: "owner", generation: claim.dispatch.generation,
        runId, memberTurnId: claim.memberTurn.id, sessionAlias: "sibling-session", logicalSessionId: "sibling-logical",
        sourceTurnId: "sibling-source", now: NOW });
      store.completeCancel(runId, memberId, NOW, false, true, "source");
      expect(store.getRun(runId)).toMatchObject({ state: "running", completionReason: "execution-cancelled" });
      store.completeCancel(runId, sibling.id, NOW, true, true, "sibling-source");
      expect(store.getRun(runId)).toMatchObject({ state: "indeterminate", completionReason: "started_result_unknown", consumedMemberTurns: 2 });
      store.close(); store = await SqliteConversationStore.open(execution.path);
      store.reconcileLateResult({ runId, memberTurnId: sibling.id, outcome: proof, content: "proven sibling result", reason: "proven sibling failure",
        sourceTurn: { sessionAlias: "sibling-session", turnId: "sibling-source" }, now: NOW });
      expect(store.getRun(runId)).toMatchObject({ state: "failed", completionReason: "budget-exhausted", consumedMemberTurns: 2 });
      expect(store.getMemberTurn(memberId)?.state).toBe("cancelled");
      expect(store.getMemberTurn(sibling.id)?.state).toBe(proof);
      expect(store.getMemberResult(store.getMemberTurn(sibling.id)!)?.content).toBe(proof === "completed" ? "proven sibling result" : undefined);
      expect(store.automaticRunsAwaitingRouting()).toEqual([]);
      store.close(); store = await SqliteConversationStore.open(execution.path);
      expect(store.getRun(runId)).toMatchObject({ state: "failed", completionReason: "budget-exhausted", consumedMemberTurns: 2 });
    } finally { store.close(); }
  });
}

for (const outcome of ["completed", "cancelled"] as const) {
  test(`human cancel after budget rejection retains proven ${outcome} classification`, async () => {
    const { store, runId, memberId } = await exhaustedExecution();
    try {
      store.cancelRun(runId, NOW);
      if (outcome === "completed") {
        store.completeExecution({ runId, memberTurnId: memberId, content: "proved before cancel",
          sourceTurn: { sessionAlias: "session", turnId: "source" }, now: NOW, forceRunTerminalOnSettle: true });
      } else { store.completeCancel(runId, memberId, NOW, false, true, "source"); }
      expect(store.getRun(runId)?.state).toBe(outcome);
      expect(store.getRun(runId)?.completionReason).toBe(outcome === "completed" ? "members-completed" : "human-cancelled");
    } finally { store.close(); }
  });
}

for (const proof of ["completed", "failed"] as const) {
  test(`late ${proof} proof retains budget rejection and cancelled sibling evidence after human stop`, async () => {
    const execution = await exhaustedExecution(true);
    let store = execution.store;
    const { runId, memberId } = execution;
    try {
      store.cancelRun(runId, NOW);
      store.completeCancel(runId, memberId, NOW, true, true, "source");
      expect(store.getRun(runId)?.state).toBe("indeterminate");
      store.close(); store = await SqliteConversationStore.open(execution.path);
      store.reconcileLateResult({ runId, memberTurnId: memberId, outcome: proof,
        content: "proven result", reason: "proven failure", sourceTurn: { sessionAlias: "session", turnId: "source" }, now: NOW });
      expect(store.getRun(runId)).toMatchObject({ state: "failed", completionReason: "budget-exhausted" });
      expect(store.listMemberTurns(runId)[1]?.state).toBe("cancelled");
      expect(store.claimNextDispatch({ owner: "next", now: NOW, leaseExpiresAt: NOW })).toBeUndefined();
    } finally { store.close(); }
  });
  test(`late ${proof} proof cannot erase the unknown sibling seal without human stop`, async () => {
    const execution = await exhaustedExecution(true);
    let store = execution.store;
    const { runId, memberId } = execution;
    try {
      store.failExecution({ runId, memberTurnId: memberId, sourceTurnId: "source", terminalState: "indeterminate",
        reason: "started_result_unknown", now: NOW });
      expect(store.listMemberTurns(runId)[1]?.state).toBe("indeterminate");
      store.close(); store = await SqliteConversationStore.open(execution.path);
      store.reconcileLateResult({ runId, memberTurnId: memberId, outcome: proof,
        content: "proven result", reason: "proven failure", sourceTurn: { sessionAlias: "session", turnId: "source" }, now: NOW });
      expect(store.getRun(runId)).toMatchObject({ state: "indeterminate", completionReason: "started_result_unknown" });
      expect(store.listMemberTurns(runId)[1]?.state).toBe("indeterminate");
      expect(store.claimNextDispatch({ owner: "next", now: NOW, leaseExpiresAt: NOW })).toBeUndefined();
    } finally { store.close(); }
  });
}
