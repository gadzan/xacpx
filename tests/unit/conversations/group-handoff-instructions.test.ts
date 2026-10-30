import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { BotService } from "../../../src/bots/bot-service";
import { GroupHandoffService } from "../../../src/conversations/group-handoff";
import { SqliteConversationStore } from "../../../src/conversations/sqlite-conversation-store";
import { createEmptyState } from "../../../src/state/types";

const NOW = "2026-10-05T00:00:00.000Z";
const LEASE = "2026-10-05T01:00:00.000Z";
const snapshot = { revision: 1, capturedAt: NOW, presentation: { name: "Leader" }, behavior: {},
  execution: { agent: "codex", workspace: "backend" } };

async function harness() {
  const store = await SqliteConversationStore.open(join(mkdtempSync(join(tmpdir(), "xacpx-handoff-instructions-")), "conversations.sqlite"));
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
  const send = async (invocationId: string, to = "bot_b") => await handoffs.send({ executionToken: capability.token,
    invocationId, args: { to, task: "Collect evidence" } });
  const read = (args: unknown = {}) => handoffs.readResult({ executionToken: capability.token, args });
  return { store, handoffs, sender, accepted, send, read, context: () => handoffs.memberContext(capability.token) };
}

test("memberContext carries the canonical roster and no restated contract rules", async () => {
  const h = await harness();
  try {
    const roster = JSON.parse(h.context());
    expect(roster.members.map((member: { botId: string }) => member.botId).sort())
      .toEqual(["bot_a", "bot_b", "bot_c"]);
    expect(roster).toEqual({ members: expect.any(Array), omittedMemberCount: 0 });
    // Every behavioral rule lives in GROUP_COLLABORATION_CONTRACT; the roster
    // surface must not restate it.
    for (const rule of ["end your turn immediately", "do not wait, sleep, or poll",
      "wakes you exactly once", "refuses reads", "untrusted member data",
      "Use group_send", "Acceptance is durable", "execution has started"]) {
      expect(h.context()).not.toContain(rule);
    }
  } finally { h.handoffs.close(); h.store.close(); }
});

test("result reads refuse every page while the bound turn has its own DB-persisted unsettled handoffs", async () => {
  const h = await harness();
  try {
    const first = await h.send("first");
    const second = await h.send("second", "bot_c");
    for (const state of ["queued", "dispatched", "running"]) {
      h.store.directWriteForTest("member_turns", first.memberTurn.id, { state });
      for (const args of [{}, { assignmentId: "unrelated-result", offset: 0, limit: 1 }]) {
        expect(h.read(args)).toEqual({ kind: "pending-handoffs", mustEndTurn: true,
          pendingAssignmentIds: [first.memberTurn.assignmentId!, second.memberTurn.assignmentId!] });
      }
    }
    h.store.directWriteForTest("member_turns", first.memberTurn.id, { state: "completed" });
    expect(h.read()).toEqual({ kind: "pending-handoffs", mustEndTurn: true,
      pendingAssignmentIds: [second.memberTurn.assignmentId!] });
    h.store.directWriteForTest("member_turns", second.memberTurn.id, { state: "failed" });
    expect(h.read()).toMatchObject({ kind: "catalog", assignments: [
      { assignmentId: first.memberTurn.assignmentId, state: "completed" },
      { assignmentId: second.memberTurn.assignmentId, state: "failed" },
    ] });
  } finally { h.handoffs.close(); h.store.close(); }
});

for (const state of ["completed", "failed", "cancelled", "indeterminate"]) {
  test(`a ${state} handoff no longer refuses result reads`, async () => {
    const h = await harness();
    try {
      const receipt = await h.send("first");
      h.store.directWriteForTest("member_turns", receipt.memberTurn.id, { state });
      expect(h.read()).toMatchObject({ kind: "catalog", assignments: [{ assignmentId: receipt.memberTurn.assignmentId, state }] });
    } finally { h.handoffs.close(); h.store.close(); }
  });
}

test("handoffs owned by another physical source turn or another Run never refuse reads", async () => {
  const h = await harness();
  try {
    const receipt = await h.send("first");
    h.store.directWriteForTest("member_turns", receipt.memberTurn.id, { handoff_source_turn_id: "another-source" });
    expect(h.read()).toEqual({ kind: "catalog", assignments: [], nextOffset: null });
    const anotherRun = h.store.acceptRequest({ conversationId: "group", topicId: "topic", requestId: "another-request",
      botId: "bot_a", content: "Another request", profileSnapshot: snapshot, now: NOW });
    h.store.directWriteForTest("member_turns", receipt.memberTurn.id, {
      handoff_source_turn_id: "source", run_id: anotherRun.run.id,
    });
    expect(h.read()).toEqual({ kind: "catalog", assignments: [], nextOffset: null });
  } finally { h.handoffs.close(); h.store.close(); }
});

test("scoped cancellation retires read and fresh send authority without cancelling the Run", async () => {
  const h = await harness();
  try {
    h.store.cancelMemberTurn(h.accepted.run.id, h.sender.id, NOW);
    expect(h.store.getRun(h.accepted.run.id)?.completionReason).toBeUndefined();
    expect(() => h.read()).toThrow("live bound Group execution");
    await expect(h.send("after-cancel")).rejects.toThrow("sender no longer owns the current execution binding");
  } finally { h.handoffs.close(); h.store.close(); }
});
