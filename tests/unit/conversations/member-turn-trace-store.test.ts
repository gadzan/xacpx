import { expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createSqlDriver } from "../../../src/conversations/sql-driver";
import { SqliteConversationStore } from "../../../src/conversations/sqlite-conversation-store";
import { ConversationError } from "../../../src/conversations/conversation-error";
import type { MemberTurnTraceIdentity, MemberTurnTraceInputEvent } from "../../../src/conversations/member-turn-trace";
const NOW = "2026-10-20T12:00:00.000Z";
const identity: MemberTurnTraceIdentity = {
  conversationId: "conversation_pr8_explicit", topicId: "topic_pr8_explicit", runId: "run_pr8_explicit",
  botId: "bot_a", memberTurnId: "mturn_pr8_explicit", attempt: 1, sourceTurnId: "physical-turn-1",
};
const text: MemberTurnTraceInputEvent = { kind: "text", payload: { text: "answer" }, createdAt: NOW };
const terminal: MemberTurnTraceInputEvent = { kind: "terminal", payload: { ok: true }, createdAt: NOW };

async function fixture(path = ":memory:") {
  const sql = await createSqlDriver(path);
  sql.exec(readFileSync(join(import.meta.dir, "fixtures/pr8-explicit-queued.sql"), "utf8"));
  const store = new SqliteConversationStore(sql);
  sql.run("UPDATE member_turns SET state = 'running', source_turn_id = ? WHERE id = ?", [identity.sourceTurnId, identity.memberTurnId]);
  sql.run("UPDATE runs SET state = 'running' WHERE id = ?", [identity.runId]);
  return { sql, store };
}

test("real PR8 schema migrates additively across repeated opens without inventing legacy traces", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "xacpx-trace-migration-")), "conversations.sqlite");
  const sql = await createSqlDriver(path);
  sql.exec(readFileSync(join(import.meta.dir, "fixtures/pr8-explicit-queued.sql"), "utf8"));
  sql.close();
  let store = await SqliteConversationStore.open(path);
  try {
    expect(store.getRun(identity.runId)?.requestMessageId).toBe("cmsg_pr8_request");
    expect(store.traces.get(identity)).toBeUndefined();
    expect(store.getMemberTurn(identity.memberTurnId)?.state).toBe("queued");
    store.close();
    store = await SqliteConversationStore.open(path);
    expect(store.traces.listAttempts(identity)).toEqual([]);
    expect(store.listMessages({ conversationId: identity.conversationId, topicId: identity.topicId, limit: 10 })).toHaveLength(1);
    store.close();
    store = await SqliteConversationStore.open(path);
    expect(store.getRun(identity.runId)?.consumedMemberTurns).toBe(0);
  } finally {
    store.close();
    rmSync(dirname(path), { recursive: true, force: true });
  }
});

test("start and every write require exact persisted run, member, bot, scope, attempt and source", async () => {
  const { sql, store } = await fixture();
  try {
    for (const patch of [
      { conversationId: "foreign" }, { topicId: "foreign" }, { runId: "foreign" }, { memberTurnId: "foreign" },
      { botId: "foreign" }, { attempt: 2 }, { sourceTurnId: "late" }, { sourceTurnId: "" },
    ]) expect(() => store.traces.appendBatch({ ...identity, ...patch }, "bad", [])).toThrow();
    sql.run("UPDATE member_turns SET state = 'queued' WHERE id = ?", [identity.memberTurnId]);
    expect(() => store.traces.appendBatch(identity, "queued", [])).toThrow();
    sql.run("UPDATE member_turns SET state = 'running' WHERE id = ?", [identity.memberTurnId]);
    expect(store.traces.appendBatch(identity, "start", []).lastSeq).toBe(0);
    sql.run("UPDATE member_turns SET source_turn_id = 'replacement' WHERE id = ?", [identity.memberTurnId]);
    expect(() => store.traces.appendBatch(identity, "late", [text])).toThrow();
    expect(store.traces.get(identity)?.lastSeq).toBe(0);
    expect(store.traces.get({ ...identity, topicId: "foreign" })).toBeUndefined();
  } finally { store.close(); }
});

