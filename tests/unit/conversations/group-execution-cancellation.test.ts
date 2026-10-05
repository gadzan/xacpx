import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { SqliteConversationStore } from "../../../src/conversations/sqlite-conversation-store";
import { createSqlDriver } from "../../../src/conversations/sql-driver";
import { isRunCancelling } from "../../../src/conversations/conversation-store";

const NOW = "2026-10-06T00:00:00.000Z";
const snapshot = { revision: 1, capturedAt: NOW, presentation: { name: "Member" }, behavior: {},
  execution: { agent: "codex", workspace: "backend" } };

async function batch(extraUnstarted = false) {
  const path = join(mkdtempSync(join(tmpdir(), "xacpx-execution-cancel-")), "conversations.sqlite");
  const store = await SqliteConversationStore.open(path);
  const accepted = store.acceptRequest({ conversationId: "conversation_group", topicId: "topic_group",
    requestId: "request", botId: "bot_a", content: "human request", profileSnapshot: snapshot,
    mode: "automatic", primaryMember: { assignmentId: "a", origin: "router" },
    members: ["b", ...(extraUnstarted ? ["c", "d"] : [])].map((id) => ({
      botId: `bot_${id}`, profileSnapshot: snapshot, assignmentId: id, origin: "router" as const,
    })), now: NOW });
  for (const id of ["a", "b"]) {
    const claim = store.claimNextDispatch({ owner: "owner", now: NOW, leaseExpiresAt: "2026-10-06T00:01:00.000Z" })!;
    store.markExecutionStarted({ dispatchId: claim.dispatch.id, owner: "owner", generation: claim.dispatch.generation,
      runId: accepted.run.id, memberTurnId: claim.memberTurn.id, sessionAlias: `session_${id}`,
      logicalSessionId: `logical_${id}`, sourceTurnId: `source_${id}`, now: NOW });
  }
  return { store, path, accepted };
}

test("execution cancellation fences claimed and pending siblings across reopen without losing active evidence", async () => {
  const h = await batch(true);
  let store = h.store;
  const [a, b, c, d] = h.accepted.memberTurns;
  const runId = h.accepted.run.id;
  try {
    const held = store.claimNextDispatch({ owner: "owner", now: NOW, leaseExpiresAt: "2026-10-06T00:01:00.000Z" })!;
    expect(held.memberTurn.id).toBe(c!.id);
    store.completeCancel(runId, a!.id, NOW, false, true, "source_a");
    expect(store.getRun(runId)).toMatchObject({ state: "running", completionReason: "execution-cancelled", consumedMemberTurns: 1 });
    expect(store.getMemberTurn(b!.id)?.state).toBe("running");
    for (const member of [c!, d!]) {
      expect(store.getMemberTurn(member.id)?.state).toBe("cancelled");
      expect(store.getMemberTurn(member.id)?.startedAt).toBeUndefined();
      expect(store.getDispatchForMemberTurn(member.id)?.state).toBe("completed");
    }
    store.close(); store = await SqliteConversationStore.open(h.path);
    expect(isRunCancelling(store.getRun(runId)!)).toBe(true);
    expect(store.claimNextDispatch({ owner: "next", now: NOW, leaseExpiresAt: NOW })).toBeUndefined();
    expect(() => store.markExecutionStarted({ dispatchId: held.dispatch.id, owner: "owner", generation: held.dispatch.generation,
      runId, memberTurnId: c!.id, sessionAlias: "session_c", logicalSessionId: "logical_c", sourceTurnId: "source_c", now: NOW })).toThrow();
    // A duplicate provider settle must neither reset intent nor debit again.
    store.completeCancel(runId, a!.id, NOW, false, true, "source_a");
    store.completeExecution({ runId, memberTurnId: b!.id, content: "healthy result",
      sourceTurn: { sessionAlias: "session_b", turnId: "source_b" }, now: NOW });
    expect(store.getRun(runId)).toMatchObject({ state: "cancelled", completionReason: "execution-cancelled", consumedMemberTurns: 2, routingState: "done" });
    expect(store.getMemberResult(store.getMemberTurn(b!.id)!)?.content).toBe("healthy result");
    expect(store.automaticRunsAwaitingRouting()).toEqual([]);
  } finally { store.close(); }
});

for (const humanStop of [false, true]) {
for (const proof of ["completed", "failed"] as const) {
test(`${humanStop ? "human Stop overrides" : "execution cancellation keeps"} provenance through unknown sibling and late ${proof} proof`, async () => {
  const h = await batch();
  let store = h.store;
  const [a, b] = h.accepted.memberTurns;
  const runId = h.accepted.run.id;
  try {
    store.completeCancel(runId, a!.id, NOW, false, true, "source_a");
    if (humanStop) store.cancelRun(runId, NOW);
    store.completeCancel(runId, b!.id, NOW, true, true, "source_b");
    expect(store.getRun(runId)).toMatchObject({ state: "indeterminate", completionReason: "started_result_unknown" });
    store.close(); store = await SqliteConversationStore.open(h.path);
    store.reconcileLateResult({ runId, memberTurnId: b!.id, outcome: proof, content: "late proven result", reason: "late proven failure",
      sourceTurn: { sessionAlias: "session_b", turnId: "source_b" }, now: NOW });
    const expectedReason = proof === "failed" ? "execution-failed" : humanStop ? "human-cancelled" : "execution-cancelled";
    expect(store.getRun(runId)).toMatchObject({ state: proof === "failed" ? "failed" : "cancelled",
      completionReason: expectedReason, consumedMemberTurns: 2, routingState: "done" });
    expect(store.getMemberTurn(a!.id)?.state).toBe("cancelled");
    expect(store.getMemberTurn(b!.id)?.state).toBe(proof);
    expect(store.getMemberResult(store.getMemberTurn(b!.id)!)?.content).toBe(proof === "completed" ? "late proven result" : undefined);
    expect(store.automaticRunsAwaitingRouting()).toEqual([]);
    store.close(); store = await SqliteConversationStore.open(h.path);
    expect(store.getRun(runId)?.completionReason).toBe(expectedReason);
  } finally { store.close(); }
});
}
}

test("adding cancellation provenance preserves old live human intent and never refills the PR9 budget", async () => {
  const h = await batch();
  let store = h.store;
  const [a, b] = h.accepted.memberTurns;
  const runId = h.accepted.run.id;
  try {
    store.cancelRun(runId, NOW);
    store.close();
    const legacy = await createSqlDriver(h.path);
    try {
      legacy.exec("ALTER TABLE runs DROP COLUMN cancellation_reason");
      legacy.run("UPDATE runs SET max_member_turns = 2, consumed_member_turns = 0 WHERE id = ?", [runId]);
    } finally { legacy.close(); }
    store = await SqliteConversationStore.open(h.path);
    expect(isRunCancelling(store.getRun(runId)!)).toBe(true);
    store.completeCancel(runId, a!.id, NOW, false, true, "source_a");
    store.completeExecution({ runId, memberTurnId: b!.id, content: "healthy result",
      sourceTurn: { sessionAlias: "session_b", turnId: "source_b" }, now: NOW });
    expect(store.getRun(runId)).toMatchObject({ state: "cancelled", completionReason: "human-cancelled", maxMemberTurns: 2, consumedMemberTurns: 2 });
    store.close(); store = await SqliteConversationStore.open(h.path);
    expect(store.getRun(runId)).toMatchObject({ completionReason: "human-cancelled", maxMemberTurns: 2, consumedMemberTurns: 2 });
  } finally { store.close(); }
});
