// Portable contract: run unchanged under node:sqlite and bun:sqlite.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteConversationStore } from "../../../src/conversations/sqlite-conversation-store";
import { createSqlDriver } from "../../../src/conversations/sql-driver";
import { snapshotBotProfile } from "../../../src/bots/bot-types";
import { ConversationWorktreeManager } from "../../../src/conversations/conversation-worktree-manager";
import { runWorkspaceGit } from "../../../src/control/workspace-git";
const now = "2026-10-08T00:00:00.000Z";
const profile = snapshotBotProfile({ id: "a", name: "Writer", agent: "codex", workspace: "w", enabled: true,
  profileRevision: 1, createdAt: now, updatedAt: now }, now);
const base = { workspace: "w", sourceRoot: "/repo", commonDir: "/repo/.git", repositoryIdentity: "abc", baseCommitSha: "a".repeat(40) };
const input = { conversationId: "c", topicId: "t", requestId: "request", botId: "a", content: "work", profileSnapshot: profile, now, worktreeBase: base };

test("SQLite worktree acceptance is atomic, replayable and survives reopen", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "10c-sqlite-")), "db"); let store = await SqliteConversationStore.open(path);
  const a = store.acceptRequest(input); const record = store.worktrees.get(a.run.id)!;
  assert.equal(record.baseCommitSha, base.baseCommitSha); assert.equal(record.resources.length, 0);
  assert.equal(store.acceptRequest(input).reused, true); assert.equal(store.worktrees.list().length, 1);
  store.close(); store = await SqliteConversationStore.open(path); assert.deepEqual(store.worktrees.get(a.run.id), record); store.close();
});
test("SQLite rollback leaves neither Run nor worktree base intent", async () => {
  const store = await SqliteConversationStore.open(":memory:", { beforeAcceptCommit: () => { throw new Error("storage fault"); } });
  assert.throws(() => store.acceptRequest(input), /storage fault/); assert.equal(store.worktrees.list().length, 0);
  assert.equal(store.listRuns("c", "t").length, 0); store.close();
});
test("SQLite old database gains additive registry without inventing worktree authority", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "10c-legacy-")), "db"); let store = await SqliteConversationStore.open(path);
  const a = store.acceptRequest({ ...input, worktreeBase: undefined }); store.close();
  const sql = await createSqlDriver(path); sql.exec("DROP TABLE conversation_worktree_runs"); sql.close();
  store = await SqliteConversationStore.open(path); assert.equal(store.worktrees.get(a.run.id), undefined);
  assert.equal(store.getMemberTurn(a.memberTurns[0]!.id)!.effect ?? "unknown", "unknown"); store.close();
});
test("SQLite resource CAS rejects stale operations across independent connections", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "10c-cas-")), "db"); const a = await SqliteConversationStore.open(path), b = await SqliteConversationStore.open(path);
  const accepted = a.acceptRequest(input); const first = a.worktrees.get(accepted.run.id)!, stale = b.worktrees.get(accepted.run.id)!;
  first.disposition = "abandoned"; a.worktrees.save(first);
  assert.throws(() => b.worktrees.save(stale), /lost its durable revision/); assert.equal(b.worktrees.get(accepted.run.id)!.disposition, "abandoned"); a.close(); b.close();
});
for (const malformed of ["{", "null", JSON.stringify({ version: 1 }), JSON.stringify({ ...base, version: 42 })]) {
  test(`SQLite corrupted worktree registry ${malformed.slice(0, 30)} fails closed`, async () => {
    const path = join(mkdtempSync(join(tmpdir(), "10c-corrupt-")), "db"); const store = await SqliteConversationStore.open(path); const a = store.acceptRequest(input);
    const sql = await createSqlDriver(path); sql.run("UPDATE conversation_worktree_runs SET record_json = ? WHERE run_id = ?", [malformed, a.run.id]); sql.close();
    assert.throws(() => store.worktrees.get(a.run.id)); store.close();
  });
}
for (const phase of ["before-claim", "claimed", "started-unknown", "started-mutating", "started-read-only"] as const) {
  test(`SQLite restart ${phase} retains worktree base and original retry classification`, async () => {
    const path = join(mkdtempSync(join(tmpdir(), "10c-restart-")), "db"); let store = await SqliteConversationStore.open(path);
    const effect = phase === "started-read-only" ? "read-only" : phase === "started-mutating" ? "mutating" : "unknown";
    const a = store.acceptRequest({ ...input, maxMemberTurns: 24, primaryMember: { effect,
      ...(effect === "read-only" ? { effectProvenance: "declared-enforced" } : {}) } });
    if (phase !== "before-claim") {
      const claim = store.claimNextDispatch({ owner: "old", now, leaseExpiresAt: "2026-10-08T00:01:00.000Z" })!;
      if (phase.startsWith("started")) store.markExecutionStarted({ dispatchId: claim.dispatch.id, owner: "old", generation: claim.dispatch.generation,
        runId: a.run.id, memberTurnId: a.memberTurns[0]!.id, sessionAlias: "s", logicalSessionId: "l", sourceTurnId: "source", now });
    }
    const registry = store.worktrees.get(a.run.id)!; store.close(); store = await SqliteConversationStore.open(path);
    store.convergePreviousOwnerClaims("new", now); assert.deepEqual(store.worktrees.get(a.run.id), registry);
    assert.equal(store.getMemberTurn(a.memberTurns[0]!.id)!.state,
      phase === "started-unknown" || phase === "started-mutating" ? "indeterminate" : phase === "claimed" ? "dispatched" : "queued");
    if (phase === "claimed") assert.equal(store.getDispatchForMemberTurn(a.memberTurns[0]!.id)!.state, "pending");
    assert.equal(store.getMemberTurn(a.memberTurns[0]!.id)!.effect ?? "unknown", effect); store.close();
  });
}
test("SQLite real Git ownership reopens without creating a second worktree", { timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "10c-native-")), cwd = join(root, "source"), path = join(root, "db");
  await runWorkspaceGit(root, ["init", "--initial-branch=main", cwd]); writeFileSync(join(cwd, "file"), "base");
  await runWorkspaceGit(cwd, ["add", "."]); await runWorkspaceGit(cwd, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "base"]);
  let store = await SqliteConversationStore.open(path), manager = new ConversationWorktreeManager(store.worktrees, join(root, "managed"), { workspaces: { w: { cwd } } });
  const a = store.acceptRequest({ ...input, worktreeBase: await manager.preflight("w") }); const ref = await manager.prepare(a.run.id, "a", () => {});
  const before = store.worktrees.get(a.run.id)!.resources[0]!; store.close(); store = await SqliteConversationStore.open(path);
  manager = new ConversationWorktreeManager(store.worktrees, join(root, "managed"), { workspaces: { w: { cwd } } });
  await manager.reconcile(); assert.deepEqual(await manager.prepare(a.run.id, "a", () => {}), ref);
  assert.equal(await manager.verifyReference(ref), before.worktreePath); assert.equal(store.worktrees.get(a.run.id)!.resources.length, 1); store.close();
});
