import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import feishuPlugin from "../../../../packages/channel-feishu/src/index";
import { createFeishuLarkClient } from "../../../../packages/channel-feishu/src/lark-client";
import { createMessageChannel, createMessageChannels, createMessageChannelFromRuntimeConfig, hasChannelFactory } from "../../../../src/channels/create-channel";
import { hasChannelCliProvider } from "../../../../src/channels/cli/registry";
import { registerChannelPlugin } from "../../../../src/channels/plugin";
import { setChannelLocale, t } from "../../../../packages/channel-feishu/src/i18n/index";
import { FeishuChannel } from "../../../../packages/channel-feishu/src/channel";
import type { ChatAgent } from "../../../../src/channels/types";
import type { FeishuMessageEvent } from "../../../../packages/channel-feishu/src/types";
import { RuntimeMediaStore } from "../../../../packages/channel-feishu/src/media-store";

function ensureFeishuPluginRegisteredForTest(): void {
  const factoryRegistered = hasChannelFactory("feishu");
  const cliProviderRegistered = hasChannelCliProvider("feishu");
  if (factoryRegistered !== cliProviderRegistered) {
    throw new Error("inconsistent feishu test registration state");
  }
  if (!factoryRegistered) registerChannelPlugin(feishuPlugin.channels![0]!);
}

beforeAll(() => {
  ensureFeishuPluginRegisteredForTest();
  setChannelLocale("zh");
});

afterAll(() => {
  setChannelLocale("en");
});

function createNoopQuota() {
  return {
    onInbound() {},
    reserveMidSegment: () => true,
    reserveFinal: () => true,
    finalRemaining: () => 4,
    hasPendingFinal: () => false,
    drainPendingFinalUpToBudget: () => [],
    prependPendingFinal() {},
    enqueuePendingFinal() {},
    clearPendingFinal() {},
  };
}

function createNoopLogger() {
  return {
    info: async () => {},
    warn: async () => {},
    error: async () => {},
    debug: async () => {},
    cleanup: async () => {},
    flush: async () => {},
  } as never;
}


function createFeishuTestClient(sent: unknown[]) {
  return {
    sdk: {
      im: {
        message: {
          reply: async (payload: unknown) => {
            sent.push(payload);
            return { data: { message_id: "om_reply", chat_id: "oc_chat" } };
          },
          create: async (payload: unknown) => {
            sent.push(payload);
            return { data: { message_id: "om_created", chat_id: "oc_chat" } };
          },
        },
      },
    },
    probeBot: async () => ({ botOpenId: "ou_bot" }),
    startWS: async () => {},
  };
}

const defaultFeishuConfig = {
  appId: "cli_test",
  appSecret: "secret_test",
  domain: "feishu",
  requireMention: true,
  textMessageFormat: "text" as const,
  dedupTtlMs: 43_200_000,
  dedupMaxEntries: 5000,
};

test("createFeishuLarkClient uses injected sdk client", () => {
  const sdk = { im: { message: {} } };
  const client = createFeishuLarkClient({
    appId: "cli_test",
    appSecret: "secret_test",
    domain: "feishu",
    injectedSdkClient: sdk,
  });

  expect(client.sdk).toBe(sdk);
});

test("createMessageChannel('feishu') returns a feishu channel", () => {
  const channel = createMessageChannel("feishu", {
    options: defaultFeishuConfig,
  });

  expect(channel.id).toBe("feishu");
});

test("FeishuChannel reports configured credentials as logged in", () => {
  const channel = new FeishuChannel(defaultFeishuConfig);

  expect(channel.isLoggedIn()).toBe(true);
});

test("FeishuChannel.start routes text websocket events to agent and replies", async () => {
  let handlers: Record<string, (data: unknown) => Promise<void> | void> = {};
  const sent: unknown[] = [];
  const channel = new FeishuChannel(
    defaultFeishuConfig,
    {
      createClient: () => ({
        sdk: {
          im: {
            message: {
              reply: async (payload: unknown) => {
                sent.push(payload);
                return { data: { message_id: "om_reply", chat_id: "oc_chat" } };
              },
              create: async () => {
                throw new Error("create should not be called");
              },
            },
          },
        },
        probeBot: async () => ({ botOpenId: "ou_bot" }),
        startWS: async (input: { handlers: Record<string, (data: unknown) => Promise<void> | void> }) => {
          handlers = input.handlers;
        },
      }),
    },
  );
  const requests: unknown[] = [];
  const agent: ChatAgent = {
    async chat(request) {
      requests.push(request);
      return { text: `echo:${request.text}` };
    },
  };

  await channel.start({ agent, abortSignal: new AbortController().signal, quota: createNoopQuota(), logger: createNoopLogger() });

  const event: FeishuMessageEvent = {
    sender: { sender_id: { open_id: "ou_sender" } },
    message: {
      message_id: "om_in",
      chat_id: "oc_chat",
      chat_type: "p2p",
      message_type: "text",
      content: JSON.stringify({ text: "hello" }),
      create_time: String(Date.now()),
    },
  };
  await handlers["im.message.receive_v1"]!(event);

  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    accountId: "default",
    conversationId: "feishu:default:oc_chat",
    text: "hello",
    replyContextToken: "om_in",
  });
  expect(sent).toEqual([
    {
      path: { message_id: "om_in" },
      data: { msg_type: "text", content: JSON.stringify({ text: "echo:hello" }) },
    },
  ]);
});


