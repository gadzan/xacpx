import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { snapshotBotProfile } from "../../../src/bots/bot-types";
import { ControlService, conversationKernel } from "../../../src/control/control-service";
import { createControlEventBus } from "../../../src/control/control-event-bus";
import { createConversationRuntime } from "../../../src/conversations/conversation-composition";
import { createConversationChannelRouter } from "../../../src/channels/conversation-channel-router";
import { MessageChannelRegistry } from "../../../src/channels/channel-registry";
import { createMessageChannel, registerChannelFactory } from "../../../src/channels/create-channel";
import { SqliteConversationStore } from "../../../src/conversations/sqlite-conversation-store";
import { createSqlDriver } from "../../../src/conversations/sql-driver";
import { createDirectConversationId } from "../../../src/domain/ids";
import { AsyncMutex } from "../../../src/orchestration/async-mutex";
import { SessionService } from "../../../src/sessions/session-service";
import { createEmptyState, type AppState } from "../../../src/state/types";
import type { Agent, ChatRequest } from "../../../src/weixin/agent/interface";
import { DiscordChannel } from "../../../packages/channel-discord/src/channel";
import { FeishuChannel } from "../../../packages/channel-feishu/src/channel";
import { YuanbaoChannel } from "../../../packages/channel-yuanbao/src/channel";
import type { YuanbaoGatewayStartInput } from "../../../packages/channel-yuanbao/src/types";
import { MSG, parseControlPayload } from "@ganglion/xacpx-relay-protocol";
import type { ChannelOwnerConfig } from "../../../src/commands/command-policy";

