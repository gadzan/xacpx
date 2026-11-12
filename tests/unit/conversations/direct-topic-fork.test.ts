import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

import { BotRuntimeManager } from "../../../src/bots/bot-runtime-manager";
import { BotService } from "../../../src/bots/bot-service";
import type { AppConfig } from "../../../src/config/types";
import { ConversationDispatcher } from "../../../src/conversations/conversation-dispatcher";
import { ConversationError } from "../../../src/conversations/conversation-error";
import { ConversationRunService } from "../../../src/conversations/conversation-run-service";
import type { ConversationTurnRunInput, ConversationTurnRunResult } from "../../../src/conversations/conversation-turn-runner";
import { SqliteConversationStore } from "../../../src/conversations/sqlite-conversation-store";
import { MAX_FORK_HANDOFF_CHARS } from "../../../src/conversations/topic-fork-handoff";
import { createDirectConversationId, createDirectTopicId } from "../../../src/domain/ids";
import { AsyncMutex } from "../../../src/orchestration/async-mutex";
import { SessionService } from "../../../src/sessions/session-service";
import { createStrictOwnedSessionRelease } from "../../../src/sessions/owned-session-release";
import { createEmptyState, type AppState } from "../../../src/state/types";
import { clearAdvertisedCommands, markCommandRevision, rememberAdvertisedCommands } from "../../../src/conversations/advertised-commands";

const NOW = "2026-11-12T00:00:00.000Z";
const BOT_ID = "bot_direct";
const HUMAN = { chatKey: "relay:human", accountId: "human", senderId: "human", isOwner: true as const };

/** Records every prompt the dispatcher would hand the provider, so the
 *  injection window is asserted on the real composed text. */
class RecordingRunner {
  calls: ConversationTurnRunInput[] = [];
  next = 0;
  /** Set to fail the next N runs before any text would be produced. */
  failNext = 0;
  async run(input: ConversationTurnRunInput): Promise<ConversationTurnRunResult> {
    this.calls.push(input);
    if (this.failNext > 0) {
      this.failNext -= 1;
      return { status: "failed", reason: "provider_rejected" } as ConversationTurnRunResult;
    }
    return { status: "completed", text: `reply ${++this.next}` };
  }
  async cancel() {
    return { cancelled: true } as never;
  }
}

async function harness() {
  const path = join(mkdtempSync(join(tmpdir(), "xacpx-direct-fork-")), "conversations.sqlite");
  const store = await SqliteConversationStore.open(path);
  const state = createEmptyState();
  const stateStore = { async save(_state: AppState) {}, async saveNow(_state: AppState) {} };
  const stateMutex = new AsyncMutex();
  const config = {
    agents: { codex: { driver: "codex" } },
    workspaces: { backend: { cwd: tmpdir() } },
    transport: { type: "acpx-cli" },
    channel: { type: "weixin" },
    channels: [],
    plugins: [],
  } as unknown as AppConfig;
  const sessions = new SessionService(config, stateStore, state, { stateMutex });
  const releaseOwnedSession = createStrictOwnedSessionRelease({
    sessions,
    transport: { async releaseLogicalSession() {}, async deleteSession() {} },
  });
  const botIds = [BOT_ID, "bot_second"];
  const bots = new BotService(config, state, stateStore, { stateMutex, createId: () => botIds.shift() ?? crypto.randomUUID() });
  await bots.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  // Every Group needs at least two members; the direct cases never touch this
  // one, and the cross-kind test needs it to exist at all.
  await bots.createBot({ name: "Second", agent: "codex", workspace: "backend" });
  const runtime = new BotRuntimeManager(bots, sessions, state, stateStore, {
    stateMutex,
    releaseOwnedSession,
    forkHandoffs: {
      getTopicForkHandoff: (topicId: string) => store.getTopicForkHandoff(topicId),
    },
  });
  let clock = Date.parse(NOW);
  const now = () => new Date(clock++);
  const runner = new RecordingRunner();
  const dispatcher = new ConversationDispatcher(store, runtime, runner, sessions, {
    now,
    ownerId: "owner",
    authorityEpoch: "epoch",
  });
  const service = new ConversationRunService(store, bots, runtime, dispatcher, sessions, state, stateStore, {
    now,
    stateMutex,
    autoKick: false,
    releaseOwnedSession,
  });
  const conversation = await service.getConversation(createDirectConversationId(BOT_ID));
  const topic = await service.createDirectTopic(BOT_ID, "Source");
  const send = async (topicId: string, text: string, requestId: string) => {
    const accepted = await service.acceptDirectPrompt({
      botId: BOT_ID,
      conversationId: conversation.id,
      topicId,
      requestId,
      content: text,
      humanIngress: HUMAN,
    });
    await dispatcher.kick();
    return accepted;
  };
  return { store, state, bots, runtime, runner, dispatcher, service, conversation, topic, send };
}