test("FeishuChannel sends scheduled notice, streaming reply, and final text as Feishu replies", async () => {
  const sent: unknown[] = [];
  const requests: unknown[] = [];
  const abortController = new AbortController();
  const channel = new FeishuChannel(defaultFeishuConfig, {
    createClient: () => createFeishuTestClient(sent),
  });
  const agent: ChatAgent = {
    async chat(request) {
      requests.push(request);
      await request.reply?.("  intermediate reply  ");
      return { text: "  final text  " };
    },
  };

  await channel.start({ agent, abortSignal: new AbortController().signal, quota: createNoopQuota(), logger: createNoopLogger() });

  await channel.sendScheduledMessage({
    chatKey: "feishu:default:oc_chat",
    taskId: "task-42",
    sessionAlias: "daily",
    accountId: "default",
    replyContextToken: "om_schedule",
    noticeText: "notice text",
    promptText: "prompt text",
    abortSignal: abortController.signal,
  });

  expect(sent).toEqual([
    { path: { message_id: "om_schedule" }, data: { msg_type: "text", content: JSON.stringify({ text: "notice text" }) } },
    { path: { message_id: "om_schedule" }, data: { msg_type: "text", content: JSON.stringify({ text: "intermediate reply" }) } },
    { path: { message_id: "om_schedule" }, data: { msg_type: "text", content: JSON.stringify({ text: "final text" }) } },
  ]);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    accountId: "default",
    conversationId: "feishu:default:oc_chat",
    text: "prompt text",
    replyContextToken: "om_schedule",
    metadata: { channel: "feishu", scheduledSessionAlias: "daily" },
  });
  expect((requests[0] as { abortSignal?: AbortSignal }).abortSignal).toBe(abortController.signal);
});

test("FeishuChannel logs unsupported scheduled media without failing text delivery", async () => {
  const sent: unknown[] = [];
  const errorLogs: Array<{ event: string; ctx?: Record<string, unknown> }> = [];
  const channel = new FeishuChannel(defaultFeishuConfig, {
    createClient: () => createFeishuTestClient(sent),
  });
  const agent: ChatAgent = {
    async chat() {
      return { text: "scheduled done", media: [{ kind: "image", filePath: "/tmp/out.png" }] };
    },
  };

  await channel.start({
    agent,
    abortSignal: new AbortController().signal,
    quota: createNoopQuota(),
    logger: {
      info: async () => {},
      error: async (event: string, _message: string, ctx?: Record<string, unknown>) => {
        errorLogs.push({ event, ctx });
      },
      debug: async () => {},
      cleanup: async () => {},
      flush: async () => {},
    } as never,
  });

  await channel.sendScheduledMessage({
    chatKey: "feishu:default:oc_chat",
    taskId: "task-media",
    sessionAlias: "daily",
    accountId: "default",
    replyContextToken: "om_schedule",
    noticeText: "notice text",
    promptText: "prompt text",
  });

  expect(sent).toEqual([
    { path: { message_id: "om_schedule" }, data: { msg_type: "text", content: JSON.stringify({ text: "notice text" }) } },
    { path: { message_id: "om_schedule" }, data: { msg_type: "text", content: JSON.stringify({ text: "scheduled done" }) } },
  ]);
  expect(errorLogs).toEqual([
    {
      event: "feishu.scheduled.media_unsupported",
      ctx: expect.objectContaining({
        accountId: "default",
        chatKey: "feishu:default:oc_chat",
        taskId: "task-media",
        sessionAlias: "daily",
        count: 1,
      }),
    },
  ]);
});

test("FeishuChannel does not send late scheduled text or media log after abort", async () => {
  const sent: unknown[] = [];
  const errorLogs: unknown[] = [];
  const abortController = new AbortController();
  const channel = new FeishuChannel(defaultFeishuConfig, {
    createClient: () => createFeishuTestClient(sent),
  });
  const agent: ChatAgent = {
    async chat(request) {
      await request.reply?.("before abort");
      abortController.abort();
      await request.reply?.("after abort");
      return { text: "late final", media: [{ kind: "image", filePath: "/tmp/out.png" }] };
    },
  };

  await channel.start({
    agent,
    abortSignal: new AbortController().signal,
    quota: createNoopQuota(),
    logger: {
      info: async () => {},
      error: async (...args: unknown[]) => {
        errorLogs.push(args);
      },
      debug: async () => {},
      cleanup: async () => {},
      flush: async () => {},
    } as never,
  });

  await channel.sendScheduledMessage({
    chatKey: "feishu:default:oc_chat",
    sessionAlias: "daily",
    replyContextToken: "om_schedule",
    noticeText: "notice text",
    promptText: "prompt text",
    abortSignal: abortController.signal,
  });

  expect(sent).toEqual([
    { path: { message_id: "om_schedule" }, data: { msg_type: "text", content: JSON.stringify({ text: "notice text" }) } },
    { path: { message_id: "om_schedule" }, data: { msg_type: "text", content: JSON.stringify({ text: "before abort" }) } },
  ]);
  expect(errorLogs).toHaveLength(0);
});