async function compose(options: { state?: AppState; path?: string; agent?: Agent; router?: unknown; ownerConfig?: ChannelOwnerConfig } = {}) {
  const state = options.state ?? createEmptyState();
  const path = options.path ?? join(mkdtempSync(join(tmpdir(), "xacpx-bindings-")), "conversations.sqlite");
  const config = { transport: { type: "acpx-cli", permissionMode: "approve-all" },
    agents: { codex: { driver: "codex" } }, workspaces: { backend: { cwd: tmpdir() } }, ...options.ownerConfig } as never;
  const stateStore = { save: async () => {}, saveNow: async () => {} };
  const stateMutex = new AsyncMutex();
  const sessions = new SessionService(config, stateStore, state, { stateMutex });
  const events = createControlEventBus();
  const control = new ControlService({ agent: options.agent ?? { chat: async () => ({ text: "provider result" }) },
    sessions, activeTurns: { isActiveAnywhere: () => false }, events, scheduled: {}, orchestration: {},
    workspaces: { list: () => [{ name: "backend", cwd: tmpdir() }] } } as never);
  const kernel = conversationKernel(control);
  const runtime = await createConversationRuntime({ config, state, stateStore, sessions, control: kernel,
    sqlitePath: path, releaseOwnedSession: async () => {}, stateMutex, autoKick: false, router: options.router,
    onProductEvent: (event) => kernel.emitConversationProduct(event) });
  kernel.bindConversationRuntime(runtime);
  const daemon = new AbortController();
  let delegated = 0;
  const normalAgent = { chat: async () => { delegated++; return { text: "ordinary" }; }, isKnownCommand: (text: string) => text === "/help" };
  const route = createConversationChannelRouter("discord", normalAgent, runtime, events, daemon.signal);
  // Unit-level ingress fixture; real adapters select before Session binding.
  const agent: Agent = { chat: (input) => (route(input) ?? normalAgent).chat(input) };
  const close = async () => { daemon.abort(); await runtime.shutdown(); };
  return { state, path, control, runtime, events, daemon, agent, route, sessions, close, normalAgent, delegated: () => delegated };
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

type MediaScenario = "available" | "failed" | "over-limit" | "missing-key";
function externalAdapter(platform: "discord" | "feishu", sent: string[], options?: { feishuOwnerLookup?: () => Promise<string | undefined>; group?: boolean }) {
  let emit: (id: string, text: string, media?: MediaScenario) => Promise<void> | void = () => {};
  let ready = false;
  const channel = platform === "discord"
    ? new DiscordChannel({ token: "x", dmPolicy: "open", guildPolicy: options?.group ? "open" : "disabled", requireMention: false,
      typingIndicator: false, enableAutocomplete: false }, { logger: logger as never, identifyStaggerMs: 0,
      createClient: () => ({
        start: async (input: any) => { emit = (id, text, media) => input.handlers.onMessage({ id, content: text,
          ...(media ? { attachments: Array.from({ length: media === "over-limit" ? 50 : 1 }, (_, index) => ({ id: `a${index}`,
            url: media === "failed" ? "https://example.invalid/unavailable" : "https://example.com/image", name: "image.png",
            contentType: "image/png", size: media === "over-limit" ? 100_000_000 : 10 })) } : {}),
          channelId: "dm", guildId: options?.group ? "guild" : null, author: { id: "human", bot: false }, createdTimestamp: Date.now() });
          ready = true; return { botUserId: "bot" }; },
        probeBot: async () => ({ botUserId: "bot" }), startTyping: async () => () => {},
        sendMessage: async (_: unknown, body: any) => { sent.push(body.content ?? ""); return { messageId: `s${sent.length}` }; },
        editMessage: async () => {}, deleteMessage: async () => {}, destroy: async () => {}, addReaction: async () => {},
      }) as never })
    : new FeishuChannel({ appId: "app", appSecret: "secret", domain: "feishu", dmPolicy: "open",
      requireMention: false, textMessageFormat: "text", replyMode: "static", trustGroupOwner: Boolean(options?.feishuOwnerLookup) }, { createClient: () => ({
        ...(options?.feishuOwnerLookup ? { getChatOwner: options.feishuOwnerLookup } : {}),
        sdk: { im: { message: {
          reply: async (body: unknown) => { sent.push(JSON.stringify(body)); return { data: { message_id: "reply", chat_id: "chat" } }; },
          create: async (body: unknown) => { sent.push(JSON.stringify(body)); return { data: { message_id: "reply", chat_id: "chat" } }; },
        } } }, probeBot: async () => ({ botOpenId: "bot" }), stop: () => {},
        startWS: async (input: any) => { emit = (id, text, media) => input.handlers["im.message.receive_v1"]({
          sender: { sender_id: { open_id: "human" }, sender_type: "user" },
          message: { message_id: id, chat_id: "chat", chat_type: options ? "group" : "p2p", message_type: media ? "post" : "text",
            content: JSON.stringify(media ? { content: [[{ tag: "text", text },
              ...Array.from({ length: media === "over-limit" ? 50 : 1 }, () => ({ tag: "img",
                ...(media === "missing-key" ? {} : { image_key: media === "failed" ? "unavailable" : "image" }) }))]] } : { text }),
            create_time: String(Date.now()) },
        }); ready = true; },
      }) as never });
  return { channel, emit: (id: string, text: string, media?: MediaScenario) => emit(id, text, media), ready: () => ready };
}

test("registered plugin types retain their namespace contract through binding, ingress, replay and unbind", async () => {
  const current = await compose();
  try {
    const { group: g, topic } = await group(current);
    for (const type of ["my_channel", "Foo", "long".repeat(20), "my channel"]) {
      registerChannelFactory(type, () => ({ id: type }) as never);
      expect(createMessageChannel(type).id).toBe(type);
      const chatKey = `${type}:abc`;
      await current.control.bindConversation({ chatKey, conversationId: g.id, topicId: topic.id });
      const input = request("work", "custom", chatKey); input.metadata!.channel = type;
      const route = createConversationChannelRouter(type, current.normalAgent, current.runtime, current.events, current.daemon.signal);
      const response = route(input)!.chat(input);
      await waitFor(() => current.runtime.store.listRuns(g.id, topic.id).some((run) => run.state === "queued"));
      await current.runtime.dispatcher.kick();
      expect((await response).text).toContain("provider result");
      await current.control.unbindConversation(chatKey);
      expect((await route(input)!.chat(input)).text).toContain("provider result");
    }
    expect(current.delegated()).toBe(0);
  } finally { await current.close(); }
});

test("durable prompt/Stop receipts precede changed command classification and reject command-shaped conflicts", async () => {
  const current = await compose(); let known = false; let ordinary = 0;
  const normal = { isKnownCommand: () => known, chat: async () => { ordinary++; return { text: "ordinary" }; } };
  const route = createConversationChannelRouter("discord", normal, current.runtime, current.events, current.daemon.signal);
  try {
    const { group: g, topic } = await group(current);
    const original = request("/future-command", "future"); const response = route(original)!.chat(original);
    await waitFor(() => current.runtime.store.listRuns(g.id, topic.id).length === 1);
    await current.runtime.dispatcher.kick(); await response; known = true;
    await current.control.unbindConversation(original.conversationId);
    const selected = route(original); expect(selected).toBeDefined();
    expect((await selected!.chat(original)).text).toContain("provider result");
    const conflict = request("/help", "future");
    await expect(route(conflict)!.prepareConversation!(conflict)).rejects.toMatchObject({ code: "external_request_conflict" });
    expect(route(request("/help", "fresh-command"))).toBeUndefined();
    await current.control.bindConversation({ chatKey: original.conversationId, conversationId: g.id, topicId: topic.id });
    const stop = request("/stop", "durable-stop"); await route(stop)!.chat(stop);
    const stopConflict = request("/help", "durable-stop");
    await expect(route(stopConflict)!.prepareConversation!(stopConflict)).rejects.toMatchObject({ code: "external_request_conflict" });
    expect(ordinary).toBe(0); expect(current.runtime.store.listRuns(g.id, topic.id)).toHaveLength(1);
  } finally { await current.close(); }
});

test("plugin empty attachment arrays accept text and Stop, and replay as the same zero-media input", async () => {
  const current = await compose();
  try {
    const { group: g, topic } = await group(current); const input = request();
    input.media = []; input.metadata!.hadInboundMedia = false;
    await current.route(input)!.prepareConversation!(input);
    expect(current.runtime.store.listRuns(g.id, topic.id)).toHaveLength(1);
    await current.route(request())!.prepareConversation!(request());
    const stop = request("/stop", "empty-media-stop"); stop.media = []; stop.metadata!.hadInboundMedia = false;
    await current.route(stop)!.chat(stop);
    expect(current.runtime.store.listRuns(g.id, topic.id)[0]).toMatchObject({ state: "cancelled", completionReason: "human-cancelled" });
    const rawMedia = request("text", "raw-media"); rawMedia.media = []; rawMedia.metadata!.hadInboundMedia = true;
    await expect(current.route(rawMedia)!.prepareConversation!(rawMedia)).rejects.toMatchObject({ code: "external_media_unsupported" });
  } finally { await current.close(); }
});

for (const rename of ["target", "other-member"] as const) {
  test(`name-addressed acceptance revalidates ${rename} rename under lifecycle gates`, async () => {
    const current = await compose(); const entered = Promise.withResolvers<void>(); const resume = Promise.withResolvers<void>();
    try {
      const { group: g, bots } = await group(current);
      (current.runtime.runs as any).beforeGroupAcceptGatesAcquired = async () => { entered.resolve(); await resume.promise; };
      const input = request("@Reviewer work"); const result = current.route(input)!.prepareConversation!(input); result.catch(() => {});
      await entered.promise;
      await current.control.updateBot(bots[rename === "target" ? 0 : 1]!.id, { name: rename === "target" ? "FormerReviewer" : "Reviewer" });
      resume.resolve(); await expect(result).rejects.toMatchObject({ code: "external_target_changed" });
      expect(current.runtime.store.listRuns(g.id)).toHaveLength(0);
      const structured = request("work", "structured"); structured.metadata!.conversationTarget = { botId: bots[0]!.id };
      await current.route(structured)!.prepareConversation!(structured);
      expect(current.runtime.store.listRuns(g.id)).toHaveLength(1);
    } finally { resume.resolve(); await current.close(); }
  });
}

test("name-addressed acceptance rejects sibling ambiguity introduced during its final persistence wait", async () => {
  const current = await compose(); const entered = Promise.withResolvers<void>(); const resume = Promise.withResolvers<void>();
  try {
    const { group: g, bots } = await group(current);
    (current.runtime.runs as any).beforeAcceptPersist = async () => { entered.resolve(); await resume.promise; };
    const input = request("@Reviewer work"); const result = current.route(input)!.prepareConversation!(input); result.catch(() => {});
    await entered.promise;
    await current.control.updateBot(bots[1]!.id, { name: "Reviewer" });
    resume.resolve(); await expect(result).rejects.toMatchObject({ code: "external_target_changed" });
    expect(current.runtime.store.listRuns(g.id)).toHaveLength(0);
    const structured = request("work", "structured-after-rename"); structured.metadata!.conversationTarget = { botId: bots[0]!.id };
    await current.route(structured)!.prepareConversation!(structured);
    expect(current.runtime.store.listRuns(g.id)).toHaveLength(1);
  } finally { resume.resolve(); await current.close(); }
});

for (const platform of ["discord", "feishu"] as const) {
  test(`actual ${platform} configured ownerIds enrich bound group authority before acceptance`, async () => {
    const current = await compose({ ownerConfig: { channels: [{ id: platform, type: platform, ownerIds: ["human"] }] } });
    const sent: string[] = []; const adapter = externalAdapter(platform, sent, { group: true, feishuOwnerLookup: async () => undefined });
    const registry = new MessageChannelRegistry([adapter.channel]); let startup: Promise<void> | undefined;
    try {
      const { group: g, topic } = await group(current);
      const chatKey = platform === "discord" ? "discord:default:g:dm" : "feishu:default:chat";
      await current.control.bindConversation({ chatKey, conversationId: g.id, topicId: topic.id });
      startup = registry.startAll({ agent: current.normalAgent, logger, quota, abortSignal: current.daemon.signal } as never,
        (id, agent) => createConversationChannelRouter(id, agent, current.runtime, current.events, current.daemon.signal));
      startup.catch(() => {}); await waitFor(adapter.ready);
      const response = Promise.resolve(adapter.emit("configured-owner", "work")); response.catch(() => {});
      await waitFor(() => current.runtime.store.listRuns(g.id, topic.id).length === 1);
      const run = current.runtime.store.listRuns(g.id, topic.id)[0]!;
      expect(current.runtime.store.getAcceptedRequest(g.id, topic.id, run.requestId)?.dispatch?.humanIngress)
        .toMatchObject({ senderId: "human", chatKey, chatType: "group", isOwner: true });
      await current.runtime.dispatcher.kick(); await response;
      expect(current.delegated()).toBe(0);
    } finally { await current.close(); await registry.stopAll(); await startup; }
  });
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

test("structured automatic routing returns the durable question and Stop can cancel a waiting-human Run", async () => {
  let starts = 0;
  const current = await compose({ agent: { chat: async () => { starts++; return { text: "wrong" }; } },
    router: { capabilityRestriction: { toolsDisabled: true, filesystemDisabled: true, terminalDisabled: true,
      permissionInteractionDisabled: true, messagingDisabled: true, orchestrationDisabled: true, structuredOutputOnly: true },
      decide: async () => ({ type: "need-human", question: "Which branch should we review?" }) },
  });
  try {
    const { group: g, topic } = await group(current);
    const input = request(); input.metadata!.conversationTarget = { mode: "automatic" };
    expect((await current.agent.chat(input)).text).toContain("Which branch should we review?");
    expect(current.runtime.store.listRuns(g.id, topic.id)[0]?.state).toBe("waiting-human");
    await current.agent.chat(request("/stop", "stop-waiting"));
    expect(current.runtime.store.listRuns(g.id, topic.id)).toHaveLength(1);
    expect(current.runtime.store.listRuns(g.id, topic.id)[0]).toMatchObject({ state: "cancelled", completionReason: "human-cancelled" });
    expect(current.delegated()).toBe(0);
    expect(starts).toBe(0);
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

for (const retainOriginalFacts of [true, false]) {
  test(`legacy receipt Stop owner migration ${retainOriginalFacts ? "backfills only original facts" : "fails closed when facts were lost"}`, async () => {
    const first = await compose();
    await group(first);
    const accepted = (await first.runtime.bindings.accept("discord", request()))!;
    await first.close();
    const sql = await createSqlDriver(first.path);
    sql.exec("ALTER TABLE external_conversation_requests DROP COLUMN stop_ingress");
    if (!retainOriginalFacts) sql.run("UPDATE pending_dispatches SET human_ingress = NULL");
    sql.close();
    const second = await compose({ state: first.state, path: first.path });
    try {
      const stop = request("/stop", "stop-migration");
      if (retainOriginalFacts) {
        expect(second.runtime.bindings.stopTargets("discord", stop)).toEqual([accepted.run.id]);
        const check = await createSqlDriver(first.path);
        try {
          expect(JSON.parse(check.get<{ stop_ingress: string }>("SELECT stop_ingress FROM external_conversation_requests")!.stop_ingress))
            .toEqual({ chatKey: request().conversationId, senderId: "human", accountId: "default" });
        } finally { check.close(); }
        const replay = await second.runtime.bindings.accept("discord", request());
        expect(replay?.dispatch?.authorityEpoch).toBe(first.runtime.authorityEpoch);
        expect(replay?.dispatch?.authorityEpoch).not.toBe(second.runtime.authorityEpoch);
        await second.agent.chat(stop);
        expect(second.runtime.store.getRun(accepted.run.id)?.completionReason).toBe("human-cancelled");
      } else {
        await expect(second.agent.chat(stop)).rejects.toMatchObject({ code: "external_stop_unavailable" });
        expect(second.runtime.store.getRun(accepted.run.id)?.state).toBe("queued");
        expect(second.delegated()).toBe(0);
      }
    } finally { await second.close(); }
  });
}

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
    const input = request(); input.abortSignal = abort.signal; input.humanStopSignal = abort.signal;
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

test("Stop receipt rollback, input conflict, event-kind collision and corrupt targets fail closed", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "xacpx-stop-receipt-")), "conversations.sqlite");
  let fail = true;
  const store = await SqliteConversationStore.open(path, { beforeAcceptCommit: () => { if (fail) throw new Error("stop disk failure"); } });
  const input = { key: "stop-key", fingerprint: "stop-fingerprint", chatKey: request().conversationId, accountId: "default", senderId: "human" };
  try {
    expect(() => store.acceptExternalStop(input, () => ["original-run"])).toThrow("stop disk failure");
    expect(store.hasExternalStopRequest(input.key)).toBe(false);
    fail = false;
    expect(store.acceptExternalStop(input, () => ["original-run"])).toEqual({ reused: false, targetRunIds: ["original-run"] });
    expect(store.acceptExternalStop(input, () => { throw new Error("replay must not select new targets"); }))
      .toEqual({ reused: true, targetRunIds: ["original-run"] });
    expect(() => store.getExternalStopRequest({ ...input, fingerprint: "changed" })).toThrow("different input");
    const now = new Date().toISOString();
    const profileSnapshot = snapshotBotProfile({ id: "bot", name: "Bot", agent: "codex", workspace: "backend", enabled: true,
      profileRevision: 1, createdAt: now, updatedAt: now }, now);
    const prompt = { conversationId: "c", topicId: "t", requestId: `external:${input.key}`, botId: "bot", content: "work", now,
      profileSnapshot, externalRequest: { key: input.key, fingerprint: "prompt" } };
    expect(() => store.acceptRequest(prompt)).toThrow("already identifies a Stop");
    store.acceptRequest({ ...prompt, requestId: "external:prompt-key", externalRequest: { key: "prompt-key", fingerprint: "prompt" } });
    expect(() => store.acceptExternalStop({ ...input, key: "prompt-key" }, () => [])).toThrow("already identifies a prompt");
    const sql = await createSqlDriver(path);
    try {
      for (const targets of ["{broken", "{}", "[1]", '["duplicate","duplicate"]']) {
        sql.run("UPDATE external_conversation_stops SET target_run_ids_json = ? WHERE source_key = ?", [targets, input.key]);
        expect(() => store.getExternalStopRequest(input)).toThrow("targets");
      }
      sql.run("UPDATE external_conversation_stops SET target_run_ids_json = '[]', sender_id = 'other' WHERE source_key = ?", [input.key]);
      expect(() => store.getExternalStopRequest(input)).toThrow("original owner");
    } finally { sql.close(); }
  } finally { store.close(); }
});

test("Stop while acceptance waits for a real Bot gate creates no Run", async () => {
  const current = await compose();
  let release = () => {};
  try {
    const { group: g, topic, bots } = await group(current);
    let entered = false;
    const gate = current.runtime.bots.runLifecycle(bots[0]!.id, async () => { entered = true; await new Promise<void>((resolve) => { release = resolve; }); });
    await waitFor(() => entered);
    const abort = new AbortController(); const input = request(); input.abortSignal = abort.signal; input.humanStopSignal = abort.signal;
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
    const input = request(); input.abortSignal = abort.signal; input.humanStopSignal = abort.signal;
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

test("a held acceptance serializes only its route; other channels and binding management progress", async () => {
  const current = await compose(); let release = () => {};
  try {
    const { group: g, topic, bots } = await group(current);
    let entered = false;
    const held = current.runtime.bots.runLifecycle(bots[0]!.id, async () => {
      entered = true; await new Promise<void>((resolve) => { release = resolve; });
    });
    await waitFor(() => entered);
    const accepted = current.runtime.bindings.accept("discord", request());
    await waitFor(() => (current.runtime.bindings as any).gates.get(request().conversationId)?.users === 1);
    let unbound = false;
    const sameRoute = current.control.unbindConversation(request().conversationId).then(() => { unbound = true; });
    const otherBot = await current.control.createBot({ name: "Independent", agent: "codex", workspace: "backend" });
    let progressed = false;
    const unrelated = (async () => {
      for (const channelId of ["discord", "feishu", "weixin"]) {
        const input = request("ordinary", "m2", `${channelId}:default:other`);
        input.metadata!.channel = channelId;
        if (channelId === "weixin") input.metadata!.chatType = "direct";
        expect(await current.runtime.bindings.accept(channelId, input)).toBeUndefined();
      }
      await current.control.bindConversation({ chatKey: "feishu:default:other", conversationId: createDirectConversationId(otherBot.id) });
      await current.control.unbindConversation("feishu:default:other");
      progressed = true;
    })();
    await waitFor(() => progressed);
    expect(unbound).toBe(false);
    expect(current.runtime.store.listRuns(g.id, topic.id)).toHaveLength(0);
    release(); await held; expect(await accepted).toBeDefined(); await sameRoute; await unrelated;
    expect(unbound).toBe(true);
    expect((current.runtime.bindings as any).gates.size).toBe(0);
  } finally { release(); await current.close(); }
});

test("early route selection keeps replay/tombstones out of Session and fails closed after unbind", async () => {
  const current = await compose();
  try {
    const { group: g, topic } = await group(current);
    const selected = current.route(request())!;
    await current.control.unbindConversation(request().conversationId);
    await expect(selected.chat(request())).rejects.toMatchObject({ code: "binding_changed" });
    expect(current.delegated()).toBe(0);
    await current.control.bindConversation({ chatKey: request().conversationId, conversationId: g.id, topicId: topic.id });
    const response = current.agent.chat(request());
    await waitFor(() => current.runtime.store.listRuns(g.id, topic.id).length === 1);
    await current.runtime.dispatcher.kick(); await response;
    await current.control.unbindConversation(request().conversationId);
    expect(current.route(request())).toBeDefined();
    expect((await current.agent.chat(request())).text).toContain("provider result");
    expect(current.delegated()).toBe(0);
    await current.control.teardownGroupTopic(g.id, topic.id);
    expect(current.route(request())).toBeDefined();
    await expect(current.agent.chat(request())).rejects.toMatchObject({ code: "external_request_retired" });
    expect(current.delegated()).toBe(0);
    expect(current.route(request("new", "new-message", "discord:default:unbound"))).toBeUndefined();
  } finally { await current.close(); }
});

test("binding revision migration persists across reopen and corrupt revision fails closed", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "xacpx-binding-revision-")), "conversations.sqlite");
  let store = await SqliteConversationStore.open(path);
  const binding = { chatKey: request().conversationId, conversationId: "c", topicId: "t" };
  store.setConversationBinding(binding); store.close();
  const sql = await createSqlDriver(path);
  sql.exec("ALTER TABLE conversation_bindings DROP COLUMN revision"); sql.close();
  store = await SqliteConversationStore.open(path);
  try {
    const revision = store.getConversationBinding(binding.chatKey)!.revision;
    expect(revision).toBeTruthy(); expect(store.listConversationBindings()).toEqual([binding]);
    store.close(); store = await SqliteConversationStore.open(path);
    expect(store.getConversationBinding(binding.chatKey)!.revision).toBe(revision);
    store.setConversationBinding(binding); expect(store.getConversationBinding(binding.chatKey)!.revision).not.toBe(revision);
    const writer = await createSqlDriver(path);
    writer.run("UPDATE conversation_bindings SET revision = NULL WHERE chat_key = ?", [binding.chatKey]); writer.close();
    expect(() => store.getConversationBinding(binding.chatKey)).toThrow("incomplete");
    store.close(); store = await SqliteConversationStore.open(path);
    expect(() => store.getConversationBinding(binding.chatKey)).toThrow("incomplete");
  } finally { store.close(); }
});

