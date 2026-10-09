import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlService, conversationKernel } from "../../../src/control/control-service";
import { createControlEventBus } from "../../../src/control/control-event-bus";
import { createConversationRuntime } from "../../../src/conversations/conversation-composition";
import { ConversationError } from "../../../src/conversations/conversation-error";
import { transitionTopic, topicLifecycleFrom } from "../../../src/conversations/topic-lifecycle";
import {
  createDirectConversationId,
  createDirectTopicId,
  createScopedDirectBindingId,
} from "../../../src/domain/ids";
import { AsyncMutex } from "../../../src/orchestration/async-mutex";
import { SessionService } from "../../../src/sessions/session-service";
import { createEmptyState, type AppState } from "../../../src/state/types";

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
  beforeAcceptPersist?: () => Promise<void>;
  path?: string;
  state?: AppState;
}) {
  const state = options?.state ?? createEmptyState();
  const path = options?.path ?? join(mkdtempSync(join(tmpdir(), "xacpx-topic-life-")), "conversations.sqlite");
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
    ...(options?.beforeAcceptPersist ? { beforeAcceptPersist: options.beforeAcceptPersist } : {}),
    onProductEvent: (event) => kernel.emitConversationProduct(event),
  });
  kernel.bindConversationRuntime(runtime);
  const close = () => runtime.shutdown();
  return { state, path, control, runtime, sessions, released, close, stateStore, stateMutex, config, events };
}

async function reopen(previous: Awaited<ReturnType<typeof compose>>, failRelease?: () => boolean) {
  await previous.close();
  return compose({
    path: previous.path,
    state: previous.state,
    ...(failRelease ? { failRelease } : {}),
  });
}

test("topic commands only allow archive, restore, clear, and teardown from their legal phases", () => {
  const active = topicLifecycleFrom({ status: "active", title: "Default" }, "default-direct");
  expect(transitionTopic(active, { type: "archive" }).phase).toBe("archived");
  expect(transitionTopic(active, { type: "rename", title: "  Notes  " }).title).toBe("Notes");
  const archived = transitionTopic(active, { type: "archive" });
  expect(transitionTopic(archived, { type: "restore" }).phase).toBe("active");
  expect(transitionTopic(active, { type: "finish-clear" }).contextGeneration).toBe(2);
  expect(() => transitionTopic(topicLifecycleFrom({ status: "deleting", title: "T" }, "extra-direct"), { type: "restore" }))
    .toThrow(ConversationError);
  expect(() => transitionTopic(active, { type: "begin-teardown" }).phase).toThrow(ConversationError);
  const extra = topicLifecycleFrom({ status: "active", title: "Extra" }, "extra-direct");
  expect(transitionTopic(extra, { type: "begin-teardown" }).phase).toBe("deleting");
  expect(() => transitionTopic(extra, { type: "begin-clear" })).toThrow(ConversationError);
});

test("rename keeps the topic id and history, and archive or restore does not bump context", async () => {
  const current = await compose();
  try {
    const bot = await current.control.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
    const conversationId = createDirectConversationId(bot.id);
    const topicId = createDirectTopicId(bot.id);
    const accepted = await current.control.promptConversation({
      conversationId,
      topicId,
      requestId: "req-rename",
      text: "keep this",
    });
    const renamed = await current.control.updateTopic(conversationId, topicId, "Notes");
    expect(renamed.id).toBe(topicId);
    expect(renamed.title).toBe("Notes");
    expect(renamed.contextGeneration).toBeUndefined();
    const history = await current.control.conversationHistory({ conversationId, topicId });
    expect(history.messages.map((message) => message.content)).toEqual(["keep this"]);
    expect(history.messages[0]?.runId).toBe(accepted.run.id);

    await current.control.cancelRun(accepted.run.id);
    const archived = await current.control.archiveTopic(conversationId, topicId);
    expect(archived.id).toBe(topicId);
    expect(archived.status).toBe("archived");
    expect(archived.contextGeneration).toBeUndefined();
    const whileArchived = await current.control.conversationHistory({ conversationId, topicId });
    expect(whileArchived.messages.map((message) => message.content)).toEqual(["keep this"]);
    await expect(current.control.promptConversation({
      conversationId,
      topicId,
      requestId: "req-while-archived",
      text: "nope",
    })).rejects.toMatchObject({ code: "topic_not_active" });

    const restored = await current.control.restoreTopic(conversationId, topicId);
    expect(restored.status).toBe("active");
    expect(restored.id).toBe(topicId);
    const after = await current.control.conversationHistory({ conversationId, topicId });
    expect(after.messages.map((message) => message.content)).toEqual(["keep this"]);
    expect(current.runtime.store.topicContextGeneration(topicId)).toBe(1);
  } finally {
    await current.close();
  }
});

