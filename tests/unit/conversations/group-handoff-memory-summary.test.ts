import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type { HandoffPublicMemoryRecord } from "../../../src/conversations/conversation-store";
import { createSqlDriver } from "../../../src/conversations/sql-driver";
import { SqliteConversationStore } from "../../../src/conversations/sqlite-conversation-store";

const NOW = "2026-11-09T00:00:00.000Z";
const LEASE = "2026-11-09T01:00:00.000Z";
const snapshot = { revision: 1, capturedAt: NOW, presentation: { name: "Member" }, behavior: {},
  execution: { agent: "codex", workspace: "backend" } };
const members = ["bot_a", "bot_b"];
const LONG_TASK = `migrate the runner scheduler to the new waiting graph ${"detail ".repeat(200)}end.`;

function publicMemoryMembersFor(current: readonly string[]) {
  return (conversationId: string, topicId: string) =>
    conversationId === "group" && topicId === "topic" ? current : undefined;
}

async function handoffHarness(path: string, options: Parameters<typeof SqliteConversationStore.open>[1] = {}, task = LONG_TASK) {
  const store = await SqliteConversationStore.open(path, {
    publicMemoryMembers: publicMemoryMembersFor(members),
    ...options,
  });
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
    args: { to: "bot_b", task },
    profileSnapshot: snapshot,
    now: NOW,
  };
  const receipt = store.acceptPublicHandoff(handoff);
  return { store, accepted, started, handoff, receipt };
}

async function summaryMessages(path: string, runId: string, handoffMessageId: string) {
  const db = await createSqlDriver(path);
  try {
    return db.all<{ id: string; role: string; content: string }>(
      `SELECT id, role, content FROM messages
       WHERE run_id = ? AND role = 'bot' AND id != ?
       ORDER BY seq`,
      [runId, handoffMessageId],
    );
  } finally {
    db.close();
  }
}

test("off (default) writes zero handoff rows and the hook sees identity only", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "xacpx-handoff-summary-off-")), "conversations.sqlite");
  const calls: HandoffPublicMemoryRecord[] = [];
  const { store, receipt } = await handoffHarness(path, {
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
    // Identity only: the (long) task text never reaches the hook.
    expect(JSON.stringify(calls)).not.toContain("migrate the runner");
    // No summary message, no memory rows for the handoff.
    expect(await summaryMessages(path, receipt.run.id, receipt.message.id)).toEqual([]);
    const db = await createSqlDriver(path);
    try {
      expect(Number(db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM bot_public_memory WHERE message_id = ?",
        [receipt.message.id],
      )?.n ?? 0)).toBe(0);
    } finally {
      db.close();
    }
  } finally {
    store.close();
  }
});

test("summary writes exactly one truncated row per current member", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "xacpx-handoff-summary-on-")), "conversations.sqlite");
  const { store, receipt } = await handoffHarness(path, { handoffMemoryMode: () => "summary" });
  try {
    const summaries = await summaryMessages(path, receipt.run.id, receipt.message.id);
    expect(summaries).toHaveLength(1);
    const summary = summaries[0]!;
    expect(summary.role).toBe("bot");
    // Truncated to the 500-char bound; the full task text is not recorded.
    expect(summary.content.length).toBeLessThanOrEqual(500);
    expect(summary.content).toContain("migrate the runner");
    expect(LONG_TASK.startsWith(summary.content.replace(/…$/, ""))).toBe(true);
    expect(summary.content.length).toBeLessThan(LONG_TASK.length);
    // Projected for exactly the current members via the same INSERT OR IGNORE path.
    const db = await createSqlDriver(path);
    try {
      const rows = db.all<{ bot_id: string }>(
        "SELECT bot_id FROM bot_public_memory WHERE message_id = ? ORDER BY bot_id",
        [summary.id],
      );
      expect(rows.map((row) => row.bot_id)).toEqual(members);
      for (const botId of members) {
        const entries = store.listPublicMemory({ botId });
        expect(entries.map((entry) => entry.messageId)).toContain(summary.id);
      }
    } finally {
      db.close();
    }
  } finally {
    store.close();
  }
});

test("a short task is recorded verbatim in summary mode", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "xacpx-handoff-summary-short-")), "conversations.sqlite");
  const task = "rotate the staging credentials";
  const { store, receipt } = await handoffHarness(path, { handoffMemoryMode: () => "summary" }, task);
  try {
    const summaries = await summaryMessages(path, receipt.run.id, receipt.message.id);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.content).toBe(task);
  } finally {
    store.close();
  }
});

test("summary replay is a no-op and ex-members gain no rows", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "xacpx-handoff-summary-replay-")), "conversations.sqlite");
  const calls: HandoffPublicMemoryRecord[] = [];
  // bot_b has left the Group: the live membership snapshot only has bot_a.
  const { store, handoff, receipt } = await handoffHarness(path, {
    recordHandoffPublicMemory: (record) => calls.push(record),
    handoffMemoryMode: () => "summary",
    publicMemoryMembers: publicMemoryMembersFor(["bot_a"]),
  });
  try {
    expect(calls).toHaveLength(1);
    const summaries = await summaryMessages(path, receipt.run.id, receipt.message.id);
    expect(summaries).toHaveLength(1);
    const db = await createSqlDriver(path);
    try {
      const rows = db.all<{ bot_id: string }>(
        "SELECT bot_id FROM bot_public_memory WHERE message_id = ? ORDER BY bot_id",
        [summaries[0]!.id],
      );
      // Only the current member; the ex-member is excluded.
      expect(rows.map((row) => row.bot_id)).toEqual(["bot_a"]);
      expect(store.listPublicMemory({ botId: "bot_b" }).map((entry) => entry.messageId))
        .not.toContain(summaries[0]!.id);
    } finally {
      db.close();
    }
    // A replay short-circuits before the hook and writes nothing either.
    expect(store.acceptPublicHandoff(handoff).reused).toBe(true);
    expect(calls).toHaveLength(1);
    expect(await summaryMessages(path, receipt.run.id, receipt.message.id)).toHaveLength(1);
  } finally {
    store.close();
  }
});
