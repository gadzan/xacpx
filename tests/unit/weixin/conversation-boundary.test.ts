import { expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlService, conversationKernel } from "../../../src/control/control-service";
import { createControlEventBus } from "../../../src/control/control-event-bus";
import { createConversationRuntime } from "../../../src/conversations/conversation-composition";
import { createConversationChannelRouter } from "../../../src/channels/conversation-channel-router";
import { MessageChannelRegistry } from "../../../src/channels/channel-registry";
import { AsyncMutex } from "../../../src/orchestration/async-mutex";
import { SessionService } from "../../../src/sessions/session-service";
import { createEmptyState } from "../../../src/state/types";
import { getLocale, setLocale } from "../../../src/i18n";
import type { ChatRequest } from "../../../src/weixin/agent/interface";
import type { WeixinMessage } from "../../../src/weixin/api/types";
import type { ChannelStopReason } from "../../../src/channels/types";

async function waitFor(condition: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!condition()) { if (Date.now() > deadline) throw new Error("condition timed out"); await Bun.sleep(3); }
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "xacpx-weixin-boundary-"));
  const priorStateDir = process.env.OPENCLAW_STATE_DIR; process.env.OPENCLAW_STATE_DIR = root;
  const pending: WeixinMessage[] = []; let wake = () => {}; let polls = 0;
  let nextBuf = ""; const pollInputs: string[] = []; let clears = 0; let sessionExpired = false;
  const sent: Array<{ context: string; text: string }> = [];
  const ordinary: ChatRequest[] = []; const errors: string[] = [];
  const configCalls: string[] = []; const inbound: string[] = [];
  mock.module("../../../src/weixin/api/api.ts", () => ({
    getUpdates: async (input: { abortSignal?: AbortSignal; get_updates_buf: string }) => {
      polls++;
      pollInputs.push(input.get_updates_buf);
      if (!pending.length && !input.abortSignal?.aborted) await new Promise<void>((resolve) => {
        const finish = () => { input.abortSignal?.removeEventListener("abort", finish); resolve(); };
        wake = finish; input.abortSignal?.addEventListener("abort", finish, { once: true });
      });
      if (sessionExpired) { sessionExpired = false; return { ret: -14, msgs: [], get_updates_buf: "" }; }
      const buf = nextBuf; nextBuf = "";
      return { ret: 0, msgs: pending.splice(0), get_updates_buf: buf };
    },
    sendMessage: async (input: any) => { sent.push({ context: input.body.msg.context_token,
      text: input.body.msg.item_list?.[0]?.text_item?.text ?? "" }); return {}; },
    sendTyping: async () => ({}),
  }));
  mock.module("../../../src/weixin/api/config-cache.ts", () => ({
    WeixinConfigManager: class { async getForUser(user: string) { configCalls.push(user); return { typingTicket: "" }; } },
  }));
  const { WeixinChannel } = await import("../../../src/channels/weixin-channel");
  const { buildWeixinConversationChatKey } = await import("../../../src/weixin/messaging/handle-weixin-message-turn");
  const { saveWeixinAccount, registerWeixinAccountId } = await import("../../../src/weixin/auth/accounts");
  const { getSyncBufFilePath, loadGetUpdatesBuf } = await import("../../../src/weixin/storage/sync-buf");
  const credentials = () => { saveWeixinAccount("default", { token: "test", baseUrl: "https://example.com" }); registerWeixinAccountId("default"); };
  const refreshCredentials = () => {
    saveWeixinAccount("default", { token: "refreshed", baseUrl: "https://example.com" }); sessionExpired = true; wake();
  };
  credentials();
  const state = createEmptyState(); const stateStore = { save: async () => {}, saveNow: async () => {} }; const stateMutex = new AsyncMutex();
  const config = { transport: { type: "acpx-cli", permissionMode: "approve-all" },
    agents: { codex: { driver: "codex" } }, workspaces: { backend: { cwd: root } } } as never;
  const sessions = new SessionService(config, stateStore, state, { stateMutex }); const events = createControlEventBus();
  const sessionReads: string[] = []; const peek = sessions.peekCurrentSessionAlias.bind(sessions);
  sessions.peekCurrentSessionAlias = (key) => { sessionReads.push(key); return peek(key); };
  const control = new ControlService({ agent: { chat: async () => ({ text: "durable result" }) }, sessions,
    activeTurns: { isActiveAnywhere: () => false }, events, scheduled: {}, orchestration: {},
    workspaces: { list: () => [{ name: "backend", cwd: root }] } } as never);
  const kernel = conversationKernel(control);
  const runtime = await createConversationRuntime({ config, state, stateStore, sessions, control: kernel,
    sqlitePath: join(root, "conversations.sqlite"), releaseOwnedSession: async () => {}, stateMutex, autoKick: false,
    onProductEvent: (event) => kernel.emitConversationProduct(event) });
  kernel.bindConversationRuntime(runtime);
  const accept = runtime.bindings.accept.bind(runtime.bindings);
  runtime.bindings.accept = async (...args) => { try { return await accept(...args); }
    catch (error) { errors.push((error as { code: string }).code); throw error; } };
  const acceptStop = runtime.bindings.acceptStop.bind(runtime.bindings);
  runtime.bindings.acceptStop = (...args) => { try { return acceptStop(...args); }
    catch (error) { errors.push((error as { code: string }).code); throw error; } };
  const bot = await control.createBot({ name: "Bot", agent: "codex", workspace: "backend" });
  const sibling = await control.createBot({ name: "Other", agent: "codex", workspace: "backend" });
  const group = await control.createGroup({ title: "Bound", botIds: [bot.id, sibling.id], leadBotId: bot.id });
  const topic = await control.createGroupTopic(group.id, "Topic", { workspace: "backend", isolation: "shared-single-writer" });
  const chatKey = "weixin:default:human"; await control.bindConversation({ chatKey, conversationId: group.id, topicId: topic.id });
  const channel = new WeixinChannel(); const registry = new MessageChannelRegistry([channel]); const daemon = new AbortController();
  const logger = { info: async () => {}, warn: async () => {}, error: async () => {}, debug: async () => {} };
  const quota = { onInbound(user: string) { inbound.push(user); }, reserveMidSegment: () => true, reserveFinal: () => true, finalRemaining: () => 4,
    hasPendingFinal: () => false, drainPendingFinalUpToBudget: () => [], prependPendingFinal() {}, enqueuePendingFinal() {}, clearPendingFinal() {} };
  let startup: Promise<void> | undefined;
  const start = async () => {
    credentials(); const before = polls;
    startup = registry.startAll({ agent: { isKnownCommand: (text: string) => text.startsWith("/"),
      chat: async (input: ChatRequest) => { ordinary.push(input); return { text: "ordinary" }; },
      clearSession: () => { clears++; } }, logger, quota, sessions, abortSignal: daemon.signal } as never,
      (id, agent) => createConversationChannelRouter(id, agent, runtime, events, daemon.signal));
    startup.catch(() => {}); await waitFor(() => polls > before);
  };
  const stop = async (reason: ChannelStopReason) => {
    if (reason === "logout") channel.logout(); else await registry.stopAll(reason);
    await startup;
  };
  const emit = (id: number, text: string, extra: Partial<WeixinMessage> = {}, buf?: string) => {
    nextBuf = buf ?? `cursor-${id}`;
    pending.push({ message_id: id, from_user_id: "human", to_user_id: "bot", context_token: `ctx-${id}`,
      create_time_ms: Date.now(), item_list: [{ type: 1, text_item: { text } }], ...extra }); wake();
  };
  const runs = () => runtime.store.listRuns(group.id, topic.id);
  const close = async () => {
    daemon.abort(); await stop("shutdown"); await runtime.shutdown();
    if (priorStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR; else process.env.OPENCLAW_STATE_DIR = priorStateDir;
    mock.restore();
  };
  return { runtime, control, group, topic, chatKey, daemon, pending, ordinary, errors, sent, start, stop, emit, runs, close, buildWeixinConversationChatKey,
    pollInputs, configCalls, inbound, sessionReads, refreshCredentials, syncPath: () => getSyncBufFilePath("default"),
    cursor: () => loadGetUpdatesBuf(getSyncBufFilePath("default")), clears: () => clears };
}

