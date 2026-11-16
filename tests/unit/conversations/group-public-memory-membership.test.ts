import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

import { BotService } from "../../../src/bots/bot-service";
import type { AppConfig } from "../../../src/config/types";
import { SqliteConversationStore } from "../../../src/conversations/sqlite-conversation-store";
import { publicMemoryMembersFor } from "../../../src/conversations/conversation-types";
import { AsyncMutex } from "../../../src/orchestration/async-mutex";
import { createEmptyState, type AppState } from "../../../src/state/types";
import type { StateStore } from "../../../src/state/state-store";
import { harness, HUMAN, until } from "./fixtures/concurrency-harness";

const NOW = "2026-11-16T00:00:00.000Z";

class MemoryStateStore implements Pick<StateStore, "save" | "saveNow"> {
  async save(): Promise<void> {}
  async saveNow(): Promise<void> {}
}

function createConfig(): AppConfig {
  return {
    agents: { codex: { driver: "codex" } },
    workspaces: { backend: { cwd: "/tmp/backend" } },
  } as AppConfig;
}

const snap = (name: string) => ({
  revision: 1,
  capturedAt: NOW,
  presentation: { name },
  behavior: {},
  execution: { agent: "codex", workspace: "backend" },
});

test("a failed retain after membership commit is healed by retrying the same patch", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "xacpx-mem-retain-")), "c.sqlite");
  const state = createEmptyState();
  const bots = new BotService(createConfig(), state, new MemoryStateStore(), {
    now: () => new Date(NOW),
    createId: () => `bot_${crypto.randomUUID()}`,
    stateMutex: new AsyncMutex(),
  });
  const store = await SqliteConversationStore.open(path, {
    publicMemoryMembers: (conversationId, topicId) =>
      publicMemoryMembersFor(state.conversations[conversationId], state.conversation_topics[topicId]),
  });

  let retainCalls = 0;
  let failNext = false;
  bots.setConversationWork({
    hasDurableBotWork: () => false,
    hasNonterminalGroupMemberWork: () => false,
    retainGroupMemberMemory: (conversationId, remainingBotIds) => {
      retainCalls += 1;
      if (failNext) {
        failNext = false;
        throw new Error("simulated retain failure");
      }
      store.retainGroupMemberMemory(conversationId, remainingBotIds);
    },
  });

  const a = await bots.createBot({ name: "A", agent: "codex", workspace: "backend" });
  const b = await bots.createBot({ name: "B", agent: "codex", workspace: "backend" });
  const c = await bots.createBot({ name: "C", agent: "codex", workspace: "backend" });
  const group = await bots.createGroup({ title: "Team", botIds: [a.id, b.id, c.id], leadBotId: a.id });
  state.conversation_topics.topic = {
    id: "topic",
    conversationId: group.id,
    title: "T",
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
  };

  store.acceptRequest({
    conversationId: group.id,
    topicId: "topic",
    requestId: "r1",
    botId: a.id,
    content: "secret group plan",
    profileSnapshot: snap("A"),
    primaryMember: { botId: a.id, profileSnapshot: snap("A") },
    members: [
      { botId: b.id, profileSnapshot: snap("B") },
      { botId: c.id, profileSnapshot: snap("C") },
    ],
    maxMemberTurns: 24,
    now: NOW,
  });
  expect(store.listPublicMemory({ botId: c.id }).map((entry) => entry.content)).toEqual(["secret group plan"]);

  failNext = true;
  await expect(bots.updateGroup(group.id, { botIds: [a.id, b.id], leadBotId: a.id }))
    .rejects.toThrow("simulated retain failure");
  expect(bots.getGroup(group.id).botIds).toEqual([a.id, b.id]);
  expect(store.listPublicMemory({ botId: c.id }).map((entry) => entry.content)).toEqual(["secret group plan"]);
  expect(retainCalls).toBe(1);

  // Same membership patch: removedMembers is empty, but retain still runs
  // against the live members and drops C.
  await bots.updateGroup(group.id, { botIds: [a.id, b.id], leadBotId: a.id });
  expect(retainCalls).toBe(2);
  expect(store.listPublicMemory({ botId: c.id })).toEqual([]);
  expect(store.listPublicMemory({ botId: a.id }).map((entry) => entry.content)).toEqual(["secret group plan"]);
  store.close();
});

