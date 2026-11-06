import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { GroupHandoffService, MAX_GROUP_SAY_LENGTH, MAX_GROUP_SAY_PER_TURN } from "../../../src/conversations/group-handoff";
import { SqliteConversationStore } from "../../../src/conversations/sqlite-conversation-store";
import { createEmptyState } from "../../../src/state/types";

const NOW = "2026-11-06T00:00:00.000Z";
const LEASE = "2026-11-06T01:00:00.000Z";
const snapshot = { revision: 1, capturedAt: NOW, presentation: { name: "Speaker" }, behavior: {},
  execution: { agent: "codex", workspace: "backend" } };

async function harness(members = ["bot_a", "bot_b", "bot_c"]) {
  const store = await SqliteConversationStore.open(join(mkdtempSync(join(tmpdir(), "xacpx-group-say-")), "conversations.sqlite"),
    { publicMemoryMembers: (conversationId, topicId) => conversationId === "group" && topicId === "topic" ? members : undefined });
  const state = createEmptyState();
  for (const id of members) {
    state.bots[id] = { id, name: id, agent: "codex", workspace: "backend", enabled: true,
      profileRevision: 1, createdAt: NOW, updatedAt: NOW };
  }
  const bots = { getBot: (id: string) => { const bot = state.bots[id]; if (!bot) throw new Error(`unknown bot ${id}`); return bot; },
    runLifecycleAll: async <T,>(_ids: readonly string[], critical: () => Promise<T>) => await critical() };
  state.conversations.group = { id: "group", kind: "group", title: "Group", botIds: members, createdAt: NOW, updatedAt: NOW };
  state.conversation_topics.topic = { id: "topic", conversationId: "group", title: "Topic", status: "active",
    executionTarget: { workspace: "backend", isolation: "shared-single-writer" }, createdAt: NOW, updatedAt: NOW };
  const accepted = store.acceptRequest({ conversationId: "group", topicId: "topic", requestId: "request",
    botId: "bot_a", content: "Review the rollout plan", profileSnapshot: snapshot, maxMemberTurns: 8, now: NOW });
  const claim = store.claimNextDispatch({ owner: "owner", authorityEpoch: "epoch", now: NOW, leaseExpiresAt: LEASE })!;
  const started = store.markExecutionStarted({ dispatchId: claim.dispatch.id, owner: "owner", generation: claim.dispatch.generation,
    runId: accepted.run.id, memberTurnId: claim.memberTurn.id, sessionAlias: "session", logicalSessionId: "logical",
    sourceTurnId: "source", now: NOW });
  state.sessions.session = { alias: "session", agent: "codex", workspace: "backend", transport_session: "transport",
    logical_session_id: "logical", owner: { kind: "group-member", bindingId: "binding", botId: "bot_a",
      conversationId: "group", topicId: "topic" }, created_at: NOW, last_used_at: NOW };
  state.bot_runtime_bindings.binding = { id: "binding", scope: "group-member", botId: "bot_a", conversationId: "group",
    topicId: "topic", sessionAlias: "session", logicalSessionId: "logical", createdAt: NOW, updatedAt: NOW };
  let wakes = 0;
  const handoffs = new GroupHandoffService({ store, bots: bots as never, state, now: () => new Date(NOW),
    wake() { wakes += 1; } });
  const capability = handoffs.bindExecution({ senderMemberTurnId: started.id, sourceTurnId: "source",
    dispatchId: claim.dispatch.id, owner: "owner", generation: claim.dispatch.generation });
  const say = async (invocationId: string, text = "Reading the rollout plan.") =>
    await handoffs.say({ executionToken: capability.token, invocationId, args: { text } });
  const transcript = (topicId = "topic") => store.listMessages({ conversationId: "group", topicId, limit: 50 });
  const openTurn = (botId: string, requestId: string, sourceTurnId: string) => {
    state.conversation_topics.topic2 = { id: "topic2", conversationId: "group", title: "Topic 2", status: "active",
      executionTarget: { workspace: "backend", isolation: "shared-single-writer" }, createdAt: NOW, updatedAt: NOW };
    const accepted2 = store.acceptRequest({ conversationId: "group", topicId: "topic2", requestId, botId,
      content: "Second goal", profileSnapshot: snapshot, maxMemberTurns: 8, now: NOW });
    const claim2 = store.claimNextDispatch({ owner: "owner", authorityEpoch: "epoch", now: NOW, leaseExpiresAt: LEASE })!;
    const started2 = store.markExecutionStarted({ dispatchId: claim2.dispatch.id, owner: "owner",
      generation: claim2.dispatch.generation, runId: accepted2.run.id, memberTurnId: claim2.memberTurn.id,
      sessionAlias: `session_${botId}`, logicalSessionId: `logical_${botId}`, sourceTurnId, now: NOW });
    state.sessions[`session_${botId}`] = { alias: `session_${botId}`, agent: "codex", workspace: "backend",
      transport_session: "transport", logical_session_id: `logical_${botId}`, owner: { kind: "group-member",
        bindingId: `binding_${botId}`, botId, conversationId: "group", topicId: "topic2" }, created_at: NOW, last_used_at: NOW };
    state.bot_runtime_bindings[`binding_${botId}`] = { id: `binding_${botId}`, scope: "group-member", botId,
      conversationId: "group", topicId: "topic2", sessionAlias: `session_${botId}`,
      logicalSessionId: `logical_${botId}`, createdAt: NOW, updatedAt: NOW };
    const capability2 = handoffs.bindExecution({ senderMemberTurnId: started2.id, sourceTurnId,
      dispatchId: claim2.dispatch.id, owner: "owner", generation: claim2.dispatch.generation });
    return { accepted: accepted2, started: started2,
      say: async (invocationId: string, text: string) =>
        await handoffs.say({ executionToken: capability2.token, invocationId, args: { text } }) };
  };
  return { store, state, handoffs, started, accepted, say, transcript, wakes: () => wakes, capability, openTurn };
}