test("Weixin durable cursor waits for bound preparation in batch order while polling continues and settlement stays pending", async () => {
  const f = await fixture(); const entered = Promise.withResolvers<void>(); const resume = Promise.withResolvers<void>();
  const accept = f.runtime.bindings.accept.bind(f.runtime.bindings);
  f.runtime.bindings.accept = async (...args) => { entered.resolve(); await resume.promise; return accept(...args); };
  try {
    await f.start(); f.emit(1, "work", {}, "B"); await entered.promise;
    expect(f.cursor()).toBeUndefined(); expect(f.runs()).toHaveLength(0);
    await waitFor(() => f.pollInputs.includes("B"));
    f.emit(2, "ordinary later batch", { from_user_id: "other" }, "C");
    await waitFor(() => f.pollInputs.includes("C")); expect(f.cursor()).toBeUndefined();
    expect(f.ordinary).toHaveLength(0); expect(f.configCalls).not.toContain("other"); expect(f.inbound).not.toContain("other");
    expect(f.sessionReads).not.toContain("weixin:default:other");
    resume.resolve(); await waitFor(() => f.cursor() === "C" && f.ordinary.length === 1);
    expect(f.runs()).toHaveLength(1); const run = f.runs()[0]!;
    expect(f.runtime.store.getAcceptedRequest(f.group.id, f.topic.id, run.requestId)?.dispatch?.humanIngress?.senderId).toBe("human");
    expect(run.state).toBe("queued"); expect(f.sent.some((entry) => entry.context === "ctx-1")).toBe(false);
  } finally { resume.resolve(); await f.close(); }
});

