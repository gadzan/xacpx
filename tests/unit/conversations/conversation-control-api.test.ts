import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

import { BotError } from "../../../src/bots/bot-error";
import type { AppConfig } from "../../../src/config/types";
import { ControlService, conversationKernel } from "../../../src/control/control-service";
import { asPublicControl } from "../../../src/control/public-control";
import type { PublicControlPromptInput } from "../../../src/control/public-control";
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
  const kernel = conversationKernel(control);
  const runtime = await createConversationRuntime({
    config,
    state,
    stateStore,
    sessions,
    control: kernel,
    sqlitePath,
    releaseOwnedSession: createProductionOwnedSessionRelease({ sessions, transport: physical }),
    onProductEvent: (event) => kernel.emitConversationProduct(event),
    autoKick: options?.autoKick ?? true,
    stateMutex,
    now,
    ...(options?.authorityEpoch ? { authorityEpoch: options.authorityEpoch } : {}),
    ...(options?.ownerId ? { ownerId: options.ownerId } : {}),
  });
  kernel.bindConversationRuntime(runtime);
  if (options?.autoKick ?? true) {
    await runtime.activateAfterConsumerLock();
  }
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
  expect(control.getConversation(conversationId).title).toBe("Senior Reviewer");
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

test("history direction cannot be combined with seq cursors", async () => {
  const { control } = await wire({ autoKick: false });
  const bot = await control.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  const conversationId = createDirectConversationId(bot.id);
  const topicId = createDirectTopicId(bot.id);
  await control.promptConversation({ conversationId, topicId, requestId: "req-page", text: "hello" });
  expect(() => control.conversationHistory({ conversationId, topicId, beforeSeq: 5, limit: 2, direction: "newest-first" }))
    .toThrow(/direction/);
  expect(() => control.conversationHistory({ conversationId, topicId, afterSeq: 1, limit: 2, direction: "oldest-first" }))
    .toThrow(/direction/);
});

test("history newest-first tail reaches messages beyond the first page", async () => {
  const { control } = await wire({ autoKick: false });
  const bot = await control.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  const conversationId = createDirectConversationId(bot.id);
  const topicId = createDirectTopicId(bot.id);
  const totalPrompts = 30;
  for (let index = 0; index < totalPrompts; index += 1) {
    await control.promptConversation({
      conversationId,
      topicId,
      requestId: `req-tail-${index}`,
      text: `hello ${index}`,
    });
  }
  const firstPage = control.conversationHistory({ conversationId, topicId, limit: 20 });
  expect(firstPage.messages.map((m) => m.seq)).toEqual(
    Array.from({ length: 20 }, (_, index) => index + 1),
  );
  expect(firstPage.hasMoreAfter).toBe(true);
  expect(firstPage.hasMoreBefore).toBe(false);
  const tail = control.conversationHistory({ conversationId, topicId, limit: 20, direction: "newest-first" });
  expect(tail.messages.map((m) => m.seq)).toEqual(
    Array.from({ length: 20 }, (_, index) => index + 11),
  );
  expect(tail.oldestSeq).toBe(11);
  expect(tail.newestSeq).toBe(30);
  expect(tail.hasMoreBefore).toBe(true);
  expect(tail.hasMoreAfter).toBe(false);
  const older = control.conversationHistory({ conversationId, topicId, beforeSeq: tail.oldestSeq, limit: 20 });
  expect(older.messages.map((m) => m.seq)).toEqual(
    Array.from({ length: 10 }, (_, index) => index + 1),
  );
  expect(older.hasMoreBefore).toBe(false);
});

test("topic runs list only that Topic and preserves newest run identity", async () => {
  const { control } = await wire({ autoKick: false });
  const bot = await control.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  const conversationId = createDirectConversationId(bot.id);
  const topicA = createDirectTopicId(bot.id);
  const topicB = (await control.createTopic(conversationId, "other")).id;
  const runA = await control.promptConversation({ conversationId, topicId: topicA, requestId: "req-a", text: "first" });
  const runB = await control.promptConversation({ conversationId, topicId: topicB, requestId: "req-b", text: "second" });
  const listedA = control.listTopicRuns(conversationId, topicA);
  const listedB = control.listTopicRuns(conversationId, topicB);
  expect(listedA.runs.map((run) => run.id)).toEqual([runA.run.id]);
  expect(listedB.runs.map((run) => run.id)).toEqual([runB.run.id]);
  expect(listedA.runs[0]).toMatchObject({ requestId: "req-a", state: "queued" });
  expect(listedA.activeRunId).toBe(runA.run.id);
  expect(listedB.activeRunId).toBe(runB.run.id);
});

