import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ControlService, conversationKernel } from "../../../src/control/control-service";
import { createControlEventBus } from "../../../src/control/control-event-bus";
import { createConversationRuntime } from "../../../src/conversations/conversation-composition";
import { ConversationError } from "../../../src/conversations/conversation-error";
import { createDirectConversationId, createDirectTopicId, createScopedDirectBindingId, createScopedGroupMemberBindingId } from "../../../src/domain/ids";
import { lifecycleOperationId } from "../../../src/conversations/lifecycle-operation";
import { AsyncMutex } from "../../../src/orchestration/async-mutex";
import { SessionService } from "../../../src/sessions/session-service";
import { createEmptyState, type AppState, type LogicalSession } from "../../../src/state/types";
import { BotError } from "../../../src/bots/bot-error";

const NOW = "2026-10-09T00:00:00.000Z";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function compose(options?: {
  failRelease?: () => boolean;
  path?: string;
  state?: AppState;
  afterBotRemovalBarrier?: () => Promise<void>;
}) {
  const state = options?.state ?? createEmptyState();
  const path = options?.path ?? join(mkdtempSync(join(tmpdir(), "xacpx-bot-remove-")), "conversations.sqlite");
  const released: string[] = [];
  const config = {
    transport: { type: "acpx-cli", permissionMode: "approve-all" },
    agents: { codex: { driver: "codex" } },
    workspaces: { backend: { cwd: tmpdir() } },
  } as never;
  const stateStore = { save: async () => {}, saveNow: async () => {} };
  const stateMutex = new AsyncMutex();
  const sessions = new SessionService(config, stateStore, state, { stateMutex });
  const events = createControlEventBus();
  const control = new ControlService({
    agent: { chat: async () => ({ text: "ok" }) },
    sessions,
    activeTurns: { isActiveAnywhere: () => false },
    events,
    scheduled: {},
    orchestration: {},
    workspaces: { list: () => [{ name: "backend", cwd: tmpdir() }] },
  } as never);
  const kernel = conversationKernel(control);
  const runtime = await createConversationRuntime({
    config,
    state,
    stateStore,
    sessions,
    control: kernel,
    sqlitePath: path,
    releaseOwnedSession: async (alias) => {
      released.push(alias);
      if (options?.failRelease?.()) {
        throw new ConversationError("session_release_failed", `release failed for ${alias}`);
      }
      delete state.sessions[alias];
    },
    stateMutex,
    autoKick: false,
    ...(options?.afterBotRemovalBarrier ? { afterBotRemovalBarrier: options.afterBotRemovalBarrier } : {}),
    onProductEvent: (event) => kernel.emitConversationProduct(event),
  });
  kernel.bindConversationRuntime(runtime);
  return {
    state,
    path,
    control,
    runtime,
    released,
    close: () => runtime.shutdown(),
  };
}

async function bot(current: Awaited<ReturnType<typeof compose>>, name: string) {
  return current.control.createBot({ name, agent: "codex", workspace: "backend" });
}

async function remove(current: Awaited<ReturnType<typeof compose>>, botId: string, requestId: string, flags?: {
  clearDirectHistory?: boolean;
  releaseDirectBindings?: boolean;
}) {
  const impact = await current.control.previewBotRemoval(botId);
  return current.control.removeBot({
    botId,
    requestId,
    previewRevision: impact.revision,
    clearDirectHistory: flags?.clearDirectHistory === true,
    releaseDirectBindings: flags?.releaseDirectBindings === true,
  });
}

test("an unused bot retires, and deleteBot still removes a different unused bot", async () => {
  const current = await compose();
  try {
    const unused = await bot(current, "Unused");
    const other = await bot(current, "Other");
    const impact = await current.control.previewBotRemoval(unused.id);
    expect(impact.groups).toEqual([]);
    expect(impact.history).toEqual({ directMessages: 0, directRuns: 0, groupMessages: 0, groupRuns: 0 });
    const removed = await current.control.removeBot({
      botId: unused.id,
      requestId: "remove-unused",
      previewRevision: impact.revision,
    });
    expect(removed.operation.phase).toBe("completed");
    expect(current.control.listBots().find((item) => item.id === unused.id)?.retired).toBe(true);
    expect(current.control.getBot(unused.id).name).toBe("Unused");
    await expect(current.control.promptConversation({
      conversationId: createDirectConversationId(unused.id),
      topicId: createDirectTopicId(unused.id),
      requestId: "after-retire",
      text: "no",
    })).rejects.toMatchObject({ code: "conversation_not_found" });
    expect(current.runtime.store.listRuns(createDirectConversationId(unused.id))).toEqual([]);
    await current.control.deleteBot(other.id);
    expect(current.control.listBots().some((item) => item.id === other.id)).toBe(false);
  } finally {
    await current.close();
  }
});