for (const sameBatch of [false, true]) {
  test(`Weixin restart replays deferred ordinary input exactly once (${sameBatch ? "same" : "later"} batch)`, async () => {
    const f = await fixture(); const entered = Promise.withResolvers<void>(); const resume = Promise.withResolvers<void>();
    const accept = f.runtime.bindings.accept.bind(f.runtime.bindings);
    f.runtime.bindings.accept = async (...args) => { entered.resolve(); await resume.promise; return accept(...args); };
    try {
      await f.start(); f.emit(1, "work", {}, "B");
      if (!sameBatch) await entered.promise;
      f.emit(2, "ordinary work", { from_user_id: "other" }, "C");
      f.emit(3, "/help", { from_user_id: "other" }, "D");
      f.emit(4, "/clear", { from_user_id: "other" }, "E");
      await entered.promise; await waitFor(() => f.pollInputs.includes("E"));
      expect(f.cursor()).toBeUndefined();
      await f.stop("disabled"); resume.resolve();
      await waitFor(() => f.errors.includes("external_request_aborted"));
      f.runtime.bindings.accept = accept; const before = f.pollInputs.length;
      await f.start(); expect(f.pollInputs[before]).toBe("");
      f.emit(1, "work", {}, "B"); f.emit(2, "ordinary work", { from_user_id: "other" }, "C");
      f.emit(3, "/help", { from_user_id: "other" }, "D"); f.emit(4, "/clear", { from_user_id: "other" }, "E");
      await waitFor(() => f.cursor() === "E" && f.clears() > 0 && f.ordinary.length >= 2);
      expect(f.ordinary.map((input) => input.text)).toEqual(["ordinary work", "/help"]);
      expect(f.clears()).toBe(1); expect(f.runs()).toHaveLength(1);
    } finally { resume.resolve(); await f.close(); }
  });
}

test("Weixin ordinary input without a cursor waits for a later covering checkpoint", async () => {
  const f = await fixture();
  try {
    await f.start(); f.emit(1, "ordinary without cursor", { from_user_id: "other" }, "");
    await waitFor(() => f.pollInputs.length >= 2); expect(f.ordinary).toHaveLength(0); expect(f.configCalls).toHaveLength(0);
    f.emit(2, "bound work", {}, "B"); await waitFor(() => f.cursor() === "B" && f.ordinary.length === 1);
    expect(f.runs()).toHaveLength(1);
  } finally { await f.close(); }
});

