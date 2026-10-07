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
import type { Agent } from "../../../src/weixin/agent/interface";

async function waitFor(condition: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!condition()) { if (Date.now() > deadline) throw new Error("condition timed out"); await Bun.sleep(3); }
}

test("real Weixin adapter delivers Conversation after /use B without entering held Session A lane or background hooks", async () => {
  const root = mkdtempSync(join(tmpdir(), "xacpx-weixin-binding-"));
  const priorStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = root;
  const daemon = new AbortController();
  const sent: Array<{ to: string; text: string; context: string }> = [];
  const pending: unknown[] = [];
  let wake = () => {};
  let cursor = 0;
  const emit = (id: number, text: string, attachments: unknown[] = []) => {
    pending.push({ message_id: id, from_user_id: "human", to_user_id: "bot", context_token: `ctx-${id}`,
      create_time_ms: Date.now(), item_list: [{ type: 1, text_item: { text } }, ...attachments] }); wake();
  };
  mock.module("../../../src/weixin/api/api.ts", () => ({
    getUpdates: async (input: { abortSignal?: AbortSignal }) => {
      if (!pending.length && !input.abortSignal?.aborted) await new Promise<void>((resolve) => {
        const finish = () => { input.abortSignal?.removeEventListener("abort", finish); resolve(); };
        wake = finish; input.abortSignal?.addEventListener("abort", finish, { once: true });
      });
      return { ret: 0, msgs: pending.splice(0), get_updates_buf: `cursor-${++cursor}` };
    },
    sendMessage: async (input: any) => { sent.push({ to: input.body.msg.to_user_id,
      text: input.body.msg.item_list?.[0]?.text_item?.text ?? "", context: input.body.msg.context_token }); return {}; },
    sendTyping: async () => ({}),
  }));
  mock.module("../../../src/weixin/api/config-cache.ts", () => ({
    WeixinConfigManager: class { async getForUser() { return { typingTicket: "" }; } },
  }));
  const { WeixinChannel } = await import("../../../src/channels/weixin-channel");
  const { saveWeixinAccount, registerWeixinAccountId } = await import("../../../src/weixin/auth/accounts");
  saveWeixinAccount("default", { token: "test", baseUrl: "https://example.com" }); registerWeixinAccountId("default");
  const state = createEmptyState();
  const config = { transport: { type: "acpx-cli", permissionMode: "approve-all" },
    agents: { codex: { driver: "codex" } }, workspaces: { backend: { cwd: root } } } as never;
  const stateStore = { save: async () => {}, saveNow: async () => {} };
  const stateMutex = new AsyncMutex();
  const sessions = new SessionService(config, stateStore, state, { stateMutex });
  const events = createControlEventBus();
  const control = new ControlService({ agent: { chat: async () => ({ text: "Conversation delivered" }) }, sessions,
    activeTurns: { isActiveAnywhere: () => false }, events, scheduled: {}, orchestration: {},
    workspaces: { list: () => [{ name: "backend", cwd: root }] } } as never);
  const kernel = conversationKernel(control);
  const runtime = await createConversationRuntime({ config, state, stateStore, sessions, control: kernel,
    sqlitePath: join(root, "conversations.sqlite"), releaseOwnedSession: async () => {}, stateMutex, autoKick: false,
    onProductEvent: (event) => kernel.emitConversationProduct(event) });
  kernel.bindConversationRuntime(runtime);
  const registry = new MessageChannelRegistry([new WeixinChannel()]);
  const chatKey = "weixin:default:human";
  const active: string[] = []; const background: string[] = [];
  let finishOrdinary = () => {}; let ordinaryStarted = false; let sessionReads = 0;
  let normalStops = 0;
  const peek = sessions.peekCurrentSessionAlias.bind(sessions);
  sessions.peekCurrentSessionAlias = (key) => { sessionReads++; return peek(key); };
  const saveBackground = sessions.setBackgroundResult.bind(sessions);
  sessions.setBackgroundResult = async (...args) => { background.push(args[1]); await saveBackground(...args); };
  const normalAgent: Agent = { isKnownCommand: (text) => text.startsWith("/use "), chat: async (input) => {
    if (input.text === "/use B") { await sessions.useSession(chatKey, "B"); return { text: "switched" }; }
    if (input.text === "/stop" || input.text === "/cancel") { normalStops++; return { text: "Session stopped" }; }
    expect(input.metadata?.boundSessionAlias).toBe("A"); ordinaryStarted = true;
    await new Promise<void>((resolve) => { finishOrdinary = resolve; }); return { text: "ordinary finished" };
  } };
  const logger = { info: async () => {}, warn: async () => {}, error: async () => {}, debug: async () => {} };
  const quota = { onInbound() {}, reserveMidSegment: () => true, reserveFinal: () => true,
    finalRemaining: () => 4, hasPendingFinal: () => false, drainPendingFinalUpToBudget: () => [],
    prependPendingFinal() {}, enqueuePendingFinal() {}, clearPendingFinal() {} };
  let startup: Promise<void> | undefined;
  let resumed: Awaited<ReturnType<typeof createConversationRuntime>> | undefined;
  let restarted: Promise<void> | undefined;
  let nextRegistry: MessageChannelRegistry | undefined;
  const nextDaemon = new AbortController();
  let finishRecovered = () => {};
  let releaseRecoveryGate = () => {}; let recoveryGate: Promise<void> | undefined;
  try {
    await sessions.createSession("A", "codex", "backend"); await sessions.createSession("B", "codex", "backend");
    await sessions.useSession(chatKey, "A");
    startup = registry.startAll({ agent: normalAgent, logger, quota, abortSignal: daemon.signal, sessions,
      activeTurns: { markActive: (_: string, alias: string) => active.push(alias), markInactive() {} } } as never,
      (id, agent) => createConversationChannelRouter(id, agent, runtime, events, daemon.signal));
    startup.catch(() => {});
    emit(1, "hold A"); await waitFor(() => ordinaryStarted);
    expect(active).toEqual(["A"]); active.length = 0; const readsBeforeConversation = sessionReads;
    const bot = await control.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
    const sibling = await control.createBot({ name: "Builder", agent: "codex", workspace: "backend" });
    const group = await control.createGroup({ title: "Bound", botIds: [bot.id, sibling.id], leadBotId: bot.id });
    const topic = await control.createGroupTopic(group.id, "Topic", { workspace: "backend", isolation: "shared-single-writer" });
    await control.bindConversation({ chatKey, conversationId: group.id, topicId: topic.id });
    emit(2, "work"); await waitFor(() => runtime.store.listRuns(group.id, topic.id).length === 1);
    expect(sessionReads).toBe(readsBeforeConversation); expect(active).toEqual([]); expect(background).toEqual([]);
    emit(3, "/use B"); await waitFor(() => peek(chatKey) === "B");
    await runtime.dispatcher.kick(); await waitFor(() => sent.some((message) => message.text.includes("Conversation delivered")));
    expect(background).toEqual([]); expect(active).toEqual([]);
    const replies = sent.filter((message) => message.text.includes("Conversation delivered"));
    expect(replies).toEqual([{ to: "human", text: "Reviewer:\nConversation delivered", context: "ctx-2" }]);
    // Stop reaches the selected Run, even after switching the normal Session.
    emit(4, "stop this Run"); await waitFor(() => runtime.store.listRuns(group.id, topic.id).length === 2);
    const stopped = runtime.store.listRuns(group.id, topic.id).find((run) => run.state === "queued")!;
    emit(5, "/stop"); await waitFor(() => runtime.store.getRun(stopped.id)?.state === "cancelled");
    await waitFor(() => sent.some((message) => message.context === "ctx-5"));
    expect(normalStops).toBe(0); expect(background).toEqual([]); expect(active).toEqual([]);
    expect(runtime.store.getRun(stopped.id)?.completionReason).toBe("human-cancelled");
    expect(sent.some((message) => message.context === "ctx-4")).toBe(false);
    // A Stop during a real lifecycle-gate wait creates no third Run.
    let unlock = () => {}; let gateEntered = false;
    const held = runtime.bots.runLifecycle(bot.id, async () => {
      gateEntered = true; await new Promise<void>((resolve) => { unlock = resolve; });
    });
    try {
      await waitFor(() => gateEntered); emit(6, "pending acceptance");
      await waitFor(() => (runtime.bindings as any).gates.get(chatKey)?.users === 1);
      emit(7, "/cancel"); await waitFor(() => sent.some((message) => message.context === "ctx-7"));
    } finally { unlock(); await held; }
    await waitFor(() => (runtime.bindings as any).gates.size === 0);
    expect(runtime.store.listRuns(group.id, topic.id)).toHaveLength(2);
    expect(normalStops).toBe(0); expect(sent.some((message) => message.context === "ctx-6")).toBe(false);
    // Unknown slash text remains bound; only recognized commands bypass routing.
    emit(8, "/unknown-command"); await waitFor(() => runtime.store.listRuns(group.id, topic.id).length === 3);
    const resumable = runtime.store.listRuns(group.id, topic.id).find((run) => run.state === "queued")!;
    let mediaRejections = 0;
    const accept = runtime.bindings.accept.bind(runtime.bindings);
    runtime.bindings.accept = async (...args) => {
      try { return await accept(...args); }
      catch (error) { if ((error as { code?: string }).code === "external_media_unsupported") mediaRejections++; throw error; }
    };
    // Raw attachments are rejected even without usable CDN keys, or on Stop.
    for (const [index, attachment] of [{ type: 2, image_item: {} }, { type: 4, file_item: { file_name: "missing" } },
      { type: 2, image_item: { aeskey: "bad", media: { encrypt_query_param: "missing" } } }].entries()) {
      emit(20 + index, "work with attachment", [attachment]);
      await waitFor(() => mediaRejections === index + 1);
    }
    emit(23, "/stop", [{ type: 2, image_item: {} }]); await Bun.sleep(20);
    expect(runtime.store.getRun(resumable.id)?.state).toBe("queued");
    expect(runtime.store.listRuns(group.id, topic.id)).toHaveLength(3);
    daemon.abort(); await startup; await Bun.sleep(5);
    expect(runtime.store.getRun(resumable.id)).toMatchObject({ state: "queued" });
    expect(runtime.store.getRun(resumable.id)?.completionReason).toBeUndefined();
    expect(sent.some((message) => message.context === "ctx-8")).toBe(false);
    finishOrdinary(); await waitFor(() => background.length === 1); expect(background).toEqual(["A"]);
    await registry.stopAll(); await runtime.shutdown();
    let recoveredStarted = false;
    const nextEvents = createControlEventBus();
    const nextControl = new ControlService({ agent: { chat: async (input: any) => {
      recoveredStarted = true;
      await new Promise<void>((resolve) => { finishRecovered = resolve;
        input.abortSignal.addEventListener("abort", resolve, { once: true }); });
      if (input.abortSignal.aborted) throw new Error("provider cancelled");
      return { text: "recovered" };
    } }, sessions, activeTurns: { isActiveAnywhere: () => false }, events: nextEvents, scheduled: {}, orchestration: {},
      workspaces: { list: () => [{ name: "backend", cwd: root }] } } as never);
    const nextKernel = conversationKernel(nextControl);
    resumed = await createConversationRuntime({ config, state, stateStore, sessions, control: nextKernel,
      sqlitePath: join(root, "conversations.sqlite"), releaseOwnedSession: async () => {}, stateMutex, autoKick: false,
      onProductEvent: (event) => nextKernel.emitConversationProduct(event) });
    nextKernel.bindConversationRuntime(resumed);
    const activation = resumed.activateAfterConsumerLock(); await waitFor(() => recoveredStarted);
    nextRegistry = new MessageChannelRegistry([new WeixinChannel()]);
    const normal: Agent = { isKnownCommand: (text) => text.startsWith("/"), chat: async () => { normalStops++; return { text: "Session stopped" }; } };
    const restored = resumed;
    restarted = nextRegistry.startAll({ agent: normal, logger, quota, abortSignal: nextDaemon.signal } as never,
      (id, agent) => createConversationChannelRouter(id, agent, restored, nextEvents, nextDaemon.signal));
    restarted.catch(() => {});
    let recoveryGateEntered = false;
    recoveryGate = restored.bots.runLifecycle(bot.id, async () => {
      recoveryGateEntered = true; await new Promise<void>((resolve) => { releaseRecoveryGate = resolve; });
    });
    await waitFor(() => recoveryGateEntered);
    let pendingHumanSignal: AbortSignal | undefined;
    const restoredAccept = restored.bindings.accept.bind(restored.bindings);
    restored.bindings.accept = (...args) => {
      if (args[1].metadata?.channelMessageId === "31") pendingHumanSignal = args[1].humanStopSignal;
      return restoredAccept(...args);
    };
    emit(31, "acceptance while recovering");
    await waitFor(() => (restored.bindings as any).gates.get(chatKey)?.users === 1);
    const previousReplies = sent.filter((message) => message.context === "ctx-5" || message.context === "ctx-7").length;
    emit(5, "/stop"); emit(7, "/cancel");
    await waitFor(() => sent.filter((message) => message.context === "ctx-5" || message.context === "ctx-7").length === previousReplies + 2);
    expect(restored.store.getRun(resumable.id)?.state).toBe("running");
    expect(pendingHumanSignal!.aborted).toBe(false);
    emit(30, "/stop");
    await waitFor(() => restored.store.getRun(resumable.id)?.state === "cancelled" && sent.some((message) => message.context === "ctx-30"));
    expect((restored.bindings as any).gates.get(chatKey)?.users).toBe(1);
    expect(pendingHumanSignal!.aborted).toBe(true);
    await activation; releaseRecoveryGate(); await recoveryGate;
    await waitFor(() => (restored.bindings as any).gates.size === 0);
    expect(restored.store.getRun(resumable.id)?.completionReason).toBe("human-cancelled");
    expect(restored.store.listRuns(group.id, topic.id)).toHaveLength(3); expect(normalStops).toBe(0);
    expect(sent.some((message) => message.context === "ctx-31")).toBe(false);
  } finally {
    releaseRecoveryGate(); await recoveryGate; finishOrdinary(); finishRecovered(); daemon.abort(); nextDaemon.abort(); await startup; await restarted;
    await registry.stopAll(); await nextRegistry?.stopAll(); await runtime.shutdown(); await resumed?.shutdown();
    if (priorStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR; else process.env.OPENCLAW_STATE_DIR = priorStateDir;
    mock.restore();
  }
});