for (const change of ["unbind-rebind", "A-B-A", "same-target"] as const) {
  test(`binding revision rejects ${change} ABA before receipt but preserves committed replay`, async () => {
    const current = await compose();
    try {
      const { group: g, topic } = await group(current);
      const input = request(); const selected = current.route(input)!;
      if (change === "unbind-rebind") await current.control.unbindConversation(input.conversationId);
      if (change === "A-B-A") {
        const other = await current.control.createGroupTopic(g.id, "Other", { workspace: "backend", isolation: "shared-single-writer" });
        await current.control.bindConversation({ chatKey: input.conversationId, conversationId: g.id, topicId: other.id });
      }
      await current.control.bindConversation({ chatKey: input.conversationId, conversationId: g.id, topicId: topic.id });
      await expect(selected.prepareConversation!(input)).rejects.toMatchObject({ code: "binding_changed" });
      expect(current.runtime.store.listRuns(g.id, topic.id)).toHaveLength(0);
      const accepted = current.route(input)!; await accepted.prepareConversation!(input);
      await current.runtime.dispatcher.kick(); expect((await accepted.chat(input)).text).toContain("provider result");
      await current.control.unbindConversation(input.conversationId);
      await current.control.bindConversation({ chatKey: input.conversationId, conversationId: g.id, topicId: topic.id });
      expect((await current.route(input)!.chat(input)).text).toContain("provider result");
      expect(current.runtime.store.listRuns(g.id, topic.id)).toHaveLength(1); expect(current.delegated()).toBe(0);
    } finally { await current.close(); }
  });
}