test("Weixin credential refresh fences old deferred ordinary work and replays from the durable cursor", async () => {
  const f = await fixture(); const entered = Promise.withResolvers<void>(); const resume = Promise.withResolvers<void>();
  const accept = f.runtime.bindings.accept.bind(f.runtime.bindings);
  f.runtime.bindings.accept = async (...args) => { entered.resolve(); await resume.promise; return accept(...args); };
  try {
    await f.start(); f.emit(1, "bound before refresh", {}, "B"); await entered.promise;
    f.emit(2, "ordinary before refresh", { from_user_id: "other" }, "C"); await waitFor(() => f.pollInputs.includes("C"));
    expect(f.cursor()).toBeUndefined(); expect(f.ordinary).toHaveLength(0);
    const before = f.pollInputs.length; f.refreshCredentials();
    await waitFor(() => f.pollInputs.length > before); expect(f.pollInputs[before]).toBe("");
    f.emit(1, "bound before refresh", {}, "B"); f.emit(2, "ordinary before refresh", { from_user_id: "other" }, "C");
    resume.resolve(); await waitFor(() => f.cursor() === "C" && f.ordinary.length === 1);
    expect(f.runs()).toHaveLength(1); expect(f.ordinary.map((input) => input.text)).toEqual(["ordinary before refresh"]);
    expect(f.configCalls.filter((user) => user === "other")).toHaveLength(1);
  } finally { resume.resolve(); await f.close(); }
});

test("Weixin an earlier checkpoint cannot release ordinary input from a later unprepared batch", async () => {
  const f = await fixture(); const entered = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const resume = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const accept = f.runtime.bindings.accept.bind(f.runtime.bindings);
  f.runtime.bindings.accept = async (...args) => {
    const index = args[1].metadata?.channelMessageId === "1" ? 0 : 1;
    entered[index]!.resolve(); await resume[index]!.promise; return accept(...args);
  };
  try {
    await f.start(); f.emit(1, "earlier bound", {}, "B"); await entered[0]!.promise;
    f.emit(2, "ordinary in later batch", { from_user_id: "other" }, "C"); f.emit(3, "later bound", {}, "D");
    await entered[1]!.promise; resume[0]!.resolve(); await waitFor(() => f.cursor() === "B");
    expect(f.ordinary).toHaveLength(0); expect(f.configCalls).not.toContain("other");
    resume[1]!.resolve(); await waitFor(() => f.cursor() === "D" && f.ordinary.length === 1);
    expect(f.runs()).toHaveLength(2);
  } finally { for (const pending of resume) pending.resolve(); await f.close(); }
});

test("Weixin failed checkpoint never dispatches ordinary work, even after later bound admission", async () => {
  const f = await fixture();
  try {
    mkdirSync(f.syncPath());
    await f.start(); f.emit(1, "ordinary", { from_user_id: "other" }, "B");
    await waitFor(() => f.pollInputs.includes("B"));
    f.emit(2, "bound work", {}, "C"); await waitFor(() => f.runs().length === 1 && f.pollInputs.includes("C"));
    expect(f.ordinary).toHaveLength(0); expect(f.configCalls).not.toContain("other"); expect(f.inbound).not.toContain("other");
    await f.stop("disabled"); rmdirSync(f.syncPath()); await f.start();
    f.emit(1, "ordinary", { from_user_id: "other" }, "B"); f.emit(2, "bound work", {}, "C");
    await waitFor(() => f.cursor() === "C" && f.ordinary.length === 1); expect(f.runs()).toHaveLength(1);
  } finally { await f.close(); }
});

test("Weixin restart before preparation resumes the old durable cursor and replays the unaccepted message", async () => {
  const f = await fixture(); const entered = Promise.withResolvers<void>(); const resume = Promise.withResolvers<void>();
  const accept = f.runtime.bindings.accept.bind(f.runtime.bindings);
  f.runtime.bindings.accept = async (...args) => { entered.resolve(); await resume.promise; return accept(...args); };
  try {
    await f.start(); f.emit(1, "work", {}, "B"); await entered.promise;
    expect(f.cursor()).toBeUndefined(); await f.stop("disabled"); resume.resolve();
    await waitFor(() => f.errors.includes("external_request_aborted")); expect(f.runs()).toHaveLength(0);
    f.runtime.bindings.accept = accept; const before = f.pollInputs.length;
    await f.start(); expect(f.pollInputs[before]).toBe("");
    f.emit(1, "work", {}, "B"); await waitFor(() => f.cursor() === "B"); expect(f.runs()).toHaveLength(1);
  } finally { resume.resolve(); await f.close(); }
});

