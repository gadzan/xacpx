import { expect, test } from "bun:test";

import { BotError } from "../../../src/bots/bot-error";
import { BotRuntimeManager } from "../../../src/bots/bot-runtime-manager";
import { BotService } from "../../../src/bots/bot-service";
import type { BotProfile } from "../../../src/bots/bot-types";
import { sessionMatchesExecution } from "../../../src/bots/bot-types";
import type { AppConfig } from "../../../src/config/types";
import type { ConversationTopic } from "../../../src/conversations/conversation-types";
import { planDirectConversation } from "../../../src/conversations/direct-conversation";
import { createDirectBindingId, createDirectConversationId, createDirectTopicId, createScopedDirectBindingId } from "../../../src/domain/ids";
import { AsyncMutex } from "../../../src/orchestration/async-mutex";
import { SessionService } from "../../../src/sessions/session-service";
import { parseState, type StateStore } from "../../../src/state/state-store";
import { createBotDirectOwner, createEmptyState, type AppState } from "../../../src/state/types";

const NOW = "2026-09-15T10:00:00.000Z";
const BOT_ID = "bot_reviewer";

function defaultBindingId(botId = BOT_ID): string {
  return createScopedDirectBindingId(
    createDirectConversationId(botId),
    createDirectTopicId(botId),
    botId,
  );
}

function extraBindingId(topicId: string, botId = BOT_ID): string {
  return createScopedDirectBindingId(createDirectConversationId(botId), topicId, botId);
}

class MemoryStateStore implements Pick<StateStore, "save" | "saveNow"> {
  public saved: AppState[] = [];
  async save(state: AppState): Promise<void> {
    this.saved.push(structuredClone(state));
  }
  async saveNow(state: AppState): Promise<void> {
    this.saved.push(structuredClone(state));
  }
}

class CrashBeforeBindingStore extends MemoryStateStore {
  failBindingPublish = false;
  override async saveNow(state: AppState): Promise<void> {
    if (this.failBindingPublish && Object.keys(state.bot_runtime_bindings).length > 0) {
      throw new Error("simulated crash before binding publish");
    }
    await super.saveNow(state);
  }
}

function createConfig(): AppConfig {
  return {
    transport: { type: "acpx-cli", command: "acpx", permissionMode: "approve-all", nonInteractivePermissions: "deny" },
    logging: { level: "info", maxSizeBytes: 1024, maxFiles: 2, retentionDays: 1, perf: { enabled: false } },
    channel: { type: "weixin", replyMode: "stream" },
    channels: [{ id: "weixin", type: "weixin", enabled: true }],
    plugins: [],
    agents: { codex: { driver: "codex" }, claude: { driver: "claude" } },
    workspaces: { backend: { cwd: "/tmp/backend" }, frontend: { cwd: "/tmp/frontend" } },
    orchestration: {
      maxPendingAgentRequestsPerCoordinator: 3,
      allowWorkerChainedRequests: false,
      allowedAgentRequestTargets: [],
      allowedAgentRequestRoles: [],
      progressHeartbeatSeconds: 30,
      maxParallelTasksPerAgent: 1,
    },
  };
}