test("durable batch replay preserves exact ordered events and latest plan without duplicate retries", async () => {
  const { sql, store } = await fixture();
  try {
    const events: MemberTurnTraceInputEvent[] = [
      text,
      { kind: "reasoning", payload: { text: "public thought" }, createdAt: NOW },
      { kind: "tool", payload: { step: { toolCallId: "tool-1", toolName: "run_command", kind: "execute", status: "running", title: "run tests" } }, createdAt: NOW },
      { kind: "plan", payload: { entries: [{ content: "first", status: "pending", priority: "high" }] }, createdAt: NOW },
      { kind: "plan", payload: { entries: [{ content: "replacement", status: "completed", priority: "high" }] }, createdAt: NOW },
    ];
    expect(store.traces.appendBatch(identity, "batch-1", events)).toMatchObject({ firstSeq: 1, lastSeq: 5, reused: false });
    expect(store.traces.appendBatch(identity, "batch-1", events)).toMatchObject({ firstSeq: 1, lastSeq: 5, reused: true });
    expect(() => store.traces.appendBatch(identity, "batch-1", [text])).toThrow();
    const page = store.traces.listEvents(identity)!;
    expect(page.events.map(event => event.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(page.events.map(event => event.kind)).toEqual(["text", "reasoning", "tool", "plan", "plan"]);
    expect(page.plan?.map(entry => entry.content)).toEqual(["replacement"]);
    sql.run("UPDATE member_turns SET attempt = 2, source_turn_id = 'new-source' WHERE id = ?", [identity.memberTurnId]);
    expect(store.traces.appendBatch(identity, "batch-1", events).reused).toBe(true);
    expect(() => store.traces.appendBatch(identity, "stale-new-batch", [text])).toThrow();
  } finally { store.close(); }
});

test("fresh empty database migrates trace tables additively and leaves every read empty", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "xacpx-trace-empty-")), "conversations.sqlite");
  let store: SqliteConversationStore | undefined;
  try {
    store = await SqliteConversationStore.open(path);
    expect(store.traces.get(identity)).toBeUndefined();
    expect(store.traces.listAttempts({ conversationId: identity.conversationId, topicId: identity.topicId,
      runId: identity.runId })).toEqual([]);
    expect(store.traces.listEvents(identity)).toBeUndefined();
    expect(store.getRun(identity.runId)).toBeUndefined();
    expect(store.traces.interrupt(identity, "nothing", NOW)).toBe(false);
    expect(store.traces.activateConsumer(NOW)).toBe(0);
    expect(() => store.traces.appendBatch(identity, "orphan", [])).toThrow();
    store.close();
    store = await SqliteConversationStore.open(path);
    expect(store.traces.get(identity)).toBeUndefined();
    expect(store.traces.listAttempts({ conversationId: identity.conversationId, topicId: identity.topicId,
      runId: identity.runId })).toEqual([]);
  } finally {
    store?.close();
    rmSync(dirname(path), { recursive: true, force: true });
  }
});

test("valid rich public steps and plans persist while unknown keys, nesting or enums never write", async () => {
  const { sql, store } = await fixture();
  try {
    const richStep = {
      toolCallId: "tool-rich", parentToolCallId: "tool-parent", isSubagent: false, toolName: "edit_file",
      kind: "edit" as const, title: "src/agent.ts", titleIsPath: true, status: "success" as const,
      durationMs: 12,
      detail: { type: "diff" as const, path: "src/agent.ts", oldText: "old", newText: "new", instruction: "swap" },
    };
    const richPlan = [
      { content: "survey", status: "completed" as const, priority: "high" as const },
      { content: "patch", status: "in_progress" as const, priority: "medium" as const },
      { content: "verify", status: "pending" as const, priority: "low" as const },
    ];
    const rich: MemberTurnTraceInputEvent[] = [
      { kind: "tool", payload: { step: richStep }, createdAt: NOW },
      { kind: "plan", payload: { entries: richPlan }, createdAt: NOW },
    ];
    expect(store.traces.appendBatch(identity, "rich", rich)).toMatchObject({ firstSeq: 1, lastSeq: 2 });
    expect(store.traces.listEvents(identity)!.events[0]?.payload).toEqual({ step: richStep });
    expect(store.traces.listEvents(identity)!.plan).toEqual(richPlan);
    const baseline = sql.get<{ count: number }>("SELECT COUNT(*) AS count FROM member_turn_trace_events")!.count;
    const rejected: Array<[string, MemberTurnTraceInputEvent[]]> = [
      ["unknown event key", [{ ...text, extra: "leaked" } as unknown as MemberTurnTraceInputEvent]],
      ["unknown payload key", [{ kind: "reasoning", payload: { text: "t", raw: "secret" }, createdAt: NOW } as unknown as MemberTurnTraceInputEvent]],
      ["nested raw tool key", [{ kind: "tool", payload: { step: { ...richStep, rawInput: { cmd: "secret" } } }, createdAt: NOW } as unknown as MemberTurnTraceInputEvent]],
      ["invalid tool status", [{ kind: "tool", payload: { step: { ...richStep, status: "bogus" } }, createdAt: NOW } as unknown as MemberTurnTraceInputEvent]],
      ["invalid tool kind", [{ kind: "tool", payload: { step: { ...richStep, kind: "bogus" } }, createdAt: NOW } as unknown as MemberTurnTraceInputEvent]],
      ["nested raw plan entry", [{ kind: "plan", payload: { entries: [{ ...richPlan[0]!, raw: "secret" }] }, createdAt: NOW } as unknown as MemberTurnTraceInputEvent]],
      ["invalid plan status", [{ kind: "plan", payload: { entries: [{ content: "x", status: "bogus" }] }, createdAt: NOW } as unknown as MemberTurnTraceInputEvent]],
      ["invalid terminal extra", [{ kind: "terminal", payload: { ok: true, raw: "secret" }, createdAt: NOW } as unknown as MemberTurnTraceInputEvent]],
    ];
    for (const [label, events] of rejected) {
      expect(() => store.traces.appendBatch(identity, `reject-${label}-${baseline}`, events), label).toThrow();
    }
    expect(sql.get<{ count: number }>("SELECT COUNT(*) AS count FROM member_turn_trace_events")!.count).toBe(baseline);
    expect(store.traces.get(identity)).toMatchObject({ recordingState: "recording", lastSeq: 2 });
    expect(store.traces.listAttempts(identity)).toHaveLength(1);
  } finally { store.close(); }
});