test("Weixin polling admits Stop while a later acceptance holds a real Bot gate, then checkpoints the stopped batch", async () => {
  const f = await fixture(); const held = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  let gate: Promise<void> | undefined; let pending = false;
  const accept = f.runtime.bindings.accept.bind(f.runtime.bindings);
  f.runtime.bindings.accept = async (...args) => { if (args[1].metadata?.channelMessageId === "2") pending = true; return accept(...args); };
  try {
    await f.start(); f.emit(1, "existing", {}, "A"); await waitFor(() => f.cursor() === "A");
    const run = f.runs()[0]!;
    gate = f.runtime.bots.runLifecycle(f.group.botIds[0]!, async () => { held.resolve(); await release.promise; }); await held.promise;
    f.emit(2, "pending", {}, "B"); await waitFor(() => pending);
    f.emit(4, "ordinary waiting", { from_user_id: "other" }, "C"); await waitFor(() => f.pollInputs.includes("C"));
    f.emit(3, "/stop", {}, "D");
    await waitFor(() => f.runtime.store.getRun(run.id)?.state === "cancelled" && f.sent.some((entry) => entry.context === "ctx-3"));
    expect(f.cursor()).toBe("A"); expect(f.runtime.store.getRun(run.id)?.completionReason).toBe("human-cancelled");
    expect(f.ordinary).toHaveLength(0);
    release.resolve(); await gate; await waitFor(() => f.cursor() === "D" && f.ordinary.length === 1); expect(f.runs()).toHaveLength(1);
  } finally { release.resolve(); await gate; await f.close(); }
});

test("Weixin Stop cursor waits for durable cancellation after receipt admission", async () => {
  const f = await fixture(); const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  const cancel = f.runtime.runs.cancelRun.bind(f.runtime.runs);
  try {
    await f.start(); f.emit(1, "existing", {}, "A"); await waitFor(() => f.cursor() === "A"); const run = f.runs()[0]!;
    f.runtime.runs.cancelRun = async (...args) => { entered.resolve(); await release.promise; return cancel(...args); };
    f.emit(2, "/stop", {}, "B"); await entered.promise;
    expect(f.cursor()).toBe("A"); expect(f.runtime.store.getRun(run.id)?.state).toBe("queued");
    release.resolve(); await waitFor(() => f.cursor() === "B");
    expect(f.runtime.store.getRun(run.id)).toMatchObject({ state: "cancelled", completionReason: "human-cancelled" });
  } finally { release.resolve(); await f.close(); }
});

test("Weixin unknown preparation failure holds later checkpoints, while deterministic media rejection can checkpoint", async () => {
  const f = await fixture(); const accept = f.runtime.bindings.accept.bind(f.runtime.bindings);
  let failed = false;
  try {
    f.runtime.bindings.accept = async () => { failed = true; throw new Error("injected unknown acceptance error"); };
    await f.start(); f.emit(1, "work", {}, "B"); await waitFor(() => failed);
    f.runtime.bindings.accept = accept; f.emit(2, "later work", {}, "C"); await waitFor(() => f.runs().length === 1);
    f.emit(4, "ordinary after unknown", { from_user_id: "other" }, "E"); await waitFor(() => f.pollInputs.includes("E"));
    expect(f.cursor()).toBeUndefined(); expect(f.ordinary).toHaveLength(0); expect(f.configCalls).not.toContain("other");
    await f.stop("disabled"); await f.start();
    f.emit(3, "media", { item_list: [{ type: 2 }] }, "D");
    await waitFor(() => f.cursor() === "D"); expect(f.errors).toContain("external_media_unsupported");
    expect(f.runs()).toHaveLength(1);
  } finally { await f.close(); }
});

test("Weixin local command replay cannot bypass a durable receipt or invoke local Session handlers", async () => {
  const f = await fixture();
  try {
    await f.start(); f.emit(1, "work"); await waitFor(() => f.runs().length === 1);
    for (const command of ["/clear", "/echo hello", "/toggle-debug", "/jx"]) {
      await f.stop("disabled"); await f.start(); const before = f.errors.length;
      f.emit(1, command); await waitFor(() => f.errors.length > before);
      expect(f.errors.at(-1)).toBe("external_request_conflict");
      expect(f.clears()).toBe(0); expect(f.ordinary).toHaveLength(0); expect(f.runs()).toHaveLength(1);
    }
    f.emit(2, "/clear"); await waitFor(() => f.clears() === 1);
  } finally { await f.close(); }
});

