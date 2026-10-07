// Portable suite: Bun executes this with the unit tests; bundle with bun:sqlite
// external and run with Node to exercise node:sqlite against identical assertions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteConversationStore } from "../../../src/conversations/sqlite-conversation-store";
import { snapshotBotProfile } from "../../../src/bots/bot-types";

const now = "2026-10-07T00:00:00.000Z";
const later = "2026-10-07T00:05:00.000Z";
function accept(store: SqliteConversationStore, topicId = "topic", safe = true) {
  const member = (id: string) => ({ botId: id, profileSnapshot: snapshotBotProfile({ id, name: id,
    agent: "codex", workspace: "backend", enabled: true, profileRevision: 1, createdAt: now, updatedAt: now }, now),
    ...(safe ? { effect: "read-only" as const, effectProvenance: "declared-enforced" as const } : {}) });
  const first = member("bot_a");
  return store.acceptRequest({ conversationId: "group", topicId, requestId: topicId, botId: first.botId,
    content: "request", profileSnapshot: first.profileSnapshot, primaryMember: first,
    members: [member("bot_b"), member("bot_c")], maxMemberTurns: 24, now });
}
function claim(store: SqliteConversationStore, limit?: number, owner = "owner", runId?: string) {
  return store.claimNextDispatch({ owner, now, leaseExpiresAt: later, authorityEpoch: "epoch", runId,
    ...(limit !== undefined ? { topicConcurrencyLimits: { topic: limit } } : {}) });
}
for (const limit of [undefined, 1, 2, 64]) {
  test(`SQLite capacity ${limit ?? "legacy"} counts durable reservations across connections and reopen`, async () => {
    const path = join(mkdtempSync(join(tmpdir(), "xacpx-cap-sqlite-")), "store.sqlite");
    let a = await SqliteConversationStore.open(path); accept(a);
    const b = await SqliteConversationStore.open(path);
    const size = limit === undefined ? 3 : Math.min(limit, 3);
    for (let i = 0; i < size; i++) assert.ok(claim(i % 2 ? b : a, limit, `owner-${i}`));
    assert.equal(claim(b, limit), undefined);
    a.close(); a = await SqliteConversationStore.open(path);
    assert.equal(claim(a, limit), undefined);
    b.close(); a.close();
  });
}
test("SQLite cancelled unstarted reservations release capacity without starting cancelled work", async () => {
  const store = await SqliteConversationStore.open(":memory:"); const run = accept(store);
  claim(store, 1); assert.equal(claim(store, 1), undefined);
  store.cancelRun(run.run.id, now);
  assert.equal(claim(store, 1), undefined);
  assert.ok(store.listMemberTurns(run.run.id).every((m) => store.getDispatchForMemberTurn(m.id)?.state === "completed"));
  const other = accept(store, "other"); assert.ok(claim(store, 1, "new", other.run.id)); store.close();
});
for (const phase of ["unstarted", "unknown", "read-only"] as const) {
  test(`SQLite previous-owner ${phase} recovery uses durable capacity and preserves retry safety`, async () => {
    const path = join(mkdtempSync(join(tmpdir(), "xacpx-cap-restart-")), "store.sqlite");
    let store = await SqliteConversationStore.open(path); const accepted = accept(store, "topic", phase !== "unknown");
    for (let i = 0; i < 2; i++) {
      const work = claim(store, 2, "dead")!;
      if (phase !== "unstarted") store.markExecutionStarted({ dispatchId: work.dispatch.id, owner: "dead",
        generation: work.dispatch.generation, runId: work.run.id, memberTurnId: work.memberTurn.id,
        sessionAlias: "old", logicalSessionId: "old", sourceTurnId: `old-source-${i}`, now });
    }
    assert.equal(claim(store, 2), undefined); store.close(); store = await SqliteConversationStore.open(path);
    store.convergePreviousOwnerClaims("new", now);
    if (phase === "unknown") {
      assert.equal(store.getRun(accepted.run.id)?.state, "indeterminate"); assert.equal(claim(store, 2, "new"), undefined);
    } else {
      assert.ok(claim(store, 2, "new")); assert.ok(claim(store, 2, "new")); assert.equal(claim(store, 2, "new"), undefined);
      if (phase === "read-only") assert.ok(store.listMemberTurns(accepted.run.id).slice(0, 2).every((m) => m.origin === "recovery" && m.attempt === 2));
    }
    store.close();
  });
}
test("SQLite lease expiry before start restores capacity through existing recovery", async () => {
  const store = await SqliteConversationStore.open(":memory:"); accept(store);
  const first = claim(store, 1)!; assert.equal(claim(store, 1), undefined);
  store.recoverExpiredClaims("2026-10-07T00:06:00.000Z");
  const second = claim(store, 1)!;
  assert.equal(second.memberTurn.id, first.memberTurn.id);
  assert.equal(second.dispatch.generation, first.dispatch.generation + 1);
  assert.equal(second.memberTurn.origin, "recovery"); store.close();
});
test("SQLite completion frees exactly one reservation while maintaining cap", async () => {
  const store = await SqliteConversationStore.open(":memory:"); const run = accept(store);
  const first = claim(store, 2)!; claim(store, 2); assert.equal(claim(store, 2), undefined);
  const started = store.markExecutionStarted({ dispatchId: first.dispatch.id, owner: "owner", generation: first.dispatch.generation,
    runId: run.run.id, memberTurnId: first.memberTurn.id, sessionAlias: "session", logicalSessionId: "logical", sourceTurnId: "source", now });
  store.completeExecution({ runId: run.run.id, memberTurnId: started.id, now, content: "done", sourceTurn: { sessionAlias: "session", turnId: "source" } });
  assert.ok(claim(store, 2)); assert.equal(claim(store, 2), undefined); store.close();
});
test("SQLite invalid scheduling policy fails closed without claiming", async () => {
  const store = await SqliteConversationStore.open(":memory:"); const run = accept(store);
  for (const value of [0, -1, 1.5, NaN, Infinity, 65]) assert.throws(() => claim(store, value), /maxConcurrentMemberTurns/);
  assert.ok(run.memberTurns.every((m) => store.getDispatchForMemberTurn(m.id)?.state === "pending")); store.close();
});
test("SQLite full Topic does not consume another Topic's capacity", async () => {
  const store = await SqliteConversationStore.open(":memory:"); const a = accept(store); const b = accept(store, "other");
  assert.ok(claim(store, 1, "owner", a.run.id)); assert.equal(claim(store, 1, "owner", a.run.id), undefined);
  assert.ok(claim(store, 1, "owner", b.run.id)); store.close();
});
