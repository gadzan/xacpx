import { expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createControlEventBus } from "../../../src/control/control-event-bus";
import type { ConversationTurnCorrelation } from "../../../src/control/conversation-control-dtos";
import { createSqlDriver } from "../../../src/conversations/sql-driver";
import { SqliteConversationStore } from "../../../src/conversations/sqlite-conversation-store";
import { GroupMemberTraceRecorder } from "../../../src/conversations/group-member-trace-recorder";
import { createEmptyState } from "../../../src/state/types";

const NOW = "2026-10-20T12:00:00.000Z";
const BOT = "bot_a";
const CONVERSATION = "conversation_pr8_explicit";
const TOPIC = "topic_pr8_explicit";
const RUN = "run_pr8_explicit";
const MEMBER = "mturn_pr8_explicit";
const ATTEMPT = 1;
const SOURCE = "physical-turn-1";

function state() {
  const next = createEmptyState();
  next.conversations[CONVERSATION] = {
    id: CONVERSATION, kind: "group", title: "Group", botIds: [BOT, "bot_b"],
    createdAt: NOW, updatedAt: NOW,
  };
  next.conversation_topics[TOPIC] = {
    id: TOPIC, conversationId: CONVERSATION, title: "Topic", status: "active",
    createdAt: NOW, updatedAt: NOW, executionTarget: { workspace: "backend", isolation: "shared" },
  };
  return next;
}

async function fixture() {
  const appState = state();
  const sql = await createSqlDriver(":memory:");
  sql.exec(readFileSync(join(import.meta.dir, "fixtures/pr8-explicit-queued.sql"), "utf8"));
  const store = new SqliteConversationStore(sql);
  sql.run("UPDATE member_turns SET state = 'running', source_turn_id = ? WHERE id = ?", [SOURCE, MEMBER]);
  sql.run("UPDATE runs SET state = 'running' WHERE id = ?", [RUN]);
  return { appState, store, sql };
}
function correlation(overrides: Partial<ConversationTurnCorrelation> = {}): ConversationTurnCorrelation {
  return {
    conversationId: CONVERSATION, topicId: TOPIC, botId: BOT, runId: RUN,
    memberTurnId: MEMBER, attempt: ATTEMPT, sourceTurnId: SOURCE, ...overrides,
  };
}
const query = { conversationId: CONVERSATION, topicId: TOPIC, runId: RUN, memberTurnId: MEMBER, attempt: ATTEMPT };

test("live Group events persist ordered public text, tools, plan and terminal", async () => {
  const { appState, store } = await fixture();
  const events = createControlEventBus();
  const recorder = new GroupMemberTraceRecorder({ store, state: appState, events, now: () => NOW });
  try {
    recorder.activate();
    events.emit({ type: "turn-started", chatKey: "group", sessionAlias: "alias", conversation: correlation() });
    events.emit({ type: "turn-output", chatKey: "group", sessionAlias: "alias", chunk: "public answer", conversation: correlation() });
    events.emit({ type: "turn-thought", chatKey: "group", sessionAlias: "alias", chunk: "visible reasoning", conversation: correlation() });
    events.emit({
      type: "tool-event", chatKey: "group", sessionAlias: "alias",
      event: { toolCallId: "tool-1", toolName: "Read", kind: "read", status: "success", rawInput: { path: "a.ts" } },
      conversation: correlation(),
    });
    events.emit({
      type: "plan", chatKey: "group", sessionAlias: "alias",
      entries: [{ content: "Inspect", status: "completed" }],
      conversation: correlation(),
    });
    events.emit({ type: "turn-finished", chatKey: "group", sessionAlias: "alias", ok: true, conversation: correlation() });
    const page = store.traces.listEvents(query)!;
    expect(page.recordingState).toBe("complete");
    expect(page.events.map((event) => event.kind)).toEqual(["text", "reasoning", "tool", "plan", "terminal"]);
    expect(JSON.stringify(page)).not.toContain("rawInput");
    expect(page.plan).toEqual([{ content: "Inspect", status: "completed" }]);
  } finally {
    recorder.dispose();
    store.close();
  }
});