function createHarness(
  store: MemoryStateStore = new MemoryStateStore(),
  state: AppState = createEmptyState(),
  options: {
    stateMutex?: AsyncMutex;
    afterDirectSnapshot?: (bot: BotProfile) => Promise<void>;
    beforeLifecycleMutation?: (input: { botId: string; op: "update" | "delete" }) => Promise<void>;
  } = {},
) {
  const config = createConfig();
  const stateMutex = options.stateMutex ?? new AsyncMutex();
  const sessions = new SessionService(config, store, state, { now: () => Date.parse(NOW), stateMutex });
  const bots = new BotService(config, state, store, {
    now: () => new Date(NOW),
    createId: () => BOT_ID,
    stateMutex,
    beforeLifecycleMutation: options.beforeLifecycleMutation,
  });
  const runtime = new BotRuntimeManager(bots, sessions, state, store, {
    now: () => new Date(NOW),
    stateMutex,
    afterDirectSnapshot: options.afterDirectSnapshot,
    releaseOwnedSession: async (alias) => {
      await sessions.removeSession(alias);
    },
  });
  return { state, store, sessions, bots, runtime, stateMutex };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function ownedSessions(state: AppState) {
  return Object.values(state.sessions).filter((session) => session.owner?.kind === "bot-direct");
}

function insertExtraDirectTopic(state: AppState, botId: string, topicId = "topic_manual_second"): string {
  const extra: ConversationTopic = {
    id: topicId,
    conversationId: createDirectConversationId(botId),
    title: "Second",
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
  };
  state.conversation_topics[topicId] = extra;
  return topicId;
}

test("planDirectConversation does not write live AppState", () => {
  const state = createEmptyState();
  const planned = planDirectConversation(state, { botId: BOT_ID, title: "Reviewer", now: NOW });
  expect(state.conversations).toEqual({});
  expect(state.conversation_topics).toEqual({});
  expect(planned.conversation.id).toBe(createDirectConversationId(BOT_ID));
  expect(planned.topic.id).toBe(createDirectTopicId(BOT_ID));
});

test("getOrCreateDirectSession creates a Bot-owned session distinct from ordinary sessions", async () => {
  const { bots, runtime, sessions, state } = createHarness();
  await sessions.createSession("api-fix", "codex", "backend");
  await bots.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });

  const binding = await runtime.getOrCreateDirectSession({ botId: BOT_ID });
  expect(binding.scope).toBe("bot-direct");
  expect(binding.botId).toBe(BOT_ID);
  expect(binding.conversationId).toBe(createDirectConversationId(BOT_ID));
  expect(binding.id).toBe(defaultBindingId());
  expect(binding.id).not.toBe(BOT_ID);

  const owned = sessions.getLogicalSessionRecord(binding.sessionAlias);
  const ordinary = sessions.getLogicalSessionRecord("api-fix");
  expect(owned?.owner).toEqual(createBotDirectOwner({
    bindingId: defaultBindingId(),
    botId: BOT_ID,
    conversationId: createDirectConversationId(BOT_ID),
    topicId: createDirectTopicId(BOT_ID),
  }));
  expect(ordinary?.owner).toBeUndefined();
  expect(owned?.logical_session_id).not.toBe(ordinary?.logical_session_id);
  expect(state.conversations[binding.conversationId]?.kind).toBe("bot");
});

test("getOrCreateDirectSession reuses the binding across Bot rename", async () => {
  const { bots, runtime } = createHarness();
  await bots.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  const first = await runtime.getOrCreateDirectSession({ botId: BOT_ID });
  await bots.updateBot(BOT_ID, { name: "Critic" });
  const second = await runtime.getOrCreateDirectSession({ botId: BOT_ID });
  expect(second.id).toBe(first.id);
  expect(second.logicalSessionId).toBe(first.logicalSessionId);
  expect(second.sessionAlias).toBe(first.sessionAlias);
});

test("stale bindings are repaired by creating a new owned session", async () => {
  const { bots, runtime, state } = createHarness();
  await bots.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  const first = await runtime.getOrCreateDirectSession({ botId: BOT_ID });
  delete state.sessions[first.sessionAlias];
  const repaired = await runtime.getOrCreateDirectSession({ botId: BOT_ID });
  expect(repaired.id).toBe(first.id);
  expect(repaired.logicalSessionId).not.toBe(first.logicalSessionId);
  expect(state.sessions[repaired.sessionAlias]?.owner?.bindingId).toBe(first.id);
  expect(ownedSessions(state)).toHaveLength(1);
});

test("concurrent getOrCreateDirectSession keeps one binding and one owned session", async () => {
  const { bots, runtime, state } = createHarness();
  await bots.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  const [first, second] = await Promise.all([
    runtime.getOrCreateDirectSession({ botId: BOT_ID }),
    runtime.getOrCreateDirectSession({ botId: BOT_ID }),
  ]);
  expect(first.id).toBe(second.id);
  expect(first.logicalSessionId).toBe(second.logicalSessionId);
  expect(Object.values(state.bot_runtime_bindings)).toHaveLength(1);
  expect(ownedSessions(state)).toHaveLength(1);
});

