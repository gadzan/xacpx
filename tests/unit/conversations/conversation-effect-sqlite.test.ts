// Identical assertions run with bun:sqlite and bundled node:sqlite.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteConversationStore } from "../../../src/conversations/sqlite-conversation-store";
import { createSqlDriver } from "../../../src/conversations/sql-driver";
import { snapshotBotProfile } from "../../../src/bots/bot-types";
import { isEffectConcurrencySafe } from "../../../src/conversations/conversation-filesystem-policy";
const now = "2026-10-07T00:00:00.000Z";
const profile = snapshotBotProfile({ id: "a", name: "Reviewer", agent: "claude", workspace: "backend",
  enabled: true, profileRevision: 1, createdAt: now, updatedAt: now }, now);
for (const effect of ["unknown", "mutating", "read-only"] as const) {
  test(`SQLite accepted ${effect} contract survives restart and preserves recovery classification`, async () => {
    const path = join(mkdtempSync(join(tmpdir(), "xacpx-effect-sqlite-")), "store.sqlite");
    let store = await SqliteConversationStore.open(path);
    const accepted = store.acceptRequest({ conversationId: "c", topicId: "t", requestId: "r", botId: "a", content: "inspect",
      profileSnapshot: profile, maxMemberTurns: 24, primaryMember: { effect, ...(effect === "read-only" ? { effectProvenance: "declared-enforced" } : {}) }, now });
    const claim = store.claimNextDispatch({ owner: "old", now, leaseExpiresAt: "2026-10-07T00:01:00.000Z" })!;
    store.markExecutionStarted({ dispatchId: claim.dispatch.id, owner: "old", generation: claim.dispatch.generation,
      runId: accepted.run.id, memberTurnId: accepted.memberTurn.id, sessionAlias: "s", logicalSessionId: "l", sourceTurnId: "source", now });
    const before = store.getMemberTurn(accepted.memberTurn.id)!; store.close(); store = await SqliteConversationStore.open(path);
    assert.deepEqual(store.getMemberTurn(before.id), before);
    store.convergePreviousOwnerClaims("new", now);
    const recovered = store.getMemberTurn(before.id)!;
    assert.equal(recovered.effect ?? "unknown", effect);
    assert.equal(recovered.effectProvenance, effect === "read-only" ? "declared-enforced" : undefined);
    assert.equal(recovered.state, effect === "read-only" ? "queued" : "indeterminate");
    assert.equal(recovered.attempt, effect === "read-only" ? 2 : 1);
    if (effect === "read-only") {
      const next = store.claimNextDispatch({ owner: "new", now, leaseExpiresAt: "2026-10-07T00:01:00.000Z" })!;
      store.markExecutionStarted({ dispatchId: next.dispatch.id, owner: "new", generation: next.dispatch.generation,
        runId: accepted.run.id, memberTurnId: before.id, sessionAlias: "s2", logicalSessionId: "l2", sourceTurnId: "source2", now });
      store.convergePreviousOwnerClaims("third", now);
      assert.equal(store.getMemberTurn(before.id)?.state, "indeterminate"); // bounded retry remains bounded
    }
    store.close();
  });
}

for (const proof of [null, "unproven", "human", "declared-enforced-corrupt", ""]) {
  test(`SQLite malformed/absent proof ${JSON.stringify(proof)} cannot authorize readers or safe retry`, async () => {
    const path = join(mkdtempSync(join(tmpdir(), "xacpx-effect-corrupt-")), "store.sqlite");
    const store = await SqliteConversationStore.open(path);
    const a = store.acceptRequest({ conversationId: "c", topicId: "t", requestId: "r", botId: "a", content: "inspect", profileSnapshot: profile, now });
    const sql = await createSqlDriver(path);
    sql.run("UPDATE member_turns SET effect = 'read-only', effect_provenance = ? WHERE id = ?", [proof, a.memberTurn.id]); sql.close();
    const member = store.getMemberTurn(a.memberTurn.id)!;
    assert.equal(isEffectConcurrencySafe(member.effect, "shared-single-writer", 1, member.effectProvenance), false);
    const c = store.claimNextDispatch({ owner: "old", now, leaseExpiresAt: "2026-10-07T00:01:00.000Z" })!;
    store.markExecutionStarted({ dispatchId: c.dispatch.id, owner: "old", generation: c.dispatch.generation,
      runId: a.run.id, memberTurnId: member.id, sessionAlias: "s", logicalSessionId: "l", sourceTurnId: "source", now });
    store.convergePreviousOwnerClaims("new", now);
    assert.equal(store.getMemberTurn(member.id)?.state, "indeterminate"); store.close();
  });
}

test("legacy rows without effect columns migrate to unknown and never obtain proof", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "xacpx-effect-legacy-")), "store.sqlite");
  let store = await SqliteConversationStore.open(path);
  const a = store.acceptRequest({ conversationId: "c", topicId: "t", requestId: "r", botId: "a", content: "inspect", profileSnapshot: profile, now });
  store.close(); const sql = await createSqlDriver(path);
  sql.exec("ALTER TABLE member_turns DROP COLUMN effect"); sql.exec("ALTER TABLE member_turns DROP COLUMN effect_provenance"); sql.close();
  store = await SqliteConversationStore.open(path);
  assert.equal(store.getMemberTurn(a.memberTurn.id)?.effect ?? "unknown", "unknown");
  assert.equal(store.getMemberTurn(a.memberTurn.id)?.effectProvenance, undefined); store.close();
});