test("FeishuChannel rejects scheduled accountId mismatch with chatKey account", async () => {
  const sent: unknown[] = [];
  const channel = new FeishuChannel(defaultFeishuConfig, {
    createClient: () => createFeishuTestClient(sent),
  });

  await channel.start({
    agent: { async chat() { return { text: "should not run" }; } },
    abortSignal: new AbortController().signal,
    quota: createNoopQuota(),
    logger: createNoopLogger(),
  });

  await expect(channel.sendScheduledMessage({
    chatKey: "feishu:default:oc_chat",
    accountId: "other",
    sessionAlias: "daily",
    replyContextToken: "om_schedule",
    noticeText: "notice text",
    promptText: "prompt text",
  })).rejects.toThrow('scheduled Feishu accountId "other" does not match chatKey account "default"');
  expect(sent).toHaveLength(0);
});

test("FeishuChannel sends scheduled failure notice after agent failure and rethrows", async () => {
  const sent: unknown[] = [];
  const channel = new FeishuChannel(defaultFeishuConfig, {
    createClient: () => createFeishuTestClient(sent),
  });
  const agent: ChatAgent = {
    async chat() {
      throw new Error("agent exploded");
    },
  };

  await channel.start({ agent, abortSignal: new AbortController().signal, quota: createNoopQuota(), logger: createNoopLogger() });

  await expect(channel.sendScheduledMessage({
    chatKey: "feishu:default:oc_chat",
    taskId: "task-42",
    sessionAlias: "daily",
    replyContextToken: "om_schedule",
    noticeText: "notice text",
    promptText: "prompt text",
  })).rejects.toThrow("agent exploded");

  expect(sent).toEqual([
    { path: { message_id: "om_schedule" }, data: { msg_type: "text", content: JSON.stringify({ text: "notice text" }) } },
    { path: { message_id: "om_schedule" }, data: { msg_type: "text", content: JSON.stringify({ text: t().scheduledFailureWithId("task-42", "agent exploded") }) } },
  ]);
});

test("FeishuChannel renders scheduled streaming output into a card", async () => {
  const sent: Array<{ data?: { msg_type?: string; content?: string } }> = [];
  const cardCreates: unknown[] = [];
  const cardUpdates: Array<{ data: string }> = [];
  const channel = new FeishuChannel(
    { ...defaultFeishuConfig, replyMode: "streaming" as const },
    {
      createClient: () => ({
        sdk: {
          im: {
            message: {
              reply: async (payload: unknown) => { sent.push(payload as never); return { data: { message_id: "om_reply", chat_id: "oc_chat" } }; },
              create: async (payload: unknown) => { sent.push(payload as never); return { data: { message_id: "om_created", chat_id: "oc_chat" } }; },
            },
          },
          cardkit: {
            v1: {
              card: {
                create: async (payload: unknown) => { cardCreates.push(payload); return { data: { card_id: "card_1" } }; },
                update: async (payload: { data: { card: { data: string } } }) => { cardUpdates.push({ data: payload.data.card.data }); return {}; },
              },
              cardElement: { content: async () => ({}) },
            },
          },
        },
        probeBot: async () => ({ botOpenId: "ou_bot" }),
        startWS: async () => {},
      }),
    },
  );
  const agent: ChatAgent = {
    async chat(request) {
      await request.reply?.("streaming chunk");
      return { text: "final card answer" };
    },
  };

  await channel.start({ agent, abortSignal: new AbortController().signal, quota: createNoopQuota(), logger: createNoopLogger() });

  await channel.sendScheduledMessage({
    chatKey: "feishu:default:oc_chat",
    taskId: "task-card",
    sessionAlias: "daily",
    replyContextToken: "om_schedule",
    noticeText: "执行定时任务 #task-card",
    promptText: "总结",
  });

  // Trigger notice stays a plain-text reply, delivered first.
  expect(sent[0]).toMatchObject({
    path: { message_id: "om_schedule" },
    data: { msg_type: "text", content: JSON.stringify({ text: "执行定时任务 #task-card" }) },
  });
  // A streaming card was seeded and the interactive message attached to the chat.
  expect(cardCreates).toHaveLength(1);
  expect(sent.some((p) => p.data?.msg_type === "interactive")).toBe(true);
  // Agent output drove card updates, and the final answer landed in the card.
  expect(cardUpdates.length).toBeGreaterThan(0);
  expect(cardUpdates.map((u) => u.data).join(" ")).toContain("final card answer");
  // The only plain-text message was the trigger notice — the answer is NOT a plain reply.
  const plainContents = sent.filter((p) => p.data?.msg_type === "text").map((p) => p.data!.content);
  expect(plainContents).toEqual([JSON.stringify({ text: "执行定时任务 #task-card" })]);
});

test("FeishuChannel sends coordinator messages to feishu chat keys", async () => {
  const sent: unknown[] = [];
  const channel = new FeishuChannel(
    defaultFeishuConfig,
    {
      createClient: () => ({
        sdk: {
          im: {
            message: {
              reply: async (payload: unknown) => {
                sent.push(payload);
                return { data: { message_id: "om_reply", chat_id: "oc_chat" } };
              },
              create: async () => {
                throw new Error("create should not be called");
              },
            },
          },
        },
        probeBot: async () => ({ botOpenId: "ou_bot" }),
        startWS: async () => {},
      }),
    },
  );

  await channel.start({
    agent: { async chat() { return { text: "" }; } },
    abortSignal: new AbortController().signal,
    quota: createNoopQuota(),
    logger: createNoopLogger(),
  });

  await channel.sendCoordinatorMessage({
    coordinatorSession: "coord",
    chatKey: "feishu:default:oc_chat",
    replyContextToken: "om_in",
    text: "wake up",
  });

  expect(sent).toEqual([
    {
      path: { message_id: "om_in" },
      data: { msg_type: "text", content: JSON.stringify({ text: "wake up" }) },
    },
  ]);
});