test("topics do not release each other, and only an extra topic can be deleted", async () => {
  const current = await compose();
  try {
    const bot = await current.control.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
    const conversationId = createDirectConversationId(bot.id);
    const defaultTopicId = createDirectTopicId(bot.id);
    const extra = await current.control.createTopic(conversationId, "Extra");
    await current.control.promptConversation({
      conversationId,
      topicId: defaultTopicId,
      requestId: "req-default",
      text: "default history",
    });
    await current.control.promptConversation({
      conversationId,
      topicId: extra.id,
      requestId: "req-extra",
      text: "extra history",
    });
    const defaultAlias = "brt_default";
    const extraAlias = "brt_extra";
    await seedDirectSession(current, bot.id, conversationId, defaultTopicId, defaultAlias);
    await seedDirectSession(current, bot.id, conversationId, extra.id, extraAlias);

    await expect(current.control.teardownTopic(conversationId, defaultTopicId, { requestId: "del-default" }))
      .rejects.toMatchObject({ code: "topic_clear_required" });
    expect(current.released).toEqual([]);

    await current.control.teardownTopic(conversationId, extra.id, { requestId: "del-extra" });
    expect(current.released).toEqual([extraAlias]);
    expect(current.state.sessions[defaultAlias]).toBeDefined();
    expect(current.state.conversation_topics[defaultTopicId]).toBeDefined();
    expect(current.state.conversation_topics[extra.id]).toBeUndefined();
    const defaultHistory = await current.control.conversationHistory({ conversationId, topicId: defaultTopicId });
    expect(defaultHistory.messages.filter((message) => message.role === "human").map((message) => message.content)).toEqual(["default history"]);
    expect(defaultHistory.messages.every((message) => message.topicId === defaultTopicId)).toBe(true);
    await expect(current.control.promptConversation({
      conversationId,
      topicId: extra.id,
      requestId: "req-extra",
      text: "again",
    })).rejects.toMatchObject({ code: "request_retired" });
    await expect(current.control.promptConversation({
      conversationId,
      topicId: extra.id,
      requestId: "req-extra-new",
      text: "again",
    })).rejects.toMatchObject({ code: "topic_not_found" });
    const again = await current.control.teardownTopic(conversationId, extra.id, { requestId: "del-extra" });
    expect(again).toEqual({ ok: true, requestId: "del-extra" });
  } finally {
    await current.close();
  }
});

test("clearing the default topic bumps generation, retires the old request, and retries as the same receipt", async () => {
  const current = await compose();
  try {
    const bot = await current.control.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
    const conversationId = createDirectConversationId(bot.id);
    const topicId = createDirectTopicId(bot.id);
    const extra = await current.control.createTopic(conversationId, "Extra");
    await current.control.promptConversation({
      conversationId,
      topicId,
      requestId: "req-old",
      text: "old context",
    });
    await current.control.promptConversation({
      conversationId,
      topicId: extra.id,
      requestId: "req-extra",
      text: "stays",
    });
    const alias = "brt_default";
    await seedDirectSession(current, bot.id, conversationId, topicId, alias);

    const cleared = await current.control.clearTopic(conversationId, topicId, {
      requestId: "clear-1",
      confirm: true,
    });
    expect(cleared.topic.id).toBe(topicId);
    expect(cleared.contextGeneration).toBe(2);
    expect(current.state.sessions[alias]).toBeUndefined();
    expect(current.state.conversation_topics[extra.id]?.title).toBe("Extra");
    const history = await current.control.conversationHistory({ conversationId, topicId });
    expect(history.messages).toEqual([]);
    const extraHistory = await current.control.conversationHistory({ conversationId, topicId: extra.id });
    expect(extraHistory.messages.filter((message) => message.role === "human").map((message) => message.content)).toEqual(["stays"]);
    expect(extraHistory.messages.every((message) => message.topicId === extra.id)).toBe(true);
    await expect(current.control.promptConversation({
      conversationId,
      topicId,
      requestId: "req-old",
      text: "replay",
    })).rejects.toMatchObject({ code: "request_retired" });

    const replay = await current.control.clearTopic(conversationId, topicId, {
      requestId: "clear-1",
      confirm: true,
    });
    expect(replay.contextGeneration).toBe(2);
    const fresh = await current.control.promptConversation({
      conversationId,
      topicId,
      requestId: "req-new",
      text: "new context",
    });
    expect(fresh.run.topicId).toBe(topicId);
    const second = await current.control.clearTopic(conversationId, topicId, {
      requestId: "clear-1",
      confirm: true,
    });
    expect(second.contextGeneration).toBe(2);
    const kept = await current.control.conversationHistory({ conversationId, topicId });
    expect(kept.messages.map((message) => message.content)).toEqual(["new context"]);
  } finally {
    await current.close();
  }
});

