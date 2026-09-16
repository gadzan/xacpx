import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

import { BotError } from "../../../src/bots/bot-error";
import type { AppConfig } from "../../../src/config/types";
import { ControlService } from "../../../src/control/control-service";
import {
  createControlEventBus,
  type ControlEvent,
} from "../../../src/control/control-event-bus";
import { ConversationError } from "../../../src/conversations/conversation-error";
import {
  createConversationRuntime,
  createProductionOwnedSessionRelease,
} from "../../../src/conversations/conversation-composition";
import {
  createDirectConversationId,
  createDirectTopicId,
  createScopedDirectBindingId,
  ownedDirectSessionAlias,
} from "../../../src/domain/ids";
import { AsyncMutex } from "../../../src/orchestration/async-mutex";
import { SessionService } from "../../../src/sessions/session-service";
import { createBotDirectOwner } from "../../../src/state/types";
import { createEmptyState, type AppState } from "../../../src/state/types";
import type { ChatRequest } from "../../../src/weixin/agent/interface";

const NOW = "2026-09-16T12:00:00.000Z";

class MemoryStateStore {
  public saved: AppState[] = [];
  async save(state: AppState): Promise<void> {
    this.saved.push(structuredClone(state));
  }
  async saveNow(state: AppState): Promise<void> {
    this.saved.push(structuredClone(state));
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

async function waitUntil(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitUntil timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function wire(options?: {
  autoKick?: boolean;
  authorityEpoch?: string;
  ownerId?: string;
  sqlitePath?: string;
  chat?: (request: ChatRequest) => Promise<{ text: string }>;
  now?: () => Date;
  stateMutex?: AsyncMutex;
}) {
  const dir = mkdtempSync(join(tmpdir(), "xacpx-ctrl-"));
  const sqlitePath = options?.sqlitePath ?? join(dir, "conversations.sqlite");
  const state = createEmptyState();
  const stateStore = new MemoryStateStore();
  const config = createConfig();
  const now = options?.now ?? (() => new Date(NOW));
  const stateMutex = options?.stateMutex ?? new AsyncMutex();
  const sessions = new SessionService(config, stateStore, state, {
    now: () => now().getTime(),
    stateMutex,
  });
  const physical = {
    deleteCalls: 0,
    releaseCalls: 0,
    async deleteSession() {
      this.deleteCalls += 1;
    },
    async releaseLogicalSession() {
      this.releaseCalls += 1;
    },
  };
  const ordinaryTransportMutations: string[] = [];
  const events = createControlEventBus();
  const seen: ControlEvent[] = [];
  events.subscribe((event) => seen.push(event));
  const origins: Array<string | undefined> = [];
  const control = new ControlService({
    agent: {
      chat: async (request: ChatRequest) => {
        origins.push(request.metadata?.origin);
        if (options?.chat) return await options.chat(request);
        return { text: "assistant-reply" };
      },
    },
    sessions,
    activeTurns: { isActiveAnywhere: () => false },
    scheduled: {} as never,
    orchestration: {} as never,
    events,
    workspaces: {
      list: () => [{ name: "backend", cwd: "/tmp/backend" }],
      create: async () => ({ name: "backend", cwd: "/tmp/backend" }),
      remove: async () => {},
    },
    uploadStore: { save: async () => ({ id: "u", path: "/tmp/u", filename: "f", mimeType: "text/plain", size: 1 }) },
    transport: {
      setModel: async () => {
        ordinaryTransportMutations.push("setModel");
      },
      getSessionModel: async () => ({ available: ["gpt"] }),
      setSessionEffort: async () => {
        ordinaryTransportMutations.push("setEffort");
      },
      getSessionEffort: async () => ({ available: ["high"] }),
    },
    removeSessionWithTransport: async (internalAlias: string) => {
      ordinaryTransportMutations.push(`remove:${internalAlias}`);
      await sessions.removeSession(internalAlias);
      return { wasActive: false };
    },
    archiveSessionWithTransport: async (internalAlias: string) => {
      ordinaryTransportMutations.push(`archive:${internalAlias}`);
      await sessions.setArchived(internalAlias, true);
    },
    unarchiveSession: async (internalAlias: string) => {
      ordinaryTransportMutations.push(`unarchive:${internalAlias}`);
      await sessions.setArchived(internalAlias, false);
    },
  } as never);
  const runtime = await createConversationRuntime({
    config,
    state,
    stateStore,
    sessions,
    control,
    sqlitePath,
    releaseOwnedSession: createProductionOwnedSessionRelease({ sessions, transport: physical }),
    onProductEvent: (event) => control.emitConversationProduct(event),
    autoKick: options?.autoKick ?? true,
    stateMutex,
    now,
    ...(options?.authorityEpoch ? { authorityEpoch: options.authorityEpoch } : {}),
    ...(options?.ownerId ? { ownerId: options.ownerId } : {}),
  });
  control.bindConversationRuntime(runtime);
  return {
    dir,
    sqlitePath,
    state,
    sessions,
    control,
    runtime,
    events,
    seen,
    origins,
    physical,
    ordinaryTransportMutations,
  };
}

test("Bot CRUD is a BotService DTO wrapper and rename keeps product IDs", async () => {
  const { control } = await wire({ autoKick: false });
  const created = await control.createBot({
    name: "Reviewer",
    agent: "codex",
    workspace: "backend",
    instructions: "Focus on races.",
  });
  expect(created.id.startsWith("bot_")).toBe(true);
  expect(control.listBots()).toEqual([expect.objectContaining({ id: created.id, name: "Reviewer" })]);
  expect(control.getBot(created.id).instructions).toBe("Focus on races.");
  expect(control.listConversations().map((row) => row.botId)).toEqual([created.id]);
  expect(control.listConversations({ botId: created.id })[0]?.id).toBe(
    createDirectConversationId(created.id),
  );

  const conversationId = createDirectConversationId(created.id);
  const topicId = createDirectTopicId(created.id);
  const detail = control.getConversation(conversationId);
  expect(detail.id).toBe(conversationId);
  expect(detail.botId).toBe(created.id);
  expect(detail.topics[0]?.id).toBe(topicId);

  const renamed = await control.updateBot(created.id, { name: "Senior Reviewer" });
  expect(renamed.id).toBe(created.id);
  expect(renamed.name).toBe("Senior Reviewer");
  expect(control.getConversation(conversationId).id).toBe(conversationId);
  expect(control.listTopics(conversationId)[0]?.id).toBe(topicId);

  const accepted = await control.promptConversation({
    conversationId,
    topicId,
    requestId: "req-rename",
    text: "review this",
  });
  expect(accepted.run.conversationId).toBe(conversationId);
  expect(accepted.run.topicId).toBe(topicId);
  expect(accepted.memberTurn.botId).toBe(created.id);
});

test("public requestId retry returns the same Run even after disable and deleting", async () => {
  const { control, runtime } = await wire({ autoKick: false });
  const bot = await control.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  const conversationId = createDirectConversationId(bot.id);
  const topicId = createDirectTopicId(bot.id);
  const first = await control.promptConversation({
    conversationId,
    topicId,
    requestId: "req-dup",
    text: "hello",
  });
  await control.updateBot(bot.id, { enabled: false });
  const retry = await control.promptConversation({
    conversationId,
    topicId,
    requestId: "req-dup",
    text: "hello",
  });
  expect(retry.reused).toBe(true);
  expect(retry.run.id).toBe(first.run.id);
  expect(retry.message.id).toBe(first.message.id);
  expect(retry.memberTurn.id).toBe(first.memberTurn.id);

  await control.updateBot(bot.id, { enabled: true });
  runtime.store.markConversationDeleting(conversationId, NOW);
  const retryDeleting = await control.promptConversation({
    conversationId,
    topicId,
    requestId: "req-dup",
    text: "hello",
  });
  expect(retryDeleting.run.id).toBe(first.run.id);

  await expect(control.promptConversation({
    conversationId,
    topicId,
    requestId: "req-new",
    text: "later",
  })).rejects.toMatchObject({ code: "conversation_deleting" });
});

test("history uses Topic seq cursors and does not duplicate the final assistant message", async () => {
  const { control } = await wire({ autoKick: true });
  const bot = await control.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  const conversationId = createDirectConversationId(bot.id);
  const topicId = createDirectTopicId(bot.id);
  const accepted = await control.promptConversation({
    conversationId,
    topicId,
    requestId: "req-hist",
    text: "hello",
  });
  await waitUntil(() => control.getRun(accepted.run.id).state === "completed");
  const page = control.conversationHistory({ conversationId, topicId, afterSeq: 0, limit: 50 });
  expect(page.messages.map((m) => [m.seq, m.role, m.content])).toEqual([
    [1, "human", "hello"],
    [2, "bot", "assistant-reply"],
  ]);
  expect(page.oldestSeq).toBe(1);
  expect(page.newestSeq).toBe(2);
  expect(page.hasMoreBefore).toBe(false);
  expect(page.hasMoreAfter).toBe(false);
  const replay = control.conversationHistory({ conversationId, topicId, afterSeq: 1, limit: 50 });
  expect(replay.messages).toEqual([expect.objectContaining({ seq: 2, role: "bot", content: "assistant-reply" })]);
  expect(replay.hasMoreBefore).toBe(true);
});

test("exact run cancel only affects that Run", async () => {
  const { control } = await wire({ autoKick: false });
  const bot = await control.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  const conversationId = createDirectConversationId(bot.id);
  const topicA = createDirectTopicId(bot.id);
  const topicB = (await control.createTopic(conversationId, "other")).id;
  const runA = await control.promptConversation({
    conversationId,
    topicId: topicA,
    requestId: "req-a",
    text: "first",
  });
  const runB = await control.promptConversation({
    conversationId,
    topicId: topicB,
    requestId: "req-b",
    text: "second",
  });
  const cancelled = await control.cancelRun(runA.run.id);
  expect(cancelled.state).toBe("cancelled");
  expect(control.getRun(runB.run.id).state).not.toBe("cancelled");
  expect(control.getRun(runA.run.id).state).toBe("cancelled");
});

test("Direct target must match the Conversation Bot and cannot inject a hidden alias", async () => {
  const { control } = await wire({ autoKick: false });
  const bot = await control.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  const other = await control.createBot({ name: "Other", agent: "codex", workspace: "backend" });
  const conversationId = createDirectConversationId(bot.id);
  const topicId = createDirectTopicId(bot.id);
  await expect(control.promptConversation({
    conversationId,
    topicId,
    requestId: "req-target",
    text: "hello",
    target: { botId: other.id },
  })).rejects.toMatchObject({ code: "conversation_target_mismatch" });

  const accepted = await control.promptConversation({
    conversationId,
    topicId,
    requestId: "req-ok",
    text: "hello",
    target: { botId: bot.id },
  });
  expect(accepted.memberTurn.botId).toBe(bot.id);
});

test("turn events carry exact Conversation/Run/MemberTurn join identity", async () => {
  const { control, seen } = await wire({ autoKick: true });
  const bot = await control.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  const conversationId = createDirectConversationId(bot.id);
  const topicId = createDirectTopicId(bot.id);
  const accepted = await control.promptConversation({
    conversationId,
    topicId,
    requestId: "req-join",
    text: "hello",
  });
  await waitUntil(() => control.getRun(accepted.run.id).state === "completed");
  const started = seen.find((event) => event.type === "turn-started");
  expect(started?.type === "turn-started" ? started.conversation : undefined).toEqual({
    conversationId,
    topicId,
    botId: bot.id,
    runId: accepted.run.id,
    memberTurnId: accepted.memberTurn.id,
  });
  expect(started?.type === "turn-started" ? started.promptRequestId : undefined).toBe(
    control.getRun(accepted.run.id).memberTurns[0]?.promptRequestId,
  );
  const memberStarted = seen.find((event) => event.type === "member-turn-started");
  expect(memberStarted?.type === "member-turn-started" ? memberStarted.memberTurn.id : undefined)
    .toBe(accepted.memberTurn.id);
});

test("deleteBot stays fail-closed while durable ownership exists", async () => {
  const { control } = await wire({ autoKick: false });
  const bot = await control.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  await control.promptConversation({
    conversationId: createDirectConversationId(bot.id),
    topicId: createDirectTopicId(bot.id),
    requestId: "req-own",
    text: "hello",
  });
  await expect(control.deleteBot(bot.id)).rejects.toBeInstanceOf(BotError);
  await expect(control.deleteBot(bot.id)).rejects.toMatchObject({ code: "bot_in_use" });
});

test("ordinary Sessions list hides bot-direct owners and not brt-looking aliases", async () => {
  const { control, sessions } = await wire({ autoKick: true });
  await sessions.createSession("visible", "codex", "backend");
  await sessions.createSession("brt_looks_hidden", "codex", "backend");
  const bot = await control.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  const accepted = await control.promptConversation({
    conversationId: createDirectConversationId(bot.id),
    topicId: createDirectTopicId(bot.id),
    requestId: "req-hide",
    text: "hello",
  });
  await waitUntil(() => control.getRun(accepted.run.id).state === "completed");
  const listed = await sessions.listSessions("wx:user");
  const aliases = listed.map((row) => row.alias);
  expect(aliases).toContain("visible");
  expect(aliases).toContain("brt_looks_hidden");
  expect(aliases.some((alias) => alias.startsWith("brt_") && alias !== "brt_looks_hidden")).toBe(false);
  const ownedAlias = Object.keys(
    (sessions as unknown as { state: { sessions: Record<string, { owner?: { kind?: string }; alias: string }> } }).state.sessions,
  ).find((alias) => sessions.getLogicalSessionRecord(alias)?.owner?.kind === "bot-direct");
  expect(ownedAlias).toBeTruthy();
  expect(aliases).not.toContain(ownedAlias);
  expect(control.listSessions("wx:user").map((row) => row.alias)).toEqual(
    expect.arrayContaining(["visible", "brt_looks_hidden"]),
  );
  expect(control.listSessions("wx:user").map((row) => row.alias)).not.toContain(ownedAlias);

  await expect(control.prompt({
    chatKey: "wx:user",
    sessionAlias: ownedAlias!,
    text: "drive hidden",
    senderId: "user",
  })).rejects.toBeInstanceOf(ConversationError);
});

test("owner metadata, not alias prefix, is the hide rule", async () => {
  const { sessions, control } = await wire({ autoKick: false });
  await sessions.createSession("brt_not_owned", "codex", "backend");
  await sessions.createSession("normal", "codex", "backend", {
    owner: createBotDirectOwner({
      bindingId: "bind_x",
      botId: "bot_x",
      conversationId: "conversation_x",
      topicId: "topic_x",
    }),
  });
  const listed = await sessions.listSessions("wx:user");
  expect(listed.map((row) => row.alias)).toEqual(["brt_not_owned"]);
  expect(control.listSessions("wx:user").map((row) => row.alias)).toEqual(["brt_not_owned"]);
});

test("public APIs fail closed after production shutdown", async () => {
  const { control, runtime } = await wire({ autoKick: false });
  const bot = await control.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  await runtime.shutdown();
  await expect(control.promptConversation({
    conversationId: createDirectConversationId(bot.id),
    topicId: createDirectTopicId(bot.id),
    requestId: "req-closed",
    text: "hello",
  })).rejects.toMatchObject({ code: "store_closed" });
  expect(() => control.conversationHistory({
    conversationId: createDirectConversationId(bot.id),
    topicId: createDirectTopicId(bot.id),
  })).toThrow(/closed/);
});

test("public Run DTO keeps indeterminate instead of mapping it to failed", async () => {
  const { toConversationRun } = await import("../../../src/control/conversation-control-dtos");
  const dto = toConversationRun({
    id: "run_1",
    conversationId: "conversation_1",
    topicId: "topic_1",
    requestMessageId: "cmsg_1",
    requestId: "req",
    mode: "explicit",
    state: "indeterminate",
    completionReason: "unproven_side_effects",
    generation: 1,
    maxMemberTurns: 8,
    consumedMemberTurns: 1,
    profileRevision: 1,
    profileSnapshot: {
      revision: 1,
      capturedAt: NOW,
      presentation: { name: "Reviewer" },
      behavior: {},
      execution: { agent: "codex", workspace: "backend" },
    },
    createdAt: NOW,
  });
  expect(dto.state).toBe("indeterminate");
  expect(dto.completionReason).toBe("unproven_side_effects");
});

test("synthetic Conversation and Topic timestamps stay stable across clock advances", async () => {
  let current = Date.parse(NOW);
  const { control } = await wire({
    autoKick: false,
    now: () => new Date(current),
  });
  const bot = await control.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  const conversationId = createDirectConversationId(bot.id);
  const topicId = createDirectTopicId(bot.id);
  const listed = control.listConversations({ botId: bot.id });
  const detail = control.getConversation(conversationId);
  const topics = control.listTopics(conversationId);
  expect(listed[0]?.id).toBe(conversationId);
  expect(listed[0]?.defaultTopicId).toBe(topicId);
  expect(detail.defaultTopicId).toBe(topicId);
  expect(detail.createdAt).toBe(bot.createdAt);
  expect(topics[0]?.id).toBe(topicId);
  expect(topics[0]?.createdAt).toBe(bot.createdAt);

  current += 60_000;
  expect(control.listConversations({ botId: bot.id })).toEqual(listed);
  expect(control.getConversation(conversationId)).toEqual(detail);
  expect(control.listTopics(conversationId)).toEqual(topics);

  const extra = await control.createTopic(conversationId, "other");
  expect(extra.id).not.toBe(topicId);
  expect(control.getConversation(conversationId).defaultTopicId).toBe(topicId);
  expect(control.listConversations({ botId: bot.id })[0]?.defaultTopicId).toBe(topicId);
});

test("idempotent prompt retry does not re-emit acceptance product events", async () => {
  const { control, seen } = await wire({ autoKick: false });
  const bot = await control.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  const conversationId = createDirectConversationId(bot.id);
  const topicId = createDirectTopicId(bot.id);
  const first = await control.promptConversation({
    conversationId,
    topicId,
    requestId: "req-once",
    text: "hello",
  });
  const messagesAfterFirst = seen.filter((event) => event.type === "conversation-message");
  const queuedAfterFirst = seen.filter(
    (event) => event.type === "conversation-run-changed" && event.run.state === "queued",
  );
  expect(messagesAfterFirst).toHaveLength(1);
  expect(queuedAfterFirst).toHaveLength(1);
  expect(messagesAfterFirst[0]?.type === "conversation-message" ? messagesAfterFirst[0].message.id : undefined)
    .toBe(first.message.id);

  const retry = await control.promptConversation({
    conversationId,
    topicId,
    requestId: "req-once",
    text: "hello",
  });
  expect(retry.reused).toBe(true);
  expect(retry.run.id).toBe(first.run.id);
  expect(retry.message.id).toBe(first.message.id);
  expect(retry.memberTurn.id).toBe(first.memberTurn.id);
  expect(seen.filter((event) => event.type === "conversation-message")).toHaveLength(1);
  expect(seen.filter(
    (event) => event.type === "conversation-run-changed" && event.run.state === "queued",
  )).toHaveLength(1);
});

test("ordinary Session mutations reject bot-direct owners without physical release", async () => {
  const { control, sessions, state, runtime, physical, ordinaryTransportMutations } = await wire({
    autoKick: true,
  });
  const bot = await control.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  const conversationId = createDirectConversationId(bot.id);
  const topicId = createDirectTopicId(bot.id);
  const accepted = await control.promptConversation({
    conversationId,
    topicId,
    requestId: "req-guard",
    text: "hello",
  });
  await waitUntil(() => control.getRun(accepted.run.id).state === "completed");
  const bindingId = createScopedDirectBindingId(conversationId, topicId, bot.id);
  const hiddenAlias = ownedDirectSessionAlias(bindingId);
  expect(sessions.getLogicalSessionRecord(hiddenAlias)?.owner?.kind).toBe("bot-direct");
  const bindingBefore = structuredClone(state.bot_runtime_bindings[bindingId]);
  expect(bindingBefore).toBeTruthy();
  const physicalBefore = { deleteCalls: physical.deleteCalls, releaseCalls: physical.releaseCalls };

  const chatKey = "wx:user";
  const ops: Array<{ name: string; run: () => unknown }> = [
    {
      name: "prompt",
      run: () => control.prompt({ chatKey, sessionAlias: hiddenAlias, text: "drive", senderId: "user" }),
    },
    { name: "remove", run: () => control.removeSession(chatKey, hiddenAlias) },
    { name: "archive", run: () => control.archiveSession(chatKey, hiddenAlias) },
    { name: "unarchive", run: () => control.unarchiveSession(chatKey, hiddenAlias) },
    { name: "rename", run: () => control.setSessionDisplayName(chatKey, hiddenAlias, "nope") },
    { name: "model", run: () => control.setSessionModel(chatKey, hiddenAlias, "gpt") },
    { name: "effort", run: () => control.setSessionEffort(chatKey, hiddenAlias, "high") },
    { name: "getModel", run: () => control.getSessionModel(chatKey, hiddenAlias) },
    { name: "cancelTurn", run: () => control.cancelTurn(chatKey, hiddenAlias) },
    { name: "cancelQueuedItem", run: () => control.cancelQueuedItem(chatKey, hiddenAlias, "item") },
    { name: "clearSession", run: () => control.clearSession(chatKey, hiddenAlias) },
  ];
  for (const op of ops) {
    try {
      await op.run();
      throw new Error(`${op.name} addressed a hidden session`);
    } catch (error) {
      expect(error).toBeInstanceOf(ConversationError);
      expect(error).toMatchObject({ code: "hidden_session" });
    }
    expect(sessions.getLogicalSessionRecord(hiddenAlias)?.owner?.kind).toBe("bot-direct");
    expect(state.bot_runtime_bindings[bindingId]).toEqual(bindingBefore);
    expect(physical.deleteCalls).toBe(physicalBefore.deleteCalls);
    expect(physical.releaseCalls).toBe(physicalBefore.releaseCalls);
    expect(ordinaryTransportMutations).toEqual([]);
  }

  await sessions.createSession("plain", "codex", "backend");
  await control.removeSession(chatKey, "plain");
  expect(ordinaryTransportMutations).toEqual(["remove:plain"]);
  expect(sessions.getLogicalSessionRecord("plain")).toBeNull();
  expect(sessions.getLogicalSessionRecord(hiddenAlias)?.owner?.kind).toBe("bot-direct");

  await runtime.runs.teardownDirectConversation(bot.id);
  expect(sessions.getLogicalSessionRecord(hiddenAlias)).toBeNull();
  expect(state.bot_runtime_bindings[bindingId]).toBeUndefined();
  expect(physical.deleteCalls + physical.releaseCalls).toBeGreaterThan(
    physicalBefore.deleteCalls + physicalBefore.releaseCalls,
  );
});