test("missing identity, direct scope, private topics and stale attempts are not recorded", async () => {
  const { appState, store } = await fixture();
  const events = createControlEventBus();
  const recorder = new GroupMemberTraceRecorder({ store, state: appState, events, now: () => NOW });
  try {
    recorder.activate();
    events.emit({ type: "turn-output", chatKey: "group", sessionAlias: "alias", chunk: "no identity" });
    events.emit({ type: "turn-finished", chatKey: "group", sessionAlias: "alias", ok: true, conversation: correlation({ attempt: undefined }) });
    appState.conversations[CONVERSATION]!.kind = "bot";
    events.emit({ type: "turn-finished", chatKey: "group", sessionAlias: "alias", ok: true, conversation: correlation() });
    appState.conversations[CONVERSATION]!.kind = "group";
    appState.conversation_topics[TOPIC]!.peerScope = { sourceConversationId: "other", sourceTopicId: "peer", sourceBotId: BOT };
    events.emit({ type: "turn-finished", chatKey: "group", sessionAlias: "alias", ok: true, conversation: correlation() });
    delete appState.conversation_topics[TOPIC]!.peerScope;
    events.emit({ type: "turn-finished", chatKey: "group", sessionAlias: "alias", ok: true, conversation: correlation({ sourceTurnId: "stale" }) });
    expect(store.traces.get(query)).toBeUndefined();
  } finally {
    recorder.dispose();
    store.close();
  }
});

test("activation interrupts crashed streams and rejects their later terminal events", async () => {
  const { appState, store } = await fixture();
  const events = createControlEventBus();
  store.traces.appendBatch({ ...correlation(), attempt: ATTEMPT, sourceTurnId: SOURCE }, "crashed-process", []);
  const recorder = new GroupMemberTraceRecorder({ store, state: appState, events, now: () => NOW });
  try {
    recorder.activate();
    expect(store.traces.get(query)?.recordingState).toBe("interrupted");
    events.emit({ type: "turn-started", chatKey: "group", sessionAlias: "alias", conversation: correlation() });
    events.emit({ type: "turn-finished", chatKey: "group", sessionAlias: "alias", ok: true, conversation: correlation() });
    expect(store.traces.get(query)?.recordingState).toBe("interrupted");
  } finally {
    recorder.dispose();
    store.close();
  }
});

test("alternating public text and thought chunks retain arrival order", async () => {
  const { appState, store } = await fixture();
  const events = createControlEventBus();
  const recorder = new GroupMemberTraceRecorder({ store, state: appState, events, now: () => NOW });
  try {
    recorder.activate();
    events.emit({ type: "turn-started", chatKey: "group", sessionAlias: "alias", conversation: correlation() });
    for (const [type, chunk] of [
      ["turn-output", "first"], ["turn-thought", "think"], ["turn-output", "second"], ["turn-thought", "again"],
    ] as const) {
      events.emit({ type, chunk, chatKey: "group", sessionAlias: "alias", conversation: correlation() });
    }
    events.emit({ type: "turn-finished", chatKey: "group", sessionAlias: "alias", ok: true, conversation: correlation() });
    const page = store.traces.listEvents(query)!;
    expect(page.events.map((event) => event.kind)).toEqual(["text", "reasoning", "text", "reasoning", "terminal"]);
    expect(page.events.slice(0, 4).map((event) => event.payload)).toEqual([
      { text: "first" }, { text: "think" }, { text: "second" }, { text: "again" },
    ]);
    expect(page.recordingState).toBe("complete");
  } finally {
    recorder.dispose();
    store.close();
  }
});

test("a short live trace becomes readable on the flush timer", async () => {
  const { appState, store } = await fixture();
  const events = createControlEventBus();
  const recorder = new GroupMemberTraceRecorder({ store, state: appState, events, now: () => NOW });
  try {
    recorder.activate();
    events.emit({ type: "turn-started", chatKey: "group", sessionAlias: "alias", conversation: correlation() });
    events.emit({ type: "turn-output", chatKey: "group", sessionAlias: "alias", chunk: "live", conversation: correlation() });
    expect(store.traces.listEvents(query)?.events).toEqual([]);
    await new Promise<void>((resolve) => setTimeout(resolve, 60));
    const page = store.traces.listEvents(query)!;
    expect(page.events.map((event) => event.payload)).toEqual([{ text: "live" }]);
    expect(page.recordingState).toBe("recording");
  } finally {
    recorder.dispose();
    store.close();
  }
});

test("a failed flush cannot later complete or restart the same attempt", async () => {
  const { appState, store } = await fixture();
  const events = createControlEventBus();
  const errors: unknown[] = [];
  const recorder = new GroupMemberTraceRecorder({ store, state: appState, events, now: () => NOW, onError: (error) => errors.push(error) });
  try {
    recorder.activate();
    events.emit({ type: "turn-started", chatKey: "group", sessionAlias: "alias", conversation: correlation() });
    const append = spyOn(store.traces, "appendBatch").mockImplementationOnce(() => { throw new Error("disk failure"); });
    events.emit({ type: "turn-output", chatKey: "group", sessionAlias: "alias", chunk: "lost", conversation: correlation() });
    events.emit({ type: "turn-finished", chatKey: "group", sessionAlias: "alias", ok: true, conversation: correlation() });
    append.mockRestore();
    events.emit({ type: "turn-started", chatKey: "group", sessionAlias: "alias", conversation: correlation() });
    events.emit({ type: "turn-finished", chatKey: "group", sessionAlias: "alias", ok: true, conversation: correlation() });
    expect(store.traces.listEvents(query)?.recordingState).toBe("interrupted");
    expect(store.traces.listEvents(query)?.events).toEqual([]);
    expect(errors.length).toBeGreaterThan(0);
  } finally {
    recorder.dispose();
    store.close();
  }
});

