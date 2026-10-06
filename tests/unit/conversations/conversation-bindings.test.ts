import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { snapshotBotProfile } from "../../../src/bots/bot-types";
import { ControlService, conversationKernel } from "../../../src/control/control-service";
import { createControlEventBus } from "../../../src/control/control-event-bus";
import { createConversationRuntime } from "../../../src/conversations/conversation-composition";
import { createConversationChannelAgent } from "../../../src/channels/conversation-channel-agent";
import { MessageChannelRegistry } from "../../../src/channels/channel-registry";
import { SqliteConversationStore } from "../../../src/conversations/sqlite-conversation-store";
import { createSqlDriver } from "../../../src/conversations/sql-driver";
import { createDirectConversationId } from "../../../src/domain/ids";
import { AsyncMutex } from "../../../src/orchestration/async-mutex";
import { SessionService } from "../../../src/sessions/session-service";
import { createEmptyState, type AppState } from "../../../src/state/types";
import type { Agent, ChatRequest } from "../../../src/weixin/agent/interface";
import { DiscordChannel } from "../../../packages/channel-discord/src/channel";
import { FeishuChannel } from "../../../packages/channel-feishu/src/channel";
import { MSG, parseControlPayload } from "@ganglion/xacpx-relay-protocol";

async function compose(options: { state?: AppState; path?: string; agent?: Agent } = {}) {
  const state = options.state ?? createEmptyState();
  const path = options.path ?? join(mkdtempSync(join(tmpdir(), "xacpx-bindings-")), "conversations.sqlite");
  const config = { transport: { type: "acpx-cli", permissionMode: "approve-all" },
    agents: { codex: { driver: "codex" } }, workspaces: { backend: { cwd: tmpdir() } } } as never;
  const stateStore = { save: async () => {}, saveNow: async () => {} };
  const stateMutex = new AsyncMutex();
  const sessions = new SessionService(config, stateStore, state, { stateMutex });
  const events = createControlEventBus();
  const control = new ControlService({ agent: options.agent ?? { chat: async () => ({ text: "provider result" }) },
    sessions, activeTurns: { isActiveAnywhere: () => false }, events, scheduled: {}, orchestration: {},
    workspaces: { list: () => [{ name: "backend", cwd: tmpdir() }] } } as never);
  const kernel = conversationKernel(control);
  const runtime = await createConversationRuntime({ config, state, stateStore, sessions, control: kernel,
    sqlitePath: path, releaseOwnedSession: async () => {}, stateMutex, autoKick: false,
    onProductEvent: (event) => kernel.emitConversationProduct(event) });
  kernel.bindConversationRuntime(runtime);
  const daemon = new AbortController();
  let delegated = 0;
  const normalAgent = { chat: async () => { delegated++; return { text: "ordinary" }; }, isKnownCommand: (text: string) => text === "/help" };
  const agent = createConversationChannelAgent("discord", normalAgent, runtime, events, daemon.signal);
  const close = async () => { daemon.abort(); await runtime.shutdown(); };
  return { state, path, control, runtime, events, daemon, agent, close, normalAgent, delegated: () => delegated };
}

function request(text = "work", messageId = "m1", chatKey = "discord:default:g:channel"): ChatRequest {
  return { accountId: "default", conversationId: chatKey, text, metadata: { channel: "discord",
    channelMessageId: messageId, origin: "human", authenticatedHuman: true, senderId: "human", chatType: "group" } };
}

async function group(current: Awaited<ReturnType<typeof compose>>, names = ["Reviewer", "Builder"]) {
  const bots = await Promise.all(names.map((name) => current.control.createBot({ name, agent: "codex", workspace: "backend" })));
  const group = await current.control.createGroup({ title: "Bound", botIds: bots.map((bot) => bot.id), leadBotId: bots[0]!.id });
  const topic = await current.control.createGroupTopic(group.id, "Topic", { workspace: "backend", isolation: "shared-single-writer" });
  await current.control.bindConversation({ chatKey: request().conversationId, conversationId: group.id, topicId: topic.id });
  return { group, topic, bots };
}