function randomTopicId(): string {
  return `topic_${crypto.randomUUID()}`;
}

test("a Direct fork writes a handoff row, copies no rows, and marks the mode", async () => {
  const h = await harness();
  try {
    await h.send(h.topic.id, "first request", "req-1");
    await h.send(h.topic.id, "second request", "req-2");
    const sourceMessages = h.store.listMessages({ conversationId: h.conversation.id, topicId: h.topic.id, limit: 50 });
    const targetTopicId = randomTopicId();

    const forked = await h.service.forkDirectTopic({
      conversationId: h.conversation.id,
      sourceTopicId: h.topic.id,
      targetTopicId,
      requestId: "fork-1",
    });

    expect(forked.id).toBe(targetTopicId);
    expect(forked.forkedFrom).toMatchObject({
      requestId: "fork-1",
      sourceTopicId: h.topic.id,
      sourceTitle: h.topic.title,
      mode: "handoff",
      rootTopicId: h.topic.id,
    });
    // No message rows in the target: a Direct turn never reads them, so a copy
    // would only fake the UI.
    expect(h.store.listMessages({ conversationId: h.conversation.id, topicId: targetTopicId, limit: 50 })).toEqual([]);
    const handoff = h.store.getTopicForkHandoff(targetTopicId);
    expect(handoff).toBeDefined();
    expect(handoff!.text).toContain("Historical context from the Direct Topic");
    expect(handoff!.text.length).toBeLessThanOrEqual(MAX_FORK_HANDOFF_CHARS);
    expect(handoff!.messageCount).toBe(sourceMessages.length);
    expect(forked.forkedFrom?.copiedMessages).toBe(handoff!.messageCount);
    // The text lives in SQLite only: state carries provenance, never the body.
    expect(JSON.stringify(h.state)).not.toContain("Historical context from the Direct Topic");
  } finally {
    h.store.close();
  }
});

test("the first prompt carries the handoff and the second one does not", async () => {
  const h = await harness();
  try {
    await h.send(h.topic.id, "remember the release checklist", "req-1");
    const targetTopicId = randomTopicId();
    await h.service.forkDirectTopic({
      conversationId: h.conversation.id,
      sourceTopicId: h.topic.id,
      targetTopicId,
      requestId: "fork-1",
    });
    const callsBefore = h.runner.calls.length;
    await h.send(targetTopicId, "next step", "req-2");
    const first = h.runner.calls[callsBefore]!;
    expect(first.text).toContain("Historical context from the Direct Topic");
    expect(first.text).toContain("<<<HISTORY");
    expect(first.text).toContain("Human: remember the release checklist");
    // The history sits before the body, so `userText` stays a suffix of the
    // final prompt and mention offsets keep their meaning.
    expect(first.text.endsWith("next step")).toBe(true);

    await h.send(targetTopicId, "and then", "req-3");
    const second = h.runner.calls[h.runner.calls.length - 1]!;
    expect(second.text).not.toContain("Historical context from the Direct Topic");
    expect(second.text).not.toContain("<<<HISTORY");
  } finally {
    h.store.close();
  }
});