test("real Weixin same sender in two groups never inherits or Stops a DM Conversation; group binding fails closed", async () => {
  const f = await fixture();
  try {
    const g1 = f.buildWeixinConversationChatKey("default", "human", "G1");
    const g2 = f.buildWeixinConversationChatKey("default", "human", "G2");
    expect(g1).not.toBe(g2); expect(g1).not.toBe(f.chatKey);
    await f.control.bindConversation({ chatKey: g1, conversationId: f.group.id, topicId: f.topic.id });
    await f.start(); f.emit(1, "DM work"); await waitFor(() => f.runs().length === 1);
    const run = f.runs()[0]!;
    f.emit(2, "group work", { group_id: "G1" }); f.emit(3, "/stop", { group_id: "G1" });
    await waitFor(() => f.errors.filter((code) => code === "external_group_unsupported").length === 2);
    f.emit(4, "other group work", { group_id: "G2" }); f.emit(5, "/stop", { group_id: "G2" });
    await waitFor(() => f.ordinary.length === 2);
    expect(f.ordinary.map((input) => input.metadata?.groupId)).toEqual(["G2", "G2"]);
    expect(f.runs()).toHaveLength(1); expect(f.runtime.store.getRun(run.id)).toMatchObject({ state: "queued" });
    expect(f.runtime.store.getRun(run.id)?.completionReason).toBeUndefined();
    await f.runtime.dispatcher.kick(); await waitFor(() => f.sent.some((message) => message.context === "ctx-1"));
    expect(f.runtime.store.getRun(run.id)?.state).toBe("completed");
  } finally { await f.close(); }
});

for (const reason of ["disabled", "removed", "logout"] as const) {
  test(`real Weixin ${reason} detaches bound waiters and stops ingress without human cancellation; restart uses a fresh signal`, async () => {
    const f = await fixture();
    try {
      await f.start(); f.emit(1, "accepted work"); await waitFor(() => f.runs().length === 1);
      const run = f.runs()[0]!; await f.stop(reason);
      expect(f.daemon.signal.aborted).toBe(false);
      expect(f.runtime.store.getRun(run.id)).toMatchObject({ state: "queued" });
      expect(f.runtime.store.getRun(run.id)?.completionReason).toBeUndefined();
      f.emit(2, "after stop"); await Bun.sleep(20); expect(f.runs()).toHaveLength(1); f.pending.length = 0;
      await f.runtime.dispatcher.kick(); await Bun.sleep(5);
      expect(f.runtime.store.getRun(run.id)?.state).toBe("completed"); expect(f.sent).toHaveLength(0);
      await f.start(); f.emit(3, "after restart"); await waitFor(() => f.runs().length === 2);
      await f.runtime.dispatcher.kick(); await waitFor(() => f.sent.some((message) => message.context === "ctx-3"));
      expect(f.ordinary).toHaveLength(0);
    } finally { await f.close(); }
  });
}

test("real Weixin quoted-message replay after restart and locale switch uses the same durable Run", async () => {
  const f = await fixture(); const previous = getLocale();
  const item_list = [{ type: 1, text_item: { text: "review" }, ref_msg: { title: "thread",
    message_item: { type: 1, text_item: { text: "original" }, ref_msg: { title: "earlier" } } } }];
  try {
    setLocale("zh"); await f.start(); f.emit(1, "review", { item_list }); await waitFor(() => f.runs().length === 1);
    const run = f.runs()[0]!;
    expect(f.runtime.store.getAcceptedRequest(f.group.id, f.topic.id, run.requestId)?.message.content)
      .toBe("[Quote: thread | [Quote: earlier]\noriginal]\nreview");
    await f.stop("disabled"); setLocale("en"); await f.start(); f.emit(1, "review", { item_list });
    await f.runtime.dispatcher.kick(); await waitFor(() => f.sent.some((message) => message.context === "ctx-1"));
    expect(f.runs()).toHaveLength(1); expect(f.runs()[0]?.id).toBe(run.id); expect(f.errors).toEqual([]);
    expect(f.ordinary).toHaveLength(0);
  } finally { setLocale(previous); await f.close(); }
});
