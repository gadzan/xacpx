import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { SqliteConversationStore } from "../../../src/conversations/sqlite-conversation-store";
import { ConversationError } from "../../../src/conversations/conversation-error";
import type { MemberTurnRecord } from "../../../src/conversations/conversation-types";

const NOW = "2026-10-29T00:00:00.000Z";
const LEASE = "2026-10-29T01:00:00.000Z";
const snapshot = { revision: 1, capturedAt: NOW, presentation: { name: "Member" }, behavior: {},
  execution: { agent: "codex", workspace: "backend" } };

async function openStore() {
  const path = join(mkdtempSync(join(tmpdir(), "xacpx-group-dedup-")), "conversations.sqlite");
  return await SqliteConversationStore.open(path);
}

function acceptLeader(store: SqliteConversationStore) {
  const accepted = store.acceptRequest({ conversationId: "conversation_group", topicId: "topic_group",
    botId: "bot_a", requestId: `req-${Math.random()}`, content: "human request", profileSnapshot: snapshot,
    maxMemberTurns: 24, now: NOW });
  const claim = store.claimNextDispatch({ owner: "owner", now: NOW, leaseExpiresAt: LEASE })!;
  const leader = store.markExecutionStarted({ dispatchId: claim.dispatch.id, owner: "owner",
    generation: claim.dispatch.generation, runId: accepted.run.id, memberTurnId: claim.memberTurn.id,
    sessionAlias: "session_a", logicalSessionId: "logical_a", sourceTurnId: "source_a", now: NOW });
  return { accepted, claim, leader };
}

function dispatch(store: SqliteConversationStore, sender: MemberTurnRecord, dispatchId: string,
  generation: number, invocationId: string, to: string, task: string) {
  return store.acceptPublicHandoff({ senderMemberTurnId: sender.id, sourceTurnId: sender.sourceTurnId!,
    dispatchId, owner: "owner", generation, invocationId, args: { to, task }, profileSnapshot: snapshot, now: NOW });
}

function handoffDuplicate(fn: () => unknown) {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ConversationError);
    expect((error as ConversationError).code).toBe("handoff_duplicate");
    return;
  }
  throw new Error("expected handoff_duplicate");
}

test("whitespace, case and trailing-punctuation variants are duplicates", async () => {
  const store = await openStore();
  try {
    const { claim, leader } = acceptLeader(store);
    dispatch(store, leader, claim.dispatch.id, claim.dispatch.generation, "dup-1", "bot_b", "fix the login bug");
    // Extra spaces + tabs.
    handoffDuplicate(() => dispatch(store, leader, claim.dispatch.id, claim.dispatch.generation,
      "dup-2", "bot_b", "  fix\t the  login bug "));
    // Case difference.
    handoffDuplicate(() => dispatch(store, leader, claim.dispatch.id, claim.dispatch.generation,
      "dup-3", "bot_b", "Fix the LOGIN bug"));
    // Trailing sentence punctuation, plus full-width variants after NFKC.
    handoffDuplicate(() => dispatch(store, leader, claim.dispatch.id, claim.dispatch.generation,
      "dup-4", "bot_b", "fix the login bug..."));
    handoffDuplicate(() => dispatch(store, leader, claim.dispatch.id, claim.dispatch.generation,
      "dup-5", "bot_b", "ＦＩＸ　ｔｈｅ　ｌｏｇｉｎ　ｂｕｇ。"));
  } finally { store.close(); }
});

test("a substantively different task is allowed, and error claims carry the duplicate code", async () => {
  const store = await openStore();
  try {
    const { claim, leader } = acceptLeader(store);
    dispatch(store, leader, claim.dispatch.id, claim.dispatch.generation, "diff-1", "bot_b", "implement login");
    const retry = dispatch(store, leader, claim.dispatch.id, claim.dispatch.generation,
      "diff-2", "bot_b", "implement login page");
    expect(retry.memberTurn.botId).toBe("bot_b");
    // The stored task text keeps the original casing/punctuation — no rewriting on write.
    expect(store.getMemberTurn(retry.memberTurn.id)?.task).toBe("implement login page");
    try {
      dispatch(store, leader, claim.dispatch.id, claim.dispatch.generation,
        "diff-3", "bot_b", "  IMPLEMENT LOGIN ");
    } catch (error) {
      expect((error as ConversationError).code).toBe("handoff_duplicate");
      expect((error as ConversationError).message).toContain("already dispatched");
      return;
    }
    throw new Error("expected handoff_duplicate");
  } finally { store.close(); }
});

test("the same task text to a different member is allowed", async () => {
  const store = await openStore();
  try {
    const { claim, leader } = acceptLeader(store);
    dispatch(store, leader, claim.dispatch.id, claim.dispatch.generation, "member-1", "bot_b", "fix the login bug");
    const other = dispatch(store, leader, claim.dispatch.id, claim.dispatch.generation,
      "member-2", "bot_c", "fix the login bug");
    expect(other.memberTurn.botId).toBe("bot_c");
  } finally { store.close(); }
});

test("an idempotent replay of the same invocation returns the original result", async () => {
  const store = await openStore();
  try {
    const { claim, leader } = acceptLeader(store);
    const first = dispatch(store, leader, claim.dispatch.id, claim.dispatch.generation,
      "replay-1", "bot_b", "fix the login bug");
    const replay = dispatch(store, leader, claim.dispatch.id, claim.dispatch.generation,
      "replay-1", "bot_b", "fix the login bug");
    // Same committed row, not a new member turn — and no handoff_duplicate.
    expect(replay.reused).toBe(true);
    expect(replay.memberTurn.id).toBe(first.memberTurn.id);
  } finally { store.close(); }
});