test("a crash after session create repairs the missing binding without orphaning the session", async () => {
  const store = new CrashBeforeBindingStore();
  const first = createHarness(store);
  await first.bots.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  store.failBindingPublish = true;
  await expect(first.runtime.getOrCreateDirectSession({ botId: BOT_ID })).rejects.toThrow("simulated crash");
  expect(first.state.bot_runtime_bindings).toEqual({});
  expect(first.state.conversations).toEqual({});
  expect(ownedSessions(first.state)).toHaveLength(1);

  const durable = store.saved.at(-1);
  expect(durable).toBeDefined();
  const reloaded = parseState(JSON.parse(JSON.stringify(durable)) as Record<string, unknown>, "state.json");
  expect(reloaded.bot_runtime_bindings).toEqual({});
  expect(ownedSessions(reloaded)).toHaveLength(1);

  const recovered = createHarness(new MemoryStateStore(), reloaded);
  const binding = await recovered.runtime.getOrCreateDirectSession({ botId: BOT_ID });
  expect(binding.id).toBe(defaultBindingId());
  expect(ownedSessions(reloaded)).toHaveLength(1);
  expect(Object.values(reloaded.bot_runtime_bindings)).toHaveLength(1);
  expect(reloaded.conversations[binding.conversationId]?.kind).toBe("bot");
});

test("scoped session without a binding still fail-closes deleteBot and repairs the same session", async () => {
  const store = new CrashBeforeBindingStore();
  const first = createHarness(store);
  await first.bots.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  store.failBindingPublish = true;
  await expect(first.runtime.getOrCreateDirectSession({ botId: BOT_ID })).rejects.toThrow("simulated crash");
  expect(first.state.bot_runtime_bindings).toEqual({});
  const durable = store.saved.at(-1);
  const reloaded = parseState(JSON.parse(JSON.stringify(durable)) as Record<string, unknown>, "state.json");
  const recovered = createHarness(new MemoryStateStore(), reloaded);
  await expect(recovered.bots.deleteBot(BOT_ID)).rejects.toMatchObject({ code: "bot_in_use" });
  const alias = ownedSessions(reloaded)[0]?.alias;
  const logicalId = ownedSessions(reloaded)[0]?.logical_session_id;
  const binding = await recovered.runtime.getOrCreateDirectSession({ botId: BOT_ID });
  expect(binding.sessionAlias).toBe(alias);
  expect(binding.logicalSessionId).toBe(logicalId);
  expect(ownedSessions(reloaded)).toHaveLength(1);
});

test("non-default Topic scoped orphan is attributable without a binding", async () => {
  const store = new CrashBeforeBindingStore();
  const first = createHarness(store);
  await first.bots.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  const topicId = insertExtraDirectTopic(first.state, BOT_ID);
  store.failBindingPublish = true;
  await expect(first.runtime.getOrCreateDirectSession({ botId: BOT_ID, topicId })).rejects.toThrow("simulated crash");
  const durable = store.saved.at(-1);
  const reloaded = parseState(JSON.parse(JSON.stringify(durable)) as Record<string, unknown>, "state.json");
  expect(reloaded.bot_runtime_bindings).toEqual({});
  expect(ownedSessions(reloaded)[0]?.owner).toMatchObject({
    kind: "bot-direct",
    botId: BOT_ID,
    topicId,
  });
  const recovered = createHarness(new MemoryStateStore(), reloaded);
  recovered.state.conversation_topics[topicId] = reloaded.conversation_topics[topicId] ?? {
    id: topicId,
    conversationId: createDirectConversationId(BOT_ID),
    title: "Second",
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
  };
  await expect(recovered.bots.deleteBot(BOT_ID)).rejects.toMatchObject({ code: "bot_in_use" });
  const alias = ownedSessions(reloaded)[0]?.alias;
  const logicalId = ownedSessions(reloaded)[0]?.logical_session_id;
  const binding = await recovered.runtime.getOrCreateDirectSession({ botId: BOT_ID, topicId });
  expect(binding.sessionAlias).toBe(alias);
  expect(binding.logicalSessionId).toBe(logicalId);
  expect(binding.topicId).toBe(topicId);
  expect(ownedSessions(reloaded)).toHaveLength(1);
});

