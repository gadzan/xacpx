import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { GroupHandoffService } from "../../../src/conversations/group-handoff";
import { SqliteConversationStore } from "../../../src/conversations/sqlite-conversation-store";
import { createEmptyState } from "../../../src/state/types";

const NOW = "2026-11-06T00:00:00.000Z";
const LATER = "2026-11-06T00:05:00.000Z";
const LEASE = "2026-11-06T01:00:00.000Z";
const STATUS = "No public reply from Speaker.";
const snapshot = { revision: 1, capturedAt: NOW, presentation: { name: "Speaker" }, behavior: {},
  execution: { agent: "codex", workspace: "backend" } };

/** A public Group Topic with one claimed, started member turn: the exact state
 *  the dispatcher hands to `store.completeExecution`. */
async function harness(gate: "group" | "direct" = "group") {
  const store = await SqliteConversationStore.open(join(mkdtempSync(join(tmpdir(), "xacpx-fallback-")), "conversations.sqlite"),
    { publicMemoryMembers: (conversationId, topicId) =>
      gate === "group" && conversationId === "group" && topicId === "topic" ? ["bot_a", "bot_b"] : undefined });
  const state = createEmptyState();
  for (const id of ["bot_a", "bot_b"]) {
    state.bots[id] = { id, name: id, agent: "codex", workspace: "backend", enabled: true,
      profileRevision: 1, createdAt: NOW, updatedAt: NOW };
  }
  const bots = { getBot: (id: string) => { const bot = state.bots[id]; if (!bot) throw new Error(`unknown bot ${id}`); return bot; },
    runLifecycleAll: async <T,>(_ids: readonly string[], critical: () => Promise<T>) => await critical() };
  state.conversations.group = { id: "group", kind: "group", title: "Group", botIds: ["bot_a", "bot_b"],
    createdAt: NOW, updatedAt: NOW };
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
  const handoffs = new GroupHandoffService({ store, bots: bots as never, state, now: () => new Date(NOW), wake() {} });
  const capability = handoffs.bindExecution({ senderMemberTurnId: started.id, sourceTurnId: "source",
    dispatchId: claim.dispatch.id, owner: "owner", generation: claim.dispatch.generation });
  const say = async (invocationId: string, text = "Reading the rollout plan.") =>
    await handoffs.say({ executionToken: capability.token, invocationId, args: { text } });
  const transcript = () => store.listMessages({ conversationId: "group", topicId: "topic", limit: 50 });
  const statusRows = () => transcript().filter((message) => message.role === "system" && !message.handoff);
  const settle = (content: string, now = LATER) => store.completeExecution({ runId: accepted.run.id,
    memberTurnId: started.id, content, sourceTurn: { sessionAlias: "session", turnId: "source" }, now });
  return { store, handoffs, accepted, started, say, transcript, statusRows, settle };
}

test("an empty final reply with no group_say posts one status row instead of an empty bubble", async () => {
  const h = await harness();
  try {
    const completed = h.settle("");
    expect(completed.statusMessage?.role).toBe("system");
    expect(completed.statusMessage?.content).toBe(STATUS);
    // The settled evidence row stays: getMemberResult owns it, with empty text.
    expect(completed.assistantMessage?.content).toBe("");
    expect(h.store.getMemberResult(h.store.getMemberTurn(h.started.id)!)?.id).toBe(completed.assistantMessage?.id);
    expect(h.transcript().map((message) => [message.role, message.content])).toEqual([
      ["human", "Review the rollout plan"],
      ["bot", ""],
      ["system", STATUS],
    ]);
    expect(h.store.getMemberTurn(h.started.id)?.state).toBe("completed");
  } finally { h.handoffs.close(); h.store.close(); }
});

test("whitespace-only final text counts as no final text", async () => {
  const h = await harness();
  try {
    const completed = h.settle("  \n\t ");
    expect(completed.statusMessage?.content).toBe(STATUS);
    expect(h.statusRows()).toHaveLength(1);
  } finally { h.handoffs.close(); h.store.close(); }
});

test("the status row never enters public memory", async () => {
  const h = await harness();
  try {
    h.settle("");
    for (const botId of ["bot_a", "bot_b"]) {
      const contents = h.store.listPublicMemory({ botId }).map((entry) => entry.content);
      expect(contents).toEqual(["Review the rollout plan"]);
      expect(contents).not.toContain(STATUS);
    }
  } finally { h.handoffs.close(); h.store.close(); }
});