async function waitFor(condition: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!condition()) { if (Date.now() > deadline) throw new Error("condition timed out"); await Bun.sleep(3); }
}

test("bound human input reaches existing provider chain, returns exact public results and stamps ingress", async () => {
  const physical: ChatRequest[] = [];
  const current = await compose({ agent: { chat: async (input) => { physical.push(input); return { text: "reviewed" }; } } });
  try {
    const { topic, group: g, bots } = await group(current);
    const response = current.agent.chat(request("@Builder implement"));
    await waitFor(() => current.runtime.store.listRuns(g.id, topic.id).length === 1);
    const run = current.runtime.store.listRuns(g.id, topic.id)[0]!;
    const member = current.runtime.store.listMemberTurns(run.id)[0]!;
    expect(member.botId).toBe(bots[1]!.id);
    const dispatch = current.runtime.store.getAcceptedRequest(g.id, topic.id, run.requestId)!.dispatch!;
    expect(dispatch.humanIngress).toMatchObject({ chatKey: request().conversationId, senderId: "human", accountId: "default", chatType: "group" });
    expect(dispatch.authorityEpoch).toBe(current.runtime.authorityEpoch);
    await current.runtime.dispatcher.kick();
    expect((await response).text).toBe("Builder:\nreviewed");
    expect(physical).toHaveLength(1);
    expect(physical[0]!.metadata!.origin).toBe("human");
    expect(current.delegated()).toBe(0);
  } finally { await current.close(); }
});

test("binding and receipt survive restart, retries replay after rebind without renewed authority", async () => {
  const first = await compose();
  const { group: g, topic } = await group(first);
  const accepted = await first.runtime.withOperation(() => first.runtime.bindings.accept("discord", request()));
  expect(accepted).toBeDefined();
  await first.close();
  const second = await compose({ state: first.state, path: first.path });
  try {
    expect(second.control.listConversationBindings()).toHaveLength(1);
    const other = await second.control.createGroupTopic(g.id, "Other", { workspace: "backend", isolation: "shared-single-writer" });
    await second.control.bindConversation({ chatKey: request().conversationId, conversationId: g.id, topicId: other.id });
    const replay = await second.runtime.bindings.accept("discord", request());
    expect(replay?.reused).toBe(true);
    expect(replay?.run.id).toBe(accepted?.run.id);
    expect(replay?.run.topicId).toBe(topic.id);
    expect(replay?.dispatch?.authorityEpoch).toBe(first.runtime.authorityEpoch);
    expect(replay?.dispatch?.authorityEpoch).not.toBe(second.runtime.authorityEpoch);
    await expect(second.runtime.bindings.accept("discord", request("changed"))).rejects.toMatchObject({ code: "external_request_conflict" });
    await second.control.unbindConversation(request().conversationId);
    expect((await second.runtime.bindings.accept("discord", request()))?.run.id).toBe(accepted?.run.id);
  } finally { await second.close(); }
});

test("thread bindings do not inherit parent or cross Topic boundaries", async () => {
  const current = await compose();
  try {
    const { group: g, topic } = await group(current);
    const other = await current.control.createGroupTopic(g.id, "Thread", { workspace: "backend", isolation: "shared-single-writer" });
    const thread = "discord:default:t:thread";
    await current.control.bindConversation({ chatKey: thread, conversationId: g.id, topicId: other.id });
    const a = await current.runtime.bindings.accept("discord", request("parent"));
    const b = await current.runtime.bindings.accept("discord", request("thread", "m1", thread));
    expect(a?.run.topicId).toBe(topic.id); expect(b?.run.topicId).toBe(other.id);
    expect(a?.run.id).not.toBe(b?.run.id);
    expect(await current.runtime.bindings.accept("discord", request("unbound", "m1", "discord:default:t:unbound"))).toBeUndefined();
  } finally { await current.close(); }
});

