import { test } from "node:test";
import assert from "node:assert/strict";
import { SqliteConversationStore } from "../../../src/conversations/sqlite-conversation-store";
import { snapshotBotProfile } from "../../../src/bots/bot-types";

const now = "2026-11-06T00:00:00.000Z";
const later = "2026-11-06T00:05:00.000Z";

function member(id: string) {
  return {
    botId: id,
    profileSnapshot: snapshotBotProfile({
      id,
      name: id,
      agent: "codex",
      workspace: "backend",
      enabled: true,
      profileRevision: 1,
      createdAt: now,
      updatedAt: now,
    }, now),
  };
}

test("public Group messages project per current member and clean with membership/topic", async () => {
  let members = ["bot_a", "bot_b"];
  const store = await SqliteConversationStore.open(":memory:", {
    publicMemoryMembers: (conversationId, topicId) =>
      conversationId === "group" && topicId === "topic" ? members : undefined,
  });
  const first = store.acceptRequest({
    conversationId: "group",
    topicId: "topic",
    requestId: "request-1",
    botId: "bot_a",
    content: "goal",
    profileSnapshot: member("bot_a").profileSnapshot,
    primaryMember: member("bot_a"),
    members: [member("bot_b")],
    maxMemberTurns: 24,
    now,
  });
  assert.deepEqual(store.listPublicMemory({ botId: "bot_a" }).map((entry) => entry.content), ["goal"]);
  assert.deepEqual(store.listPublicMemory({ botId: "bot_b" }).map((entry) => entry.content), ["goal"]);

  const work = store.claimNextDispatch({
    owner: "owner",
    now,
    leaseExpiresAt: later,
    authorityEpoch: "epoch",
  })!;
  const started = store.markExecutionStarted({
    dispatchId: work.dispatch.id,
    owner: "owner",
    generation: work.dispatch.generation,
    runId: first.run.id,
    memberTurnId: work.memberTurn.id,
    sessionAlias: "session",
    logicalSessionId: "logical",
    sourceTurnId: "source",
    now,
  });
  store.completeExecution({
    runId: first.run.id,
    memberTurnId: started.id,
    now: later,
    content: "result",
    sourceTurn: { sessionAlias: "session", turnId: "source" },
  });

  assert.deepEqual(
    store.listPublicMemory({ botId: "bot_a" }).map((entry) => [entry.role, entry.content]),
    [["human", "goal"], ["bot", "result"]],
  );
  assert.deepEqual(
    store.listPublicMemory({ botId: "bot_b" }).map((entry) => entry.content),
    ["goal", "result"],
  );

  members = ["bot_b"];
  store.acceptRequest({
    conversationId: "group",
    topicId: "topic",
    requestId: "request-2",
    botId: "bot_b",
    content: "second",
    profileSnapshot: member("bot_b").profileSnapshot,
    primaryMember: member("bot_b"),
    maxMemberTurns: 24,
    now: later,
  });
  assert.deepEqual(store.listPublicMemory({ botId: "bot_a" }).map((entry) => entry.content), ["goal", "result"]);
  assert.deepEqual(
    store.listPublicMemory({ botId: "bot_b" }).map((entry) => entry.content),
    ["goal", "result", "second"],
  );

  store.deletePublicMemoryForGroupMember("group", "bot_a");
  assert.deepEqual(store.listPublicMemory({ botId: "bot_a" }), []);

  store.deleteTopicRows("group", "topic");
  assert.deepEqual(store.listPublicMemory({ botId: "bot_b" }), []);
  store.close();
});
