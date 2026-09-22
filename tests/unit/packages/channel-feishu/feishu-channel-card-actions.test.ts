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

test("a failing card bind does not take down the channel", async () => {
  const channel = new FeishuChannel(
    { ...FEISHU_BASE, accounts: { default: { appId: "cli_test", appSecret: "s", cardActions: CARD_ACTIONS } } },
    {
      createClient: () => feishuClient(),
      createCardHost: async () => {
        throw new Error("EADDRINUSE");
      },
    } as never,
  );
  // The WS message channel is the primary function; a taken port must not
  // silently become a working card channel either.
  await expect(channel.start({
    logger: noopLogger(),
    abortSignal: new AbortController().signal,
    agent: { chat: async () => ({ text: "ok" }) },
    activeTurns: null,
    sessions: null,
    quota: { onInbound: () => {} },
    locale: "en",
  } as never)).resolves.toBeUndefined();
  try {
    expect(channel.isLoggedIn()).toBe(true);
  } finally {
    channel.logout();
  }
});

test("a card action reaching the channel is honestly reported as unsupported", async () => {
  const host = makeFakeHost();
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
      info: async (event: string, _message: string, fields?: Record<string, unknown>) => {
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
      value: { token: "abc" },
      formValues: { secret_note: "must-not-be-logged" },
    });
    // Stage 1 has no renderer, so the endpoint admits it rather than pretending.
    expect(outcome).toEqual({ ok: false, reason: "unsupported" });
    // The action was observed, and the operator is logged only truncated: the
    // full open_id is PII-adjacent and the logs are not a per-request audit.
    expect(logged.map((entry) => entry.event)).toContain("feishu.card.action");
    const entry = logged.find((item) => item.event === "feishu.card.action");
    expect(entry?.fields?.operatorPrefix).toBe("ou_real_");
    const serialized = JSON.stringify(logged);
    expect(serialized).not.toContain("must-not-be-logged");
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
