import { expect, test } from "bun:test";
import { GroupHandoffService } from "../../../src/conversations/group-handoff";
import { parseRoundtableSpeech } from "../../../src/conversations/conversation-roundtable";
import { createEmptyState } from "../../../src/state/types";
import { harness, until } from "./fixtures/concurrency-harness";
import {
  acceptRoundtable,
  completeTurn,
  openRoundtableStore,
  RT_CONVERSATION,
  RT_NOW,
  RT_OWNER,
  RT_SNAPSHOT,
  RT_TOPIC,
  startTurn,
} from "./fixtures/roundtable-harness";

test("parseRoundtableSpeech treats only exact (pass) as abstention and empty as failure", () => {
  expect(parseRoundtableSpeech("(pass)")).toEqual({ outcome: "pass" });
  expect(parseRoundtableSpeech("  (PASS)\n")).toEqual({ outcome: "pass" });
  expect(parseRoundtableSpeech("")).toEqual({ outcome: "empty" });
  expect(parseRoundtableSpeech("   \n ")).toEqual({ outcome: "empty" });
  expect(parseRoundtableSpeech("we should (pass) on this")).toEqual({
    outcome: "message",
    content: "we should (pass) on this",
  });
});

test("a pass completes the turn and writes no public message", async () => {
  const store = await openRoundtableStore();
  try {
    const accepted = acceptRoundtable(store, { botIds: ["bot_a", "bot_b"] });
    const turn = store.listMemberTurns(accepted.run.id)[0]!;
    completeTurn(store, accepted.run.id, turn.id, { pass: true });
    const settled = store.getMemberTurn(turn.id)!;
    expect(settled.state).toBe("completed");
    expect(settled.speechOutcome).toBe("pass");
    expect(store.getDispatchForMemberTurn(turn.id)?.state).toBe("completed");
    expect(store.getRun(accepted.run.id)?.consumedMemberTurns).toBe(1);
    expect(store.listMessages({ conversationId: RT_CONVERSATION, topicId: RT_TOPIC, limit: 20 })
      .filter((message) => message.role === "bot")).toHaveLength(0);
    expect(store.getRunWorkOutcome(accepted.run.id)?.lead?.sawCompletion).toBe(false);
  } finally {
    store.close();
  }
});

test("all speakers passing completes the Run with roundtable-no-speech", async () => {
  const store = await openRoundtableStore();
  try {
    const accepted = acceptRoundtable(store, { botIds: ["bot_a", "bot_b"], rounds: 2 });
    const turns = store.listMemberTurns(accepted.run.id);
    for (const turn of turns) completeTurn(store, accepted.run.id, turn.id, { pass: true });
    expect(store.getRun(accepted.run.id)).toMatchObject({
      state: "completed",
      completionReason: "roundtable-no-speech",
    });
    expect(store.listMessages({ conversationId: RT_CONVERSATION, topicId: RT_TOPIC, limit: 20 })
      .filter((message) => message.role === "bot")).toHaveLength(0);
    expect(store.getRunWorkOutcome(accepted.run.id)?.lead?.sawCompletion).toBe(false);
  } finally {
    store.close();
  }
});

test("one real speech alongside passes completes as members-completed", async () => {
  const store = await openRoundtableStore();
  try {
    const accepted = acceptRoundtable(store, { botIds: ["bot_a", "bot_b"] });
    const turns = store.listMemberTurns(accepted.run.id);
    completeTurn(store, accepted.run.id, turns[0]!.id, { pass: true });
    completeTurn(store, accepted.run.id, turns[1]!.id, { content: "A concrete decision" });
    expect(store.getRun(accepted.run.id)).toMatchObject({
      state: "completed",
      completionReason: "members-completed",
    });
    expect(store.listMessages({ conversationId: RT_CONVERSATION, topicId: RT_TOPIC, limit: 20 })
      .filter((message) => message.role === "bot").map((message) => message.content)).toEqual(["A concrete decision"]);
  } finally {
    store.close();
  }
});

test("empty final text fails the speaker and never becomes a pass", async () => {
  const h = await harness();
  try {
    const { group, topic, members } = await h.group();
    const accepted = await h.service.acceptGroupPrompt({
      conversationId: group.id,
      topicId: topic.id,
      requestId: "rt-empty",
      text: "Discuss",
      target: { mode: "roundtable", botIds: [members[0]!, members[1]!] },
      humanIngress: { chatKey: "relay:human", accountId: "human", senderId: "human", isOwner: true },
    });
    const drain = h.dispatcher.kick();
    await until(() => h.runner.calls.length === 1);
    expect(h.runner.calls[0]!.text).toContain("sequential Group discussion");
    expect(h.runner.calls[0]!.text).toContain("group_send and group_read_result are unavailable in a discussion. Do not assign work.");
    expect(h.runner.calls[0]!.text).not.toContain("collaborating in the same Group Topic");
    expect(h.runner.calls[0]!.text).not.toContain("Read existing results with `group_read_result`");
    h.runner.finish(0, { status: "completed", text: "" });
    await drain;
    expect(h.store.getRun(accepted.run.id)?.state).toBe("failed");
    const failed = h.store.listMemberTurns(accepted.run.id).find((turn) => turn.state === "failed");
    expect(failed?.failureReason).toBe("empty-speech");
    expect(h.store.listMessages({ conversationId: group.id, topicId: topic.id, limit: 20 })
      .filter((message) => message.role === "bot")).toHaveLength(0);
  } finally {
    h.store.close();
  }
});