test("flush revalidation fallback closes stale identities interrupted and never fabricates terminals", async () => {
  const { sql, store } = await fixture();
  try {
    store.traces.appendBatch(identity, "first", [text]);
    expect(store.traces.closeUnknownIdentity(identity, NOW)).toBe(false);
    expect(store.traces.closeUnknownIdentity({ ...identity, memberTurnId: "mturn_missing" }, NOW)).toBe(false);
    sql.run("UPDATE member_turns SET source_turn_id = 'rotated' WHERE id = ?", [identity.memberTurnId]);
    expect(store.traces.closeUnknownIdentity(identity, "2026-10-20T13:00:00.000Z")).toBe(true);
    expect(store.traces.get(identity)).toMatchObject({
      recordingState: "interrupted",
      completenessReason: "trace_identity_mismatch",
      finishedAt: "2026-10-20T13:00:00.000Z",
      lastSeq: 1,
    });
    expect(store.traces.closeUnknownIdentity(identity, NOW)).toBe(false);
    expect(() => store.traces.appendBatch(identity, "late", [text])).toThrow();
    expect(store.traces.listEvents(identity)?.events).toHaveLength(1);
  } finally { store.close(); }
});

test("raw adapter payloads and oversize events are rejected without durable side effects", async () => {
  const { sql, store } = await fixture();
  try {
    const rawStep = { toolCallId: "tool-1", toolName: "run_command", kind: "execute", status: "running", title: "run", rawOutput: "secret" };
    expect(() => store.traces.appendBatch(identity, "raw", [
      { kind: "tool", payload: { step: rawStep }, createdAt: NOW } as unknown as MemberTurnTraceInputEvent,
    ])).toThrow("trace tool requires a public normalized step");
    expect(() => store.traces.appendBatch(identity, "huge", [
      { kind: "text", payload: { text: "x".repeat(200 * 1024) }, createdAt: NOW },
    ])).toThrowError(ConversationError);
    expect(store.traces.get(identity)).toBeUndefined();
    expect(sql.get<{ count: number }>("SELECT COUNT(*) AS count FROM member_turn_trace_events")?.count).toBe(0);
    expect(store.traces.interrupt(identity, "oversize_rejected", NOW)).toBe(false);
    store.traces.appendBatch(identity, "start", [text]);
    expect(store.traces.interrupt(identity, "oversize_rejected", NOW)).toBe(true);
  } finally { store.close(); }
});

