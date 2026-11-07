import { expect, test } from "bun:test";
import { ConversationError } from "../../../src/conversations/conversation-error";
import { SqliteConversationStore } from "../../../src/conversations/sqlite-conversation-store";
import {
  acceptRoundtable,
  completeTurn,
  openRoundtableStore,
  RT_CONVERSATION,
  RT_NOW,
  RT_TOPIC,
  startTurn,
} from "./fixtures/roundtable-harness";

function botMessages(store: SqliteConversationStore) {
  return store.listMessages({ conversationId: RT_CONVERSATION, topicId: RT_TOPIC, limit: 50 })
    .filter((message) => message.role === "bot");
}

test("a pass landing after the indeterminate seal stays a pass with no message", async () => {
  const store = await openRoundtableStore();
  try {
    const accepted = acceptRoundtable(store, { botIds: ["bot_a", "bot_b"] });
    const turn = store.listMemberTurns(accepted.run.id)[0]!;
    const { started, sourceTurnId } = startTurn(store, accepted.run.id, turn.id);
    store.completeCancel(accepted.run.id, started.id, RT_NOW, true);
    expect(store.getRun(accepted.run.id)?.state).toBe("indeterminate");
    const before = botMessages(store).length;

    const completed = store.completeExecution({
      runId: accepted.run.id,
      memberTurnId: started.id,
      content: "(pass)",
      sourceTurn: { sessionAlias: "session", turnId: sourceTurnId },
      now: RT_NOW,
    });
    expect(completed.assistantMessage).toBeUndefined();
    expect(store.getMemberTurn(started.id)).toMatchObject({ state: "completed", speechOutcome: "pass" });
    expect(store.getRun(accepted.run.id)?.state).toBe("indeterminate");
    expect(botMessages(store)).toHaveLength(before);
    expect(botMessages(store).some((message) => message.content.trim().toLowerCase() === "(pass)")).toBe(false);
  } finally {
    store.close();
  }
});

test("a live late pass under cancel intent writes no message", async () => {
  const store = await openRoundtableStore();
  try {
    const accepted = acceptRoundtable(store, { botIds: ["bot_a", "bot_b"] });
    const turn = store.listMemberTurns(accepted.run.id)[0]!;
    const { started, sourceTurnId } = startTurn(store, accepted.run.id, turn.id);
    store.cancelRun(accepted.run.id, RT_NOW);
    const before = botMessages(store).length;
    const reconciled = store.reconcileLateResult({
      runId: accepted.run.id,
      memberTurnId: started.id,
      outcome: "completed",
      content: "  (PASS) ",
      sourceTurn: { sessionAlias: "session", turnId: sourceTurnId },
      now: RT_NOW,
    });
    expect(reconciled.reconciled).toBe(true);
    expect(store.getMemberTurn(started.id)).toMatchObject({ state: "completed", speechOutcome: "pass" });
    expect(botMessages(store)).toHaveLength(before);
    expect(botMessages(store).some((message) => message.content.trim().toLowerCase() === "(pass)")).toBe(false);
  } finally {
    store.close();
  }
});

test("a pass converged through cancel settlement writes no message", async () => {
  const store = await openRoundtableStore();
  try {
    const accepted = acceptRoundtable(store, { botIds: ["bot_a", "bot_b"] });
    const turn = store.listMemberTurns(accepted.run.id)[0]!;
    const { started, sourceTurnId } = startTurn(store, accepted.run.id, turn.id);
    store.cancelRun(accepted.run.id, RT_NOW);
    const before = botMessages(store).length;
    const settled = store.settleCancelBatch({
      runId: accepted.run.id,
      outcomes: [{
        memberTurnId: started.id,
        outcome: "completed",
        content: "(pass)",
        sourceTurn: { sessionAlias: "session", turnId: sourceTurnId },
      }],
      now: RT_NOW,
    });
    expect(settled.settled[0]?.member).toMatchObject({ state: "completed", speechOutcome: "pass" });
    expect(settled.settled[0]?.message).toBeUndefined();
    expect(settled.run.state).toBe("cancelled");
    expect(botMessages(store)).toHaveLength(before);
    expect(botMessages(store).some((message) => message.content.trim().toLowerCase() === "(pass)")).toBe(false);
  } finally {
    store.close();
  }
});

test("a roundtable message outcome rejects empty text before any insert", async () => {
  const store = await openRoundtableStore();
  try {
    const accepted = acceptRoundtable(store, { botIds: ["bot_a", "bot_b"] });
    const turn = store.listMemberTurns(accepted.run.id)[0]!;
    const { started, sourceTurnId } = startTurn(store, accepted.run.id, turn.id);
    const before = botMessages(store).length;
    for (const content of ["", "   \n\t "]) {
      expect(() => store.completeExecution({
        runId: accepted.run.id,
        memberTurnId: started.id,
        content,
        sourceTurn: { sessionAlias: "session", turnId: sourceTurnId },
        now: RT_NOW,
      })).toThrow(new ConversationError("empty-speech", "a roundtable message outcome requires non-empty text"));
    }
    expect(botMessages(store)).toHaveLength(before);
    expect(store.getMemberTurn(started.id)?.state).toBe("running");
  } finally {
    store.close();
  }
});

test("a pass alongside real speech still lets the roundtable complete normally", async () => {
  const store = await openRoundtableStore();
  try {
    const accepted = acceptRoundtable(store, { botIds: ["bot_a", "bot_b"] });
    const turns = store.listMemberTurns(accepted.run.id);
    completeTurn(store, accepted.run.id, turns[0]!.id, { pass: true });
    completeTurn(store, accepted.run.id, turns[1]!.id, { content: "One decision" });
    expect(store.getRun(accepted.run.id)).toMatchObject({ state: "completed", completionReason: "members-completed" });
  } finally {
    store.close();
  }
});
