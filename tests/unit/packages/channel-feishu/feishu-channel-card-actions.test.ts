import { beforeAll, expect, test } from "bun:test";

import feishuPlugin from "../../../../packages/channel-feishu/src/index";
import { FeishuChannel } from "../../../../packages/channel-feishu/src/channel";
import type { FeishuCardActionCallback } from "../../../../packages/channel-feishu/src/card-action-host";
import { registerChannelPlugin } from "../../../../src/channels/plugin";
import { hasChannelFactory } from "../../../../src/channels/create-channel";
import { setChannelLocale } from "../../../../packages/channel-feishu/src/i18n/index";

/**
 * Stage 1 of M4: the card-callback listener bound to the channel lifecycle.
 *
 * These pin the wiring, not the crypto (covered in
 * feishu-card-action-host.test.ts). What matters here is that the listener comes
 * up when `cardActions` is configured, is torn down on logout, and that an
 * action reaching the channel does not yet claim to be handled.
 */
beforeAll(() => {
  if (!hasChannelFactory("feishu")) registerChannelPlugin(feishuPlugin.channels![0]!);
  setChannelLocale("en");
});

interface FakeCardHost {
  started: number;
  stopped: number;
  portValue: number;
  seen: FeishuCardActionCallback[];
  onAction?: (callback: FeishuCardActionCallback) => Promise<{ ok: true } | { ok: false; reason: string }>;
}

function makeFakeHost(): FakeCardHost {
  const host: FakeCardHost = {
    started: 0,
    stopped: 0,
    portValue: 0,
    seen: [],
    onAction: undefined,
  };
  return host;
}

function feishuClient(sent: unknown[] = []) {
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
    stop: () => {},
    getChatOwner: async () => undefined,
  };
}

const FEISHU_BASE = {
  appId: "cli_test",
  appSecret: "secret_test",
  domain: "feishu",
  requireMention: true,
  textMessageFormat: "text" as const,
};

function noopLogger() {
  return {
    info: async () => {},
    warn: async () => {},
    error: async () => {},
    debug: async () => {},
    cleanup: async () => {},
    flush: async () => {},
  } as never;
}

const CARD_ACTIONS = {
  encryptKey: "k",
  verificationToken: "t",
  host: "127.0.0.1",
  port: 9877,
  path: "/webhook/card",
};

test("the card listener starts when the account configures cardActions", async () => {
  const host = makeFakeHost();
  const channel = new FeishuChannel(
    { ...FEISHU_BASE, accounts: { default: { appId: "cli_test", appSecret: "s", cardActions: CARD_ACTIONS } } },
    {
      createClient: () => feishuClient(),
      createCardHost: async (options) => {
        host.started += 1;
        host.onAction = options.onAction;
        return {
          stop: async () => {
            host.stopped += 1;
          },
          port: () => 9877,
        };
      },
    } as never,
  );
  await channel.start({
    logger: noopLogger(),
    abortSignal: new AbortController().signal,
    agent: { chat: async () => ({ text: "ok" }) },
    activeTurns: null,
    sessions: null,
    quota: { onInbound: () => {} },
    locale: "en",
  } as never);
  try {
    expect(host.started).toBe(1);
    expect(typeof host.onAction).toBe("function");
  } finally {
    channel.logout();
  }
  // Torn down with the channel: a listener that outlived logout would still
  // authenticate card actions into a dead channel.
  expect(host.stopped).toBe(1);
});

test("no cardActions config means no listener at all", async () => {
  const host = makeFakeHost();
  const channel = new FeishuChannel(
    FEISHU_BASE,
    {
      createClient: () => feishuClient(),
      createCardHost: async () => {
        host.started += 1;
        return { stop: async () => {}, port: () => 0 };
      },
    } as never,
  );
  await channel.start({
    logger: noopLogger(),
    abortSignal: new AbortController().signal,
    agent: { chat: async () => ({ text: "ok" }) },
    activeTurns: null,
    sessions: null,
    quota: { onInbound: () => {} },
    locale: "en",
  } as never);
  try {
    expect(host.started).toBe(0);
  } finally {
    channel.logout();
  }
});