test("releaseDirectBinding uses verified physical release and keeps ownership on failure", async () => {
  let failPhysical = true;
  const physicalReleased: string[] = [];
  const store = new MemoryStateStore();
  const state = createEmptyState();
  const config = createConfig();
  const stateMutex = new AsyncMutex();
  const sessions = new SessionService(config, store, state, { now: () => Date.parse(NOW), stateMutex });
  const bots = new BotService(config, state, store, {
    now: () => new Date(NOW),
    createId: () => BOT_ID,
    stateMutex,
  });
  const runtime = new BotRuntimeManager(bots, sessions, state, store, {
    now: () => new Date(NOW),
    stateMutex,
    releaseOwnedSession: async (alias) => {
      physicalReleased.push(alias);
      if (failPhysical) {
        throw new Error("injected physical teardown failure");
      }
      await sessions.removeSession(alias);
    },
  });
  await bots.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  const binding = await runtime.getOrCreateDirectSession({ botId: BOT_ID });
  expect(ownedSessions(state)).toHaveLength(1);
  await expect(runtime.releaseDirectBinding(binding.id)).rejects.toThrow("injected physical teardown failure");
  expect(physicalReleased).toEqual([binding.sessionAlias]);
  expect(state.bot_runtime_bindings[binding.id]).toBeDefined();
  expect(ownedSessions(state)).toHaveLength(1);
  failPhysical = false;
  await runtime.releaseDirectBinding(binding.id);
  expect(state.bot_runtime_bindings[binding.id]).toBeUndefined();
  expect(ownedSessions(state)).toHaveLength(0);
});

test("getOrCreateDirectSession does not deadlock on the shared session mutex", async () => {
  const mutex = new AsyncMutex();
  let acquiredDuringSnapshot = false;
  const { bots, runtime } = createHarness(new MemoryStateStore(), createEmptyState(), {
    stateMutex: mutex,
    afterDirectSnapshot: async () => {
      await mutex.run(async () => {
        acquiredDuringSnapshot = true;
      });
    },
  });
  await bots.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  const binding = await Promise.race([
    runtime.getOrCreateDirectSession({ botId: BOT_ID }),
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("deadlocked on shared stateMutex")), 2000);
    }),
  ]);
  expect(acquiredDuringSnapshot).toBe(true);
  expect(binding.sessionAlias).toBe(`brt_${defaultBindingId()}`);
  const reused = await Promise.race([
    runtime.getOrCreateDirectSession({ botId: BOT_ID }),
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("deadlocked on shared stateMutex reuse")), 2000);
    }),
  ]);
  expect(reused.id).toBe(binding.id);
});

test("getOrCreateDirectSession restores a live binding after state reload", async () => {
  const first = createHarness();
  await first.bots.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  const created = await first.runtime.getOrCreateDirectSession({ botId: BOT_ID });
  const reloaded = parseState(JSON.parse(JSON.stringify(first.state)) as Record<string, unknown>, "state.json");
  const recovered = createHarness(new MemoryStateStore(), reloaded);
  const restored = await recovered.runtime.getOrCreateDirectSession({ botId: BOT_ID });
  expect(restored.id).toBe(created.id);
  expect(restored.logicalSessionId).toBe(created.logicalSessionId);
  expect(restored.sessionAlias).toBe(created.sessionAlias);
  expect(recovered.store.saved).toHaveLength(0);
});

test("planDirectConversation keeps the default topic when another active topic exists", () => {
  const state = createEmptyState();
  const conversationId = createDirectConversationId(BOT_ID);
  state.conversations[conversationId] = {
    id: conversationId,
    kind: "bot",
    title: "Reviewer",
    botIds: [BOT_ID],
    createdAt: NOW,
    updatedAt: NOW,
  };
  insertExtraDirectTopic(state, BOT_ID);
  const planned = planDirectConversation(state, { botId: BOT_ID, title: "Reviewer", now: NOW });
  expect(planned.topic.id).toBe(createDirectTopicId(BOT_ID));
  expect(planned.topic.id).not.toBe("topic_manual_second");
});

test("getOrCreateDirectSession materializes a second topic on its own runtime key", async () => {
  const { bots, runtime, state } = createHarness();
  await bots.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  const extraTopicId = insertExtraDirectTopic(state, BOT_ID);

  const extra = await runtime.getOrCreateDirectSession({ botId: BOT_ID, topicId: extraTopicId });
  expect(extra.topicId).toBe(extraTopicId);
  expect(extra.id).toBe(extraBindingId(extraTopicId));
  expect(extra.sessionAlias).toBe(`brt_${extraBindingId(extraTopicId)}`);
  expect(ownedSessions(state)).toHaveLength(1);
  expect(state.conversations[createDirectConversationId(BOT_ID)]?.kind).toBe("bot");
  expect(state.conversation_topics[createDirectTopicId(BOT_ID)]).toBeUndefined();
});