test("exact current member addressing fails closed on ambiguity, removed/unknown names and malformed targets", async () => {
  const current = await compose();
  try {
    const { group: g, topic, bots } = await group(current, ["Same", "Same", "Name with spaces"]);
    for (const text of ["@Same work", "@Unknown work", "@{broken work"]) {
      await expect(current.agent.chat(request(text))).rejects.toBeDefined();
    }
    const outsider = await current.control.createBot({ name: "Outsider", agent: "codex", workspace: "backend" });
    await expect(current.agent.chat(request("@Outsider work"))).rejects.toMatchObject({ code: "external_target_ambiguous" });
    const invalid = request(); invalid.metadata!.conversationTarget = { botId: outsider.id };
    await expect(current.agent.chat(invalid)).rejects.toBeDefined();
    expect(current.runtime.store.listRuns(g.id, topic.id)).toHaveLength(0);
    const a = await current.runtime.bindings.accept("discord", request("@{Name with spaces} work"));
    expect(a?.memberTurn?.botId).toBe(bots[2]!.id);
    const everyone = request("all", "m2"); everyone.metadata!.conversationTarget = { mode: "everyone" };
    expect((await current.runtime.bindings.accept("discord", everyone))?.memberTurns).toHaveLength(3);
  } finally { await current.close(); }
});

test("missing, bot and generated provenance never parse targets or fall through a bound chat", async () => {
  const current = await compose();
  try {
    const { group: g, topic } = await group(current);
    for (const patch of [{ origin: undefined }, { origin: "peer" }, { authenticatedHuman: false },
      { authenticatedHuman: undefined }, { senderId: undefined }, { channelMessageId: undefined }, { channel: "feishu" }]) {
      const input = request("@Reviewer work"); Object.assign(input.metadata!, patch);
      await expect(current.agent.chat(input)).rejects.toBeDefined();
    }
    expect(current.runtime.store.listRuns(g.id, topic.id)).toHaveLength(0);
    expect(current.delegated()).toBe(0);
    expect(await current.agent.chat(request("/help"))).toEqual({ text: "ordinary" });
    const scheduled = request(); scheduled.metadata!.origin = "scheduled";
    expect(await current.agent.chat(scheduled)).toEqual({ text: "ordinary" });
  } finally { await current.close(); }
});

test("Direct default Topic, concurrent duplicate, archived Topic and teardown receipt tombstone", async () => {
  const current = await compose();
  try {
    const bot = await current.control.createBot({ name: "Direct", agent: "codex", workspace: "backend" });
    const binding = await current.control.bindConversation({ chatKey: request().conversationId, conversationId: createDirectConversationId(bot.id) });
    expect(binding.topicId).toBeDefined();
    const duplicates = await Promise.all([current.runtime.bindings.accept("discord", request()), current.runtime.bindings.accept("discord", request())]);
    expect(duplicates[0]?.run.id).toBe(duplicates[1]?.run.id);
    expect(duplicates[1]?.reused).toBe(true);
    const { group: g, topic } = await group(current);
    await current.control.archiveGroupTopic(g.id, topic.id);
    await expect(current.agent.chat(request("work", "m2"))).rejects.toMatchObject({ code: "binding_topic_invalid" });
    await current.control.teardownGroupTopic(g.id, topic.id);
    expect(current.control.listConversationBindings()).toHaveLength(0);
    current.runtime.store.deleteTopicRows(binding.conversationId, binding.topicId);
    await expect(current.runtime.bindings.accept("discord", request())).rejects.toMatchObject({ code: "external_request_retired" });
  } finally { await current.close(); }
});

