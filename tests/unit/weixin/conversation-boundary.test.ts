import { expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
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
  const sent: Array<{ context: string; text: string }> = [];
  const ordinary: ChatRequest[] = []; const errors: string[] = [];
  mock.module("../../../src/weixin/api/api.ts", () => ({
    getUpdates: async (input: { abortSignal?: AbortSignal }) => {
      polls++;
      if (!pending.length && !input.abortSignal?.aborted) await new Promise<void>((resolve) => {
        const finish = () => { input.abortSignal?.removeEventListener("abort", finish); resolve(); };
        wake = finish; input.abortSignal?.addEventListener("abort", finish, { once: true });
      });
      return { ret: 0, msgs: pending.splice(0), get_updates_buf: "" };
    },
    sendMessage: async (input: any) => { sent.push({ context: input.body.msg.context_token,
      text: input.body.msg.item_list?.[0]?.text_item?.text ?? "" }); return {}; },
    sendTyping: async () => ({}),
  }));
  mock.module("../../../src/weixin/api/config-cache.ts", () => ({
    WeixinConfigManager: class { async getForUser() { return { typingTicket: "" }; } },
  }));
  const { WeixinChannel } = await import("../../../src/channels/weixin-channel");
  const { buildWeixinConversationChatKey } = await import("../../../src/weixin/messaging/handle-weixin-message-turn");
  const { saveWeixinAccount, registerWeixinAccountId } = await import("../../../src/weixin/auth/accounts");
  const credentials = () => { saveWeixinAccount("default", { token: "test", baseUrl: "https://example.com" }); registerWeixinAccountId("default"); };
  credentials();
  const state = createEmptyState(); const stateStore = { save: async () => {}, saveNow: async () => {} }; const stateMutex = new AsyncMutex();
  const config = { transport: { type: "acpx-cli", permissionMode: "approve-all" },
    agents: { codex: { driver: "codex" } }, workspaces: { backend: { cwd: root } } } as never;
  const sessions = new SessionService(config, stateStore, state, { stateMutex }); const events = createControlEventBus();
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
  const quota = { onInbound() {}, reserveMidSegment: () => true, reserveFinal: () => true, finalRemaining: () => 4,
    hasPendingFinal: () => false, drainPendingFinalUpToBudget: () => [], prependPendingFinal() {}, enqueuePendingFinal() {}, clearPendingFinal() {} };
  let startup: Promise<void> | undefined;
  const start = async () => {
    credentials(); const before = polls;
    startup = registry.startAll({ agent: { isKnownCommand: (text: string) => text.startsWith("/"),
      chat: async (input: ChatRequest) => { ordinary.push(input); return { text: "ordinary" }; } }, logger, quota, abortSignal: daemon.signal } as never,
      (id, agent) => createConversationChannelRouter(id, agent, runtime, events, daemon.signal));
    startup.catch(() => {}); await waitFor(() => polls > before);
  };
  const stop = async (reason: ChannelStopReason) => {
    if (reason === "logout") channel.logout(); else await registry.stopAll(reason);
    await startup;
  };
  const emit = (id: number, text: string, extra: Partial<WeixinMessage> = {}) => {
    pending.push({ message_id: id, from_user_id: "human", to_user_id: "bot", context_token: `ctx-${id}`,
      create_time_ms: Date.now(), item_list: [{ type: 1, text_item: { text } }], ...extra }); wake();
  };
  const runs = () => runtime.store.listRuns(group.id, topic.id);
  const close = async () => {
    daemon.abort(); await stop("shutdown"); await runtime.shutdown();
    if (priorStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR; else process.env.OPENCLAW_STATE_DIR = priorStateDir;
    mock.restore();
  };
  return { runtime, control, group, topic, chatKey, daemon, pending, ordinary, errors, sent, start, stop, emit, runs, close, buildWeixinConversationChatKey };
}

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