test("a group_say writes one public message and stops at the per-turn cap", async () => {
  const h = await harness();
  try {
    const first = await h.say("call-1");
    expect(first.reused).toBe(false);
    expect(first.remaining).toBe(MAX_GROUP_SAY_PER_TURN - 1);
    await h.say("call-2", "Comparing two rollback options.");
    await h.say("call-3", "Waiting on the migration check.");
    expect(h.transcript().filter((message) => message.role === "bot")).toHaveLength(3);

    const fourth = await h.say("call-4").then(() => null, (error: { code?: string }) => error);
    expect(fourth?.code).toBe("group_say_limit");
    expect(h.transcript().filter((message) => message.role === "bot")).toHaveLength(3);
  } finally { h.handoffs.close(); h.store.close(); }
});

test("a group_say wakes nobody and leaves dispatch and membership untouched", async () => {
  const h = await harness();
  try {
    const dispatchesBefore = h.store.listDispatchesForRun(h.accepted.run.id).length;
    const turnsBefore = h.store.listMemberTurns(h.accepted.run.id).length;
    await h.say("call-1");
    expect(h.wakes()).toBe(0);
    expect(h.store.listDispatchesForRun(h.accepted.run.id).length).toBe(dispatchesBefore);
    expect(h.store.listMemberTurns(h.accepted.run.id).length).toBe(turnsBefore);
    expect(h.store.getMemberTurn(h.started.id)?.state).toBe("running");
  } finally { h.handoffs.close(); h.store.close(); }
});

test("a group_say is projected into every current member's public memory", async () => {
  const h = await harness(["bot_a", "bot_b"]);
  try {
    await h.say("call-1");
    for (const botId of ["bot_a", "bot_b"]) {
      expect(h.store.listPublicMemory({ botId }).map((entry) => entry.content)).toEqual(["Review the rollout plan", "Reading the rollout plan."]);
    }
    expect(h.store.listPublicMemory({ botId: "bot_c" })).toEqual([]);
  } finally { h.handoffs.close(); h.store.close(); }
});

test("a final reply identical to the last group_say is not posted twice", async () => {
  const h = await harness();
  try {
    await h.say("call-1", "First note.");
    const spoken = await h.say("call-2", "Reading the rollout plan.");
    const completed = h.store.completeExecution({ runId: h.accepted.run.id, memberTurnId: h.started.id,
      content: "  Reading the rollout plan.  ", sourceTurn: { sessionAlias: "session", turnId: "source" }, now: LEASE });
    expect(completed.assistantMessage?.id).toBe(spoken.message.id);
    expect(h.transcript().filter((message) => message.role === "bot")).toHaveLength(2);
    expect(h.store.getMemberResult(h.store.getMemberTurn(h.started.id)!)?.content).toBe("Reading the rollout plan.");
  } finally { h.handoffs.close(); h.store.close(); }
});

test("a final reply that differs from the last group_say is posted in addition to it", async () => {
  const h = await harness();
  try {
    await h.say("call-1", "Reading the rollout plan.");
    const completed = h.store.completeExecution({ runId: h.accepted.run.id, memberTurnId: h.started.id,
      content: "The rollout plan is safe to ship.", sourceTurn: { sessionAlias: "session", turnId: "source" }, now: LEASE });
    expect(completed.assistantMessage?.content).toBe("The rollout plan is safe to ship.");
    expect(h.transcript().filter((message) => message.role === "bot").map((message) => message.content))
      .toEqual(["Reading the rollout plan.", "The rollout plan is safe to ship."]);
  } finally { h.handoffs.close(); h.store.close(); }
});