test("Stop cancels the accepted Run and shutdown can finish while the channel awaits a queued Run", async () => {
  const current = await compose();
  try {
    const { group: g, topic } = await group(current);
    const abort = new AbortController();
    const input = request(); input.abortSignal = abort.signal;
    const waiting = current.agent.chat(input);
    await waitFor(() => current.runtime.store.listRuns(g.id, topic.id).length === 1);
    abort.abort();
    expect(await waiting).toMatchObject({ silent: true });
    expect(current.runtime.store.listRuns(g.id, topic.id)[0]!.state).toBe("cancelled");
    const pending = current.agent.chat(request("shutdown", "m2"));
    // Observe rejection before initiating shutdown to avoid unhandled rejection.
    const stopped = pending.then(() => undefined, (error) => error);
    await waitFor(() => current.runtime.store.listRuns(g.id, topic.id).length === 2);
    await current.close(); expect(await stopped).toMatchObject({ code: "runtime_closed" });
  } finally { await current.close(); }
});

test("binding management rejects product keys, invalid Group Topic and corrupted persisted binding", async () => {
  const current = await compose();
  try {
    const { group: g, topic } = await group(current);
    await expect(current.control.bindConversation({ chatKey: "bot:forged", conversationId: g.id, topicId: topic.id })).rejects.toMatchObject({ code: "binding_invalid" });
    await expect(current.control.bindConversation({ chatKey: request().conversationId, conversationId: g.id })).rejects.toMatchObject({ code: "binding_topic_invalid" });
    const sql = await createSqlDriver(current.path);
    sql.run("UPDATE conversation_bindings SET topic_id = ''"); sql.close();
    await expect(current.agent.chat(request())).rejects.toMatchObject({ code: "binding_corrupt" });
    expect(current.delegated()).toBe(0);
  } finally { await current.close(); }
});

test("binding RPC validators bound input and strip attempted authority", () => {
  expect(parseControlPayload(MSG.conversationBindingsSet, { chatKey: "discord:default:g:channel", conversationId: "g", topicId: "t", humanIngress: { senderId: "forged" } }))
    .toEqual({ chatKey: "discord:default:g:channel", conversationId: "g", topicId: "t" });
  expect(parseControlPayload(MSG.conversationBindingsSet, { chatKey: "x".repeat(2049), conversationId: "g" })).toBeNull();
  expect(parseControlPayload(MSG.conversationBindingsDelete, { chatKey: 123 })).toBeNull();
});

test("platform receipt and Run rollback together, then survive a successful retry and reopen", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "xacpx-receipt-")), "conversations.sqlite");
  let fail = true;
  const store = await SqliteConversationStore.open(path, { beforeAcceptCommit: () => { if (fail) throw new Error("disk failure"); } });
  const key = "a".repeat(64), fingerprint = "b".repeat(64), now = new Date().toISOString();
  const profileSnapshot = snapshotBotProfile({ id: "bot", name: "Bot", agent: "codex", workspace: "backend",
    enabled: true, profileRevision: 1, createdAt: now, updatedAt: now }, now);
  const input = { conversationId: "c", topicId: "t", requestId: `external:${key}`, botId: "bot", content: "work",
    now, profileSnapshot, externalRequest: { key, fingerprint } };
  try {
    expect(() => store.acceptRequest(input)).toThrow("disk failure");
    expect(store.getExternalRequest(input.externalRequest)).toBeUndefined();
    expect(store.listRuns("c", "t")).toHaveLength(0);
    fail = false;
    const accepted = store.acceptRequest(input);
    expect(store.getExternalRequest(input.externalRequest)?.run.id).toBe(accepted.run.id);
    expect(store.acceptRequest(input).reused).toBe(true);
    store.close();
    const reopened = await SqliteConversationStore.open(path);
    try { expect(reopened.getExternalRequest(input.externalRequest)?.run.id).toBe(accepted.run.id); }
    finally { reopened.close(); }
  } finally { store.close(); }
});

