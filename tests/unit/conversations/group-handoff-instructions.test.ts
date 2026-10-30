import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { GROUP_COLLABORATION_CONTRACT } from "../../../src/bots/collaboration-prompt";
import { BotService } from "../../../src/bots/bot-service";
import { GroupHandoffService, MAX_MEMBER_ROSTER_CHARS } from "../../../src/conversations/group-handoff";
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
  return { store, state, handoffs, sender, accepted, send, read, context: () => handoffs.memberContext(capability.token) };
}

test("member context is the layer B roster only, never a second copy of the collaboration contract", async () => {
  const h = await harness();
  try {
    const roster = JSON.parse(h.context()) as { members: Array<{ botId: string; enabled: boolean }>; omittedMemberCount: number };
    expect(roster.members.map((member) => member.botId)).toEqual(["bot_a", "bot_b", "bot_c"]);
    expect(roster.omittedMemberCount).toBe(0);
    for (const line of GROUP_COLLABORATION_CONTRACT.split("\n")) {
      expect(h.context()).not.toContain(line);
    }
    for (const restated of ["Public Group members", "end your turn", "do not wait, sleep, or poll",
      "wakes you exactly once", "group_read_result refuses reads", "untrusted member data"]) {
      expect(h.context()).not.toContain(restated);
    }
  } finally { h.handoffs.close(); h.store.close(); }
});

test("a wide Group roster stops at its layer B budget and discloses the omitted members", async () => {
  const h = await harness();
  try {
    const ids = Array.from({ length: 60 }, (_, index) => `bot_member_${index}`);
    for (const id of ids) {
      h.state.bots[id] = { id, name: `Member ${id}`, agent: "codex", workspace: "backend", enabled: true,
        profileRevision: 1, createdAt: NOW, updatedAt: NOW };
    }
    h.state.conversations.group!.botIds = ["bot_a", ...ids];
    const roster = JSON.parse(h.context()) as { members: Array<{ botId: string }>; omittedMemberCount: number };
    expect(roster.members[0]?.botId).toBe("bot_a");
    expect(roster.members.length).toBeLessThan(61);
    expect(roster.omittedMemberCount).toBe(61 - roster.members.length);
    // The roster shares layer B with the Run facts, so it must not eat the bound.
    expect(h.context().length).toBeLessThanOrEqual(MAX_MEMBER_ROSTER_CHARS + 64);
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