test("selection freezes Conversation and Topic; replacements fail closed while committed receipts still replay", async () => {
  const current = await compose();
  try {
    const { group: g, topic } = await group(current);
    const selectedTopic = current.route(request())!;
    const otherTopic = await current.control.createGroupTopic(g.id, "Other", { workspace: "backend", isolation: "shared-single-writer" });
    await current.control.bindConversation({ chatKey: request().conversationId, conversationId: g.id, topicId: otherTopic.id });
    await expect(selectedTopic.chat(request())).rejects.toMatchObject({ code: "binding_changed" });
    const selectedGroup = current.route(request())!;
    const { group: otherGroup, topic: newTopic } = await group(current, ["Other", "Partner"]);
    await expect(selectedGroup.chat(request())).rejects.toMatchObject({ code: "binding_changed" });
    expect(current.runtime.store.listRuns(g.id)).toHaveLength(0);
    expect(current.runtime.store.listRuns(otherGroup.id)).toHaveLength(0);
    const response = current.agent.chat(request());
    await waitFor(() => current.runtime.store.listRuns(otherGroup.id, newTopic.id).length === 1);
    await current.runtime.dispatcher.kick(); await response;
    const replay = current.route(request())!;
    await current.control.bindConversation({ chatKey: request().conversationId, conversationId: g.id, topicId: topic.id });
    expect((await replay.chat(request())).text).toContain("provider result");
    expect(current.runtime.store.listRuns(g.id)).toHaveLength(0);
  } finally { await current.close(); }
});

test("actual Feishu trustGroupOwner blocked RPC cannot delay acceptance or Stop; enrichment applies only to later turns", async () => {
  const current = await compose();
  const sent: string[] = []; let finishLookup = (_owner: string) => {}; let lookups = 0;
  const adapter = externalAdapter("feishu", sent, { feishuOwnerLookup: () => {
    lookups++; return new Promise<string>((resolve) => { finishLookup = resolve; });
  } });
  const registry = new MessageChannelRegistry([adapter.channel]); let startup: Promise<void> | undefined;
  try {
    const { group: g, topic } = await group(current); const chatKey = "feishu:default:chat";
    await current.control.bindConversation({ chatKey, conversationId: g.id, topicId: topic.id });
    startup = registry.startAll({ agent: current.normalAgent, logger, quota, abortSignal: current.daemon.signal } as never,
      (id, agent) => createConversationChannelRouter(id, agent, current.runtime, current.events, current.daemon.signal));
    startup.catch(() => {}); await waitFor(adapter.ready);
    const response = Promise.resolve(adapter.emit("cold-owner", "work")).catch(() => {});
    await waitFor(() => lookups === 1 && current.runtime.store.listRuns(g.id, topic.id).length === 1);
    const run = current.runtime.store.listRuns(g.id, topic.id)[0]!;
    const original = current.runtime.store.getAcceptedRequest(g.id, topic.id, run.requestId)!;
    expect(original.dispatch?.humanIngress?.isOwner).toBe(false);
    await adapter.emit("stop-cold-owner", "/stop"); await response;
    expect(current.runtime.store.getRun(run.id)).toMatchObject({ state: "cancelled", completionReason: "human-cancelled" });
    expect(lookups).toBe(1);
    finishLookup("human"); await waitFor(() => (adapter.channel as any).chatOwnerCache.size === 1);
    const later = Promise.resolve(adapter.emit("warm-owner", "later work")); later.catch(() => {});
    await waitFor(() => current.runtime.store.listRuns(g.id, topic.id).length === 2);
    const next = current.runtime.store.listRuns(g.id, topic.id).find((item) => item.id !== run.id)!;
    expect(current.runtime.store.getAcceptedRequest(g.id, topic.id, next.requestId)?.dispatch?.humanIngress?.isOwner).toBe(true);
    expect(original.dispatch?.humanIngress?.isOwner).toBe(false);
    await current.runtime.dispatcher.kick(); await later; expect(lookups).toBe(1);
    expect(current.delegated()).toBe(0);
  } finally { finishLookup("human"); await current.close(); await registry.stopAll(); await startup; }
});