test("FeishuChannel routes per-account inbound and outbound across multiple bots", async () => {
  const handlersByAccount: Record<string, Record<string, (data: unknown) => Promise<void> | void>> = {};
  const sentByAccount: Record<string, unknown[]> = { main: [], review: [] };
  const probedAccounts: string[] = [];

  const channel = new FeishuChannel(
    {
      defaultAccount: "main",
      requireMention: false,
      accounts: {
        main: { appId: "main_app", appSecret: "main_secret" },
        review: { appId: "review_app", appSecret: "review_secret" },
      },
    },
    {
      createClient: (account) => ({
        sdk: {
          im: {
            message: {
              reply: async (payload: unknown) => {
                sentByAccount[account.accountId]!.push(payload);
                return { data: { message_id: "om_reply", chat_id: "oc_chat" } };
              },
              create: async () => {
                throw new Error("create should not be called");
              },
            },
          },
        },
        probeBot: async () => {
          probedAccounts.push(account.accountId);
          return { botOpenId: `ou_bot_${account.accountId}` };
        },
        startWS: async (input: { handlers: Record<string, (data: unknown) => Promise<void> | void> }) => {
          handlersByAccount[account.accountId] = input.handlers;
        },
        stop: () => {},
      }),
    },
  );
  const requests: Array<{ accountId: string; conversationId: string; text: string }> = [];
  const agent: ChatAgent = {
    async chat(request) {
      requests.push({ accountId: request.accountId, conversationId: request.conversationId, text: request.text });
      return { text: `${request.accountId}-echo:${request.text}` };
    },
  };

  await channel.start({ agent, abortSignal: new AbortController().signal, quota: createNoopQuota(), logger: createNoopLogger() });

  expect(probedAccounts.sort()).toEqual(["main", "review"]);

  // inbound on review account
  const reviewEvent: FeishuMessageEvent = {
    sender: { sender_id: { open_id: "ou_user" } },
    message: {
      message_id: "om_review",
      chat_id: "oc_review",
      chat_type: "p2p",
      message_type: "text",
      content: JSON.stringify({ text: "review please" }),
      create_time: String(Date.now()),
    },
  };
  await handlersByAccount.review!["im.message.receive_v1"]!(reviewEvent);

  expect(requests).toEqual([
    { accountId: "review", conversationId: "feishu:review:oc_review", text: "review please" },
  ]);
  expect(sentByAccount.review).toHaveLength(1);
  expect(sentByAccount.main).toHaveLength(0);

  // outbound coordinator message routed by chatKey accountId
  await channel.sendCoordinatorMessage({
    coordinatorSession: "coord",
    chatKey: "feishu:main:oc_main",
    replyContextToken: "om_main",
    text: "hi main",
  });

  expect(sentByAccount.main).toEqual([
    {
      path: { message_id: "om_main" },
      data: { msg_type: "text", content: JSON.stringify({ text: "hi main" }) },
    },
  ]);
});

test("FeishuChannel drops inbound message when access policy denies sender", async () => {
  let handlers: Record<string, (data: unknown) => Promise<void> | void> = {};
  const sent: unknown[] = [];
  const channel = new FeishuChannel(
    {
      appId: "cli_test",
      appSecret: "secret_test",
      requireMention: false,
      dmPolicy: "allowlist",
      allowFrom: ["ou_admin"],
    },
    {
      createClient: () => ({
        sdk: {
          im: {
            message: {
              reply: async (payload: unknown) => {
                sent.push(payload);
                return { data: { message_id: "om_reply", chat_id: "oc_chat" } };
              },
              create: async () => {
                throw new Error("create should not be called");
              },
            },
          },
        },
        probeBot: async () => ({ botOpenId: "ou_bot" }),
        startWS: async (input: { handlers: Record<string, (data: unknown) => Promise<void> | void> }) => {
          handlers = input.handlers;
        },
        stop: () => {},
      }),
    },
  );
  const requests: unknown[] = [];
  const agent: ChatAgent = {
    async chat(request) {
      requests.push(request);
      return { text: "should not reach" };
    },
  };
  await channel.start({ agent, abortSignal: new AbortController().signal, quota: createNoopQuota(), logger: createNoopLogger() });

  const event: FeishuMessageEvent = {
    sender: { sender_id: { open_id: "ou_outsider" } },
    message: {
      message_id: "om_blocked",
      chat_id: "oc_dm",
      chat_type: "p2p",
      message_type: "text",
      content: JSON.stringify({ text: "hi" }),
      create_time: String(Date.now()),
    },
  };
  await handlers["im.message.receive_v1"]!(event);

  expect(requests).toHaveLength(0);
  expect(sent).toHaveLength(0);
});