test("same-bot later batches and sibling members allocate independent seq streams", async () => {
  const { sql, store } = await fixture();
  try {
    const sameBot = { ...identity, memberTurnId: "mturn_second", sourceTurnId: "physical-second" };
    const sibling = { ...identity, botId: "bot_b", memberTurnId: "mturn_sibling", sourceTurnId: "physical-sibling" };
    for (const member of [sameBot, sibling]) sql.run(`INSERT INTO member_turns
      (id, run_id, conversation_id, topic_id, bot_id, source_turn_id, batch, member_index, attempt,
       origin, state, trigger_message_ids_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 2, 0, 1, 'followup', 'running', '[]', ?)`,
    [member.memberTurnId, member.runId, member.conversationId, member.topicId, member.botId, member.sourceTurnId, NOW]);
    for (const member of [identity, sameBot, sibling]) {
      expect(store.traces.appendBatch(member, "same-batch-id", [text]).lastSeq).toBe(1);
    }
    store.traces.appendBatch(identity, "second", [text]);
    expect(store.traces.listEvents(sameBot)?.events.map(event => event.seq)).toEqual([1]);
    expect(store.traces.listAttempts(identity).map(trace => trace.identity.memberTurnId)).toEqual([
      identity.memberTurnId,
    ]);
    expect(store.traces.listAttempts({ conversationId: identity.conversationId, topicId: identity.topicId, runId: identity.runId })).toHaveLength(3);
    expect(store.traces.get({ ...sameBot, sourceTurnId: identity.sourceTurnId })).toBeUndefined();
  } finally { store.close(); }
});

test("only an accepted final terminal marker completes a trace, even after member status changes", async () => {
  const { sql, store } = await fixture();
  try {
    store.traces.appendBatch(identity, "first", [text]);
    sql.run("UPDATE member_turns SET state = 'completed' WHERE id = ?", [identity.memberTurnId]);
    sql.run("UPDATE runs SET state = 'completed' WHERE id = ?", [identity.runId]);
    expect(store.traces.get(identity)?.recordingState).toBe("recording");
    expect(() => store.traces.appendBatch(identity, "bad-terminal", [terminal, text])).toThrow();
    expect(store.traces.get(identity)?.lastSeq).toBe(1);
    store.traces.appendBatch(identity, "terminal", [terminal]);
    expect(store.traces.get(identity)).toMatchObject({ recordingState: "complete", lastSeq: 2, finishedAt: NOW });
    expect(store.traces.listEvents(identity)?.events.at(-1)?.kind).toBe("terminal");
    expect(store.traces.appendBatch(identity, "terminal", [terminal]).reused).toBe(true);
    expect(() => store.traces.appendBatch(identity, "after", [text])).toThrow();
    expect(store.traces.interrupt(identity, "late-failure")).toBe(false);
    expect(store.traces.activateConsumer()).toBe(0);
  } finally { store.close(); }
});

test("paging has exact scope, stable cursors, bounded event counts and UTF-8 response bytes", async () => {
  const { store } = await fixture();
  try {
    store.traces.appendBatch(identity, "many", Array.from({ length: 220 }, (_, index) => ({
      kind: "text" as const, payload: { text: `${index}:界`.repeat(40) }, createdAt: NOW,
    })));
    const capped = store.traces.listEvents(identity, { limit: 10000 })!;
    expect(capped.events).toHaveLength(200);
    expect(capped.hasMore).toBe(true);
    let cursor = 0;
    const sequences: number[] = [];
    do {
      const page = store.traces.listEvents(identity, { afterSeq: cursor, limit: 7, maxBytes: 2400 })!;
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(2400);
      expect(page.events.length).toBeGreaterThan(0);
      expect(page.events.length).toBeLessThanOrEqual(7);
      sequences.push(...page.events.map(event => event.seq));
      cursor = page.nextSeq;
      if (!page.hasMore) break;
    } while (cursor < 220);
    expect(sequences).toEqual(Array.from({ length: 220 }, (_, index) => index + 1));
    expect(store.traces.listEvents(identity, { afterSeq: 220 })?.events).toEqual([]);
    expect(store.traces.listEvents({ ...identity, runId: "foreign" })).toBeUndefined();
    expect(() => store.traces.listEvents(identity, { afterSeq: -1 })).toThrow();
    expect(() => store.traces.listEvents(identity, { maxBytes: 1 })).toThrow();
  } finally { store.close(); }
});

test("failed transaction rolls back events, sequence, plan, completion and batch receipt", async () => {
  const { sql, store } = await fixture();
  try {
    sql.exec(`CREATE TRIGGER reject_second_trace BEFORE INSERT ON member_turn_trace_events WHEN NEW.seq = 2
      BEGIN SELECT RAISE(ABORT, 'injected trace failure'); END;`);
    expect(() => store.traces.appendBatch(identity, "retry-me", [text, terminal])).toThrow("injected trace failure");
    expect(store.traces.get(identity)).toBeUndefined();
    expect(sql.get<{ count: number }>("SELECT COUNT(*) AS count FROM member_turn_trace_events")?.count).toBe(0);
    expect(sql.get<{ count: number }>("SELECT COUNT(*) AS count FROM member_turn_trace_batches")?.count).toBe(0);
    sql.exec("DROP TRIGGER reject_second_trace");
    expect(store.traces.appendBatch(identity, "retry-me", [text, terminal])).toMatchObject({ reused: false, firstSeq: 1, lastSeq: 2 });
  } finally { store.close(); }
});