for (const failure of ["provenance", "selector"] as const) {
  test(`actual Yuanbao ${failure} rejection prepares before media/history/heartbeat; known commands keep raw text`, async () => {
    const current = await compose(); let input: YuanbaoGatewayStartInput | undefined;
    let fetches = 0; let heartbeats = 0; let preparations = 0; let sessionReads = 0;
    const ordinary: ChatRequest[] = []; const selected: ChatRequest[] = [];
    const channel = new YuanbaoChannel({ appKey: "key", appSecret: "secret", botId: "bot", requireMention: true,
      historyLimit: 10, outboundQueueStrategy: "immediate", minChars: 1, maxChars: 1000, idleMs: 0 }, {
      createGateway: () => ({ start: async (start) => { input = start; }, sendText: async () => {},
        sendReplyHeartbeat: async () => { heartbeats++; } }),
      fetchInboundMedia: (async () => { fetches++; throw new Error("bound media must not download"); }) as typeof fetch,
    });
    const normal: Agent = { isKnownCommand: (text) => text === "/help", chat: async (request) => { ordinary.push(request); return { text: "Session" }; } };
    const route = createConversationChannelRouter("yuanbao", normal, current.runtime, current.events, current.daemon.signal);
    const send = (id: string, text: string, addressed: boolean, media = false) => input!.onMessage({ accountId: "default", chatType: "group",
      raw: { from_account: "human", group_code: "g1", msg_id: id, msg_body: [
        ...(addressed ? [{ msg_type: "TIMCustomElem", msg_content: { data: JSON.stringify({ elem_type: 1002, text: "@Bot", user_id: "bot" }) } }] : []),
        { msg_type: "TIMTextElem", msg_content: { text } },
        ...(media ? [{ msg_type: "TIMImageElem", msg_content: { image_info_array: [{ type: 1, url: "https://example.invalid/image", size: 1 }] } }] : []),
      ] } });
    try {
      const { group: g, topic } = await group(current); const chatKey = "yuanbao:default:group:g1";
      await current.control.bindConversation({ chatKey, conversationId: g.id, topicId: topic.id });
      if (failure === "selector") {
        const db = await createSqlDriver(current.path); db.run("UPDATE conversation_bindings SET topic_id = '' WHERE chat_key = ?", [chatKey]); db.close();
      }
      await channel.start({ agent: normal, logger, quota, abortSignal: current.daemon.signal,
        sessions: { peekCurrentSessionAlias: () => { sessionReads++; return undefined; } } as never,
        routeConversation: (request) => {
          selected.push(request); const agent = route(request);
          return agent ? { ...agent, prepareConversation: async (full) => { preparations++; return agent.prepareConversation!(full); } } : undefined;
        } });
      await send("history", "preserved aside", false);
      expect(selected).toHaveLength(0);
      await expect(send("blocked", "work", true, true)).rejects.toMatchObject({
        code: failure === "selector" ? "binding_corrupt" : "external_human_required",
      });
      expect(preparations).toBe(1); expect(fetches).toBe(0); expect(heartbeats).toBe(0); expect(sessionReads).toBe(0);
      expect(ordinary).toHaveLength(0); expect(current.runtime.store.listRuns(g.id, topic.id)).toHaveLength(0);
      expect(selected[0]).toMatchObject({ text: "work", metadata: { channelMessageId: "blocked", senderId: "human", hadInboundMedia: true } });
      await send("command", "/help", false); expect(ordinary[0]?.text).toBe("/help");
      await current.control.unbindConversation(chatKey);
      await send("normal", "later work", true);
      expect(ordinary).toHaveLength(2); expect(ordinary[1]?.text).toContain("preserved aside");
      expect(ordinary[1]?.text).toContain("later work"); expect(fetches).toBe(0);
    } finally { channel.logout(); await current.close(); }
  });
}

test("raw attachment presence rejects failed/skipped/retried media without creating a receipt", async () => {
  const current = await compose();
  try {
    const { group: g, topic } = await group(current);
    for (const media of [[{ kind: "image", filePath: "downloaded.png" }], undefined, []]) {
      const input = request("analyze attachment", "media-message");
      input.metadata!.hadInboundMedia = true; input.media = media as ChatRequest["media"];
      await expect(current.agent.chat(input)).rejects.toMatchObject({ code: "external_media_unsupported" });
    }
    expect(current.runtime.store.listRuns(g.id, topic.id)).toHaveLength(0);
    const key = createHash("sha256").update(JSON.stringify(["discord", "default", request().conversationId, "media-message"])).digest("hex");
    expect(current.runtime.store.hasExternalRequest(key)).toBe(false);
  } finally { await current.close(); }
});