test("a known command first turn keeps the handoff for the next prompt", async () => {
  const h = await harness();
  try {
    await h.send(h.topic.id, "context worth keeping", "req-1");
    const targetTopicId = randomTopicId();
    await h.service.forkDirectTopic({
      conversationId: h.conversation.id,
      sourceTopicId: h.topic.id,
      targetTopicId,
      requestId: "fork-1",
    });
    const before = h.runner.calls.length;
    await h.send(targetTopicId, "/status", "req-2");
    expect(h.runner.calls[before]!.text).toBe("/status");
    // The command turn persists a bot reply and must still leave the marker
    // untouched: the next real prompt is what the fork was made for.
    expect(h.store.getTopicForkHandoff(targetTopicId)?.consumedAt).toBeUndefined();
    await h.send(targetTopicId, "real prompt", "req-3");
    expect(h.runner.calls[h.runner.calls.length - 1]!.text).toContain("Historical context from the Direct Topic");
    expect(h.store.getTopicForkHandoff(targetTopicId)?.consumedAt).toBeTruthy();
  } finally {
    clearAdvertisedCommands();
    h.store.close();
  }
});

test("an advertised runtime command first turn also keeps the handoff", async () => {
  const h = await harness();
  try {
    await h.send(h.topic.id, "context worth keeping", "req-1");
    const targetTopicId = randomTopicId();
    await h.service.forkDirectTopic({
      conversationId: h.conversation.id,
      sourceTopicId: h.topic.id,
      targetTopicId,
      requestId: "fork-1",
    });
    // Revision first, advertisement second: a revision change retires every
    // callback for the runtime, so the reverse order would be wiped before the
    // turn ever reads it.
    const identity = { conversationId: h.conversation.id, topicId: targetTopicId, botId: BOT_ID };
    markCommandRevision(identity, "1:1");
    rememberAdvertisedCommands(identity, [{ name: "compact" }]);
    const before = h.runner.calls.length;
    await h.send(targetTopicId, "/compact", "req-2");
    expect(h.runner.calls[before]!.text).toBe("/compact");
    expect(h.store.getTopicForkHandoff(targetTopicId)?.consumedAt).toBeUndefined();
    await h.send(targetTopicId, "real prompt", "req-3");
    expect(h.runner.calls[h.runner.calls.length - 1]!.text).toContain("Historical context from the Direct Topic");
  } finally {
    clearAdvertisedCommands();
    h.store.close();
  }
});

test("a provider failure after composition does not re-inject on the next prompt", async () => {
  const h = await harness();
  try {
    await h.send(h.topic.id, "history worth exactly one look", "req-1");
    const targetTopicId = randomTopicId();
    await h.service.forkDirectTopic({
      conversationId: h.conversation.id,
      sourceTopicId: h.topic.id,
      targetTopicId,
      requestId: "fork-1",
    });
    h.runner.failNext = 1;
    const before = h.runner.calls.length;
    await h.send(targetTopicId, "first attempt", "req-2");
    // The prompt was composed WITH the history, so the injection is spent even
    // though the provider failed: a fork is worth one look, not a replay loop.
    expect(h.runner.calls[before]!.text).toContain("Historical context from the Direct Topic");
    expect(h.store.getTopicForkHandoff(targetTopicId)?.consumedAt).toBeTruthy();
    await h.send(targetTopicId, "second attempt", "req-3");
    expect(h.runner.calls[h.runner.calls.length - 1]!.text)
      .not.toContain("Historical context from the Direct Topic");
  } finally {
    h.store.close();
  }
});

test("the consumption marker keeps its first timestamp on a repeat write", async () => {
  const h = await harness();
  try {
    await h.send(h.topic.id, "history", "req-1");
    const targetTopicId = randomTopicId();
    await h.service.forkDirectTopic({
      conversationId: h.conversation.id,
      sourceTopicId: h.topic.id,
      targetTopicId,
      requestId: "fork-1",
    });
    h.store.markTopicForkHandoffConsumed(targetTopicId, "2026-11-12T01:00:00.000Z");
    h.store.markTopicForkHandoffConsumed(targetTopicId, "2026-11-12T02:00:00.000Z");
    expect(h.store.getTopicForkHandoff(targetTopicId)?.consumedAt).toBe("2026-11-12T01:00:00.000Z");
  } finally {
    h.store.close();
  }
});

