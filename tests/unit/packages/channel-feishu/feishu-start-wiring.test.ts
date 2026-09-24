import { expect, test } from "bun:test";

import { FeishuChannel } from "../../../../packages/channel-feishu/src/channel";
import type { FeishuChannelConfig } from "../../../../packages/channel-feishu/src/config";
import type { FeishuClientFactory } from "../../../../packages/channel-feishu/src/feishu-client";
import type { ChannelStartInput, CreateChannelDeps } from "../../../../src/plugin-api";

function createNoopLogger(): ChannelStartInput["logger"] {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as unknown as ChannelStartInput["logger"];
}

function createNoopQuota(): ChannelStartInput["quota"] {
  return {
    consume: async () => ({ allowed: true }),
  } as unknown as ChannelStartInput["quota"];
}

function createDeps(overrides?: Partial<CreateChannelDeps>): CreateChannelDeps {
  return {
    // Stub client: probeBot/startWS are noops so start() completes without any
    // real WebSocket connection or network access.
    createClient: (() => ({
      sdk: { im: { message: { reply: async () => ({}), create: async () => ({}) } } },
      probeBot: async () => ({ botOpenId: "ou_bot" }),
      startWS: async () => {},
      stop: () => {},
    })) as unknown as FeishuClientFactory,
    ...overrides,
  };
}

// A valid, enabled, fully-configured account so parseFeishuChannelConfig passes.
// The stub client's startWS is a noop, so start() completes without network.
function buildConfig(): FeishuChannelConfig {
  return {
    appId: "app-id",
    appSecret: "app-secret",
  } as unknown as FeishuChannelConfig;
}

function makeChannel(): FeishuChannel {
  return new FeishuChannel(buildConfig(), createDeps());
}

test("start() captures sessions and activeTurns from ChannelStartInput", async () => {
  const sessions = {
    peekCurrentSessionAlias: () => undefined,
    setBackgroundResult: async () => {},
    takeBackgroundResult: async () => null,
    listBackgroundResultAliases: () => [],
    resolveFuzzyAlias: () => ({ kind: "none" }),
  } as any;
  const activeTurns = { markActive() {}, markInactive() {}, isActive: () => false, isActiveAnywhere: () => false } as any;

  const channel = makeChannel();

  await channel.start({
    agent: { chat: async () => ({ text: "" }) } as any,
    abortSignal: new AbortController().signal,
    quota: createNoopQuota(),
    logger: createNoopLogger(),
    sessions,
    activeTurns,
  } as any);

  expect((channel as any).sessions).toBe(sessions);
  expect((channel as any).activeTurns).toBe(activeTurns);
});

// ---------------------------------------------------------------------------
// Failed-start rollback
//
// A channel-level startup failure used to leave the accounts that had already
// come up installed. The registry marked feishu failed and dropped it from the
// advertised form capability, while its live WebSocket receiver and card
// listener kept delivering events into a channel nobody was watching — a
// logically failed channel still processing messages.
// ---------------------------------------------------------------------------

/** Both accounts opt into the card channel, so a live listener exists to leak. */
const CARD_ACTIONS = {
  encryptKey: "k",
  verificationToken: "t",
  host: "127.0.0.1",
  port: 9877,
  path: "/webhook/card",
};

function rollbackConfig(): FeishuChannelConfig {
  return {
    defaultAccount: "alpha",
    accounts: {
      alpha: { appId: "alpha_app", appSecret: "alpha_secret", cardActions: CARD_ACTIONS },
      beta: { appId: "beta_app", appSecret: "beta_secret", cardActions: { ...CARD_ACTIONS, port: 9878 } },
    },
  } as unknown as FeishuChannelConfig;
}

function rollbackStartInput(): ChannelStartInput {
  return {
    agent: { chat: async () => ({ text: "" }) },
    abortSignal: new AbortController().signal,
    quota: createNoopQuota(),
    logger: createNoopLogger(),
  } as never;
}

/**
 * Stub client recording the real lifecycle surfaces the channel itself calls,
 * so "a receiver survived" is observable as a `stop()` that never came rather
 * than by poking channel internals.
 */
function recordingClient(accountId: string, failStartWS: () => boolean) {
  // Counters live behind `rec` so the stubs mutate the same object the test
  // reads: spreading a number into the wrapper would snapshot 0 forever.
  const rec = { wsStarted: 0, stopped: 0 };
  return {
    rec,
    client: {
      sdk: { im: { message: { reply: async () => ({}), create: async () => ({}) } } },
      probeBot: async () => ({ botOpenId: `ou_${accountId}` }),
      startWS: async () => {
        rec.wsStarted += 1;
        if (failStartWS()) throw Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" });
      },
      stop: () => {
        rec.stopped += 1;
      },
    },
  };
}

/** Card listener stub: `stopped` is the only observable fact about it. */
function fakeCardHost() {
  let stoppedCount = 0;
  return {
    stopped: () => stoppedCount,
    runtime: {
      stop: async () => {
        stoppedCount += 1;
      },
      port: () => 9877,
    },
  };
}