for (const platform of ["discord", "feishu"] as const) {
  test(`actual ${platform} rejects original attachments before download or degradation`, async () => {
    const current = await compose(); const sent: string[] = [];
    const { channel, emit, ready } = externalAdapter(platform, sent);
    const registry = new MessageChannelRegistry([channel]); let startup: Promise<void> | undefined;
    let rejected = 0; let downloads = 0;
    const accept = current.runtime.bindings.accept.bind(current.runtime.bindings);
    current.runtime.bindings.accept = async (...args) => {
      try { return await accept(...args); } catch (error) {
        if ((error as { code?: string }).code === "external_media_unsupported") rejected++;
        throw error;
      }
    };
    (channel as any).downloadInboundAttachments = async () => { downloads++; throw new Error("bound media must not download"); };
    try {
      const { group: g, topic } = await group(current);
      const chatKey = platform === "discord" ? "discord:default:dm:dm" : "feishu:default:chat";
      await current.control.bindConversation({ chatKey, conversationId: g.id, topicId: topic.id });
      startup = registry.startAll({ agent: current.normalAgent, logger, quota, abortSignal: current.daemon.signal } as never,
        (id, agent) => createConversationChannelRouter(id, agent, current.runtime, current.events, current.daemon.signal));
      startup.catch(() => {}); await waitFor(ready); await Bun.sleep(5);
      for (const mode of ["available", "failed", "over-limit", "missing-key"] as const) {
        const before = rejected;
        await Promise.resolve(emit(mode, "analyze attachment", mode)).catch(() => {});
        await waitFor(() => rejected === before + 1);
      }
      expect(downloads).toBe(0); expect(current.runtime.store.listRuns(g.id, topic.id)).toHaveLength(0);
      expect(current.delegated()).toBe(0);
    } finally { await current.close(); await registry.stopAll(); await startup; }
  });

  test(`actual ${platform} commits later ingress while typing setup and an earlier Run are pending`, async () => {
    const current = await compose(); const sent: string[] = [];
    const { channel, emit, ready } = externalAdapter(platform, sent);
    const registry = new MessageChannelRegistry([channel]); let startup: Promise<void> | undefined;
    let releaseUi = () => {}; let uiCalls = 0;
    const blockedUi = new Promise<void>((resolve) => { releaseUi = resolve; });
    try {
      const { group: g, topic } = await group(current);
      const chatKey = platform === "discord" ? "discord:default:dm:dm" : "feishu:default:chat";
      await current.control.bindConversation({ chatKey, conversationId: g.id, topicId: topic.id });
      startup = registry.startAll({ agent: current.normalAgent, logger, quota, abortSignal: current.daemon.signal } as never,
        (id, agent) => createConversationChannelRouter(id, agent, current.runtime, current.events, current.daemon.signal));
      startup.catch(() => {}); await waitFor(ready); await Bun.sleep(5);
      const runtime = (channel as any).accounts.get("default");
      if (platform === "discord") {
        runtime.account.typingIndicator = true;
        runtime.client.startTyping = async () => { uiCalls++; await blockedUi; return () => {}; };
      } else {
        runtime.client.sdk.im.messageReaction = { create: async () => { uiCalls++; await blockedUi; return { data: { reaction_id: "typing" } }; }, delete: async () => {} };
      }
      const first = Promise.resolve(emit("ui1", "first")); await waitFor(() => uiCalls === 1);
      const second = Promise.resolve(emit("ui2", "second"));
      await waitFor(() => current.runtime.store.listRuns(g.id, topic.id).length === 2);
      expect(current.runtime.store.listRuns(g.id, topic.id).every((run) => run.state === "queued")).toBe(true);
      expect(sent).toEqual([]);
      releaseUi(); await current.runtime.dispatcher.kick(); await first; await second;
      await waitFor(() => sent.filter((text) => text.includes("provider result")).length === 2);
    } finally { releaseUi(); await current.close(); await registry.stopAll(); await startup; }
  });
  for (const stopText of ["/stop", "stop"]) {
    test(`actual ${platform} durably accepts pending input and restores ${stopText} targeting after restart`, async () => {
      const first = await compose();
      let second: Awaited<ReturnType<typeof compose>> | undefined;
      let startup: Promise<void> | undefined; let restarted: Promise<void> | undefined;
      const sent: string[] = [];
      const original = externalAdapter(platform, sent);
      const originalRegistry = new MessageChannelRegistry([original.channel]);
      let nextRegistry: MessageChannelRegistry | undefined;
      let providerStarted = false; let finishProvider = () => {}; let normalStops = 0;
      let ordinarySignal: AbortSignal | undefined; let finishOrdinary = () => {};
      try {
        const { group: g, topic } = await group(first);
        const chatKey = platform === "discord" ? "discord:default:dm:dm" : "feishu:default:chat";
        await first.control.bindConversation({ chatKey, conversationId: g.id, topicId: topic.id });
        startup = originalRegistry.startAll({ agent: first.normalAgent, logger, quota, abortSignal: first.daemon.signal } as never,
          (id, agent) => createConversationChannelRouter(id, agent, first.runtime, first.events, first.daemon.signal));
        startup.catch(() => {}); await waitFor(original.ready); await Bun.sleep(5);
        const deliveries = ["m1", "m2", "m3"].map((id) => Promise.resolve(original.emit(id, `work ${id}`)).catch((error) => error));
        await waitFor(() => first.runtime.store.listRuns(g.id, topic.id).length === 3);
        const runs = first.runtime.store.listRuns(g.id, topic.id);
        expect(runs.every((run) => run.state === "queued")).toBe(true);
        for (const run of runs) expect(first.runtime.store.getAcceptedRequest(g.id, topic.id, run.requestId)).toBeDefined();
        const replacement = await first.control.createGroupTopic(g.id, "Rebound", { workspace: "backend", isolation: "shared-single-writer" });
        await first.control.bindConversation({ chatKey, conversationId: g.id, topicId: replacement.id });
        expect(first.runtime.store.listRuns(g.id, replacement.id)).toHaveLength(0);
        await original.channel.stop("disabled"); await Promise.all(deliveries); await first.close(); await startup;
        second = await compose({ state: first.state, path: first.path, agent: { chat: async (input) => {
          providerStarted = true;
          await new Promise<void>((resolve) => { finishProvider = resolve; input.abortSignal!.addEventListener("abort", resolve as () => void, { once: true }); });
          if (input.abortSignal!.aborted) throw new Error("provider cancelled");
          return { text: "recovered" };
        } } });
        const resumed = second;
        const activation = resumed.runtime.activateAfterConsumerLock();
        await waitFor(() => providerStarted);
        const adapter = externalAdapter(platform, sent); nextRegistry = new MessageChannelRegistry([adapter.channel]);
        const normal: Agent = { isKnownCommand: () => true, chat: async (input) => {
          if (input.text === "hold restored Session") {
            ordinarySignal = input.abortSignal;
            await new Promise<void>((resolve) => { finishOrdinary = resolve; }); return { text: "Session survived" };
          }
          normalStops++; return { text: "Session stopped" };
        } };
        restarted = nextRegistry.startAll({ agent: normal, logger, quota, abortSignal: resumed.daemon.signal } as never,
          (id, agent) => createConversationChannelRouter(id, agent, resumed.runtime, resumed.events, resumed.daemon.signal));
        restarted.catch(() => {}); await waitFor(adapter.ready); await Bun.sleep(5);
        const ordinary = Promise.resolve(adapter.emit("session-after-restart", "hold restored Session"));
        await waitFor(() => ordinarySignal !== undefined);
        await Promise.resolve(adapter.emit("media-stop", stopText, "missing-key")).catch(() => {});
        expect(resumed.runtime.store.listRuns(g.id, topic.id).some((run) => run.state === "running")).toBe(true);
        expect(ordinarySignal!.aborted).toBe(false);
        await adapter.emit("stop-after-restart", stopText);
        await waitFor(() => resumed.runtime.store.listRuns(g.id, topic.id).every((run) => run.state === "cancelled"));
        await activation;
        expect(normalStops).toBe(0); expect(resumed.runtime.store.listRuns(g.id, topic.id)).toHaveLength(3);
        expect(resumed.runtime.store.listRuns(g.id, replacement.id)).toHaveLength(0);
        expect(resumed.runtime.store.listRuns(g.id, topic.id).map((run) => run.completionReason)).toEqual(Array(3).fill("human-cancelled"));
        expect(ordinarySignal!.aborted).toBe(false);
        const tasks = [...(adapter.channel as any).activeTasks.values()].flat();
        expect(tasks.some((task: any) => task.executionDomain === "session" && !task.suppressed)).toBe(true);
        finishOrdinary(); await ordinary; await waitFor(() => sent.some((message) => message.includes("Session survived")));
      } finally { finishOrdinary(); finishProvider(); await first.close(); await second?.close(); await originalRegistry.stopAll(); await nextRegistry?.stopAll(); await startup; await restarted; }
    });
  }
  test(`actual ${platform} replayed Stop preserves later Runs and blocked acceptance after restart/rebind`, async () => {
    const first = await compose();
    let second: Awaited<ReturnType<typeof compose>> | undefined;
    let startup: Promise<void> | undefined; let restarted: Promise<void> | undefined;
    let nextRegistry: MessageChannelRegistry | undefined;
    let finishProvider = () => {}; let releaseGate = () => {}; let gate: Promise<void> | undefined;
    let providerStarted = false; let providerCalls = 0; let normalStops = 0;
    const sent: string[] = [];
    const original = externalAdapter(platform, sent); const originalRegistry = new MessageChannelRegistry([original.channel]);
    try {
      const { group: g, topic, bots } = await group(first);
      const chatKey = platform === "discord" ? "discord:default:dm:dm" : "feishu:default:chat";
      await first.control.bindConversation({ chatKey, conversationId: g.id, topicId: topic.id });
      startup = originalRegistry.startAll({ agent: first.normalAgent, logger, quota, abortSignal: first.daemon.signal } as never,
        (id, agent) => createConversationChannelRouter(id, agent, first.runtime, first.events, first.daemon.signal));
      startup.catch(() => {}); await waitFor(original.ready);
      await original.emit("empty-stop", "/stop");
      const a = Promise.resolve(original.emit("run-a", "original work")).catch(() => {});
      await waitFor(() => first.runtime.store.listRuns(g.id, topic.id).length === 1);
      const runA = first.runtime.store.listRuns(g.id, topic.id)[0]!;
      await original.emit("stop-a", "/stop"); await a;
      expect(first.runtime.store.getRun(runA.id)?.completionReason).toBe("human-cancelled");
      const b = Promise.resolve(original.emit("run-b", "later work")).catch(() => {});
      await waitFor(() => first.runtime.store.listRuns(g.id, topic.id).length === 2);
      const runB = first.runtime.store.listRuns(g.id, topic.id).find((run) => run.state === "queued")!;
      const replacement = await first.control.createGroupTopic(g.id, "Rebound", { workspace: "backend", isolation: "shared-single-writer" });
      await first.control.bindConversation({ chatKey, conversationId: g.id, topicId: replacement.id });
      await original.channel.stop("disabled"); await b; await first.close(); await startup;
      second = await compose({ state: first.state, path: first.path, agent: { chat: async (input) => {
        if (++providerCalls === 1) {
          providerStarted = true;
          await new Promise<void>((resolve) => { finishProvider = resolve;
            input.abortSignal!.addEventListener("abort", resolve as () => void, { once: true }); });
          if (input.abortSignal!.aborted) throw new Error("later Run was wrongly cancelled");
        }
        return { text: "later Run survived" };
      } } });
      const resumed = second; const activation = resumed.runtime.activateAfterConsumerLock();
      await waitFor(() => providerStarted);
      const adapter = externalAdapter(platform, sent); nextRegistry = new MessageChannelRegistry([adapter.channel]);
      const normal: Agent = { isKnownCommand: (text) => text.startsWith("/"), chat: async () => { normalStops++; return { text: "Session" }; } };
      restarted = nextRegistry.startAll({ agent: normal, logger, quota, abortSignal: resumed.daemon.signal } as never,
        (id, agent) => createConversationChannelRouter(id, agent, resumed.runtime, resumed.events, resumed.daemon.signal));
      restarted.catch(() => {}); await waitFor(adapter.ready);
      let gateEntered = false;
      gate = resumed.runtime.bots.runLifecycle(bots[0]!.id, async () => { gateEntered = true; await new Promise<void>((resolve) => { releaseGate = resolve; }); });
      await waitFor(() => gateEntered);
      const c = Promise.resolve(adapter.emit("run-c", "pending later work")).catch((error) => error);
      await waitFor(() => (resumed.runtime.bindings as any).gates.get(chatKey)?.users === 1);
      await adapter.emit("stop-a", "/stop"); await adapter.emit("empty-stop", "/stop");
      expect(resumed.runtime.store.getRun(runB.id)).toMatchObject({ state: "running" });
      expect(resumed.runtime.store.getRun(runB.id)?.completionReason).toBeUndefined();
      const pending = [...(adapter.channel as any).activeTasks.values()].flat().find((task: any) => task.messageId === "run-c") as any;
      expect(pending.suppressed).toBe(false); expect(pending.abortController.signal.aborted).toBe(false);
      expect(pending.humanStopController.signal.aborted).toBe(false);
      const stopInput = request("/stop", "stop-a", chatKey); stopInput.metadata!.channel = platform;
      expect(resumed.runtime.bindings.acceptStop(platform, stopInput)).toEqual({ reused: true, targetRunIds: [runA.id] });
      stopInput.metadata!.channelMessageId = "empty-stop";
      expect(resumed.runtime.bindings.acceptStop(platform, stopInput)).toEqual({ reused: true, targetRunIds: [] });
      expect(normalStops).toBe(0);
      releaseGate(); await gate; await waitFor(() => resumed.runtime.store.listRuns(g.id, replacement.id).length === 1);
      expect(resumed.runtime.store.listRuns(g.id, replacement.id)[0]?.state).toBe("queued");
      finishProvider(); await activation; await c;
      expect(resumed.runtime.store.getRun(runB.id)?.state).toBe("completed");
      expect(resumed.runtime.store.listRuns(g.id, replacement.id)[0]?.state).toBe("completed");
    } finally {
      releaseGate(); finishProvider(); await gate; await first.close(); await second?.close();
      await originalRegistry.stopAll(); await nextRegistry?.stopAll(); await startup; await restarted;
    }
  });
  test(`actual ${platform} Stop preempts a blocked acceptance while cancelling a recovered Run`, async () => {
    const first = await compose();
    let second: Awaited<ReturnType<typeof compose>> | undefined;
    let startup: Promise<void> | undefined;
    let registry: MessageChannelRegistry | undefined;
    let releaseGate = () => {}; let finishProvider = () => {};
    let gate: Promise<void> | undefined;
    let providerStarted = false; let normalStops = 0;
    try {
      const { group: g, topic, bots } = await group(first);
      const chatKey = platform === "discord" ? "discord:default:dm:dm" : "feishu:default:chat";
      await first.control.bindConversation({ chatKey, conversationId: g.id, topicId: topic.id });
      const original = request("recover this", "before-restart", chatKey); original.metadata!.channel = platform;
      const accepted = (await first.runtime.bindings.accept(platform, original))!;
      await first.close();
      second = await compose({ state: first.state, path: first.path, agent: { chat: async (input) => {
        providerStarted = true;
        await new Promise<void>((resolve) => { finishProvider = resolve;
          input.abortSignal!.addEventListener("abort", resolve as () => void, { once: true }); });
        if (input.abortSignal!.aborted) throw new Error("provider cancelled");
        return { text: "recovered result" };
      } } });
      const resumed = second;
      const activation = resumed.runtime.activateAfterConsumerLock();
      await waitFor(() => providerStarted);
      let gateEntered = false;
      gate = resumed.runtime.bots.runLifecycle(bots[0]!.id, async () => {
        gateEntered = true; await new Promise<void>((resolve) => { releaseGate = resolve; });
      });
      await waitFor(() => gateEntered);
      const sent: string[] = [];
      const adapter = externalAdapter(platform, sent); registry = new MessageChannelRegistry([adapter.channel]);
      const normal: Agent = { isKnownCommand: (text) => text.startsWith("/"), chat: async () => {
        normalStops++; return { text: "ordinary Session" };
      } };
      startup = registry.startAll({ agent: normal, logger, quota, abortSignal: resumed.daemon.signal } as never,
        (id, agent) => createConversationChannelRouter(id, agent, resumed.runtime, resumed.events, resumed.daemon.signal));
      startup.catch(() => {}); await waitFor(adapter.ready);
      const pending = Promise.resolve(adapter.emit("pending-after-restart", "new acceptance")).catch((error) => error);
      await waitFor(() => (resumed.runtime.bindings as any).gates.get(chatKey)?.users === 1);
      expect(resumed.runtime.store.listRuns(g.id, topic.id)).toHaveLength(1);
      let stopReturned = false;
      const stop = Promise.resolve(adapter.emit("stop-blocked-acceptance", "/stop")).then(() => { stopReturned = true; });
      stop.catch(() => {});
      // The Bot gate remains held for every assertion here. R1 has no old
      // adapter controller, so only durable Stop lookup can cancel it.
      await waitFor(() => stopReturned && sent.some((text) => text.includes("Conversation stop requested.")));
      expect(resumed.runtime.store.getRun(accepted.run.id)).toMatchObject({ state: "cancelled", completionReason: "human-cancelled" });
      expect((resumed.runtime.bindings as any).gates.get(chatKey)?.users).toBe(1);
      expect(normalStops).toBe(0);
      await activation; await stop;
      releaseGate(); await gate; await pending;
      await waitFor(() => (resumed.runtime.bindings as any).gates.size === 0);
      expect(resumed.runtime.store.listRuns(g.id, topic.id)).toHaveLength(1);
      const pendingKey = createHash("sha256").update(JSON.stringify([platform, "default", chatKey, "pending-after-restart"])).digest("hex");
      expect(resumed.runtime.store.hasExternalRequest(pendingKey)).toBe(false);
    } finally {
      releaseGate(); finishProvider(); await gate; await first.close(); await second?.close(); await registry?.stopAll(); await startup;
    }
  });
  for (const reason of ["disabled", "removed"] as const) {
    test(`actual ${platform} stop(${reason}) detaches without cancelling durable ingress`, async () => {
      const current = await compose();
      const sent: string[] = [];
      const { channel, emit, ready } = externalAdapter(platform, sent);
      const registry = new MessageChannelRegistry([channel]);
      let startup: Promise<void> | undefined;
      try {
        const { group: g, topic } = await group(current);
        const chatKey = platform === "discord" ? "discord:default:dm:dm" : "feishu:default:chat";
        await current.control.bindConversation({ chatKey, conversationId: g.id, topicId: topic.id });
        startup = registry.startAll({ agent: current.normalAgent, logger, quota, abortSignal: current.daemon.signal } as never,
          (id, agent) => createConversationChannelRouter(id, agent, current.runtime, current.events, current.daemon.signal));
        startup.catch(() => {}); await waitFor(ready); await Bun.sleep(5);
        const response = Promise.resolve(emit("queued", "work")).catch((error) => error);
        await waitFor(() => current.runtime.store.listRuns(g.id, topic.id).length === 1);
        const runId = current.runtime.store.listRuns(g.id, topic.id)[0]!.id;
        await channel.stop(reason); await Bun.sleep(5);
        expect(current.daemon.signal.aborted).toBe(false);
        expect(current.runtime.store.getRun(runId)).toMatchObject({ state: "queued" });
        expect(current.runtime.store.getRun(runId)?.completionReason).toBeUndefined();
        expect((channel as any).activeTasks.size).toBe(0);
        expect(current.delegated()).toBe(0);
        await response; await current.close();
        const reopened = await SqliteConversationStore.open(current.path);
        try {
          expect(reopened.getRun(runId)?.state).toBe("queued");
          expect(reopened.getRun(runId)?.completionReason).toBeUndefined();
        } finally { reopened.close(); }
        expect(sent.some((text) => text.includes("provider result"))).toBe(false);
      } finally { await current.close(); await registry.stopAll(); await startup; }
    });
  }
  test(`actual ${platform} bound Conversation bypasses Session A lane, result storage and Stop after /use B`, async () => {
    let providerCalls = 0;
    let finishProvider = () => {};
    let providerAborted = false;
    const current = await compose({ agent: { chat: async (input) => {
      if (++providerCalls === 1) return { text: "provider result" };
      await new Promise<void>((resolve) => {
        finishProvider = resolve;
        input.abortSignal!.addEventListener("abort", () => { providerAborted = true; resolve(); }, { once: true });
      });
      if (input.abortSignal!.aborted) throw new Error("provider cancelled");
      return { text: "cancelled provider output" };
    } } });
    const sent: string[] = []; const active: string[] = []; const background: string[] = [];
    let sessionReads = 0;
    const peek = current.sessions.peekCurrentSessionAlias.bind(current.sessions);
    current.sessions.peekCurrentSessionAlias = (key) => { sessionReads++; return peek(key); };
    let finishOrdinary = () => {}; let ordinaryStarted = false;
    let ordinarySignal: AbortSignal | undefined;
    const chatKey = platform === "discord" ? "discord:default:dm:dm" : "feishu:default:chat";
    const { channel, emit } = externalAdapter(platform, sent);
    const registry = new MessageChannelRegistry([channel]); let startup: Promise<void> | undefined;
    const normalAgent: Agent = { isKnownCommand: (text) => text.startsWith("/use "), chat: async (input) => {
      if (input.text === "/use B") { await current.sessions.useSession(chatKey, "B"); return { text: "switched" }; }
      expect(input.metadata?.boundSessionAlias).toBe("A"); ordinarySignal = input.abortSignal; ordinaryStarted = true;
      await new Promise<void>((resolve) => { finishOrdinary = resolve; }); return { text: "ordinary finished" };
    } };
    const storeBackground = current.sessions.setBackgroundResult.bind(current.sessions);
    current.sessions.setBackgroundResult = async (...args) => { background.push(args[1]); await storeBackground(...args); };
    try {
      await current.sessions.createSession("A", "codex", "backend"); await current.sessions.createSession("B", "codex", "backend");
      await current.sessions.useSession(chatKey, "A");
      startup = registry.startAll({ agent: normalAgent, logger, quota, abortSignal: current.daemon.signal,
        sessions: current.sessions, activeTurns: { markActive: (_: string, alias: string) => active.push(alias), markInactive() {} } } as never,
        (id, agent) => createConversationChannelRouter(id, agent, current.runtime, current.events, current.daemon.signal));
      startup.catch(() => {}); await waitFor(() => platform === "discord" ? (channel as any).accounts.size > 0 : true);
      await Bun.sleep(10);
      const ordinary = emit("ordinary", "hold Session A"); await waitFor(() => ordinaryStarted);
      const taskFor = (messageId: string) => ([...(channel as any).activeTasks.values()].flat() as
        Array<{ messageId: string; suppressed: boolean; abortController: AbortController }>).find((task) => task.messageId === messageId);
      const ordinaryTask = taskFor("ordinary")!;
      expect(ordinarySignal).toBeDefined(); expect(ordinarySignal!.aborted).toBe(false);
      expect(active).toEqual(["A"]); active.length = 0;
      const readsBeforeConversation = sessionReads;
      const { group: g, topic } = await group(current);
      await current.control.bindConversation({ chatKey, conversationId: g.id, topicId: topic.id });
      const conversation = emit("conversation", "work");
      await waitFor(() => current.runtime.store.listRuns(g.id, topic.id).length === 1);
      expect(sessionReads).toBe(readsBeforeConversation);
      expect(active).toEqual([]); expect(background).toEqual([]);
      await emit("switch", "/use B"); await waitFor(() => current.sessions.peekCurrentSessionAlias(chatKey) === "B");
      await current.runtime.dispatcher.kick(); await conversation;
      await waitFor(() => sent.some((text) => text.includes("provider result")));
      expect(background).toEqual([]); expect(active).toEqual([]);
      expect(sent.filter((text) => text.includes("provider result"))).toHaveLength(1);
      // Keep A running while a second Conversation reaches the real provider.
      // A third Conversation is durably accepted into the core Topic queue.
      const toCancel = emit("cancel-conversation", "cancel this work");
      await waitFor(() => current.runtime.store.listRuns(g.id, topic.id).length === 2);
      const cancelledRun = current.runtime.store.listRuns(g.id, topic.id).find((run) => run.state === "queued")!;
      const dispatched = current.runtime.dispatcher.kick();
      await waitFor(() => providerCalls === 2);
      const queued = emit("queued-conversation", "queued work");
      await waitFor(() => current.runtime.store.listRuns(g.id, topic.id).length === 3);
      const queuedRun = current.runtime.store.listRuns(g.id, topic.id)[2]!;
      expect(queuedRun.state).toBe("queued");
      const queuedTask = taskFor("queued-conversation")!;
      await emit("stop", "/stop");
      await waitFor(() => current.runtime.store.getRun(cancelledRun.id)?.state === "cancelled");
      await toCancel; await queued; await dispatched;
      expect(providerAborted).toBe(true);
      expect(queuedTask.abortController.signal.aborted).toBe(true); expect(queuedTask.suppressed).toBe(true);
      expect(ordinarySignal!.aborted).toBe(false); expect(ordinaryTask.suppressed).toBe(false);
      expect(current.runtime.store.listRuns(g.id, topic.id)).toHaveLength(3);
      expect(current.runtime.store.getRun(queuedRun.id)?.state).toBe("cancelled");
      expect(providerCalls).toBe(2);
      expect(sent.some((text) => text.includes("cancelled provider output"))).toBe(false);
      expect(background).toEqual([]); expect(active).toEqual([]);
      // Only the genuine Session turn may later produce a Session completion.
      finishOrdinary(); await ordinary;
      await waitFor(() => background.length === 1); expect(background).toEqual(["A"]);
      expect(ordinarySignal!.aborted).toBe(false); expect(ordinaryTask.suppressed).toBe(false);
      expect(sent.some((text) => text.includes("ordinary finished"))).toBe(true);
    } finally { finishProvider(); finishOrdinary(); await current.close(); await registry.stopAll(); await startup; }
  });
}

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
      (id, agent) => createConversationChannelRouter(id, agent, current.runtime, current.events, current.daemon.signal));
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
      (id, agent) => createConversationChannelRouter(id, agent, current.runtime, current.events, current.daemon.signal));
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