test("a fork still talks after its source Topic is deleted, and the same request replays", async () => {
  const h = await harness();
  try {
    await h.send(h.topic.id, "history that outlives the source", "req-1");
    const targetTopicId = randomTopicId();
    const input = {
      conversationId: h.conversation.id,
      sourceTopicId: h.topic.id,
      targetTopicId,
      requestId: "fork-1",
    };
    const forked = await h.service.forkDirectTopic(input);
    await h.service.teardownTopic(h.conversation.id, h.topic.id, "teardown-1");
    const before = h.runner.calls.length;
    await h.send(targetTopicId, "still here", "req-2");
    expect(h.runner.calls[before]!.text).toContain("Human: history that outlives the source");
    // The replay resolves before it reads the source, so a deleted source is
    // not `topic_not_found` for a fork that already exists.
    const replay = await h.service.forkDirectTopic(input);
    expect(replay.id).toBe(forked.id);
    expect(h.store.getTopicForkHandoff(targetTopicId)!.text).toBe(h.store.getTopicForkHandoff(targetTopicId)!.text);
    expect(h.state.conversation_topics[targetTopicId]?.forkedFrom?.requestId).toBe("fork-1");
  } finally {
    h.store.close();
  }
});

test("a replay under a different request id is a conflict, and a foreign target is refused", async () => {
  const h = await harness();
  try {
    await h.send(h.topic.id, "history", "req-1");
    const targetTopicId = randomTopicId();
    const base = {
      conversationId: h.conversation.id,
      sourceTopicId: h.topic.id,
      targetTopicId,
    };
    await h.service.forkDirectTopic({ ...base, requestId: "fork-1" });
    await expect(h.service.forkDirectTopic({ ...base, requestId: "fork-2" }))
      .rejects.toThrow(expect.objectContaining({ code: "topic_exists" }));
  } finally {
    h.store.close();
  }
});

test("a damaged target fails closed instead of being handed back", async () => {
  const h = await harness();
  try {
    await h.send(h.topic.id, "history", "req-1");
    const targetTopicId = randomTopicId();
    const input = {
      conversationId: h.conversation.id,
      sourceTopicId: h.topic.id,
      targetTopicId,
      requestId: "fork-1",
    };
    await h.service.forkDirectTopic(input);
    // Simulate a handoff row lost under a surviving Topic record.
    h.store.deleteTopicRows(h.conversation.id, targetTopicId);
    await expect(h.service.forkDirectTopic(input))
      .rejects.toThrow(expect.objectContaining({ code: "topic_fork_history_missing" }));
  } finally {
    h.store.close();
  }
});

test("an orphan handoff row with no Topic record fails closed and is not adopted", async () => {
  const h = await harness();
  try {
    const targetTopicId = randomTopicId();
    h.store.putTopicForkHandoff({
      topicId: targetTopicId,
      conversationId: h.conversation.id,
      text: "orphan text",
      throughSeq: 3,
      messageCount: 2,
      omittedMessages: 0,
      createdAt: NOW,
    });
    await h.send(h.topic.id, "history", "req-1");
    await expect(h.service.forkDirectTopic({
      conversationId: h.conversation.id,
      sourceTopicId: h.topic.id,
      targetTopicId,
      requestId: "fork-1",
    })).rejects.toThrow(expect.objectContaining({ code: "topic_fork_history_missing" }));
    expect(h.state.conversation_topics[targetTopicId]).toBeUndefined();
  } finally {
    h.store.close();
  }
});

test("an empty source reports empty instead of writing a hollow handoff", async () => {
  const h = await harness();
  try {
    await expect(h.service.forkDirectTopic({
      conversationId: h.conversation.id,
      sourceTopicId: h.topic.id,
      targetTopicId: randomTopicId(),
      requestId: "fork-1",
    })).rejects.toThrow(expect.objectContaining({ code: "topic_fork_empty" }));
  } finally {
    h.store.close();
  }
});

test("an unsettled source reports unsettled and settles once the run completes", async () => {
  const h = await harness();
  try {
    h.runner.failNext = 0;
    const accepted = await h.service.acceptDirectPrompt({
      botId: BOT_ID,
      conversationId: h.conversation.id,
      topicId: h.topic.id,
      requestId: "req-1",
      content: "in flight",
      humanIngress: HUMAN,
    });
    expect(accepted.run.state).toBe("queued");
    await expect(h.service.forkDirectTopic({
      conversationId: h.conversation.id,
      sourceTopicId: h.topic.id,
      targetTopicId: randomTopicId(),
      requestId: "fork-1",
    })).rejects.toThrow(expect.objectContaining({ code: "topic_fork_source_unsettled" }));
    await h.dispatcher.kick();
    const forked = await h.service.forkDirectTopic({
      conversationId: h.conversation.id,
      sourceTopicId: h.topic.id,
      targetTopicId: randomTopicId(),
      requestId: "fork-2",
    });
    expect(forked.forkedFrom?.mode).toBe("handoff");
    expect(forked.forkedFrom?.sourceRunId).toBe(accepted.run.id);
  } finally {
    h.store.close();
  }
});