test("FeishuChannel skips disabled accounts and only starts WS for enabled ones", async () => {
  const wsStartedFor: string[] = [];
  const channel = new FeishuChannel(
    {
      defaultAccount: "main",
      requireMention: false,
      accounts: {
        main: { appId: "main_app", appSecret: "main_secret" },
        ops: { appId: "ops_app", appSecret: "ops_secret", enabled: false },
      },
    },
    {
      createClient: (account) => ({
        sdk: { im: { message: { reply: async () => ({}), create: async () => ({}) } } },
        probeBot: async () => ({ botOpenId: `ou_${account.accountId}` }),
        startWS: async () => {
          wsStartedFor.push(account.accountId);
        },
        stop: () => {},
      }),
    },
  );
  await channel.start({
    agent: { async chat() { return { text: "" }; } },
    abortSignal: new AbortController().signal,
    quota: createNoopQuota(),
    logger: createNoopLogger(),
  });

  expect(wsStartedFor).toEqual(["main"]);
  await expect(channel.sendCoordinatorMessage({
    coordinatorSession: "coord",
    chatKey: "feishu:ops:oc_chat",
    replyContextToken: "om_x",
    text: "ops",
  })).rejects.toThrow('feishu account "ops" is not started');
});

test("FeishuChannel routes outbound to threaded chatKey on a non-default account", async () => {
  const sentByAccount: Record<string, unknown[]> = { main: [], review: [] };
  const channel = new FeishuChannel(
    {
      defaultAccount: "main",
      requireMention: false,
      accounts: {
        main: { appId: "main_app", appSecret: "main_secret" },
        review: { appId: "review_app", appSecret: "review_secret" },
      },
    },
    {
      createClient: (account) => ({
        sdk: {
          im: {
            message: {
              reply: async (payload: unknown) => {
                sentByAccount[account.accountId]!.push(payload);
                return { data: { message_id: "om_reply", chat_id: "oc_chat" } };
              },
              create: async () => {
                throw new Error("create should not be called");
              },
            },
          },
        },
        probeBot: async () => ({ botOpenId: `ou_${account.accountId}` }),
        startWS: async () => {},
        stop: () => {},
      }),
    },
  );
  await channel.start({
    agent: { async chat() { return { text: "" }; } },
    abortSignal: new AbortController().signal,
    quota: createNoopQuota(),
    logger: createNoopLogger(),
  });

  await channel.sendCoordinatorMessage({
    coordinatorSession: "coord",
    chatKey: "feishu:review:oc_review:thread:om_root",
    replyContextToken: "om_root",
    text: "thread reply",
  });

  expect(sentByAccount.review).toEqual([
    {
      path: { message_id: "om_root" },
      data: { msg_type: "text", content: JSON.stringify({ text: "thread reply" }) },
    },
  ]);
  expect(sentByAccount.main).toHaveLength(0);
});

test("FeishuChannel sendRouteText fails fast for unknown account ids", async () => {
  const channel = new FeishuChannel(
    defaultFeishuConfig,
    {
      createClient: () => ({
        sdk: { im: { message: { reply: async () => ({}), create: async () => ({}) } } },
        probeBot: async () => ({ botOpenId: "ou_bot" }),
        startWS: async () => {},
        stop: () => {},
      }),
    },
  );
  await channel.start({
    agent: { async chat() { return { text: "" }; } },
    abortSignal: new AbortController().signal,
    quota: createNoopQuota(),
    logger: createNoopLogger(),
  });

  await expect(channel.sendCoordinatorMessage({
    coordinatorSession: "coord",
    chatKey: "feishu:ghost:oc_chat",
    replyContextToken: "om_x",
    text: "nope",
  })).rejects.toThrow('feishu account "ghost" is not started');
});

test("createMessageChannels creates enabled runtime channels", () => {
  const channels = createMessageChannels([
    { id: "weixin", type: "weixin", enabled: true },
    { id: "feishu", type: "feishu", enabled: true, options: defaultFeishuConfig },
    { id: "disabled", type: "weixin", enabled: false },
  ]);

  expect(channels.map((channel) => channel.id)).toEqual(["weixin", "feishu"]);
});

test("createMessageChannelFromRuntimeConfig rejects mismatched id and type", () => {
  expect(() =>
    createMessageChannelFromRuntimeConfig({ id: "feishu-main", type: "feishu", enabled: true, options: defaultFeishuConfig }),
  ).toThrow('channels.feishu-main.id must equal type "feishu"');
});