test("topic runs list prefers the executing Run and otherwise the oldest queued Run", async () => {
  const { control, runtime } = await wire({ autoKick: false });
  const bot = await control.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  const conversationId = createDirectConversationId(bot.id);
  const topicId = createDirectTopicId(bot.id);
  const first = await control.promptConversation({ conversationId, topicId, requestId: "req-first", text: "first" });
  const second = await control.promptConversation({ conversationId, topicId, requestId: "req-second", text: "second" });
  const third = await control.promptConversation({ conversationId, topicId, requestId: "req-third", text: "third" });
  // Simulate execution ownership: claim the oldest durable dispatch, then mark
  // it started so the oldest Run is executing while later accepts stay queued.
  const dispatch = runtime.store.getDispatchForRun(first.run.id)!;
  const claimed = runtime.store.claimNextDispatch({
    authorityEpoch: runtime.authorityEpoch,
    now: NOW,
    owner: "test-owner",
    leaseExpiresAt: "2026-09-16T12:01:00.000Z",
  });
  expect(claimed?.run.id).toBe(first.run.id);
  runtime.store.markExecutionStarted({
    dispatchId: dispatch.id,
    owner: "test-owner",
    generation: claimed!.dispatch.generation,
    runId: first.run.id,
    memberTurnId: runtime.store.listMemberTurns(first.run.id)[0]!.id,
    sessionAlias: "alias",
    logicalSessionId: "logical",
    sourceTurnId: "source",
    now: NOW,
  });
  const listed = control.listTopicRuns(conversationId, topicId);
  expect(listed.runs.map((run) => run.id)).toEqual([first.run.id, second.run.id, third.run.id]);
  expect(listed.activeRunId).toBe(first.run.id);
  // Complete (not cancel) the executing Run directly in durable state: a
  // cancel would kick the dispatcher and drain the queued Runs in this test
  // wire, hiding the oldest-queued-next assertion.
  runtime.store.completeExecution({
    runId: first.run.id,
    memberTurnId: runtime.store.listMemberTurns(first.run.id)[0]!.id,
    botId: bot.id,
    content: "done",
    sourceTurn: { sessionAlias: "alias" },
    now: NOW,
  });
  const afterComplete = control.listTopicRuns(conversationId, topicId);
  expect(afterComplete.activeRunId).toBe(second.run.id);
});

test("prompt accept returns the topic-wide owner, not just the accepted Run", async () => {
  const { control } = await wire({ autoKick: false });
  const bot = await control.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  const conversationId = createDirectConversationId(bot.id);
  const topicId = createDirectTopicId(bot.id);
  const first = await control.promptConversation({ conversationId, topicId, requestId: "req-first", text: "first" });
  const second = await control.promptConversation({ conversationId, topicId, requestId: "req-second", text: "second" });
  // Both accepts are queued, so the oldest durable Run still owns the Topic:
  // the second accept must name the first Run as the topic-wide owner.
  expect(first.activeRunId).toBe(first.run.id);
  expect(first.activeRun?.id).toBe(first.run.id);
  expect(second.run.id).not.toBe(first.run.id);
  expect(second.activeRunId).toBe(first.run.id);
  expect(second.activeRun?.id).toBe(first.run.id);
});

test("topic runs list bounds the returned page while keeping durable active selection", async () => {
  const { control } = await wire({ autoKick: false });
  const bot = await control.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  const conversationId = createDirectConversationId(bot.id);
  const topicId = createDirectTopicId(bot.id);
  for (let index = 0; index < 5; index += 1) {
    await control.promptConversation({ conversationId, topicId, requestId: `req-${index}`, text: `text ${index}` });
  }
  const page = control.listTopicRuns(conversationId, topicId, 2);
  expect(page.runs).toHaveLength(2);
  expect(page.runs.map((run) => run.requestId)).toEqual(["req-3", "req-4"]);
  // Paging bounds the transport payload, never the active identity: the
  // oldest queued Run stays the durable owner even outside the newest page.
  expect(page.activeRunId).toBe(page.activeRun?.id);
  expect(page.activeRun).toMatchObject({ requestId: "req-0", state: "queued" });
});