test("a replayed group_say invocation returns its first message instead of a second row", async () => {
  const h = await harness();
  try {
    const first = await h.say("call-1");
    const replay = await h.say("call-1");
    expect(replay.reused).toBe(true);
    expect(replay.message.id).toBe(first.message.id);
    expect(h.transcript().filter((message) => message.role === "bot")).toHaveLength(1);
    await expect(h.say("call-1", "Different text under the same invocation.")).rejects.toThrow();
  } finally { h.handoffs.close(); h.store.close(); }
});

test("a group_say refuses text past the length bound", async () => {
  const h = await harness();
  try {
    await expect(h.say("call-1", "x".repeat(MAX_GROUP_SAY_LENGTH + 1))).rejects.toThrow();
    expect(h.transcript().filter((message) => message.role === "bot")).toHaveLength(0);
  } finally { h.handoffs.close(); h.store.close(); }
});

test("the replay key is scoped to the execution, so two turns may share an invocation id", async () => {
  const h = await harness();
  try {
    await h.say("call-1", "Reading the rollout plan.");
    const other = h.openTurn("bot_b", "request-b", "source-b");
    const different = await other.say("call-1", "A different remark.");
    expect(different.reused).toBe(false);
    expect(different.message.senderBotId).toBe("bot_b");
    expect(h.transcript("topic2").filter((message) => message.role === "bot").map((message) => message.senderBotId))
      .toEqual(["bot_b"]);
    expect(h.transcript().filter((message) => message.role === "bot")).toHaveLength(1);

    const same = await other.say("call-1", "A different remark.");
    expect(same.reused).toBe(true);
    expect(h.transcript("topic2").filter((message) => message.role === "bot")).toHaveLength(1);
  } finally { h.handoffs.close(); h.store.close(); }
});

test("two turns writing the same text under the same invocation id keep their own rows", async () => {
  const h = await harness();
  try {
    await h.say("call-1", "Reading the rollout plan.");
    const other = h.openTurn("bot_b", "request-b", "source-b");
    const receipt = await other.say("call-1", "Reading the rollout plan.");
    expect(receipt.reused).toBe(false);
    const says = h.transcript("topic2").filter((message) => message.role === "bot");
    expect(says).toHaveLength(1);
    expect(receipt.message.id).toBe(says[0]!.id);
    expect(h.transcript().filter((message) => message.role === "bot").map((message) => message.senderBotId)).toEqual(["bot_a"]);
  } finally { h.handoffs.close(); h.store.close(); }
});

test("only the last group_say dedups the final reply", async () => {
  const h = await harness();
  try {
    await h.say("call-1", "First note.");
    await h.say("call-2", "Last note.");
    const completed = h.store.completeExecution({ runId: h.accepted.run.id, memberTurnId: h.started.id,
      content: "First note.", sourceTurn: { sessionAlias: "session", turnId: "source" }, now: LEASE });
    expect(completed.assistantMessage?.content).toBe("First note.");
    expect(h.transcript().filter((message) => message.role === "bot").map((message) => message.content))
      .toEqual(["First note.", "Last note.", "First note."]);

    const h2 = await harness();
    try {
      await h2.say("call-1", "First note.");
      const last = await h2.say("call-2", "Last note.");
      const promoted = h2.store.completeExecution({ runId: h2.accepted.run.id, memberTurnId: h2.started.id,
        content: "Last note.", sourceTurn: { sessionAlias: "session", turnId: "source" }, now: LEASE });
      expect(promoted.assistantMessage?.id).toBe(last.message.id);
      expect(h2.transcript().filter((message) => message.role === "bot")).toHaveLength(2);
    } finally { h2.handoffs.close(); h2.store.close(); }
  } finally { h.handoffs.close(); h.store.close(); }
});

test("dedup compares whitespace the way the runtime trimmed the text", async () => {
  const h = await harness();
  try {
    const said = await h.say("call-1", "Reading the rollout plan.");
    const completed = h.store.completeExecution({ runId: h.accepted.run.id, memberTurnId: h.started.id,
      content: "Reading the rollout plan.\n", sourceTurn: { sessionAlias: "session", turnId: "source" }, now: LEASE });
    expect(completed.assistantMessage?.id).toBe(said.message.id);
    expect(h.transcript().filter((message) => message.role === "bot")).toHaveLength(1);
  } finally { h.handoffs.close(); h.store.close(); }
});