test("FeishuChannel downloads inbound image and forwards media to agent", async () => {
  let handlers: Record<string, (data: unknown) => Promise<void> | void> = {};
  const sent: unknown[] = [];
  const tmpBase = join(process.cwd(), ".test-tmp");
  await mkdir(tmpBase, { recursive: true });
  const mediaRootDir = await mkdtemp(join(tmpBase, "weacpx-test-media-"));
  const mediaStore = new RuntimeMediaStore({ rootDir: mediaRootDir });
  try {
    const channel = new FeishuChannel(
      defaultFeishuConfig,
      {
        createClient: () => ({
          sdk: {
            im: {
              message: {
                reply: async (payload: unknown) => {
                  sent.push(payload);
                  return { data: { message_id: "om_reply", chat_id: "oc_chat" } };
                },
                create: async () => {
                  throw new Error("create should not be called");
                },
              },
              messageResource: {
                get: async () => Buffer.from("fake-image-data"),
              },
            },
          },
          probeBot: async () => ({ botOpenId: "ou_bot" }),
          startWS: async (input: { handlers: Record<string, (data: unknown) => Promise<void> | void> }) => {
            handlers = input.handlers;
          },
        }),
        mediaStore,
      },
    );
    const requests: unknown[] = [];
    const agent: ChatAgent = {
      async chat(request) {
        requests.push(request);
        return { text: "got it" };
      },
    };

    await channel.start({ agent, abortSignal: new AbortController().signal, quota: createNoopQuota(), logger: createNoopLogger() });

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou_sender" } },
      message: {
        message_id: "om_img",
        chat_id: "oc_chat",
        chat_type: "p2p",
        message_type: "image",
        content: JSON.stringify({ image_key: "img_v2_test" }),
        create_time: String(Date.now()),
      },
    };
    await handlers["im.message.receive_v1"]!(event);

    expect(requests).toHaveLength(1);
    const request = requests[0] as { text: string; media?: Array<{ kind: string }> };
    expect(request.text).toContain("img_v2_test");
    expect(request.media).toBeDefined();
    expect(request.media!.length).toBe(1);
    expect(request.media![0].kind).toBe("image");
  } finally {
    await rm(mediaRootDir, { recursive: true, force: true });
  }
});

test("FeishuChannel rejects outbound remote media URLs before sending", async () => {
  let handlers: Record<string, (data: unknown) => Promise<void> | void> = {};
  const sentMedia: unknown[] = [];
  const errorLogs: string[] = [];
  const channel = new FeishuChannel(
    defaultFeishuConfig,
    {
      createClient: () => ({
        sdk: {
          im: {
            message: {
              reply: async () => ({ data: { message_id: "om_reply", chat_id: "oc_chat" } }),
              create: async () => ({ data: { message_id: "om_create", chat_id: "oc_chat" } }),
            },
          },
        },
        probeBot: async () => ({ botOpenId: "ou_bot" }),
        startWS: async (input: { handlers: Record<string, (data: unknown) => Promise<void> | void> }) => {
          handlers = input.handlers;
        },
      }),
    },
  );
  const agent: ChatAgent = {
    async chat() {
      return {
        text: "done",
        media: [{ kind: "image", filePath: "https://evil.example.com/steal.png" }],
      };
    },
  };

  await channel.start({
    agent,
    abortSignal: new AbortController().signal,
    quota: createNoopQuota(),
    logger: {
      info: async () => {},
      error: async (_event: string, _msg: string, ctx?: Record<string, unknown>) => {
        errorLogs.push(String(ctx?.filePath ?? ""));
      },
      debug: async () => {},
      cleanup: async () => {},
      flush: async () => {},
    } as never,
  });

  const event: FeishuMessageEvent = {
    sender: { sender_id: { open_id: "ou_sender" } },
    message: {
      message_id: "om_txt",
      chat_id: "oc_chat",
      chat_type: "p2p",
      message_type: "text",
      content: JSON.stringify({ text: "send image" }),
      create_time: String(Date.now()),
    },
  };
  await handlers["im.message.receive_v1"]!(event);

  expect(sentMedia).toHaveLength(0);
  expect(errorLogs.some((log) => log.includes("https://evil.example.com/steal.png"))).toBe(true);
});

test("FeishuChannel rejects outbound media pointing to a directory", async () => {
  let handlers: Record<string, (data: unknown) => Promise<void> | void> = {};
  const errorLogs: string[] = [];
  const channel = new FeishuChannel(
    defaultFeishuConfig,
    {
      createClient: () => ({
        sdk: {
          im: {
            message: {
              reply: async () => ({ data: { message_id: "om_reply", chat_id: "oc_chat" } }),
              create: async () => ({ data: { message_id: "om_create", chat_id: "oc_chat" } }),
            },
          },
        },
        probeBot: async () => ({ botOpenId: "ou_bot" }),
        startWS: async (input: { handlers: Record<string, (data: unknown) => Promise<void> | void> }) => {
          handlers = input.handlers;
        },
      }),
    },
  );
  const agent: ChatAgent = {
    async chat() {
      return {
        text: "done",
        media: [{ kind: "file", filePath: process.cwd() }],
      };
    },
  };

  await channel.start({
    agent,
    abortSignal: new AbortController().signal,
    quota: createNoopQuota(),
    logger: {
      info: async () => {},
      error: async (_event: string, _msg: string, ctx?: Record<string, unknown>) => {
        errorLogs.push(String(ctx?.filePath ?? ""));
      },
      debug: async () => {},
      cleanup: async () => {},
      flush: async () => {},
    } as never,
  });

  const event: FeishuMessageEvent = {
    sender: { sender_id: { open_id: "ou_sender" } },
    message: {
      message_id: "om_txt",
      chat_id: "oc_chat",
      chat_type: "p2p",
      message_type: "text",
      content: JSON.stringify({ text: "send dir" }),
      create_time: String(Date.now()),
    },
  };
  await handlers["im.message.receive_v1"]!(event);

  expect(errorLogs.some((log) => log.includes(process.cwd()))).toBe(true);
});