test("removing a member drops its Group history from later Direct prompts", async () => {
  const state = createEmptyState();
  const h = await harness({
    state,
    publicMemoryMembers: (conversationId, topicId) =>
      publicMemoryMembersFor(state.conversations[conversationId], state.conversation_topics[topicId]),
  });
  try {
    const members = h.ids.slice(0, 3);
    const group = await h.bots.createGroup({ title: "Memory team", botIds: members, leadBotId: members[0] });
    const topic = await h.service.createGroupTopic(group.id, "Topic", {
      workspace: "backend",
      isolation: "shared-single-writer",
    });
    const accepted = h.accept(group.id, topic.id, 1, true, "secret", undefined, members, "secret group plan");
    const drain = h.dispatcher.kick();
    await until(() => h.runner.calls.some((call) => call.runId === accepted.run.id));
    const index = h.runner.calls.findIndex((call) => call.runId === accepted.run.id);
    h.runner.finish(index, { status: "completed", text: "public reply" });
    await drain;

    const removed = members[2]!;
    const remaining = members.slice(0, 2);
    const before = await h.service.acceptDirectPrompt({
      botId: removed,
      requestId: "direct-before",
      content: "private question",
      humanIngress: HUMAN,
    });
    const beforeDrain = h.dispatcher.kick();
    await until(() => h.runner.calls.some((call) => call.runId === before.run.id));
    const beforeCall = h.runner.calls.find((call) => call.runId === before.run.id)!;
    h.runner.finish(h.runner.calls.indexOf(beforeCall), { status: "completed", text: "direct reply" });
    await beforeDrain;
    expect(beforeCall.text).toContain("secret group plan");

    await h.bots.updateGroup(group.id, { botIds: remaining, leadBotId: remaining[0] });
    expect(h.store.listPublicMemory({ botId: removed })).toEqual([]);

    const after = await h.service.acceptDirectPrompt({
      botId: removed,
      requestId: "direct-after",
      content: "private question",
      humanIngress: HUMAN,
    });
    const afterDrain = h.dispatcher.kick();
    await until(() => h.runner.calls.some((call) => call.runId === after.run.id));
    const afterCall = h.runner.calls.find((call) => call.runId === after.run.id)!;
    h.runner.finish(h.runner.calls.indexOf(afterCall), { status: "completed", text: "direct reply" });
    await afterDrain;
    expect(afterCall.text).not.toContain("secret group plan");
    expect(afterCall.text).not.toContain("Shared group context");
  } finally {
    h.store.close();
  }
});

test("activation drops leftover public memory for Bots that are no longer members", async () => {
  const state: AppState = createEmptyState();
  const h = await harness({
    state,
    publicMemoryMembers: (conversationId, topicId) =>
      publicMemoryMembersFor(state.conversations[conversationId], state.conversation_topics[topicId]),
  });
  try {
    const members = h.ids.slice(0, 3);
    const group = await h.bots.createGroup({ title: "Memory team", botIds: members, leadBotId: members[0] });
    const topic = await h.service.createGroupTopic(group.id, "Topic", {
      workspace: "backend",
      isolation: "shared-single-writer",
    });
    const accepted = h.accept(group.id, topic.id, 1, true, "secret", undefined, members, "secret group plan");
    const drain = h.dispatcher.kick();
    await until(() => h.runner.calls.some((call) => call.runId === accepted.run.id));
    h.runner.finish(h.runner.calls.findIndex((call) => call.runId === accepted.run.id), {
      status: "completed",
      text: "public reply",
    });
    await drain;

    const removed = members[2]!;
    const remaining = members.slice(0, 2);
    // Crash window: AppState membership already committed, SQLite rows leftover.
    const live = state.conversations[group.id]!;
    state.conversations[group.id] = { ...live, botIds: remaining };
    expect(h.store.listPublicMemory({ botId: removed }).map((entry) => entry.content)).toContain("secret group plan");

    await h.service.activateAfterConsumerLock();
    expect(h.store.listPublicMemory({ botId: removed })).toEqual([]);
    expect(h.store.listPublicMemory({ botId: remaining[0]! }).map((entry) => entry.content)).toContain("secret group plan");
  } finally {
    h.store.close();
  }
});
