import { expect, test } from "bun:test";
import {
  acceptRoundtable,
  claimNext,
  completeTurn,
  failTurn,
  openRoundtableStore,
  roundtablePath,
  RT_CONVERSATION,
  RT_LEASE,
  RT_NOW,
  RT_OWNER,
  RT_TOPIC,
  startTurn,
} from "./fixtures/roundtable-harness";

test("claims follow memberIndex strictly and a running speaker blocks the next", async () => {
  const store = await openRoundtableStore();
  try {
    const accepted = acceptRoundtable(store, { botIds: ["bot_a", "bot_b"], rounds: 2 });
    const turns = store.listMemberTurns(accepted.run.id);
    const { started } = startTurn(store, accepted.run.id, turns[0]!.id);
    expect(started.state).toBe("running");
    // No queue jump while the floor holder executes, including the next round.
    expect(claimNext(store, { runId: accepted.run.id })).toBeUndefined();
    expect(store.peekClaimableTopicIds({ owner: RT_OWNER, now: RT_NOW, leaseExpiresAt: RT_LEASE, topicId: RT_TOPIC }, 5))
      .toEqual([]);
    completeTurn(store, accepted.run.id, turns[0]!.id);
    expect(store.peekClaimableTopicIds({ owner: RT_OWNER, now: RT_NOW, leaseExpiresAt: RT_LEASE, topicId: RT_TOPIC }, 5))
      .toEqual([RT_TOPIC]);
    expect(claimNext(store, { runId: accepted.run.id })?.memberTurn.id).toBe(turns[1]!.id);
  } finally {
    store.close();
  }
});

test("a queued earlier turn blocks the floor until it terminals, and pass releases it", async () => {
  const store = await openRoundtableStore();
  try {
    const accepted = acceptRoundtable(store, { botIds: ["bot_a", "bot_b"], rounds: 1 });
    const turns = store.listMemberTurns(accepted.run.id);
    completeTurn(store, accepted.run.id, turns[0]!.id, { pass: true });
    expect(store.getMemberTurn(turns[0]!.id)).toMatchObject({ state: "completed", speechOutcome: "pass" });
    expect(store.getMessage(accepted.message.id)).toBeDefined();
    expect(store.listMessages({ conversationId: RT_CONVERSATION, topicId: RT_TOPIC, limit: 20 })
      .filter((message) => message.role === "bot")).toHaveLength(0);
    expect(claimNext(store, { runId: accepted.run.id })?.memberTurn.id).toBe(turns[1]!.id);
  } finally {
    store.close();
  }
});

test("a failed speaker cancels the later tail in the same transaction", async () => {
  const store = await openRoundtableStore();
  try {
    const accepted = acceptRoundtable(store, { botIds: ["bot_a", "bot_b"], rounds: 2 });
    const turns = store.listMemberTurns(accepted.run.id);
    completeTurn(store, accepted.run.id, turns[0]!.id);
    const run = failTurn(store, accepted.run.id, turns[1]!.id, "boom");
    const after = store.listMemberTurns(accepted.run.id);
    expect(after.map((turn) => turn.state)).toEqual(["completed", "failed", "cancelled", "cancelled"]);
    expect(run.state).toBe("failed");
    // The cancelled tail never ran: only the two real settlements are charged.
    expect(store.getRun(accepted.run.id)?.consumedMemberTurns).toBe(2);
    expect(claimNext(store, { runId: accepted.run.id })).toBeUndefined();
  } finally {
    store.close();
  }
});

test("order and floor survive a repository restart", async () => {
  const path = roundtablePath();
  let store = await openRoundtableStore(path);
  try {
    const accepted = acceptRoundtable(store, { botIds: ["bot_a", "bot_b", "bot_c"], rounds: 2, requestId: "restart" });
    const turns = store.listMemberTurns(accepted.run.id);
    completeTurn(store, accepted.run.id, turns[0]!.id);
    store.close();
    store = await openRoundtableStore(path);
    // Rows alone reconstruct the cursor: the next claim is the second speaker.
    const resumed = startTurn(store, accepted.run.id, turns[1]!.id);
    expect(resumed.started.memberIndex).toBe(1);
    expect(claimNext(store, { runId: accepted.run.id })).toBeUndefined();
  } finally {
    store.close();
  }
});

test("a single Bot may speak again in a later round but not twice in one round", async () => {
  const store = await openRoundtableStore();
  try {
    const accepted = acceptRoundtable(store, { botIds: ["bot_a", "bot_b"], rounds: 2 });
    const turns = store.listMemberTurns(accepted.run.id);
    completeTurn(store, accepted.run.id, turns[0]!.id);
    completeTurn(store, accepted.run.id, turns[1]!.id);
    const next = claimNext(store, { runId: accepted.run.id });
    expect(next?.memberTurn.id).toBe(turns[2]!.id);
    expect(next?.memberTurn.botId).toBe("bot_a");
  } finally {
    store.close();
  }
});