function groupEvent(messageId: string, senderOpenId: string, text: string): FeishuMessageEvent {
  return {
    sender: { sender_id: { open_id: senderOpenId } },
    message: {
      message_id: messageId,
      chat_id: "oc_group",
      chat_type: "group",
      message_type: "text",
      content: JSON.stringify({ text }),
      create_time: String(Date.now()),
      mentions: [{ key: "@bot", id: { open_id: "ou_bot" } }],
    },
  };
}

test("trustGroupOwner asserts isOwner on group turns from the chat owner", async () => {
  let handlers: Record<string, (data: unknown) => Promise<void> | void> = {};
  let ownerLookups = 0;
  const channel = new FeishuChannel(
    { ...defaultFeishuConfig, trustGroupOwner: true },
    {
      createClient: () => ({
        sdk: { im: { message: { reply: async () => ({}), create: async () => ({}) } } },
        probeBot: async () => ({ botOpenId: "ou_bot" }),
        getChatOwner: async () => {
          ownerLookups += 1;
          return "ou_owner";
        },
        startWS: async (input: { handlers: Record<string, (data: unknown) => Promise<void> | void> }) => {
          handlers = input.handlers;
        },
      }),
    },
  );
  const requests: { metadata?: Record<string, unknown> }[] = [];
  const agent: ChatAgent = {
    async chat(request) {
      requests.push(request as { metadata?: Record<string, unknown> });
      return { text: "ok" };
    },
  };

  await channel.start({ agent, abortSignal: new AbortController().signal, quota: createNoopQuota(), logger: createNoopLogger() });

  await handlers["im.message.receive_v1"]!(groupEvent("om_g1", "ou_owner", "@bot /use demo"));
  await handlers["im.message.receive_v1"]!(groupEvent("om_g2", "ou_member", "@bot /use demo"));

  expect(requests).toHaveLength(2);
  expect(requests[0]!.metadata).toMatchObject({ channel: "feishu", chatType: "group", senderId: "ou_owner", groupId: "oc_group", isOwner: true });
  expect(requests[1]!.metadata).toMatchObject({ senderId: "ou_member" });
  expect(requests[1]!.metadata!.isOwner).toBeUndefined();
  // One cached owner lookup serves both messages.
  expect(ownerLookups).toBe(1);
});

test("trustGroupOwner lookup failure leaves isOwner absent (fail closed)", async () => {
  let handlers: Record<string, (data: unknown) => Promise<void> | void> = {};
  const channel = new FeishuChannel(
    { ...defaultFeishuConfig, trustGroupOwner: true },
    {
      createClient: () => ({
        sdk: { im: { message: { reply: async () => ({}), create: async () => ({}) } } },
        probeBot: async () => ({ botOpenId: "ou_bot" }),
        getChatOwner: async () => {
          throw new Error("scope missing");
        },
        startWS: async (input: { handlers: Record<string, (data: unknown) => Promise<void> | void> }) => {
          handlers = input.handlers;
        },
      }),
    },
  );
  const requests: { metadata?: Record<string, unknown> }[] = [];
  const agent: ChatAgent = {
    async chat(request) {
      requests.push(request as { metadata?: Record<string, unknown> });
      return { text: "ok" };
    },
  };

  await channel.start({ agent, abortSignal: new AbortController().signal, quota: createNoopQuota(), logger: createNoopLogger() });

  await handlers["im.message.receive_v1"]!(groupEvent("om_g3", "ou_owner", "@bot /use demo"));

  expect(requests).toHaveLength(1);
  expect(requests[0]!.metadata!.isOwner).toBeUndefined();
});

test("trustGroupOwner off never queries the chat owner", async () => {
  let handlers: Record<string, (data: unknown) => Promise<void> | void> = {};
  let ownerLookups = 0;
  const channel = new FeishuChannel(
    defaultFeishuConfig,
    {
      createClient: () => ({
        sdk: { im: { message: { reply: async () => ({}), create: async () => ({}) } } },
        probeBot: async () => ({ botOpenId: "ou_bot" }),
        getChatOwner: async () => {
          ownerLookups += 1;
          return "ou_owner";
        },
        startWS: async (input: { handlers: Record<string, (data: unknown) => Promise<void> | void> }) => {
          handlers = input.handlers;
        },
      }),
    },
  );
  const requests: { metadata?: Record<string, unknown> }[] = [];
  const agent: ChatAgent = {
    async chat(request) {
      requests.push(request as { metadata?: Record<string, unknown> });
      return { text: "ok" };
    },
  };

  await channel.start({ agent, abortSignal: new AbortController().signal, quota: createNoopQuota(), logger: createNoopLogger() });

  await handlers["im.message.receive_v1"]!(groupEvent("om_g4", "ou_owner", "@bot /use demo"));

  expect(requests).toHaveLength(1);
  expect(requests[0]!.metadata!.isOwner).toBeUndefined();
  expect(ownerLookups).toBe(0);
});