test("corrupt receipt cannot join a different valid Run; public request-id collision cannot mint a receipt", async () => {
  const current = await compose();
  try {
    const { group: g, topic } = await group(current);
    const a = await current.runtime.bindings.accept("discord", request());
    const b = await current.control.promptConversation({ conversationId: g.id, topicId: topic.id, requestId: "foreign", text: "foreign", target: { mode: "everyone" } });
    const sql = await createSqlDriver(current.path);
    sql.run("UPDATE external_conversation_requests SET run_id = ?", [b.run.id]); sql.close();
    await expect(current.runtime.bindings.accept("discord", request())).rejects.toMatchObject({ code: "external_request_corrupt" });
    const key = createHash("sha256").update(JSON.stringify(["discord", "default", request().conversationId, "collision"])).digest("hex");
    await current.control.promptConversation({ conversationId: g.id, topicId: topic.id, requestId: `external:${key}`, text: "preexisting", target: { mode: "everyone" } });
    await expect(current.runtime.bindings.accept("discord", request("work", "collision"))).rejects.toMatchObject({ code: "external_request_conflict" });
    expect(a?.run.id).not.toBe(b.run.id);
  } finally { await current.close(); }
});

test("Stop while acceptance waits for a real Bot gate creates no Run", async () => {
  const current = await compose();
  let release = () => {};
  try {
    const { group: g, topic, bots } = await group(current);
    let entered = false;
    const gate = current.runtime.bots.runLifecycle(bots[0]!.id, async () => { entered = true; await new Promise<void>((resolve) => { release = resolve; }); });
    await waitFor(() => entered);
    const abort = new AbortController(); const input = request(); input.abortSignal = abort.signal;
    const outcome = current.agent.chat(input).catch((error) => error);
    await Bun.sleep(5); abort.abort(); release(); await gate;
    expect(await outcome).toMatchObject({ code: "external_request_aborted" });
    expect(current.runtime.store.listRuns(g.id, topic.id)).toHaveLength(0);
  } finally { release(); await current.close(); }
});

test("human Stop from accepted projection fences provider admission before channel response listener is installed", async () => {
  let starts = 0;
  const current = await compose({ agent: { chat: async () => { starts++; return { text: "wrong" }; } } });
  const abort = new AbortController();
  const unsubscribe = current.events.subscribe((event) => {
    if (event.type === "conversation-message" && event.message.role === "human") abort.abort();
  });
  try {
    const { group: g, topic } = await group(current);
    const input = request(); input.abortSignal = abort.signal;
    expect(await current.agent.chat(input)).toMatchObject({ silent: true });
    expect(starts).toBe(0);
    expect(current.runtime.store.listRuns(g.id, topic.id)[0]?.state).toBe("cancelled");
  } finally { unsubscribe(); await current.close(); }
});

test("unused Direct binding keeps Bot deletion closed until unbind, with no runtime materialization", async () => {
  const current = await compose();
  try {
    const bot = await current.control.createBot({ name: "Bound", agent: "codex", workspace: "backend" });
    await current.control.bindConversation({ chatKey: request().conversationId, conversationId: createDirectConversationId(bot.id) });
    expect(current.runtime.bots.hasRuntime(bot.id)).toBe(false);
    await expect(current.control.deleteBot(bot.id)).rejects.toMatchObject({ code: "bot_in_use" });
    await current.control.unbindConversation(request().conversationId);
    await current.control.deleteBot(bot.id);
    expect(current.control.listBots()).toHaveLength(0);
  } finally { await current.close(); }
});

test("daemon-triggered channel abort does not mint human Stop provenance on a resumable queued Run", async () => {
  const current = await compose();
  try {
    const { group: g, topic } = await group(current);
    const abort = new AbortController();
    current.daemon.signal.addEventListener("abort", () => abort.abort(), { once: true });
    const input = request(); input.abortSignal = abort.signal;
    const response = current.agent.chat(input).catch((error) => error);
    await waitFor(() => current.runtime.store.listRuns(g.id, topic.id).length === 1);
    const runId = current.runtime.store.listRuns(g.id, topic.id)[0]!.id;
    await current.close(); expect(await response).toMatchObject({ code: "runtime_closed" });
    const reopened = await SqliteConversationStore.open(current.path);
    try {
      expect(reopened.getRun(runId)?.state).toBe("queued");
      expect(reopened.getRun(runId)?.completionReason).toBeUndefined();
    }
    finally { reopened.close(); }
  } finally { await current.close(); }
});

