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
 *
 * `startWS` WAITS FOR THE SIGNAL, exactly like `createFeishuLarkClient` does
 * (lark-client.ts:117-129): a healthy account's WebSocket promise does not
 * settle until its signal aborts, so it spans the whole process lifetime. A
 * stub that resolves immediately hides that, and a rollback that only works
 * against a resolving stub is untested — `allSettled` over the raw startups
 * passed those tests while hanging on the real client.
 */
function recordingClient(accountId: string, failStartWS: () => boolean, options: { failAfter?: number } = {}) {
  // Counters live behind `rec` so the stubs mutate the same object the test
  // reads: spreading a number into the wrapper would snapshot 0 forever.
  const rec = { wsStarted: 0, stopped: 0 };
  return {
    rec,
    client: {
      sdk: { im: { message: { reply: async () => ({}), create: async () => ({}) } } },
      probeBot: async () => ({ botOpenId: `ou_${accountId}` }),
      startWS: async (input: { abortSignal?: AbortSignal }) => {
        rec.wsStarted += 1;
        // `failAfter` lets a test hold the failure back long enough for the
        // healthy sibling to be genuinely parked in startWS first, which is the
        // ordering that matters: the failure must arrive at a channel that
        // already has a live receiver to tear down.
        if (failStartWS() && options.failAfter !== undefined) {
          await new Promise((resolve) => setTimeout(resolve, options.failAfter));
        }
        if (failStartWS()) throw Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" });
        // The real client parks here until the signal fires. The stub must too,
        // or a rollback that depends on cancelling the sibling is never
        // exercised.
        await new Promise<void>((resolve) => {
          if (input.abortSignal?.aborted) {
            resolve();
            return;
          }
          input.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
        });
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
  // beta fails only AFTER alpha is parked in startWS — the real production
  // shape. A client whose startWS resolves immediately would let the rollback
  // pass against semantics the real client never has.
  const alpha = recordingClient("alpha", () => false);
  const beta = recordingClient("beta", () => true, { failAfter: 20 });
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
    { clients: new Map([["alpha", recordingClient("alpha", () => false)], ["beta", recordingClient("beta", () => true, { failAfter: 20 })]]), hosts: new Map([["alpha", fakeCardHost()], ["beta", fakeCardHost()]]) },
  ];
  let attempt = 0;

  const channel = new FeishuChannel(rollbackConfig(), {
    createClient: ((account: { accountId: string }) => attempts[attempt]!.clients.get(account.accountId)!.client) as never,
    createCardHost: async (options: { config: { port: number } }) =>
      attempts[attempt]!.hosts.get(options.config.port === 9878 ? "beta" : "alpha")!.runtime,
  } as never);

  // A healthy start() parks in `startWS()` and never resolves — that is the real
  // client's contract (lark-client.ts:117-129), so the stub honours it. The
  // first attempt is therefore released by aborting ITS OWN daemon signal, not
  // by letting it "finish".
  const firstDaemon = new AbortController();
  attempt = 0;
  const first = channel.start({ ...rollbackStartInput(), abortSignal: firstDaemon.signal } as never);
  // Let both accounts reach their parked receiver before releasing them.
  await new Promise((resolve) => setTimeout(resolve, 30));
  firstDaemon.abort(new Error("test releasing the first start"));
  await first;
  const firstAlpha = attempts[0]!.clients.get("alpha")!;
  expect(firstAlpha.rec.wsStarted).toBe(1);
  // The first start's receivers are live and must NOT have been torn down.
  expect(firstAlpha.rec.stopped).toBe(0);
  expect(attempts[0]!.hosts.get("alpha")!.stopped()).toBe(0);

  // The second attempt fails at beta. Everything THIS call installed — its own
  // fresh alpha client and card listener — must be unwound, WITHOUT the daemon
  // signal being aborted: the rollback cancels the attempt, not the process.
  const secondDaemon = new AbortController();
  attempt = 1;
  await expect(channel.start({ ...rollbackStartInput(), abortSignal: secondDaemon.signal } as never))
    .rejects.toThrow(/EADDRINUSE/);

  const secondAlpha = attempts[1]!.clients.get("alpha")!;
  expect(secondAlpha.rec.wsStarted).toBe(1);
  expect(secondAlpha.rec.stopped).toBe(1);
  expect(attempts[1]!.hosts.get("alpha")!.stopped()).toBe(1);
  // ...and the first attempt's runtime is precisely what was NOT torn down.
  expect(firstAlpha.rec.stopped).toBe(0);
  expect(attempts[0]!.hosts.get("alpha")!.stopped()).toBe(0);
  expect(secondDaemon.signal.aborted).toBe(false);

  // The restored previous runtime is the one still serving alpha's route.
  await channel.sendCoordinatorMessage({
    coordinatorSession: "coord",
    chatKey: "feishu:alpha:oc_alpha",
    replyContextToken: "om_alpha",
    text: "still receiving",
  });
  channel.logout();
});

test("a start whose healthy sibling is parked in startWS still rejects when another account fails", async () => {
  // THE PRODUCTION LIFECYCLE. `createFeishuLarkClient.startWS` awaits until its
  // signal aborts (lark-client.ts:117-129), so a healthy account's startup
  // promise never settles on its own — it spans the whole process lifetime.
  //
  // `Promise.all` over the raw startups rejects the instant beta fails, while
  // alpha is still mid-install, so rolling back then races alpha's suspended
  // `startWS`. `Promise.allSettled` waits for alpha, which never settles, so
  // beta's error never surfaces and `start()` hangs. Both are wrong.
  //
  // The correct behaviour: alpha is genuinely parked in a receiver it will hold
  // for the life of the process, beta fails, and `start()` rejects promptly —
  // without the DAEMON signal being aborted, because cancelling a failed attempt
  // must not tear down every other channel on the daemon.
  const alpha = recordingClient("alpha", () => false);
  const beta = recordingClient("beta", () => true, { failAfter: 20 });
  const clients = new Map([["alpha", alpha], ["beta", beta]]);
  const hosts = new Map([["alpha", fakeCardHost()], ["beta", fakeCardHost()]]);

  const channel = new FeishuChannel(rollbackConfig(), {
    createClient: ((account: { accountId: string }) => clients.get(account.accountId)!.client) as never,
    createCardHost: async (options: { config: { port: number } }) =>
      hosts.get(options.config.port === 9878 ? "beta" : "alpha")!.runtime,
  } as never);

  const daemon = new AbortController();
  // A parked sibling that is NEVER released by the daemon: if the implementation
  // waits for it, this test hangs rather than passing quietly.
  const failure = channel
    .start({ ...rollbackStartInput(), abortSignal: daemon.signal } as never)
    .then(() => undefined, (error: Error) => error);
  // Let alpha park in its receiver, and let beta fail.
  await new Promise((resolve) => setTimeout(resolve, 80));

  const error = await failure;
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toMatch(/EADDRINUSE/);
  // The attempt was cancelled, NOT the daemon: other channels on this signal are
  // untouched, and nothing here aborted the process-level controller.
  expect(daemon.signal.aborted).toBe(false);
  // Alpha really had a live receiver, and it is gone.
  expect(alpha.rec.wsStarted).toBe(1);
  expect(alpha.rec.stopped).toBe(1);
  expect(hosts.get("alpha")!.stopped()).toBe(1);
  channel.logout();
});