test("restart interruption occurs only on consumer activation and preserves previous attempt history", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "xacpx-trace-restart-")), "conversations.sqlite");
  let { store } = await fixture(path);
  try {
    store.traces.appendBatch(identity, "first", [text]);
    store.close();
    store = await SqliteConversationStore.open(path);
    expect(store.traces.get(identity)?.recordingState).toBe("recording");
    expect(store.traces.activateConsumer(NOW)).toBe(1);
    expect(store.traces.get(identity)).toMatchObject({ recordingState: "interrupted", completenessReason: "consumer_restarted" });
    expect(store.traces.activateConsumer(NOW)).toBe(0);
    expect(() => store.traces.appendBatch(identity, "resume-old", [text])).toThrow();
    store.close();
    const sql = await createSqlDriver(path);
    sql.run("UPDATE member_turns SET attempt = 2, source_turn_id = 'attempt-two', state = 'running' WHERE id = ?", [identity.memberTurnId]);
    store = new SqliteConversationStore(sql);
    const next = { ...identity, attempt: 2, sourceTurnId: "attempt-two" };
    store.traces.appendBatch(next, "first", [text, terminal]);
    const historicalQuery = { conversationId: identity.conversationId, topicId: identity.topicId, runId: identity.runId, memberTurnId: identity.memberTurnId, attempt: identity.attempt };
    expect(store.traces.listEvents(historicalQuery)?.events.map(event => event.seq)).toEqual([1]);
    expect(store.traces.listAttempts(identity).map(trace => trace.recordingState)).toEqual(["interrupted", "complete"]);
  } finally {
    store.close();
    rmSync(dirname(path), { recursive: true, force: true });
  }
});

test("explicit recorder interruption preserves committed data and cannot fabricate a missing trace", async () => {
  const { store } = await fixture();
  try {
    expect(store.traces.interrupt(identity, "write_failed", NOW)).toBe(false);
    store.traces.appendBatch(identity, "first", [text]);
    expect(store.traces.interrupt({ ...identity, sourceTurnId: "wrong" }, "wrong", NOW)).toBe(false);
    expect(store.traces.interrupt(identity, "recorder_overflow", NOW)).toBe(true);
    expect(store.traces.get(identity)).toMatchObject({ recordingState: "interrupted", completenessReason: "recorder_overflow", lastSeq: 1 });
    expect(store.traces.listEvents(identity)?.events).toHaveLength(1);
    expect(() => store.traces.appendBatch(identity, "terminal", [terminal])).toThrow();
  } finally { store.close(); }
});

for (const operation of ["teardown", "clear", "conversation"] as const) {
  test(`${operation} atomically removes trace events and durable batch receipts; rollback retains them`, async () => {
    const { sql, store } = await fixture();
    try {
      store.traces.appendBatch(identity, "first", [text]);
      const remove = () => {
        if (operation === "teardown") store.deleteTopicRows(identity.conversationId, identity.topicId);
        else if (operation === "clear") store.retireTopicContext({ conversationId: identity.conversationId, topicId: identity.topicId, requestId: "clear-1", now: NOW, releaseBindings: true });
        else store.deleteConversationRows(identity.conversationId);
      };
      sql.exec(`CREATE TRIGGER reject_run_delete BEFORE DELETE ON runs
        BEGIN SELECT RAISE(ABORT, 'injected cleanup failure'); END;`);
      expect(remove).toThrow("injected cleanup failure");
      expect(store.traces.get(identity)?.lastSeq).toBe(1);
      expect(store.traces.listEvents(identity)?.events).toHaveLength(1);
      expect(sql.get<{ count: number }>("SELECT COUNT(*) AS count FROM member_turn_trace_batches")?.count).toBe(1);
      expect(store.getMemberTurn(identity.memberTurnId)).toBeDefined();
      sql.exec("DROP TRIGGER reject_run_delete");
      remove();
      remove();
      expect(store.traces.get(identity)).toBeUndefined();
      for (const table of ["member_turn_traces", "member_turn_trace_events", "member_turn_trace_batches"]) {
        expect(sql.get<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`)?.count).toBe(0);
      }
      expect(store.getMemberTurn(identity.memberTurnId)).toBeUndefined();
    } finally { store.close(); }
  });
}