test("Direct binding revalidates after a queued Bot deletion through the shared lifecycle gate", async () => {
  const current = await compose(); let release = () => {};
  try {
    const bot = await current.control.createBot({ name: "Deleting", agent: "codex", workspace: "backend" });
    let entered = false;
    const held = current.runtime.bots.runLifecycle(bot.id, async () => { entered = true; await new Promise<void>((resolve) => { release = resolve; }); });
    await waitFor(() => entered);
    const deleted = current.control.deleteBot(bot.id);
    const bound = current.control.bindConversation({ chatKey: request().conversationId, conversationId: createDirectConversationId(bot.id) })
      .then(() => undefined, (error) => error);
    await Bun.sleep(5); release(); await held; await deleted;
    expect(await bound).toBeDefined();
    expect(current.control.listConversationBindings()).toHaveLength(0);
  } finally { release(); await current.close(); }
});

const logger = { info: async () => {}, warn: async () => {}, error: async () => {}, debug: async () => {} };
const quota = { onInbound() {}, reserveMidSegment: () => true, reserveFinal: () => true,
  finalRemaining: () => 4, hasPendingFinal: () => false, drainPendingFinalUpToBudget: () => [],
  prependPendingFinal() {}, enqueuePendingFinal() {}, clearPendingFinal() {} };

test("actual Discord admission precedes binding lookup; admitted human DM reaches provider, allowed bot does not", async () => {
  const current = await compose();
  let onMessage: ((message: unknown) => void) | undefined;
  const sent: string[] = [];
  const client = { start: async (input: { handlers: { onMessage: (message: unknown) => void } }) => {
    onMessage = input.handlers.onMessage; return { botUserId: "bot", botTag: "Bot" };
  }, probeBot: async () => ({ botUserId: "bot" }), sendMessage: async (_: unknown, body: { content?: string }) => {
    sent.push(body.content ?? ""); return { messageId: `s${sent.length}` };
  }, editMessage: async () => {}, deleteMessage: async () => {}, startTyping: async () => () => {},
  addReaction: async () => {}, destroy: async () => {} };
  const channel = new DiscordChannel({ token: "x", dmPolicy: "allowlist", allowFrom: ["human"],
    guildPolicy: "disabled", allowBots: true, requireMention: false, typingIndicator: false, enableAutocomplete: false },
    { logger: logger as never, createClient: () => client as never, identifyStaggerMs: 0 });
  const registry = new MessageChannelRegistry([channel]);
  let startup: Promise<void> | undefined;
  let lookups = 0;
  const accept = current.runtime.bindings.accept.bind(current.runtime.bindings);
  current.runtime.bindings.accept = (...args) => { lookups++; return accept(...args); };
  try {
    const { group: g, topic } = await group(current);
    await current.control.bindConversation({ chatKey: "discord:default:dm:dm", conversationId: g.id, topicId: topic.id });
    startup = registry.startAll({ agent: current.normalAgent, logger, quota, abortSignal: current.daemon.signal } as never,
      (id, agent) => createConversationChannelAgent(id, agent, current.runtime, current.events, current.daemon.signal));
    startup.catch(() => {});
    await waitFor(() => Boolean(onMessage)); await Bun.sleep(5);
    expect(onMessage).toBeDefined();
    const emit = (id: string, senderId: string, bot: boolean) => onMessage!({ id, channelId: "dm", guildId: null,
      author: { id: senderId, bot }, content: "work", createdTimestamp: Date.now() });
    emit("denied", "stranger", false); await Bun.sleep(25);
    expect(lookups).toBe(0); expect(current.runtime.store.listRuns(g.id, topic.id)).toHaveLength(0);
    emit("human-message", "human", false);
    await waitFor(() => current.runtime.store.listRuns(g.id, topic.id).length === 1);
    await current.runtime.dispatcher.kick(); await waitFor(() => sent.some((text) => text.includes("provider result")));
    expect(lookups).toBe(1); expect(current.delegated()).toBe(0);
    emit("bot-message", "human", true); await waitFor(() => lookups === 2); await Bun.sleep(25);
    expect(current.runtime.store.listRuns(g.id, topic.id)).toHaveLength(1);
    expect(current.delegated()).toBe(0);
  } finally { await current.close(); await registry.stopAll(); await startup; }
});