test("a topic that does not belong to the direct conversation stays topic_not_found", async () => {
  const { bots, runtime, state } = createHarness();
  await bots.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  state.conversation_topics.topic_other = {
    id: "topic_other",
    conversationId: "conversation_someone_else",
    title: "Other",
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
  };

  await expect(runtime.getOrCreateDirectSession({ botId: BOT_ID, topicId: "topic_other" })).rejects.toMatchObject({
    code: "topic_not_found",
  });
  await expect(runtime.getOrCreateDirectSession({ botId: BOT_ID, topicId: "topic_missing" })).rejects.toMatchObject({
    code: "topic_not_found",
  });
  expect(state.bot_runtime_bindings).toEqual({});
  expect(ownedSessions(state)).toHaveLength(0);
});

test("a second topic does not reuse the default binding after runtime exists", async () => {
  const { bots, runtime, state } = createHarness();
  await bots.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  const created = await runtime.getOrCreateDirectSession({ botId: BOT_ID });
  const extraTopicId = insertExtraDirectTopic(state, BOT_ID);

  const extra = await runtime.getOrCreateDirectSession({ botId: BOT_ID, topicId: extraTopicId });
  expect(extra.id).toBe(extraBindingId(extraTopicId));
  expect(extra.id).not.toBe(created.id);
  expect(extra.sessionAlias).not.toBe(created.sessionAlias);
  expect(extra.logicalSessionId).not.toBe(created.logicalSessionId);
  expect(Object.keys(state.bot_runtime_bindings).sort()).toEqual([defaultBindingId(), extraBindingId(extraTopicId)].sort());
  expect(state.bot_runtime_bindings[defaultBindingId()]?.topicId).toBe(createDirectTopicId(BOT_ID));
  expect(ownedSessions(state)).toHaveLength(2);
});

test("omitting topicId still binds the default topic when another active topic exists", async () => {
  const { bots, runtime, state } = createHarness();
  await bots.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  insertExtraDirectTopic(state, BOT_ID);
  const binding = await runtime.getOrCreateDirectSession({ botId: BOT_ID });
  expect(binding.topicId).toBe(createDirectTopicId(BOT_ID));
  expect(binding.topicId).not.toBe("topic_manual_second");
  expect(Object.keys(state.bot_runtime_bindings)).toEqual([defaultBindingId()]);
  expect(ownedSessions(state)).toHaveLength(1);
});

test("a concurrent second-topic request does not join the default single-flight", async () => {
  const { bots, runtime, state } = createHarness();
  await bots.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  const extraTopicId = insertExtraDirectTopic(state, BOT_ID);
  const [defaultResult, extraResult] = await Promise.allSettled([
    runtime.getOrCreateDirectSession({ botId: BOT_ID }),
    runtime.getOrCreateDirectSession({ botId: BOT_ID, topicId: extraTopicId }),
  ]);
  expect(defaultResult.status).toBe("fulfilled");
  expect(extraResult.status).toBe("fulfilled");
  const defaultBinding = defaultResult.status === "fulfilled" ? defaultResult.value : undefined;
  const extraBinding = extraResult.status === "fulfilled" ? extraResult.value : undefined;
  expect(defaultBinding?.id).toBe(defaultBindingId());
  expect(extraBinding?.id).toBe(extraBindingId(extraTopicId));
  expect(extraBinding?.id).not.toBe(defaultBinding?.id);
  expect(Object.keys(state.bot_runtime_bindings).sort()).toEqual([defaultBindingId(), extraBindingId(extraTopicId)].sort());
  expect(ownedSessions(state)).toHaveLength(2);
});

test("update agent racing first materialization is totally ordered by the lifecycle gate", async () => {
  const snapshot = deferred();
  const resume = deferred();
  const { bots, runtime, state } = createHarness(new MemoryStateStore(), createEmptyState(), {
    afterDirectSnapshot: async (bot) => {
      expect(bot.agent).toBe("codex");
      expect(bot.workspace).toBe("backend");
      snapshot.resolve();
      await resume.promise;
    },
  });
  await bots.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  const materialize = runtime.getOrCreateDirectSession({ botId: BOT_ID });
  await snapshot.promise;
  const update = bots.updateBot(BOT_ID, { agent: "claude" });
  resume.resolve();
  const [runtimeResult, updateResult] = await Promise.allSettled([materialize, update]);
  expect(runtimeResult.status).toBe("fulfilled");
  expect(updateResult.status).toBe("rejected");
  expect(updateResult.status === "rejected" ? updateResult.reason : undefined).toMatchObject({
    code: "runtime_identity_locked",
  });
  expect(bots.getBot(BOT_ID).agent).toBe("codex");
  expect(bots.getBot(BOT_ID).workspace).toBe("backend");
  const owned = ownedSessions(state);
  expect(owned).toHaveLength(1);
  expect(owned[0]?.agent).toBe("codex");
  expect(owned[0]?.workspace).toBe("backend");
  expect(state.bot_runtime_bindings[defaultBindingId()]?.sessionAlias).toBe(owned[0]?.alias);
});

