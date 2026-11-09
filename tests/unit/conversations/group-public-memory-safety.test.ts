import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type { HandoffPublicMemoryRecord, PublicMemoryOrphanReport } from "../../../src/conversations/conversation-store";
import { createSqlDriver } from "../../../src/conversations/sql-driver";
import { SqliteConversationStore } from "../../../src/conversations/sqlite-conversation-store";

const NOW = "2026-11-09T00:00:00.000Z";
const LEASE = "2026-11-09T01:00:00.000Z";
const snapshot = { revision: 1, capturedAt: NOW, presentation: { name: "Member" }, behavior: {},
  execution: { agent: "codex", workspace: "backend" } };
const members = ["bot_a", "bot_b"];
const publicMemoryMembers = (conversationId: string, topicId: string) =>
  conversationId === "group" && topicId === "topic" ? members : undefined;

/** A public Group Topic whose leader turn is claimed, started, and can
 *  dispatch one handoff to `bot_b`. */
async function handoffHarness(path: string, options: Parameters<typeof SqliteConversationStore.open>[1] = {}) {
  const store = await SqliteConversationStore.open(path, { publicMemoryMembers, ...options });
  const accepted = store.acceptRequest({
    conversationId: "group",
    topicId: "topic",
    requestId: "request",
    botId: "bot_a",
    content: "goal",
    profileSnapshot: snapshot,
    primaryMember: { botId: "bot_a", profileSnapshot: snapshot },
    members: [{ botId: "bot_b", profileSnapshot: snapshot }],
    maxMemberTurns: 24,
    now: NOW,
  });
  const claim = store.claimNextDispatch({ owner: "owner", now: NOW, leaseExpiresAt: LEASE })!;
  const started = store.markExecutionStarted({
    dispatchId: claim.dispatch.id,
    owner: "owner",
    generation: claim.dispatch.generation,
    runId: accepted.run.id,
    memberTurnId: claim.memberTurn.id,
    sessionAlias: "session_a",
    logicalSessionId: "logical_a",
    sourceTurnId: "source_a",
    now: NOW,
  });
  const handoff = {
    senderMemberTurnId: started.id,
    sourceTurnId: "source_a",
    dispatchId: claim.dispatch.id,
    owner: "owner",
    generation: claim.dispatch.generation,
    invocationId: "handoff",
    args: { to: "bot_b", task: "secret task text that must never be projected" },
    profileSnapshot: snapshot,
    now: NOW,
  };
  const receipt = store.acceptPublicHandoff(handoff);
  return { store, accepted, started, handoff, receipt };
}

async function countMemoryRows(path: string, messageId?: string): Promise<number> {
  const db = await createSqlDriver(path);
  try {
    return Number((messageId === undefined
      ? db.get<{ n: number }>("SELECT COUNT(*) AS n FROM bot_public_memory")
      : db.get<{ n: number }>("SELECT COUNT(*) AS n FROM bot_public_memory WHERE message_id = ?", [messageId]))?.n ?? 0);
  } finally {
    db.close();
  }
}

test("a public handoff records no public memory by default", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "xacpx-memory-handoff-off-")), "conversations.sqlite");
  const { store, receipt } = await handoffHarness(path);
  try {
    // Only the human request is projected; the handoff message contributes
    // nothing, and the task text appears in no memory entry.
    expect(store.listPublicMemory({ botId: "bot_a" }).map((entry) => entry.content)).toEqual(["goal"]);
    expect(await countMemoryRows(path, receipt.message.id)).toBe(0);
    const db = await createSqlDriver(path);
    try {
      expect(db.get<{ role: string }>("SELECT role FROM messages WHERE id = ?", [receipt.message.id])?.role).toBe("system");
    } finally {
      db.close();
    }
  } finally {
    store.close();
  }
});

test("the handoff public-memory hook is reachable and still records nothing", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "xacpx-memory-handoff-hook-")), "conversations.sqlite");
  const calls: HandoffPublicMemoryRecord[] = [];
  const { store, handoff, receipt } = await handoffHarness(path, {
    recordHandoffPublicMemory: (record) => calls.push(record),
  });
  try {
    expect(calls).toEqual([{
      messageId: receipt.message.id,
      conversationId: "group",
      topicId: "topic",
      runId: receipt.run.id,
      senderBotId: "bot_a",
      targetBotId: "bot_b",
      createdAt: NOW,
    }]);
    // The record carries identity only: no task text is passed to the hook.
    expect(JSON.stringify(calls)).not.toContain("secret task text");
    // A replay short-circuits before the hook and writes nothing either.
    expect(store.acceptPublicHandoff(handoff).reused).toBe(true);
    expect(calls).toHaveLength(1);
    expect(await countMemoryRows(path, receipt.message.id)).toBe(0);
  } finally {
    store.close();
  }
});