test("actual Feishu admission and explicit sender type fence bound thread human provenance", async () => {
  const current = await compose();
  let handlers: Record<string, (event: unknown) => Promise<void> | void> = {};
  const sent: unknown[] = [];
  const channel = new FeishuChannel({ appId: "app", appSecret: "secret", domain: "feishu", requireMention: false,
    dmPolicy: "allowlist", allowFrom: ["human"], groupPolicy: "open", textMessageFormat: "text", replyMode: "static" }, {
    createClient: () => ({ sdk: { im: { message: {
      reply: async (body: unknown) => { sent.push(body); return { data: { message_id: "reply", chat_id: "chat" } }; },
      create: async (body: unknown) => { sent.push(body); return { data: { message_id: "reply", chat_id: "chat" } }; },
    } } }, probeBot: async () => ({ botOpenId: "bot" }),
    startWS: async (input: { handlers: typeof handlers }) => { handlers = input.handlers; }, stop: () => {} }) as never,
  });
  const registry = new MessageChannelRegistry([channel]);
  let lookups = 0;
  const accept = current.runtime.bindings.accept.bind(current.runtime.bindings);
  current.runtime.bindings.accept = (...args) => { lookups++; return accept(...args); };
  try {
    const { group: g, topic } = await group(current);
    await current.control.bindConversation({ chatKey: "feishu:default:chat:thread:thread", conversationId: g.id, topicId: topic.id });
    await registry.startAll({ agent: current.normalAgent, logger, quota, abortSignal: current.daemon.signal } as never,
      (id, agent) => createConversationChannelAgent(id, agent, current.runtime, current.events, current.daemon.signal));
    const emit = (id: string, senderId: string, senderType?: string) => handlers["im.message.receive_v1"]!({
      sender: { sender_id: { open_id: senderId }, ...(senderType ? { sender_type: senderType } : {}) },
      message: { message_id: id, chat_id: "chat", chat_type: "p2p", thread_id: "thread", message_type: "text",
        content: JSON.stringify({ text: "work" }), create_time: String(Date.now()) },
    });
    await emit("denied", "stranger", "user");
    expect(lookups).toBe(0);
    const human = emit("human-message", "human", "user");
    await waitFor(() => current.runtime.store.listRuns(g.id, topic.id).length === 1);
    await current.runtime.dispatcher.kick(); await human;
    expect(JSON.stringify(sent)).toContain("provider result");
    await Promise.resolve(emit("app-message", "human", "app")).catch(() => {});
    await Promise.resolve(emit("unknown-message", "human")).catch(() => {});
    expect(lookups).toBe(3); expect(current.runtime.store.listRuns(g.id, topic.id)).toHaveLength(1);
    expect(current.delegated()).toBe(0);
    const run = current.runtime.store.listRuns(g.id, topic.id)[0]!;
    expect(current.runtime.store.getAcceptedRequest(g.id, topic.id, run.requestId)?.dispatch?.humanIngress?.chatKey)
      .toBe("feishu:default:chat:thread:thread");
  } finally { await registry.stopAll(); await current.close(); }
});
