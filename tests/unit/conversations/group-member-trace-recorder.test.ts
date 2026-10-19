import { expect, test } from "bun:test";
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
  return { appState, store };
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

test("activation marks a crashed recording interrupted and a clean dispose preserves terminal work", async () => {
  const { appState, store } = await fixture();
  const events = createControlEventBus();
  const recorder = new GroupMemberTraceRecorder({ store, state: appState, events, now: () => NOW });
  try {
    events.emit({ type: "turn-finished", chatKey: "group", sessionAlias: "alias", ok: true, conversation: correlation() });
    expect(store.traces.get(query)).toBeUndefined();
    recorder.activate();
    events.emit({ type: "turn-output", chatKey: "group", sessionAlias: "alias", chunk: "interrupted", conversation: correlation() });
    recorder.dispose();
    expect(store.traces.get(query)?.recordingState).toBe("recording");
    const reopened = new GroupMemberTraceRecorder({ store, state: appState, events, now: () => NOW });
    try {
      reopened.activate();
      expect(store.traces.get(query)?.recordingState).toBe("interrupted");
    } finally {
      reopened.dispose();
    }
  } finally {
    store.close();
  }
});