test("an empty final reply after a group_say keeps the spoken message and posts no status", async () => {
  const h = await harness();
  try {
    const spoken = await h.say("call-1");
    const completed = h.settle("");
    expect(completed.statusMessage).toBeUndefined();
    expect(h.statusRows()).toHaveLength(0);
    expect(h.transcript().map((message) => [message.role, message.content])).toEqual([
      ["human", "Review the rollout plan"],
      ["bot", spoken.message.content],
      ["bot", ""],
    ]);
  } finally { h.handoffs.close(); h.store.close(); }
});

test("an identical final reply is promoted to the group_say and no status appears", async () => {
  const h = await harness();
  try {
    const spoken = await h.say("call-1");
    const completed = h.settle(`  ${spoken.message.content}  `);
    expect(completed.assistantMessage?.id).toBe(spoken.message.id);
    expect(completed.statusMessage).toBeUndefined();
    expect(h.statusRows()).toHaveLength(0);
    expect(h.transcript().filter((message) => message.role === "bot")).toHaveLength(1);
  } finally { h.handoffs.close(); h.store.close(); }
});

test("a Direct topic keeps its silence: no status narration", async () => {
  const h = await harness("direct");
  try {
    const completed = h.settle("");
    expect(completed.statusMessage).toBeUndefined();
    expect(h.statusRows()).toHaveLength(0);
    expect(h.transcript().filter((message) => message.role === "bot").map((message) => message.content)).toEqual([""]);
  } finally { h.handoffs.close(); h.store.close(); }
});

test("cancellation settlement posts the same status for an empty final reply", async () => {
  const h = await harness();
  try {
    h.store.cancelRun(h.accepted.run.id, NOW, "human-cancelled");
    const settled = h.store.settleCancelBatch({ runId: h.accepted.run.id, now: LATER, outcomes: [{
      memberTurnId: h.started.id, outcome: "completed", content: "",
      sourceTurn: { sessionAlias: "session", turnId: "source" },
    }] });
    expect(settled.settled[0]?.statusMessage?.content).toBe(STATUS);
    expect(h.statusRows().map((message) => message.content)).toEqual([STATUS]);
  } finally { h.handoffs.close(); h.store.close(); }
});

test("a late proof under cancel intent posts one status and never a second", async () => {
  const h = await harness();
  try {
    h.store.cancelRun(h.accepted.run.id, NOW, "human-cancelled");
    const late = h.store.reconcileLateResult({ runId: h.accepted.run.id, memberTurnId: h.started.id,
      outcome: "completed", content: "", sourceTurn: { sessionAlias: "session", turnId: "source" }, now: LATER });
    expect(late.reconciled).toBe(true);
    expect(late.statusMessage?.content).toBe(STATUS);
    const replay = h.store.reconcileLateResult({ runId: h.accepted.run.id, memberTurnId: h.started.id,
      outcome: "completed", content: "", sourceTurn: { sessionAlias: "session", turnId: "source" }, now: LATER });
    expect(replay.reconciled).toBe(false);
    expect(h.statusRows()).toHaveLength(1);
  } finally { h.handoffs.close(); h.store.close(); }
});

test("a proven result for a sealed member posts exactly one status", async () => {
  const h = await harness();
  try {
    h.store.cancelRun(h.accepted.run.id, NOW, "human-cancelled");
    const sealed = h.store.settleCancelBatch({ runId: h.accepted.run.id, now: LATER, outcomes: [{
      memberTurnId: h.started.id, outcome: "unknown",
    }] });
    expect(sealed.run.state).toBe("indeterminate");
    const late = h.store.reconcileLateResult({ runId: h.accepted.run.id, memberTurnId: h.started.id,
      outcome: "completed", content: "", sourceTurn: { sessionAlias: "session", turnId: "source" }, now: LATER });
    expect(late.reconciled).toBe(true);
    expect(late.statusMessage?.content).toBe(STATUS);
    expect(h.statusRows()).toHaveLength(1);
    expect(h.store.listPublicMemory({ botId: "bot_b" }).map((entry) => entry.content)).not.toContain(STATUS);
  } finally { h.handoffs.close(); h.store.close(); }
});