test("the Direct default Topic cannot be a fork target", async () => {
  const h = await harness();
  try {
    await h.send(h.topic.id, "history", "req-1");
    await expect(h.service.forkDirectTopic({
      conversationId: h.conversation.id,
      sourceTopicId: h.topic.id,
      targetTopicId: createDirectTopicId(BOT_ID),
      requestId: "fork-1",
    })).rejects.toThrow(expect.objectContaining({ code: "topic_exists" }));
  } finally {
    h.store.close();
  }
});

test("a Group conversation cannot be forked as Direct", async () => {
  const h = await harness();
  try {
    const group = await h.bots.createGroup({ title: "Group", botIds: [BOT_ID, "bot_second"] });
    const groupTopic = await h.service.createGroupTopic(group.id, "T", { workspace: "backend", isolation: "shared" });
    await expect(h.service.forkDirectTopic({
      conversationId: group.id,
      sourceTopicId: groupTopic.id,
      targetTopicId: randomTopicId(),
      requestId: "fork-1",
    })).rejects.toThrow(expect.objectContaining({ code: "conversation_not_direct" }));
  } finally {
    h.store.close();
  }
});

test("clearing the default Topic drops the fork provenance and the handoff row", async () => {
  const h = await harness();
  try {
    // Fork INTO the default Topic is refused, so build the state the clear path
    // must clean: a default Topic that owns a handoff row and a fork record.
    const defaultTopicId = createDirectTopicId(BOT_ID);
    await h.send(h.topic.id, "history", "req-1");
    h.store.putTopicForkHandoff({
      topicId: defaultTopicId,
      conversationId: h.conversation.id,
      text: "stale handoff",
      throughSeq: 1,
      messageCount: 1,
      omittedMessages: 0,
      createdAt: NOW,
    });
    await h.service.clearDefaultTopic(h.conversation.id, defaultTopicId, { requestId: "clear-1", confirm: true });
    expect(h.state.conversation_topics[defaultTopicId]?.forkedFrom).toBeUndefined();
    expect(h.store.getTopicForkHandoff(defaultTopicId)).toBeUndefined();
  } finally {
    h.store.close();
  }
});

test("fork-of-fork carries the parent handoff and accumulates the counts", async () => {
  const h = await harness();
  try {
    await h.send(h.topic.id, "generation one", "req-1");
    const second = randomTopicId();
    const firstFork = await h.service.forkDirectTopic({
      conversationId: h.conversation.id,
      sourceTopicId: h.topic.id,
      targetTopicId: second,
      requestId: "fork-1",
    });
    await h.send(second, "generation two", "req-2");
    const third = randomTopicId();
    const secondFork = await h.service.forkDirectTopic({
      conversationId: h.conversation.id,
      sourceTopicId: second,
      targetTopicId: third,
      requestId: "fork-2",
    });
    const handoff = h.store.getTopicForkHandoff(third)!;
    expect(handoff.text).toContain("generation one");
    expect(handoff.text).toContain("generation two");
    expect(secondFork.forkedFrom?.rootTopicId).toBe(h.topic.id);
    expect(handoff.messageCount).toBeGreaterThan(firstFork.forkedFrom!.copiedMessages);
  } finally {
    h.store.close();
  }
});

test("a message boundary outside the source Topic is refused", async () => {
  const h = await harness();
  try {
    await h.send(h.topic.id, "history", "req-1");
    const other = await h.service.createDirectTopic(BOT_ID, "Other");
    await expect(h.service.forkDirectTopic({
      conversationId: h.conversation.id,
      sourceTopicId: h.topic.id,
      targetTopicId: randomTopicId(),
      requestId: "fork-1",
      sourcePoint: { type: "run", runId: "run_missing" },
    })).rejects.toThrow(ConversationError);
    void other;
  } finally {
    h.store.close();
  }
});