test("trustGroupOwner pending lookup keeps the bound session marked active", async () => {
  let handlers: Record<string, (data: unknown) => Promise<void> | void> = {};
  let releaseOwnerLookup: ((ownerId: string) => void) | undefined;
  const channel = new FeishuChannel(
    { ...defaultFeishuConfig, trustGroupOwner: true },
    {
      createClient: () => ({
        sdk: { im: { message: { reply: async () => ({}), create: async () => ({}) } } },
        probeBot: async () => ({ botOpenId: "ou_bot" }),
        getChatOwner: () =>
          new Promise<string | undefined>((resolve) => {
            releaseOwnerLookup = resolve;
          }),
        stop: () => {},
        startWS: async (input: { handlers: Record<string, (data: unknown) => Promise<void> | void> }) => {
          handlers = input.handlers;
        },
      }),
    },
  );
  const requests: { metadata?: Record<string, unknown> }[] = [];
  const agent: ChatAgent = {
    async chat(request) {
      requests.push(request as { metadata?: Record<string, unknown> });
      return { text: "ok" };
    },
  };
  const activeKeys = new Set<string>();
  const activeTurns = {
    markActive: (_chatKey: string, alias: string) => activeKeys.add(alias),
    markInactive: (_chatKey: string, alias: string) => activeKeys.delete(alias),
    isActive: (_chatKey: string, alias: string) => activeKeys.has(alias),
    isActiveAnywhere: (alias: string) => activeKeys.has(alias),
  };
  const sessions = { peekCurrentSessionAlias: () => "demo" };

  await channel.start({
    agent,
    abortSignal: new AbortController().signal,
    quota: createNoopQuota(),
    logger: createNoopLogger(),
    activeTurns: activeTurns as never,
    sessions: sessions as never,
  });

  const handled = handlers["im.message.receive_v1"]!(groupEvent("om_g5", "ou_owner", "@bot hello"));
  // The turn is blocked inside the owner lookup, but the dispatch-bound
  // session must already be under active-turn protection (archive refusal,
  // running-state reporting) - exactly the window the lookup opened up.
  for (let i = 0; i < 100 && activeKeys.size === 0; i++) await Promise.resolve();
  expect(activeTurns.isActiveAnywhere("demo")).toBe(true);
  expect(releaseOwnerLookup).toBeDefined();

  releaseOwnerLookup!("ou_owner");
  await handled;

  expect(requests).toHaveLength(1);
  expect(requests[0]!.metadata!.isOwner).toBe(true);
  expect(activeKeys.has("demo")).toBe(false);
});

test("trustGroupOwner lookup pending across logout never repopulates the cache", async () => {
  let handlers: Record<string, (data: unknown) => Promise<void> | void> = {};
  let releaseOwnerLookup: ((ownerId: string) => void) | undefined;
  const channel = new FeishuChannel(
    { ...defaultFeishuConfig, trustGroupOwner: true },
    {
      createClient: () => ({
        sdk: { im: { message: { reply: async () => ({}), create: async () => ({}) } } },
        probeBot: async () => ({ botOpenId: "ou_bot" }),
        getChatOwner: () =>
          new Promise<string | undefined>((resolve) => {
            releaseOwnerLookup = resolve;
          }),
        stop: () => {},
        startWS: async (input: { handlers: Record<string, (data: unknown) => Promise<void> | void> }) => {
          handlers = input.handlers;
        },
      }),
    },
  );
  const agent: ChatAgent = { async chat() { return { text: "ok" }; } };

  await channel.start({ agent, abortSignal: new AbortController().signal, quota: createNoopQuota(), logger: createNoopLogger() });

  const handled = handlers["im.message.receive_v1"]!(groupEvent("om_g6", "ou_owner", "@bot hello"));
  for (let i = 0; i < 100 && !releaseOwnerLookup; i++) await Promise.resolve();

  // Lifecycle restart while the lookup is still in flight.
  channel.logout();
  releaseOwnerLookup!("ou_owner");
  await handled;

  // The stale answer served its own straggler turn but must not be cached
  // into the new lifecycle.
  const cache = (channel as unknown as { chatOwnerCache: Map<string, unknown> }).chatOwnerCache;
  expect(cache.size).toBe(0);
});

test("trustGroupOwner failure sentinel short-circuits repeated failing lookups", async () => {
  let handlers: Record<string, (data: unknown) => Promise<void> | void> = {};
  let ownerLookups = 0;
  const channel = new FeishuChannel(
    { ...defaultFeishuConfig, trustGroupOwner: true },
    {
      createClient: () => ({
        sdk: { im: { message: { reply: async () => ({}), create: async () => ({}) } } },
        probeBot: async () => ({ botOpenId: "ou_bot" }),
        getChatOwner: async () => {
          ownerLookups += 1;
          throw new Error("scope missing");
        },
        startWS: async (input: { handlers: Record<string, (data: unknown) => Promise<void> | void> }) => {
          handlers = input.handlers;
        },
      }),
    },
  );
  const requests: { metadata?: Record<string, unknown> }[] = [];
  const agent: ChatAgent = {
    async chat(request) {
      requests.push(request as { metadata?: Record<string, unknown> });
      return { text: "ok" };
    },
  };

  await channel.start({ agent, abortSignal: new AbortController().signal, quota: createNoopQuota(), logger: createNoopLogger() });

  await handlers["im.message.receive_v1"]!(groupEvent("om_g7", "ou_owner", "@bot /use demo"));
  await handlers["im.message.receive_v1"]!(groupEvent("om_g8", "ou_owner", "@bot /use other"));

  expect(requests).toHaveLength(2);
  expect(requests[0]!.metadata!.isOwner).toBeUndefined();
  expect(requests[1]!.metadata!.isOwner).toBeUndefined();
  // The fail-closed sentinel (30s) absorbs the second message: one REST call,
  // not one per group message.
  expect(ownerLookups).toBe(1);
});