test("a failed multi-account start rolls back every account it installed", async () => {
  const alpha = recordingClient("alpha", () => false);
  const beta = recordingClient("beta", () => true);
  const clients = new Map([
    ["alpha", alpha],
    ["beta", beta],
  ]);
  // A listener per account, so the stopped count says WHICH listeners went
  // away rather than a punched card of "some listener stopped N times".
  const hosts = new Map([
    ["alpha", fakeCardHost()],
    ["beta", fakeCardHost()],
  ]);

  const channel = new FeishuChannel(rollbackConfig(), {
    createClient: ((account: { accountId: string }) => clients.get(account.accountId)!.client) as never,
    createCardHost: async (options: { config: { port: number } }) =>
      hosts.get(options.config.port === 9878 ? "beta" : "alpha")!.runtime,
  } as never);

  // (a) start() rejects, with the original error rather than a wrapper.
  await expect(channel.start(rollbackStartInput())).rejects.toThrow(/EADDRINUSE/);

  // (b) No receiver survives: alpha had completed its whole startup — WS
  // receiver live, card listener live — and beta's failure tore both down
  // through the same mechanism logout() uses.
  expect(alpha.rec.wsStarted).toBe(1);
  expect(alpha.rec.stopped).toBe(1);
  expect(beta.rec.stopped).toBe(1);
  expect(hosts.get("alpha")!.stopped()).toBe(1);
  expect(hosts.get("beta")!.stopped()).toBe(1);

  // (c) The registry holds neither runtime: a channel that failed to start
  // answers outbound routes as "not started" instead of dispatching.
  await expect(channel.sendCoordinatorMessage({
    coordinatorSession: "coord",
    chatKey: "feishu:alpha:oc_alpha",
    replyContextToken: "om_alpha",
    text: "hello",
  })).rejects.toThrow('feishu account "alpha" is not started');
  await expect(channel.sendCoordinatorMessage({
    coordinatorSession: "coord",
    chatKey: "feishu:beta:oc_beta",
    replyContextToken: "om_beta",
    text: "hello",
  })).rejects.toThrow('feishu account "beta" is not started');
});

test("a single-account EADDRINUSE still rejects start and leaves nothing live", async () => {
  const cardHost = fakeCardHost();
  const only = recordingClient("default", () => true);
  const channel = new FeishuChannel(
    {
      appId: "solo_app",
      appSecret: "solo_secret",
      accounts: { default: { appId: "solo_app", appSecret: "solo_secret", cardActions: CARD_ACTIONS } },
    } as unknown as FeishuChannelConfig,
    {
      createClient: (() => only.client) as never,
      createCardHost: async () => cardHost.runtime,
    } as never,
  );

  await expect(channel.start(rollbackStartInput())).rejects.toThrow(/EADDRINUSE/);
  expect(only.rec.stopped).toBe(1);
  expect(cardHost.stopped()).toBe(1);

  await expect(channel.sendCoordinatorMessage({
    coordinatorSession: "coord",
    chatKey: "feishu:default:oc_solo",
    replyContextToken: "om_solo",
    text: "hello",
  })).rejects.toThrow('feishu account "default" is not started');
});

test("a failed re-start leaves a runtime installed by a previous start alone", async () => {
  // One channel instance, two start() calls: the first installs alpha+beta
  // healthy; the second, whose beta cannot bind, must roll back only what THIS
  // call installed. The first start's live receivers are not this call's
  // business, so they must come through untouched.
  //
  // Each attempt gets its OWN client and listener stubs, because the second
  // start() builds a fresh runtime for every account — overwriting alpha's map
  // slot. Counting against shared stubs would make "the previous runtime
  // survived" indistinguishable from "the replacement was never stopped".
  const attempts = [
    { clients: new Map([["alpha", recordingClient("alpha", () => false)], ["beta", recordingClient("beta", () => false)]]), hosts: new Map([["alpha", fakeCardHost()], ["beta", fakeCardHost()]]) },
    { clients: new Map([["alpha", recordingClient("alpha", () => false)], ["beta", recordingClient("beta", () => true)]]), hosts: new Map([["alpha", fakeCardHost()], ["beta", fakeCardHost()]]) },
  ];
  let attempt = 0;

  const channel = new FeishuChannel(rollbackConfig(), {
    createClient: ((account: { accountId: string }) => attempts[attempt]!.clients.get(account.accountId)!.client) as never,
    createCardHost: async (options: { config: { port: number } }) =>
      attempts[attempt]!.hosts.get(options.config.port === 9878 ? "beta" : "alpha")!.runtime,
  } as never);

  attempt = 0;
  await channel.start(rollbackStartInput());
  const firstAlpha = attempts[0]!.clients.get("alpha")!;
  expect(firstAlpha.rec.wsStarted).toBe(1);

  // The second attempt fails at beta. Everything THIS call installed — its own
  // fresh alpha client and card listener — must be unwound.
  attempt = 1;
  await expect(channel.start(rollbackStartInput())).rejects.toThrow(/EADDRINUSE/);

  const secondAlpha = attempts[1]!.clients.get("alpha")!;
  expect(secondAlpha.rec.wsStarted).toBe(1);
  expect(secondAlpha.rec.stopped).toBe(1);
  expect(attempts[1]!.hosts.get("alpha")!.stopped()).toBe(1);
  // ...and the first attempt's runtime is precisely what was NOT torn down.
  expect(firstAlpha.rec.stopped).toBe(0);
  expect(attempts[0]!.hosts.get("alpha")!.stopped()).toBe(0);

  // The restored previous runtime is the one still serving alpha's route.
  await channel.sendCoordinatorMessage({
    coordinatorSession: "coord",
    chatKey: "feishu:alpha:oc_alpha",
    replyContextToken: "om_alpha",
    text: "still receiving",
  });
  channel.logout();
});