test("a send that lands before clear is retired and does not run again", async () => {
  const gate = deferred();
  let entered = false;
  const current = await compose({
    beforeAcceptPersist: async () => {
      entered = true;
      await gate.promise;
    },
  });
  try {
    const bot = await current.control.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
    const conversationId = createDirectConversationId(bot.id);
    const topicId = createDirectTopicId(bot.id);
    const sending = current.control.promptConversation({
      conversationId,
      topicId,
      requestId: "req-race",
      text: "in flight",
    });
    while (!entered) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const clearing = current.control.clearTopic(conversationId, topicId, {
      requestId: "clear-race",
      confirm: true,
    });
    gate.resolve();
    const accepted = await sending;
    const cleared = await clearing;
    expect(accepted.run.requestId).toBe("req-race");
    expect(cleared.topic.id).toBe(topicId);
    expect(cleared.contextGeneration).toBe(2);
    expect((await current.control.conversationHistory({ conversationId, topicId })).messages).toEqual([]);
    await expect(current.control.promptConversation({
      conversationId,
      topicId,
      requestId: "req-race",
      text: "in flight",
    })).rejects.toMatchObject({ code: "request_retired" });
  } finally {
    gate.resolve();
    await current.close();
  }
});

test("external bindings block teardown until the caller confirms, and a release failure can be retried after restart", async () => {
  let fail = true;
  const current = await compose({ failRelease: () => fail });
  try {
    const bot = await current.control.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
    const conversationId = createDirectConversationId(bot.id);
    const extra = await current.control.createTopic(conversationId, "Extra");
    await current.control.bindConversation({
      chatKey: "discord:default:bound",
      conversationId,
      topicId: extra.id,
    });
    await expect(current.control.teardownTopic(conversationId, extra.id, { requestId: "del-bound" }))
      .rejects.toMatchObject({ code: "topic_bindings_present" });
    expect(current.control.listConversationBindings()).toEqual([
      { chatKey: "discord:default:bound", conversationId, topicId: extra.id },
    ]);
    const preview = current.control.previewTopic(conversationId, extra.id);
    expect(preview.bindings).toEqual([{ chatKey: "discord:default:bound" }]);
    expect(preview.actions.teardown).toBe(true);
    expect(preview.actions.clear).toBe(false);

    await seedDirectSession(current, bot.id, conversationId, extra.id, "brt_extra");
    await expect(current.control.teardownTopic(conversationId, extra.id, {
      requestId: "del-bound",
      releaseBindings: true,
    })).rejects.toMatchObject({ code: "session_release_failed" });
    expect(current.state.conversation_topics[extra.id]?.status).toBe("deleting");
    expect(current.control.listConversationBindings()).toHaveLength(1);

    fail = false;
    const restarted = await reopen(current, () => false);
    try {
      const done = await restarted.control.teardownTopic(conversationId, extra.id, {
        requestId: "del-bound",
        releaseBindings: true,
      });
      expect(done).toEqual({ ok: true, requestId: "del-bound" });
      expect(restarted.state.conversation_topics[extra.id]).toBeUndefined();
      expect(restarted.state.sessions["brt_extra"]).toBeUndefined();
      expect(restarted.control.listConversationBindings()).toEqual([]);
      const defaultPreview = restarted.control.previewTopic(conversationId, createDirectTopicId(bot.id));
      expect(defaultPreview.actions.clear).toBe(true);
      expect(defaultPreview.actions.teardown).toBe(false);
    } finally {
      await restarted.close();
    }
  } finally {
    await current.close();
  }
});

async function seedDirectSession(
  current: { state: AppState; sessions: SessionService },
  botId: string,
  conversationId: string,
  topicId: string,
  alias: string,
): Promise<void> {
  const bindingId = createScopedDirectBindingId(conversationId, topicId, botId);
  await current.sessions.createSession(alias, "codex", "backend", {
    owner: { kind: "bot-direct", bindingId, botId, conversationId, topicId },
  });
  const logicalSessionId = current.state.sessions[alias]!.logical_session_id;
  current.state.bot_runtime_bindings[bindingId] = {
    id: bindingId,
    scope: "bot-direct",
    conversationId,
    topicId,
    botId,
    logicalSessionId,
    sessionAlias: alias,
    createdAt: NOW,
    updatedAt: NOW,
  };
}