/**
 * One live Group execution on a real store whose second terminal row carries a
 * roundtable `pass`. `roundtable` selects which Run shape owns that row: a real
 * discussion, or a fanout Run that the service still filters defensively.
 */
async function bindPassFixture(roundtable: boolean) {
  const store = await openRoundtableStore();
  const state = createEmptyState();
  state.conversations[RT_CONVERSATION] = {
    id: RT_CONVERSATION, kind: "group", title: "Roundtable", botIds: ["bot_a", "bot_b"],
    createdAt: RT_NOW, updatedAt: RT_NOW,
  };
  state.conversation_topics[RT_TOPIC] = {
    id: RT_TOPIC, conversationId: RT_CONVERSATION, title: "Topic", status: "active",
    executionTarget: { workspace: "backend", isolation: "shared-single-writer" },
    createdAt: RT_NOW, updatedAt: RT_NOW,
  };
  state.bots.bot_a = { id: "bot_a", name: "A", agent: "codex", workspace: "backend", enabled: true,
    profileRevision: 1, createdAt: RT_NOW, updatedAt: RT_NOW };
  state.bots.bot_b = { id: "bot_b", name: "B", agent: "codex", workspace: "backend", enabled: true,
    profileRevision: 1, createdAt: RT_NOW, updatedAt: RT_NOW };
  const accepted = roundtable
    ? acceptRoundtable(store, { botIds: ["bot_a", "bot_b"] })
    : store.acceptRequest({
      conversationId: RT_CONVERSATION, topicId: RT_TOPIC, requestId: "fanout-pass",
      botId: "bot_a", content: "fanout", profileSnapshot: RT_SNAPSHOT, shape: "fanout",
      members: [{ botId: "bot_b", profileSnapshot: RT_SNAPSHOT }], now: RT_NOW,
    });
  const turns = store.listMemberTurns(accepted.run.id);
  const { started, claim } = startTurn(store, accepted.run.id, turns[0]!.id);
  // A completed, pass-marked assignment must stay out of the assignment catalog
  // even though it is terminal. Written directly so the filter is what is under
  // test, not the store's roundtable-only validation of `speechOutcome`.
  store.directWriteForTest("member_turns", turns[1]!.id, {
    state: "completed",
    speech_outcome: "pass",
    assignment_id: "pass_assignment",
    finished_at: RT_NOW,
  });
  state.sessions.session = {
    alias: "session", agent: "codex", workspace: "backend", transport_session: "transport",
    logical_session_id: "logical",
    owner: { kind: "group-member", bindingId: "binding", botId: started.botId,
      conversationId: RT_CONVERSATION, topicId: RT_TOPIC },
    created_at: RT_NOW, last_used_at: RT_NOW,
  };
  state.bot_runtime_bindings.binding = {
    id: "binding", scope: "group-member", botId: started.botId, conversationId: RT_CONVERSATION,
    topicId: RT_TOPIC, sessionAlias: "session", logicalSessionId: "logical",
    createdAt: RT_NOW, updatedAt: RT_NOW,
  };
  const handoffs = new GroupHandoffService({
    store,
    bots: { getBot: (id: string) => state.bots[id]!, runLifecycleAll: async <T,>(_ids: readonly string[], fn: () => Promise<T>) => fn() } as never,
    state,
    now: () => new Date(RT_NOW),
    wake() {},
  });
  const capability = handoffs.bindExecution({
    senderMemberTurnId: started.id, sourceTurnId: "source_0", dispatchId: claim.dispatch.id,
    owner: RT_OWNER, generation: claim.dispatch.generation,
  }, roundtable ? { roundtable: true } : {});
  return { store, handoffs, capability };
}

test("group_read_result never lists or serves a pass row", async () => {
  const { store, handoffs, capability } = await bindPassFixture(false);
  try {
    expect(capability.token.startsWith("group-execution:")).toBe(true);
    expect(capability.token.startsWith("group-execution:roundtable:")).toBe(false);
    const catalog = handoffs.readResult({ executionToken: capability.token, invocationId: "read", args: {} } as never);
    expect(catalog).toEqual({ kind: "catalog", assignments: [], nextOffset: null });
    expect(() => handoffs.readResult({
      executionToken: capability.token, invocationId: "read-pass", args: { assignmentId: "pass_assignment" },
    } as never)).toThrow(expect.objectContaining({ code: "member_result_missing" }));
  } finally {
    handoffs.close(); store.close();
  }
});

test("a roundtable capability can neither dispatch nor read assignments", async () => {
  const { store, handoffs, capability } = await bindPassFixture(true);
  try {
    expect(capability.token.startsWith("group-execution:roundtable:")).toBe(true);
    for (const args of [{}, { assignmentId: "pass_assignment" }]) {
      expect(() => handoffs.readResult({ executionToken: capability.token, args } as never))
        .toThrow(expect.objectContaining({ code: "group_read_result_from_roundtable_refused" }));
    }
    // The store's existing roundtable gate still holds behind the hidden tool.
    await expect(handoffs.send({ executionToken: capability.token, invocationId: "direct-call",
      args: { to: "bot_b", task: "assign work" } }))
      .rejects.toMatchObject({ code: "handoff_from_roundtable_refused" });
    expect(store.listMessages({ conversationId: RT_CONVERSATION, topicId: RT_TOPIC, limit: 20 }))
      .toHaveLength(1);
  } finally {
    handoffs.close(); store.close();
  }
});