test("a bot that only created a topic can be removed while that topic stays", async () => {
  const current = await compose();
  try {
    const created = await bot(current, "Notes");
    const conversationId = createDirectConversationId(created.id);
    const topic = await current.control.createTopic(conversationId, "Scratch");
    await expect(current.control.deleteBot(created.id)).rejects.toMatchObject({ code: "bot_in_use" });
    const removed = await remove(current, created.id, "remove-topic");
    expect(removed.operation.phase).toBe("completed");
    expect(current.state.conversation_topics[topic.id]?.title).toBe("Scratch");
    expect(current.runtime.store.hasDurableBotWork(created.id)).toBe(false);
    expect(current.control.getBot(created.id).retired).toBe(true);
  } finally {
    await current.close();
  }
});

test("direct chat stays unless the caller explicitly clears it, and group history stays either way", async () => {
  const current = await compose();
  try {
    const speaker = await bot(current, "Speaker");
    const partner = await bot(current, "Partner");
    const keeper = await bot(current, "Keeper");
    const conversationId = createDirectConversationId(speaker.id);
    const topicId = createDirectTopicId(speaker.id);
    await current.control.promptConversation({
      conversationId,
      topicId,
      requestId: "direct-1",
      text: "private note",
    });
    const group = await current.control.createGroup({ title: "Team", botIds: [speaker.id, partner.id, keeper.id] });
    const groupTopic = await current.control.createGroupTopic(group.id, "Sprint", {
      workspace: "backend",
      isolation: "shared",
    });
    await current.control.promptConversation({
      conversationId: group.id,
      topicId: groupTopic.id,
      requestId: "group-1",
      text: "group note",
      target: { mode: "members", botIds: [speaker.id] },
    });
    await current.runtime.runs.cancelRun((await current.runtime.store.listRuns(group.id, groupTopic.id))[0]!.id);
    await current.control.updateGroup(group.id, { botIds: [partner.id, keeper.id] });
    const kept = await remove(current, speaker.id, "remove-keep");
    expect(kept.operation.phase).toBe("completed");
    expect(kept.operation.clearDirectHistory).toBe(false);
    expect(current.runtime.store.listRuns(conversationId).length).toBeGreaterThan(0);
    expect(current.runtime.store.botHistoryCounts(speaker.id, conversationId).groupRuns).toBeGreaterThan(0);
    expect(current.runtime.store.hasDurableBotWork(speaker.id)).toBe(true);
    await expect(current.control.deleteBot(speaker.id)).rejects.toMatchObject({ code: "bot_not_found" });
    expect(current.control.getBot(partner.id).retired).toBeUndefined();
    expect(current.state.conversations[group.id]?.botIds).toEqual([partner.id, keeper.id]);
    expect(current.state.conversation_topics[groupTopic.id]?.title).toBe("Sprint");
  } finally {
    await current.close();
  }
});

test("clearing direct history does not erase group history", async () => {
  const current = await compose();
  try {
    const speaker = await bot(current, "Speaker");
    const partner = await bot(current, "Partner");
    const keeper = await bot(current, "Keeper");
    const conversationId = createDirectConversationId(speaker.id);
    await current.control.promptConversation({
      conversationId,
      topicId: createDirectTopicId(speaker.id),
      requestId: "direct-clear",
      text: "erase me",
    });
    const group = await current.control.createGroup({ title: "Team", botIds: [speaker.id, partner.id, keeper.id] });
    const groupTopic = await current.control.createGroupTopic(group.id, "Sprint", {
      workspace: "backend",
      isolation: "shared",
    });
    await current.control.promptConversation({
      conversationId: group.id,
      topicId: groupTopic.id,
      requestId: "group-clear",
      text: "keep me",
      target: { mode: "members", botIds: [partner.id] },
    });
    await current.control.updateGroup(group.id, { botIds: [partner.id, keeper.id] });
    await remove(current, speaker.id, "remove-clear", { clearDirectHistory: true });
    expect(current.runtime.store.listRuns(conversationId)).toEqual([]);
    expect(current.runtime.store.botHistoryCounts(speaker.id, conversationId).groupRuns).toBe(0);
    expect(current.runtime.store.listRuns(group.id).map((run) => run.requestId)).toEqual(["group-clear"]);
    expect(current.state.bots[partner.id]?.name).toBe("Partner");
  } finally {
    await current.close();
  }
});