test("startup reports orphaned public-memory references without deleting them", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "xacpx-memory-orphans-")), "conversations.sqlite");
  const first = await handoffHarness(path);
  const requested = first.accepted.message.id;
  first.store.close();

  const db = await createSqlDriver(path);
  try {
    // Simulate a cleanup path that removed the message but missed its
    // projection rows (no such path exists today; this is the safety net).
    db.run("DELETE FROM messages WHERE id = ?", [requested]);
  } finally {
    db.close();
  }
  const before = await countMemoryRows(path);
  expect(before).toBe(members.length);

  const reports: PublicMemoryOrphanReport[] = [];
  const reopened = await SqliteConversationStore.open(path, {
    publicMemoryMembers,
    onPublicMemoryOrphans: (report) => reports.push(report),
  });
  try {
    expect(reports).toHaveLength(1);
    expect(reports[0]!.total).toBe(members.length);
    expect(reports[0]!.orphans).toEqual(members.map((botId) => ({
      botId,
      messageId: requested,
      conversationId: "group",
      topicId: "topic",
    })));
    // Report-only: the references are still there and simply read as empty.
    expect(await countMemoryRows(path)).toBe(before);
    expect(reopened.listPublicMemory({ botId: "bot_a" })).toEqual([]);
  } finally {
    reopened.close();
  }
});

test("startup logs orphans when no report callback is supplied", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "xacpx-memory-orphans-log-")), "conversations.sqlite");
  const first = await handoffHarness(path);
  first.store.close();
  const db = await createSqlDriver(path);
  try {
    db.run("DELETE FROM messages WHERE id = ?", [first.accepted.message.id]);
  } finally {
    db.close();
  }

  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
  let reopened: SqliteConversationStore | undefined;
  try {
    reopened = await SqliteConversationStore.open(path, { publicMemoryMembers });
  } finally {
    console.warn = original;
  }
  try {
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`${members.length} bot_public_memory reference(s)`);
    expect(warnings[0]).toContain("report-only");
    expect(await countMemoryRows(path)).toBe(members.length);
  } finally {
    reopened?.close();
  }
});

test("existing topic-clear and conversation-delete paths drop references in the same transaction", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "xacpx-memory-cleanup-")), "conversations.sqlite");
  const { store } = await handoffHarness(path);
  try {
    expect(await countMemoryRows(path)).toBe(members.length);
    store.retireTopicContext({ conversationId: "group", topicId: "topic", requestId: "clear-1", releaseBindings: false, now: NOW });
    expect(await countMemoryRows(path)).toBe(0);

    store.acceptRequest({
      conversationId: "group",
      topicId: "topic",
      requestId: "request-2",
      botId: "bot_a",
      content: "second goal",
      profileSnapshot: snapshot,
      primaryMember: { botId: "bot_a", profileSnapshot: snapshot },
      members: [{ botId: "bot_b", profileSnapshot: snapshot }],
      maxMemberTurns: 24,
      now: NOW,
    });
    expect(await countMemoryRows(path)).toBe(members.length);
    store.deleteConversationRows("group");
    expect(await countMemoryRows(path)).toBe(0);
  } finally {
    store.close();
  }
});

test("a throwing handoff hook does not roll back admitted work", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "xacpx-memory-hook-throws-")), "conversations.sqlite");
  const { store, receipt } = await handoffHarness(path, {
    recordHandoffPublicMemory: () => { throw new Error("projection unavailable"); },
  });
  try {
    expect(store.getMemberTurn(receipt.memberTurn.id)).toBeDefined();
    expect(store.getMessage(receipt.message.id)).toBeDefined();
    expect(await countMemoryRows(path, receipt.message.id)).toBe(0);
  } finally {
    store.close();
  }
});

test("a throwing orphan reporter does not fail startup", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "xacpx-memory-orphans-throws-")), "conversations.sqlite");
  const first = await handoffHarness(path);
  const requested = first.accepted.message.id;
  first.store.close();
  const db = await createSqlDriver(path);
  try {
    db.run("DELETE FROM messages WHERE id = ?", [requested]);
  } finally {
    db.close();
  }
  const before = await countMemoryRows(path);

  const reopened = await SqliteConversationStore.open(path, {
    publicMemoryMembers,
    onPublicMemoryOrphans: () => { throw new Error("diagnostics unavailable"); },
  });
  try {
    expect(reopened.listPublicMemory({ botId: "bot_a" })).toEqual([]);
    expect(await countMemoryRows(path)).toBe(before);
  } finally {
    reopened.close();
  }
});