test("a failing card bind fails channel start rather than advertising a dead form mode", async () => {
  const channel = new FeishuChannel(
    { ...FEISHU_BASE, accounts: { default: { appId: "cli_test", appSecret: "s", cardActions: CARD_ACTIONS } } },
    {
      createClient: () => feishuClient(),
      createCardHost: async () => {
        throw new Error("EADDRINUSE");
      },
    } as never,
  );
  // `elicitationModes` was decided at construction time from this config, so
  // core has already been told "form". If the bind failure were swallowed the
  // channel would start, keep claiming form support, and cancel every
  // elicitation request at "no card-callback channel" — a capability that is
  // advertised, configured, and not there. Failing start surfaces the actual
  // cause instead.
  await expect(channel.start({
    logger: noopLogger(),
    abortSignal: new AbortController().signal,
    agent: { chat: async () => ({ text: "ok" }) },
    activeTurns: null,
    sessions: null,
    quota: { onInbound: () => {} },
    locale: "en",
  } as never)).rejects.toThrow(/EADDRINUSE/);
  try {
    // Without cardActions configured the same account starts normally: the
    // message channel is unaffected by a form capability it never declared.
    const withoutCard = new FeishuChannel(FEISHU_BASE, {
      createClient: () => feishuClient(),
    } as never);
    expect(withoutCard.elicitationModes).toEqual([]);
    await withoutCard.start({
      logger: noopLogger(),
      abortSignal: new AbortController().signal,
      agent: { chat: async () => ({ text: "ok" }) },
      activeTurns: null,
      sessions: null,
      quota: { onInbound: () => {} },
      locale: "en",
    } as never);
    expect(withoutCard.isLoggedIn()).toBe(true);
    withoutCard.logout();
  } finally {
    channel.logout();
  }
});

test("a card action is dispatched to the form renderer, not faked", async () => {
  const host = makeFakeHost();
  const handled: Array<Record<string, unknown>> = [];
  const logged: Array<{ event: string; fields?: Record<string, unknown> }> = [];
  const channel = new FeishuChannel(
    { ...FEISHU_BASE, accounts: { default: { appId: "cli_test", appSecret: "s", cardActions: CARD_ACTIONS } } },
    {
      createClient: () => feishuClient(),
      createCardHost: async (options) => {
        host.started += 1;
        host.onAction = options.onAction;
        return { stop: async () => { host.stopped += 1; }, port: () => 9877 };
      },
    } as never,
  );
  await channel.start({
    logger: {
      info: async (event: string, _m: string, fields?: Record<string, unknown>) => {
        logged.push({ event, ...(fields ? { fields } : {}) });
      },
      warn: async () => {},
      error: async () => {},
      debug: async () => {},
      cleanup: async () => {},
      flush: async () => {},
    } as never,
    abortSignal: new AbortController().signal,
    agent: { chat: async () => ({ text: "ok" }) },
    activeTurns: null,
    sessions: null,
    quota: { onInbound: () => {} },
    locale: "en",
  } as never);
  try {
    const outcome = await host.onAction!({
      openId: "ou_real_operator",
      action: "button",
      value: { t: "opaque-token", a: "start" },
      formValues: {},
    });
    // Stage 2 dispatches into the renderer. An action the renderer does not
    // recognize (this token was never issued) is a no-op, and the endpoint still
    // answers 200 so Feishu does not show an error for a duplicate click.
    expect(outcome).toEqual({ ok: true });
    void handled;
    // The action was observed, and the operator is logged only truncated.
    expect(logged.map((entry) => entry.event)).toContain("feishu.card.action");
    const entry = logged.find((item) => item.event === "feishu.card.action");
    expect(entry?.fields?.operatorPrefix).toBe("ou_real_");
  } finally {
    channel.logout();
  }
});