test("a bot in a group is not removed, and a two-member group cannot drop one member", async () => {
  const current = await compose();
  try {
    const left = await bot(current, "Left");
    const right = await bot(current, "Right");
    const group = await current.control.createGroup({ title: "Pair", botIds: [left.id, right.id] });
    const impact = await current.control.previewBotRemoval(left.id);
    expect(impact.groups).toEqual([{
      conversationId: group.id,
      title: "Pair",
      memberCount: 2,
      blocker: "group-needs-another-member",
    }]);
    await expect(current.control.removeBot({
      botId: left.id,
      requestId: "remove-pair",
      previewRevision: impact.revision,
    })).rejects.toMatchObject({ code: "bot_in_group" });
    expect(current.control.getGroup(group.id).botIds).toEqual([left.id, right.id]);
    expect(current.state.bots[right.id]?.name).toBe("Right");
  } finally {
    await current.close();
  }
});

test("a departed member session is released and the group transcript stays", async () => {
  const current = await compose();
  try {
    const left = await bot(current, "Left");
    const mid = await bot(current, "Mid");
    const right = await bot(current, "Right");
    const group = await current.control.createGroup({ title: "Trio", botIds: [left.id, mid.id, right.id] });
    const topic = await current.control.createGroupTopic(group.id, "Sprint", {
      workspace: "backend",
      isolation: "shared",
    });
    await current.control.promptConversation({
      conversationId: group.id,
      topicId: topic.id,
      requestId: "said",
      text: "from left",
      target: { mode: "members", botIds: [left.id] },
    });
    await current.runtime.runs.cancelRun(current.runtime.store.listRuns(group.id, topic.id)[0]!.id);
    const bindingId = createScopedGroupMemberBindingId(group.id, topic.id, left.id);
    const alias = "alias-left";
    current.state.bot_runtime_bindings[bindingId] = {
      id: bindingId,
      scope: "group-member",
      botId: left.id,
      conversationId: group.id,
      topicId: topic.id,
      logicalSessionId: "ls-left",
      sessionAlias: alias,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const session: LogicalSession = {
      alias,
      agent: "codex",
      workspace: "backend",
      transport_session: "transport-left",
      logical_session_id: "ls-left",
      created_at: NOW,
      last_used_at: NOW,
      owner: {
        kind: "group-member",
        bindingId,
        botId: left.id,
        conversationId: group.id,
        topicId: topic.id,
      },
    };
    current.state.sessions[alias] = session;
    const keeperAlias = "alias-right";
    current.state.sessions[keeperAlias] = {
      ...session,
      alias: keeperAlias,
      logical_session_id: "ls-right",
      transport_session: "transport-right",
      owner: {
        kind: "group-member",
        bindingId: createScopedGroupMemberBindingId(group.id, topic.id, right.id),
        botId: right.id,
        conversationId: group.id,
        topicId: topic.id,
      },
    };
    await current.control.updateGroup(group.id, { botIds: [mid.id, right.id] });
    const impact = await current.control.previewBotRemoval(left.id);
    expect(impact.departedMemberRuntimes.map((row) => row.bindingId)).toEqual([bindingId]);
    expect(impact.history.groupRuns).toBeGreaterThan(0);
    await current.control.removeBot({
      botId: left.id,
      requestId: "remove-left",
      previewRevision: impact.revision,
    });
    expect(current.released).toContain(alias);
    expect(current.state.sessions[alias]).toBeUndefined();
    expect(current.state.sessions[keeperAlias]?.owner?.botId).toBe(right.id);
    expect(current.state.conversation_topics[topic.id]?.conversationId).toBe(group.id);
    expect(current.runtime.store.listRuns(group.id, topic.id)[0]?.requestId).toBe("said");
    expect(current.control.getBot(left.id).retired).toBe(true);
  } finally {
    await current.close();
  }
});

test("a new prompt during removal is rejected and does not recreate the bot", async () => {
  const currentHold = deferred();
  let seen: unknown;
  const current = await compose({
    afterBotRemovalBarrier: async () => {
      const created = Object.values(current.state.bots)[0];
      if (!created) return;
      try {
        await current.control.promptConversation({
          conversationId: createDirectConversationId(created.id),
          topicId: createDirectTopicId(created.id),
          requestId: "raced",
          text: "too late",
        });
        seen = "accepted";
      } catch (error) {
        seen = error;
      }
      currentHold.resolve();
    },
  });
  try {
    const created = await bot(current, "Racy");
    const removal = remove(current, created.id, "remove-race");
    await currentHold.promise;
    await removal;
    expect(seen).toBeInstanceOf(BotError);
    expect(seen).toMatchObject({ code: "bot_removing" });
    expect(current.runtime.store.listRuns(createDirectConversationId(created.id)).map((run) => run.requestId)).not.toContain("raced");
    expect(current.control.getBot(created.id).retired).toBe(true);
  } finally {
    await current.close();
  }
});

test("membership that changes after preview must be previewed again", async () => {
  const current = await compose();
  try {
    const moving = await bot(current, "Moving");
    const left = await bot(current, "Left");
    const right = await bot(current, "Right");
    const impact = await current.control.previewBotRemoval(moving.id);
    const group = await current.control.createGroup({ title: "Pair", botIds: [left.id, right.id] });
    await current.control.updateGroup(group.id, { botIds: [left.id, right.id, moving.id] });
    await expect(current.control.removeBot({
      botId: moving.id,
      requestId: "remove-stale",
      previewRevision: impact.revision,
    })).rejects.toMatchObject({ code: "removal_stale" });
    expect(current.control.getGroup(group.id).botIds).toEqual([left.id, right.id, moving.id]);
    expect(current.state.bots[moving.id]?.enabled).toBe(true);
  } finally {
    await current.close();
  }
});

test("cancel failure and release failure leave a retryable barrier", async () => {
  const cancelCurrent = await compose();
  try {
    const created = await bot(cancelCurrent, "Cancel");
    await cancelCurrent.control.promptConversation({
      conversationId: createDirectConversationId(created.id),
      topicId: createDirectTopicId(created.id),
      requestId: "live",
      text: "stop",
    });
    const original = cancelCurrent.runtime.runs.cancelRun.bind(cancelCurrent.runtime.runs);
    cancelCurrent.runtime.runs.cancelRun = async () => {
      throw new ConversationError("cancel_failed", "cancel failed");
    };
    const impact = await cancelCurrent.control.previewBotRemoval(created.id);
    await expect(cancelCurrent.control.removeBot({
      botId: created.id,
      requestId: "remove-cancel",
      previewRevision: impact.revision,
    })).rejects.toMatchObject({ code: "cancel_failed" });
    expect(cancelCurrent.runtime.store.botRemovalPhase(created.id)).toBe("deleting");
    expect(cancelCurrent.control.getLifecycleOperation(lifecycleOperationId("bot-remove", "remove-cancel")).phase).toBe("failed");
    expect(cancelCurrent.state.bots[created.id]?.name).toBe("Cancel");
    cancelCurrent.runtime.runs.cancelRun = original;
    const retried = await cancelCurrent.control.removeBot({
      botId: created.id,
      requestId: "remove-cancel",
      previewRevision: "ignored",
    });
    expect(retried.operation.phase).toBe("completed");
  } finally {
    await cancelCurrent.close();
  }
});

test("release failure survives restart and the same request finishes", async () => {
  let fail = true;
  const first = await compose({ failRelease: () => fail });
  const created = await bot(first, "Release");
  const alias = "alias-direct";
  const conversationId = createDirectConversationId(created.id);
  const topicId = createDirectTopicId(created.id);
  const bindingId = createScopedDirectBindingId(conversationId, topicId, created.id);
  first.state.bot_runtime_bindings[bindingId] = {
    id: bindingId,
    scope: "bot-direct",
    botId: created.id,
    conversationId,
    topicId,
    logicalSessionId: "ls-direct",
    sessionAlias: alias,
    createdAt: NOW,
    updatedAt: NOW,
  };
  first.state.sessions[alias] = {
    alias,
    agent: "codex",
    workspace: "backend",
    transport_session: "transport-direct",
    logical_session_id: "ls-direct",
    created_at: NOW,
    last_used_at: NOW,
    owner: {
      kind: "bot-direct",
      bindingId,
      botId: created.id,
      conversationId,
      topicId,
    },
  };
  const impact = await first.control.previewBotRemoval(created.id);
  await expect(first.control.removeBot({
    botId: created.id,
    requestId: "remove-release",
    previewRevision: impact.revision,
  })).rejects.toMatchObject({ code: "session_release_failed" });
  expect(first.control.getLifecycleOperation(lifecycleOperationId("bot-remove", "remove-release")).phase).toBe("failed");
  await first.close();
  fail = false;
  const second = await compose({ path: first.path, state: first.state, failRelease: () => false });
  try {
    const retried = await second.control.removeBot({
      botId: created.id,
      requestId: "remove-release",
      previewRevision: "ignored",
    });
    expect(retried.operation.phase).toBe("completed");
    expect(second.control.getBot(created.id).retired).toBe(true);
    expect(second.state.sessions[alias]).toBeUndefined();
  } finally {
    await second.close();
  }
});

test("an indeterminate run keeps the barrier and does not look finished", async () => {
  const current = await compose();
  try {
    const created = await bot(current, "Unknown");
    const conversationId = createDirectConversationId(created.id);
    const accepted = await current.control.promptConversation({
      conversationId,
      topicId: createDirectTopicId(created.id),
      requestId: "unknown-run",
      text: "maybe",
    });
    const memberId = accepted.memberTurn?.id ?? current.runtime.store.listMemberTurns(accepted.run.id)[0]?.id;
    expect(memberId).toBeTruthy();
    current.runtime.store.completeCancel(accepted.run.id, memberId!, NOW, true);
    const impact = await current.control.previewBotRemoval(created.id);
    expect(impact.runs.indeterminate).toEqual([accepted.run.id]);
    await expect(current.control.removeBot({
      botId: created.id,
      requestId: "remove-unknown",
      previewRevision: impact.revision,
    })).rejects.toMatchObject({ code: "conversation_indeterminate" });
    expect(current.runtime.store.botRemovalPhase(created.id)).toBe("indeterminate");
    const operation = current.control.getLifecycleOperation(lifecycleOperationId("bot-remove", "remove-unknown"));
    expect(operation.phase).toBe("indeterminate");
    expect(current.state.bots[created.id]?.name).toBe("Unknown");
    await expect(current.control.updateBot(created.id, { enabled: true })).rejects.toMatchObject({ code: "bot_removing" });
    await expect(current.control.createTopic(conversationId, "Nope")).rejects.toMatchObject({ code: "bot_removing" });
    const other = await bot(current, "Other");
    const third = await bot(current, "Third");
    const group = await current.control.createGroup({ title: "Pair", botIds: [other.id, third.id] });
    await expect(current.control.updateGroup(group.id, { botIds: [other.id, third.id, created.id] }))
      .rejects.toMatchObject({ code: "bot_removing" });
    expect(current.control.getGroup(group.id).botIds).toEqual([other.id, third.id]);
  } finally {
    await current.close();
  }
});

test("the same removal request returns the same result", async () => {
  const current = await compose();
  try {
    const created = await bot(current, "Twice");
    const first = await remove(current, created.id, "remove-twice");
    const second = await current.control.removeBot({
      botId: created.id,
      requestId: "remove-twice",
      previewRevision: "anything",
    });
    expect(second.operation).toEqual(first.operation);
    expect(current.control.listBots().filter((item) => item.id === created.id)).toHaveLength(1);
  } finally {
    await current.close();
  }
});

test("an AppState removal phase installs the SQLite barrier before accept", async () => {
  const current = await compose();
  try {
    const created = await bot(current, "Ahead");
    current.state.bot_removals[created.id] = {
      botId: created.id,
      phase: "deleting",
      updatedAt: NOW,
    };
    await expect(current.control.promptConversation({
      conversationId: createDirectConversationId(created.id),
      topicId: createDirectTopicId(created.id),
      requestId: "blocked",
      text: "no",
    })).rejects.toMatchObject({ code: "bot_removing" });
    expect(current.runtime.store.botRemovalPhase(created.id)).toBe("deleting");
    expect(current.runtime.store.listRuns(createDirectConversationId(created.id))).toEqual([]);
  } finally {
    await current.close();
  }
});