test("empty public plan snapshots replace earlier plans", async () => {
  const { appState, store } = await fixture();
  const events = createControlEventBus();
  const recorder = new GroupMemberTraceRecorder({ store, state: appState, events, now: () => NOW });
  try {
    recorder.activate();
    events.emit({ type: "turn-started", chatKey: "group", sessionAlias: "alias", conversation: correlation() });
    events.emit({ type: "plan", chatKey: "group", sessionAlias: "alias", entries: [{ content: "Task", status: "pending" }], conversation: correlation() });
    events.emit({ type: "plan", chatKey: "group", sessionAlias: "alias", entries: [], conversation: correlation() });
    events.emit({ type: "turn-finished", chatKey: "group", sessionAlias: "alias", ok: true, conversation: correlation() });
    const page = store.traces.listEvents(query)!;
    expect(page.plan).toEqual([]);
    expect(page.events.map((event) => event.kind)).toEqual(["plan", "plan", "terminal"]);
    expect(page.recordingState).toBe("complete");
  } finally {
    recorder.dispose();
    store.close();
  }
});

test("terminal and stream events without an observed start create no trace", async () => {
  const { appState, store } = await fixture();
  const events = createControlEventBus();
  const recorder = new GroupMemberTraceRecorder({ store, state: appState, events, now: () => NOW });
  try {
    recorder.activate();
    events.emit({ type: "turn-output", chatKey: "group", sessionAlias: "alias", chunk: "unobserved", conversation: correlation() });
    events.emit({ type: "plan", chatKey: "group", sessionAlias: "alias", entries: [], conversation: correlation() });
    events.emit({ type: "turn-finished", chatKey: "group", sessionAlias: "alias", ok: true, conversation: correlation() });
    expect(store.traces.get(query)).toBeUndefined();
  } finally {
    recorder.dispose();
    store.close();
  }
});

test("shutdown flushes with unique batch identities, interrupts open traces and detaches", async () => {
  const { appState, store } = await fixture();
  const events = createControlEventBus();
  const errors: unknown[] = [];
  const recorder = new GroupMemberTraceRecorder({ store, state: appState, events, now: () => NOW, onError: (error) => errors.push(error) });
  recorder.activate();
  events.emit({ type: "turn-started", chatKey: "group", sessionAlias: "alias", conversation: correlation() });
  events.emit({ type: "plan", chatKey: "group", sessionAlias: "alias", entries: [], conversation: correlation() });
  events.emit({ type: "turn-output", chatKey: "group", sessionAlias: "alias", chunk: "last chunk", conversation: correlation() });
  recorder.dispose();
  const page = store.traces.listEvents(query)!;
  expect(page.events.map((event) => event.kind)).toEqual(["plan", "text"]);
  expect(page.recordingState).toBe("interrupted");
  expect(page.completenessReason).toBe("recorder_disposed");
  store.close();
  expect(() => recorder.dispose()).not.toThrow();
  events.emit({ type: "turn-finished", chatKey: "group", sessionAlias: "alias", ok: true, conversation: correlation() });
  await new Promise<void>((resolve) => setTimeout(resolve, 60));
  expect(errors).toEqual([]);
});

test("retired attempt buffers are fenced again when they flush", async () => {
  const { appState, store, sql } = await fixture();
  const events = createControlEventBus();
  const recorder = new GroupMemberTraceRecorder({ store, state: appState, events, now: () => NOW });
  try {
    recorder.activate();
    events.emit({ type: "turn-started", chatKey: "group", sessionAlias: "alias", conversation: correlation() });
    events.emit({ type: "turn-output", chatKey: "group", sessionAlias: "alias", chunk: "stale buffer", conversation: correlation() });
    sql.run("UPDATE member_turns SET attempt = 2, source_turn_id = ? WHERE id = ?", ["physical-turn-2", MEMBER]);
    events.emit({ type: "turn-started", chatKey: "group", sessionAlias: "alias", conversation: correlation({ attempt: 2, sourceTurnId: "physical-turn-2" }) });
    events.emit({ type: "turn-output", chatKey: "group", sessionAlias: "alias", chunk: "fresh", conversation: correlation({ attempt: 2, sourceTurnId: "physical-turn-2" }) });
    events.emit({ type: "turn-finished", chatKey: "group", sessionAlias: "alias", ok: true, conversation: correlation({ attempt: 2, sourceTurnId: "physical-turn-2" }) });
    await new Promise<void>((resolve) => setTimeout(resolve, 60));
    expect(store.traces.listEvents(query)?.recordingState).toBe("interrupted");
    expect(store.traces.listEvents(query)?.events).toEqual([]);
    const current = store.traces.listEvents({ ...query, attempt: 2 })!;
    expect(current.recordingState).toBe("complete");
    expect(current.events.map((event) => event.payload)).toEqual([{ text: "fresh" }, { ok: true }]);
  } finally {
    recorder.dispose();
    store.close();
  }
});