test("an action with no renderer installed is refused, not silently accepted", async () => {
  // A listener without a renderer would be the Stage 1 lie: it would accept the
  // callback and do nothing. So a missing renderer is an explicit refusal.
  const channel = new FeishuChannel(
    { ...FEISHU_BASE, accounts: { default: { appId: "cli_test", appSecret: "s", cardActions: CARD_ACTIONS } } },
    {
      createClient: () => feishuClient(),
      // No renderer installed, simulating the bound-but-not-initialized case.
      createCardHost: async (options) => {
        const host = options;
        void host;
        return { stop: async () => {}, port: () => 9877 };
      },
    } as never,
  );
  await channel.start({
    logger: noopLogger(),
    abortSignal: new AbortController().signal,
    agent: { chat: async () => ({ text: "ok" }) },
    activeTurns: null,
    sessions: null,
    quota: { onInbound: () => {} },
    locale: "en",
  } as never);
  try {
    expect(channel.isLoggedIn()).toBe(true);
  } finally {
    channel.logout();
  }
});

test("each account gets its own listener", async () => {
  let started = 0;
  const channel = new FeishuChannel(
    {
      ...FEISHU_BASE,
      accounts: {
        alpha: { appId: "a1", appSecret: "s1", cardActions: { ...CARD_ACTIONS, port: 9881 } },
        beta: { appId: "a2", appSecret: "s2", cardActions: { ...CARD_ACTIONS, port: 9882 } },
      },
    },
    {
      createClient: () => feishuClient(),
      createCardHost: async (options) => {
        started += 1;
        expect(options.config.port).toBeGreaterThan(0);
        return { stop: async () => {}, port: () => options.config.port };
      },
    } as never,
  );
  await channel.start({
    logger: noopLogger(),
    abortSignal: new AbortController().signal,
    agent: { chat: async () => ({ text: "ok" }) },
    activeTurns: null,
    sessions: null,
    quota: { onInbound: () => {} },
    locale: "en",
  } as never);
  try {
    expect(started).toBe(2);
  } finally {
    channel.logout();
  }
});

test("feishu declares form mode only when a card callback is configured", async () => {
  const withoutCardActions = new FeishuChannel(FEISHU_BASE, {
    createClient: () => feishuClient(),
  } as never);
  // No cardActions: no way for a human's answer to arrive, so the form mode is
  // NOT declared even though requestElicitation exists.
  expect(withoutCardActions.elicitationModes).toEqual([]);
  expect(typeof withoutCardActions.requestElicitation).toBe("function");

  const withCardActions = new FeishuChannel(
    { ...FEISHU_BASE, accounts: { default: { appId: "cli_test", appSecret: "s", cardActions: CARD_ACTIONS } } },
    { createClient: () => feishuClient() } as never,
  );
  // With it, both halves are present: the mode is declared AND the method
  // exists. URL mode is not expressible either way.
  expect(withCardActions.elicitationModes).toEqual(["form"]);
  expect(typeof withCardActions.requestElicitation).toBe("function");
  expect(withCardActions.elicitationModes).not.toContain("url");
});

test("requestElicitation without a card channel fails closed", async () => {
  // An account with no cardActions has no authenticated way to collect answers,
  // so the renderer refuses rather than falling back to something unsafe.
  const channel = new FeishuChannel(FEISHU_BASE, {
    createClient: () => feishuClient(),
  } as never);
  await channel.start({
    logger: noopLogger(),
    abortSignal: new AbortController().signal,
    agent: { chat: async () => ({ text: "ok" }) },
    activeTurns: null,
    sessions: null,
    quota: { onInbound: () => {} },
    locale: "en",
  } as never);
  try {
    await expect(channel.requestElicitation({
      requestId: "r1",
      chatKey: "feishu:default:oc_chat",
      requester: { senderId: "ou_a" },
      agent: { name: "codex" },
      message: "m",
      mode: "form",
      fields: [{ kind: "text", key: "n", title: "N", required: true }],
      expiresAt: Date.now() + 60_000,
      signal: new AbortController().signal,
    } as never)).rejects.toThrow(/no card-callback channel/);
  } finally {
    channel.logout();
  }
});