test("topic runs list reports no active run after completion and newest active after multiple prompts", async () => {
  const { control } = await wire({ autoKick: true, chat: async () => ({ text: "done" }) });
  const bot = await control.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  const conversationId = createDirectConversationId(bot.id);
  const topicId = createDirectTopicId(bot.id);
  const first = await control.promptConversation({ conversationId, topicId, requestId: "req-first", text: "first" });
  await waitUntil(() => control.getRun(first.run.id).state === "completed");
  const idle = control.listTopicRuns(conversationId, topicId);
  expect(idle.runs.map((run) => run.id)).toEqual([first.run.id]);
  expect(idle.activeRunId).toBeUndefined();
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
  const { control, runtime, state } = await wire({ autoKick: false });
  const bot = await control.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  const botsBefore = structuredClone(state.bots);
  const conversationsBefore = structuredClone(state.conversations);
  const topicsBefore = structuredClone(state.conversation_topics);
  await runtime.shutdown();
  await expect(control.createBot({ name: "Later", agent: "codex", workspace: "backend" }))
    .rejects.toMatchObject({ code: "runtime_closed" });
  await expect(control.updateBot(bot.id, { name: "Senior" }))
    .rejects.toMatchObject({ code: "runtime_closed" });
  await expect(control.deleteBot(bot.id))
    .rejects.toMatchObject({ code: "runtime_closed" });
  await expect(control.createTopic(createDirectConversationId(bot.id), "extra"))
    .rejects.toMatchObject({ code: "runtime_closed" });
  await expect(control.promptConversation({
    conversationId: createDirectConversationId(bot.id),
    topicId: createDirectTopicId(bot.id),
    requestId: "req-closed",
    text: "hello",
  })).rejects.toMatchObject({ code: "runtime_closed" });
  await expect(control.cancelRun("run_missing")).rejects.toMatchObject({ code: "runtime_closed" });
  expect(() => control.conversationHistory({
    conversationId: createDirectConversationId(bot.id),
    topicId: createDirectTopicId(bot.id),
  })).toThrow(/closed/);
  expect(() => control.listBots()).toThrow(/closed/);
  expect(() => control.listConversations()).toThrow(/closed/);
  expect(state.bots).toEqual(botsBefore);
  expect(state.conversations).toEqual(conversationsBefore);
  expect(state.conversation_topics).toEqual(topicsBefore);
  await expect(runtime.bots.createBot({ name: "Direct", agent: "codex", workspace: "backend" }))
    .rejects.toMatchObject({ code: "runtime_closed" });
  expect(state.bots).toEqual(botsBefore);
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

type _PublicPromptForbidden = Extract<
  keyof PublicControlPromptInput,
  "executionOrigin" | "conversation" | "conversationSeam"
>;
const _publicPromptHasNoAuthority: [_PublicPromptForbidden] extends [never] ? true : false = true;
void _publicPromptHasNoAuthority;

type _PublicServiceForbidden = Extract<
  keyof ControlService,
  | "promptImmediate"
  | "cancelTurnForPromptRequest"
  | "inspectPromptRequest"
  | "cancelQueuedConversationItem"
  | "bindConversationRuntime"
  | "emitConversationProduct"
  | "promptConversationFromHumanIngress"
>;
const _publicServiceHasNoTrustedMethods: [_PublicServiceForbidden] extends [never] ? true : false = true;
void _publicServiceHasNoTrustedMethods;

test("public Control facade cannot mint Conversation execution authority", async () => {
  const { control, sessions, seen, origins } = await wire({ autoKick: true });
  const publicControl = asPublicControl(control);
  expect("promptImmediate" in control).toBe(false);
  expect("cancelTurnForPromptRequest" in control).toBe(false);
  expect("inspectPromptRequest" in control).toBe(false);
  expect("cancelQueuedConversationItem" in control).toBe(false);
  expect("bindConversationRuntime" in control).toBe(false);
  expect("emitConversationProduct" in control).toBe(false);
  expect("promptConversationFromHumanIngress" in control).toBe(false);
  expect((control as { promptImmediate?: unknown }).promptImmediate).toBeUndefined();
  expect((control as { cancelQueuedConversationItem?: unknown }).cancelQueuedConversationItem)
    .toBeUndefined();
  expect("promptImmediate" in publicControl).toBe(false);
  expect((publicControl as { promptImmediate?: unknown }).promptImmediate).toBeUndefined();
  expect(typeof conversationKernel(control).promptImmediate).toBe("function");

  await sessions.createSession("plain", "codex", "backend");
  const bot = await control.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  const accepted = await control.promptConversation({
    conversationId: createDirectConversationId(bot.id),
    topicId: createDirectTopicId(bot.id),
    requestId: "req-public-guard",
    text: "hello",
  });
  await waitUntil(() => control.getRun(accepted.run.id).state === "completed");
  const hiddenAlias = Object.keys(
    (sessions as unknown as { state: { sessions: Record<string, { owner?: { kind?: string }; alias: string }> } }).state.sessions,
  ).find((alias) => sessions.getLogicalSessionRecord(alias)?.owner?.kind === "bot-direct");
  expect(hiddenAlias).toBeTruthy();

  const forged = {
    chatKey: "wx:user",
    sessionAlias: hiddenAlias!,
    text: "drive hidden",
    senderId: "user",
    executionOrigin: "human",
    conversation: {
      conversationId: createDirectConversationId(bot.id),
      topicId: createDirectTopicId(bot.id),
      botId: bot.id,
      runId: accepted.run.id,
      memberTurnId: accepted.memberTurn.id,
    },
    conversationSeam: true,
  };
  await expect(publicControl.prompt(forged as never)).rejects.toMatchObject({ code: "hidden_session" });
  await expect(control.prompt(forged as never)).rejects.toMatchObject({ code: "hidden_session" });
  try {
    publicControl.cancelQueuedItem("wx:user", hiddenAlias!, "item", { conversationSeam: true } as never);
    throw new Error("cancelQueuedItem addressed a hidden session");
  } catch (error) {
    expect(error).toMatchObject({ code: "hidden_session" });
  }

  const before = seen.filter((event) => event.type === "turn-started").length;
  const ordinary = await publicControl.prompt({
    chatKey: "wx:user",
    sessionAlias: "plain",
    text: "ok",
    senderId: "user",
    ...({ executionOrigin: "orchestration" } as object),
  } as PublicControlPromptInput);
  expect(ordinary.ok).toBe(true);
  expect(origins.at(-1)).toBe("human");
  await waitUntil(() => seen.filter((event) => event.type === "turn-started").length > before);
  const started = seen.filter((event) => event.type === "turn-started").at(-1);
  expect(started?.type === "turn-started" ? started.sessionAlias : undefined).toBe("plain");
});

test("createBot emits conversations-changed and list includes the Direct Conversation", async () => {
  const { control, seen } = await wire({ autoKick: false });
  const before = seen.filter((event) => event.type === "conversations-changed").length;
  expect(control.listConversations()).toEqual([]);
  const bot = await control.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  const listed = control.listConversations();
  expect(listed).toEqual([
    expect.objectContaining({
      id: createDirectConversationId(bot.id),
      botId: bot.id,
      title: "Reviewer",
    }),
  ]);
  const changed = seen.filter((event) => event.type === "conversations-changed");
  expect(changed.length).toBe(before + 1);
  expect(seen.filter((event) => event.type === "bots-changed").length).toBe(1);
});

test("rename of a synthetic Direct Conversation updates the public projection", async () => {
  const { control, seen } = await wire({ autoKick: false });
  const bot = await control.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  const conversationId = createDirectConversationId(bot.id);
  expect(control.getConversation(conversationId).title).toBe("Reviewer");
  const before = seen.filter((event) => event.type === "conversations-changed").length;
  const renamed = await control.updateBot(bot.id, { name: "Senior" });
  expect(renamed.name).toBe("Senior");
  const projection = control.getConversation(conversationId);
  expect(projection.title).toBe("Senior");
  expect(projection.updatedAt).toBe(renamed.updatedAt);
  expect(projection.id).toBe(conversationId);
  expect(seen.filter((event) => event.type === "conversations-changed").length).toBe(before + 1);
});

test("Direct Conversation presentation matches whether or not runtime materialized", async () => {
  let nowA = Date.parse(NOW);
  const pathA = await wire({ autoKick: false, now: () => new Date(nowA) });
  const botA = await pathA.control.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  const conversationIdA = createDirectConversationId(botA.id);
  const topicIdA = createDirectTopicId(botA.id);
  nowA += 60_000;
  const renamedA = await pathA.control.updateBot(botA.id, { name: "Senior" });
  const summaryA = pathA.control.getConversation(conversationIdA);
  const listedA = pathA.control.listConversations({ botId: botA.id })[0];

  let nowB = Date.parse(NOW);
  const pathB = await wire({ autoKick: false, now: () => new Date(nowB) });
  const botB = await pathB.control.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  const conversationIdB = createDirectConversationId(botB.id);
  const topicIdB = createDirectTopicId(botB.id);
  const accepted = await pathB.control.promptConversation({
    conversationId: conversationIdB,
    topicId: topicIdB,
    requestId: "req-materialize",
    text: "hello",
  });
  const extraTopic = await pathB.control.createTopic(conversationIdB, "other");
  nowB += 60_000;
  const renamedB = await pathB.control.updateBot(botB.id, { name: "Senior" });
  const summaryB = pathB.control.getConversation(conversationIdB);
  const listedB = pathB.control.listConversations({ botId: botB.id })[0];

  expect(summaryA.title).toBe("Senior");
  expect(summaryB.title).toBe("Senior");
  expect(listedA?.title).toBe("Senior");
  expect(listedB?.title).toBe("Senior");
  expect(summaryA.createdAt).toBe(botA.createdAt);
  expect(summaryB.createdAt).toBe(botB.createdAt);
  expect(summaryA.updatedAt).toBe(renamedA.updatedAt);
  expect(summaryB.updatedAt).toBe(renamedB.updatedAt);
  expect(summaryA.id).toBe(conversationIdA);
  expect(summaryB.id).toBe(conversationIdB);
  expect(botA.id).not.toBe(botB.id);
  expect(pathA.control.listTopics(conversationIdA)[0]?.id).toBe(topicIdA);
  expect(pathB.control.listTopics(conversationIdB).map((topic) => topic.id)).toEqual(
    expect.arrayContaining([topicIdB, extraTopic.id]),
  );
  expect(pathB.control.getRun(accepted.run.id).id).toBe(accepted.run.id);
  expect(pathB.control.getConversation(conversationIdB).defaultTopicId).toBe(topicIdB);
  expect(pathB.control.listConversations({ botId: botB.id })[0]?.defaultTopicId).toBe(topicIdB);

  const defaultTopicA = pathA.control.listTopics(conversationIdA)[0];
  const defaultTopicB = pathB.control.listTopics(conversationIdB).find((topic) => topic.id === topicIdB);
  const defaultFromGetA = pathA.control.getConversation(conversationIdA).topics.find((topic) => topic.id === topicIdA);
  const defaultFromGetB = pathB.control.getConversation(conversationIdB).topics.find((topic) => topic.id === topicIdB);
  const expectedDefault = (conversationId: string, topicId: string, createdAt: string) => ({
    id: topicId,
    conversationId,
    title: "Default",
    status: "active" as const,
    createdAt,
    updatedAt: createdAt,
  });
  expect(defaultTopicA).toEqual(expectedDefault(conversationIdA, topicIdA, botA.createdAt));
  expect(defaultTopicB).toEqual(expectedDefault(conversationIdB, topicIdB, botB.createdAt));
  expect(defaultTopicA?.updatedAt).not.toBe(renamedA.updatedAt);
  expect(defaultTopicB?.updatedAt).not.toBe(renamedB.updatedAt);
  expect(defaultFromGetA).toEqual(defaultTopicA);
  expect(defaultFromGetB).toEqual(defaultTopicB);
  expect({ ...defaultTopicA, id: "default", conversationId: "c" }).toEqual({
    ...defaultTopicB,
    id: "default",
    conversationId: "c",
  });
});

test("PR3 persisted default Topic clocks overlay to Bot createdAt after upgrade", async () => {
  const t0 = NOW;
  const t1 = "2026-09-16T12:05:00.000Z";
  const { control, state } = await wire({
    autoKick: false,
    now: () => new Date(t0),
  });
  const bot = await control.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  expect(bot.createdAt).toBe(t0);
  const conversationId = createDirectConversationId(bot.id);
  const topicId = createDirectTopicId(bot.id);
  state.conversations[conversationId] = {
    id: conversationId,
    kind: "bot",
    title: "Reviewer",
    botIds: [bot.id],
    createdAt: t1,
    updatedAt: t1,
  };
  state.conversation_topics[topicId] = {
    id: topicId,
    conversationId,
    title: "Default",
    status: "active",
    createdAt: t1,
    updatedAt: t1,
  };

  const listed = control.listTopics(conversationId)[0];
  const fromGet = control.getConversation(conversationId).topics.find((topic) => topic.id === topicId);
  expect(listed).toEqual({
    id: topicId,
    conversationId,
    title: "Default",
    status: "active",
    createdAt: t0,
    updatedAt: t0,
  });
  expect(fromGet).toEqual(listed);
  expect(listed?.createdAt).not.toBe(t1);
  expect(listed?.updatedAt).not.toBe(t1);
});

test("public promptConversation cannot mint human ingress; kernel stamp can", async () => {
  const { control, runtime } = await wire({ autoKick: false });
  const bot = await control.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  const publicAccepted = await asPublicControl(control).promptConversation({
    conversationId: createDirectConversationId(bot.id),
    topicId: createDirectTopicId(bot.id),
    requestId: "req-public",
    text: "hello",
    ...({
      humanIngress: { chatKey: "relay:acct", senderId: "acct", isOwner: true },
      executionOrigin: "human",
    } as object),
  } as never);
  await runtime.dispatcher.kick();
  expect(control.getRun(publicAccepted.run.id).memberTurns[0]?.origin).toBe("recovery");

  const human = await conversationKernel(control).promptConversationFromHumanIngress({
    conversationId: createDirectConversationId(bot.id),
    topicId: createDirectTopicId(bot.id),
    requestId: "req-trusted",
    text: "hello",
  }, { chatKey: "relay:acct", senderId: "acct", accountId: "acct", isOwner: true });
  await runtime.dispatcher.kick();
  expect(control.getRun(human.run.id).memberTurns[0]?.origin).toBe("human");

  await expect(conversationKernel(control).promptConversationFromHumanIngress({
    conversationId: createDirectConversationId(bot.id),
    topicId: createDirectTopicId(bot.id),
    requestId: "req-bot-key",
    text: "hello",
  }, { chatKey: `bot:${createDirectConversationId(bot.id)}:${createDirectTopicId(bot.id)}`, senderId: "acct" })).rejects.toMatchObject({
    code: "human_ingress_invalid",
  });
  await runtime.shutdown();
});
test("group CRUD, topic lifecycle, and teardown flow through public Control", async () => {
  const { control, runtime } = await wire({ autoKick: false });
  const botA = await control.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  const botB = await control.createBot({ name: "Tester", agent: "codex", workspace: "backend" });
  const group = await control.createGroup({ title: "Release Team", botIds: [botA.id, botB.id], leadBotId: botA.id });
  expect(group.kind).toBe("group");
  expect(group.botIds).toEqual([botA.id, botB.id]);
  expect(group.leadBotId).toBe(botA.id);
  const renamed = await control.updateGroup(group.id, { title: "Release Team 2" });
  expect(renamed.title).toBe("Release Team 2");
  const detail = control.getGroup(group.id);
  expect(detail.topics).toEqual([]);
  const topic = await control.createGroupTopic(group.id, "Sprint 1", {
    workspace: "backend",
    isolation: "shared-single-writer",
  });
  expect(topic.conversationId).toBe(group.id);
  expect(topic.executionTarget).toEqual({ workspace: "backend", isolation: "shared-single-writer" });
  expect(control.getGroup(group.id).topics.map((t) => t.id)).toContain(topic.id);
  const archived = await control.archiveGroupTopic(group.id, topic.id);
  expect(archived.status).toBe("archived");
  // Member binding materializes on the group topic, isolated from direct bindings.
  const member = await runtime.botRuntime.getOrCreateGroupMemberSession({
    botId: botA.id, conversationId: group.id, topicId: topic.id,
  });
  expect(member.scope).toBe("group-member");
  await control.teardownGroupTopic(group.id, topic.id);
  expect(control.getGroup(group.id).topics.map((t) => t.id)).not.toContain(topic.id);
  // Public deleteGroup runs verified teardown (not the fail-closed metadata
  // delete): a second topic is torn down inline and the group disappears.
  const topic2 = await control.createGroupTopic(group.id, "Sprint 2", {
    workspace: "backend",
    isolation: "shared",
  });
  await control.deleteGroup(group.id);
  expect(() => control.getGroup(group.id)).toThrow();
  await runtime.shutdown();
});