test("accepted sticky identity is checked inside the lifecycle gate before any session is created", async () => {
  const { bots, runtime, state } = createHarness();
  await bots.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  await bots.updateBot(BOT_ID, { agent: "claude", workspace: "frontend" });
  await expect(runtime.getOrCreateDirectSession({
    botId: BOT_ID,
    execution: { agent: "codex", workspace: "backend" },
  })).rejects.toMatchObject({
    name: "BotError",
    code: "runtime_revision_mismatch",
  });
  expect(ownedSessions(state)).toHaveLength(0);
  expect(state.bot_runtime_bindings).toEqual({});
  expect(bots.getBot(BOT_ID).agent).toBe("claude");
  expect(bots.getBot(BOT_ID).workspace).toBe("frontend");
});

test("an identity update that wins the lifecycle gate is used by the first materialization", async () => {
  const entered = deferred();
  const resume = deferred();
  const { bots, runtime, state } = createHarness(new MemoryStateStore(), createEmptyState(), {
    beforeLifecycleMutation: async ({ op }) => {
      if (op !== "update") {
        return;
      }
      entered.resolve();
      await resume.promise;
    },
  });
  await bots.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  const update = bots.updateBot(BOT_ID, { agent: "claude", workspace: "frontend" });
  await entered.promise;
  const materialize = runtime.getOrCreateDirectSession({ botId: BOT_ID });
  resume.resolve();
  await update;
  const binding = await materialize;
  expect(bots.getBot(BOT_ID).agent).toBe("claude");
  expect(bots.getBot(BOT_ID).workspace).toBe("frontend");
  const owned = ownedSessions(state);
  expect(owned).toHaveLength(1);
  expect(owned[0]?.agent).toBe("claude");
  expect(owned[0]?.workspace).toBe("frontend");
  expect(binding.sessionAlias).toBe(owned[0]?.alias);
});

test("delete racing first materialization never leaves dangling ownership", async () => {
  const snapshot = deferred();
  const resume = deferred();
  const { bots, runtime, state } = createHarness(new MemoryStateStore(), createEmptyState(), {
    afterDirectSnapshot: async () => {
      snapshot.resolve();
      await resume.promise;
    },
  });
  await bots.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  const materialize = runtime.getOrCreateDirectSession({ botId: BOT_ID });
  await snapshot.promise;
  const deletion = bots.deleteBot(BOT_ID);
  resume.resolve();
  const [runtimeResult, deleteResult] = await Promise.allSettled([materialize, deletion]);
  expect(runtimeResult.status).toBe("fulfilled");
  expect(deleteResult.status).toBe("rejected");
  expect(deleteResult.status === "rejected" ? deleteResult.reason : undefined).toMatchObject({
    code: "bot_in_use",
  });
  expect(bots.getBot(BOT_ID).id).toBe(BOT_ID);
  expect(Object.keys(state.bot_runtime_bindings)).toEqual([defaultBindingId()]);
  expect(state.conversations[createDirectConversationId(BOT_ID)]?.botIds).toEqual([BOT_ID]);
  expect(ownedSessions(state)).toHaveLength(1);
});

test("a delete that wins the lifecycle gate leaves no Conversation, binding, or owned session", async () => {
  const entered = deferred();
  const resume = deferred();
  const { bots, runtime, state } = createHarness(new MemoryStateStore(), createEmptyState(), {
    beforeLifecycleMutation: async ({ op }) => {
      if (op !== "delete") {
        return;
      }
      entered.resolve();
      await resume.promise;
    },
  });
  await bots.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  const deletion = bots.deleteBot(BOT_ID);
  await entered.promise;
  const materialize = runtime.getOrCreateDirectSession({ botId: BOT_ID });
  resume.resolve();
  await deletion;
  await expect(materialize).rejects.toMatchObject({ code: "bot_not_found" });
  expect(state.bots[BOT_ID]).toBeUndefined();
  expect(state.conversations).toEqual({});
  expect(state.conversation_topics).toEqual({});
  expect(state.bot_runtime_bindings).toEqual({});
  expect(ownedSessions(state)).toHaveLength(0);
});