test("interleaved sibling members keep independent sequences and terminal state", async () => {
  const { appState, store, sql } = await fixture();
  const sibling = correlation({ memberTurnId: "sibling", botId: "bot_b", sourceTurnId: "sibling-source" });
  sql.run(`INSERT INTO member_turns
    (id, run_id, conversation_id, topic_id, bot_id, source_turn_id, attempt, origin, state, trigger_message_ids_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, 'human-explicit', 'running', '[]', ?)`,
  [sibling.memberTurnId, RUN, CONVERSATION, TOPIC, sibling.botId, sibling.sourceTurnId!, NOW]);
  const events = createControlEventBus();
  const recorder = new GroupMemberTraceRecorder({ store, state: appState, events, now: () => NOW });
  try {
    recorder.activate();
    for (const member of [correlation(), sibling]) {
      events.emit({ type: "turn-started", chatKey: "group", sessionAlias: "alias", conversation: member });
    }
    events.emit({ type: "turn-output", chatKey: "group", sessionAlias: "alias", chunk: "A", conversation: correlation() });
    events.emit({ type: "turn-thought", chatKey: "group", sessionAlias: "alias", chunk: "B", conversation: sibling });
    events.emit({ type: "turn-finished", chatKey: "group", sessionAlias: "alias", ok: true, conversation: sibling });
    events.emit({ type: "turn-output", chatKey: "group", sessionAlias: "alias", chunk: "2", conversation: correlation() });
    events.emit({ type: "turn-finished", chatKey: "group", sessionAlias: "alias", ok: true, conversation: correlation() });
    const first = store.traces.listEvents(query)!;
    const second = store.traces.listEvents({ ...query, memberTurnId: sibling.memberTurnId })!;
    expect(first.events.map((event) => event.seq)).toEqual([1, 2]);
    expect(first.events[0]?.payload).toEqual({ text: "A2" });
    expect(second.events.map((event) => event.seq)).toEqual([1, 2]);
    expect(second.events[0]?.payload).toEqual({ text: "B" });
    expect([first.recordingState, second.recordingState]).toEqual(["complete", "complete"]);
  } finally {
    recorder.dispose();
    store.close();
  }
});

test("escaped Unicode text chunks fit the durable UTF8 JSON event bound without loss", async () => {
  const { appState, store } = await fixture();
  const events = createControlEventBus();
  const recorder = new GroupMemberTraceRecorder({ store, state: appState, events, now: () => NOW });
  const text = "\u0000😀漢\"\\".repeat(15000);
  try {
    recorder.activate();
    events.emit({ type: "turn-started", chatKey: "group", sessionAlias: "alias", conversation: correlation() });
    events.emit({ type: "turn-output", chatKey: "group", sessionAlias: "alias", chunk: text, conversation: correlation() });
    events.emit({ type: "turn-finished", chatKey: "group", sessionAlias: "alias", ok: true, conversation: correlation() });
    const page = store.traces.listEvents(query, { maxBytes: 1024 * 1024 })!;
    const chunks = page.events.filter((event) => event.kind === "text");
    expect(chunks.map((event) => event.payload.text).join("")).toBe(text);
    for (const event of chunks) expect(Buffer.byteLength(JSON.stringify(event), "utf8")).toBeLessThanOrEqual(128 * 1024);
    expect(page.recordingState).toBe("complete");
  } finally {
    recorder.dispose();
    store.close();
  }
});

test("plans that cannot be retained whole interrupt instead of silently truncating", async () => {
  const { appState, store } = await fixture();
  const events = createControlEventBus();
  const recorder = new GroupMemberTraceRecorder({ store, state: appState, events, now: () => NOW });
  try {
    recorder.activate();
    events.emit({ type: "turn-started", chatKey: "group", sessionAlias: "alias", conversation: correlation() });
    events.emit({ type: "plan", chatKey: "group", sessionAlias: "alias", entries: [{ content: "x".repeat(4097), status: "pending" }], conversation: correlation() });
    events.emit({ type: "turn-finished", chatKey: "group", sessionAlias: "alias", ok: true, conversation: correlation() });
    expect(store.traces.get(query)?.recordingState).toBe("interrupted");
    expect(store.traces.get(query)?.completenessReason).toBe("trace_plan_invalid");
    expect(store.traces.listEvents(query)?.events).toEqual([]);
  } finally {
    recorder.dispose();
    store.close();
  }
});