test("PR2 default binding is adopted onto the scoped key without orphaning the owned session", async () => {
  const { bots, runtime, sessions, state } = createHarness();
  await bots.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  const legacyId = createDirectBindingId(BOT_ID);
  const alias = `brt_${legacyId}`;
  await sessions.createSession(alias, "codex", "backend", {
    owner: { kind: "bot-direct", bindingId: legacyId },
  });
  const owned = sessions.getLogicalSessionRecord(alias);
  expect(owned).toBeDefined();
  state.bot_runtime_bindings[legacyId] = {
    id: legacyId,
    scope: "bot-direct",
    conversationId: createDirectConversationId(BOT_ID),
    topicId: createDirectTopicId(BOT_ID),
    botId: BOT_ID,
    logicalSessionId: owned!.logical_session_id,
    sessionAlias: alias,
    createdAt: NOW,
    updatedAt: NOW,
  };
  state.conversations[createDirectConversationId(BOT_ID)] = {
    id: createDirectConversationId(BOT_ID),
    kind: "bot",
    title: "Reviewer",
    botIds: [BOT_ID],
    createdAt: NOW,
    updatedAt: NOW,
  };
  state.conversation_topics[createDirectTopicId(BOT_ID)] = {
    id: createDirectTopicId(BOT_ID),
    conversationId: createDirectConversationId(BOT_ID),
    title: "Default",
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
  };

  const binding = await runtime.getOrCreateDirectSession({ botId: BOT_ID });
  expect(binding.id).toBe(defaultBindingId());
  expect(binding.sessionAlias).toBe(alias);
  expect(binding.logicalSessionId).toBe(owned!.logical_session_id);
  expect(state.bot_runtime_bindings[legacyId]).toBeUndefined();
  expect(state.bot_runtime_bindings[defaultBindingId()]?.sessionAlias).toBe(alias);
  expect(ownedSessions(state)).toHaveLength(1);
  expect(sessions.getLogicalSessionRecord(alias)?.owner).toEqual(createBotDirectOwner({
    bindingId: defaultBindingId(),
    botId: BOT_ID,
    conversationId: createDirectConversationId(BOT_ID),
    topicId: createDirectTopicId(BOT_ID),
  }));
});

test("PR2 adoption aligns stale legacy model/effort to the accepted snapshot", async () => {
  const { bots, runtime, sessions, state } = createHarness();
  await bots.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  const legacyId = createDirectBindingId(BOT_ID);
  const alias = `brt_${legacyId}`;
  await sessions.createSession(alias, "codex", "backend", {
    owner: { kind: "bot-direct", bindingId: legacyId },
    model: "gpt-old",
    effort: "low",
  });
  const owned = sessions.getLogicalSessionRecord(alias);
  expect(owned).toBeDefined();
  state.bot_runtime_bindings[legacyId] = {
    id: legacyId,
    scope: "bot-direct",
    conversationId: createDirectConversationId(BOT_ID),
    topicId: createDirectTopicId(BOT_ID),
    botId: BOT_ID,
    logicalSessionId: owned!.logical_session_id,
    sessionAlias: alias,
    createdAt: NOW,
    updatedAt: NOW,
  };
  state.conversations[createDirectConversationId(BOT_ID)] = {
    id: createDirectConversationId(BOT_ID),
    kind: "bot",
    title: "Reviewer",
    botIds: [BOT_ID],
    createdAt: NOW,
    updatedAt: NOW,
  };
  state.conversation_topics[createDirectTopicId(BOT_ID)] = {
    id: createDirectTopicId(BOT_ID),
    conversationId: createDirectConversationId(BOT_ID),
    title: "Default",
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
  };
  const execution = { agent: "codex", workspace: "backend", model: "gpt-snapshot", effort: "high" };
  const binding = await runtime.getOrCreateDirectSession({ botId: BOT_ID, execution });
  const adopted = sessions.getLogicalSessionRecord(binding.sessionAlias);
  expect(adopted?.model).toBe("gpt-snapshot");
  expect(adopted?.effort).toBe("high");
  expect(sessionMatchesExecution(adopted!, execution)).toBe(true);
  expect(state.bot_runtime_bindings[legacyId]).toBeUndefined();
  expect(binding.sessionAlias).toBe(alias);
});
