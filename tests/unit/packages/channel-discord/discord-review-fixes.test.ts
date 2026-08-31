import { beforeAll, expect, mock, test } from "bun:test";
import { DiscordChannel } from "../../../../packages/channel-discord/src/channel";
import { createDiscordClient } from "../../../../packages/channel-discord/src/discord-client";
import type { DiscordBotIdentity, DiscordClientLike } from "../../../../packages/channel-discord/src/discord-client";
import type { DiscordInboundMessage } from "../../../../packages/channel-discord/src/types";
import { MessageChannelRegistry } from "../../../../src/channels/channel-registry";
import { registerKnownChannelId } from "../../../../src/channels/channel-scope";
import type { ChannelStartInput } from "xacpx/plugin-api";

beforeAll(() => {
  // Production registers this via registerChannelFactory when the plugin loads.
  registerKnownChannelId("discord");
});

function makeLogger(errors: string[] = []): {
  info: (...args: unknown[]) => Promise<void>;
  warn: (...args: unknown[]) => Promise<void>;
  error: (event: string, msg: string, fields?: Record<string, unknown>) => Promise<void>;
  debug: (...args: unknown[]) => Promise<void>;
  errors: string[];
} {
  return {
    info: async () => {},
    warn: async () => {},
    error: async (_event, msg) => {
      errors.push(msg);
    },
    debug: async () => {},
    errors,
  };
}

function makeStartInput(logger: ReturnType<typeof makeLogger>, abort: AbortController): ChannelStartInput {
  return {
    logger,
    abortSignal: abort.signal,
    agent: null,
    activeTurns: null,
    sessions: null,
    quota: null,
    locale: "en",
  } as unknown as ChannelStartInput;
}

function makeRuntimeStartInput(agent: unknown, quota: unknown, abort: AbortController): ChannelStartInput {
  return {
    logger: makeLogger(),
    abortSignal: abort.signal,
    agent,
    activeTurns: null,
    sessions: null,
    quota,
    locale: "en",
  } as unknown as ChannelStartInput;
}

/** Client whose Gateway session reports `identity` while the REST probe
 *  reports nothing — the exact shape of the fail-open bug H1 fixes. */
function makeGatewayClient(identity: DiscordBotIdentity): DiscordClientLike & {
  emit: (msg: DiscordInboundMessage) => void;
  destroyCount: number;
  sent: string[];
} {
  let handler: ((msg: DiscordInboundMessage) => void) | null = null;
  const sent: string[] = [];
  const client = {
    start: async (input: { handlers: { onMessage(m: DiscordInboundMessage): void } }) => {
      handler = input.handlers.onMessage;
      return identity;
    },
    probeBot: async () => ({ botUserId: "" }),
    sendMessage: async (_target: unknown, body: { content?: string | null }) => {
      sent.push(body.content ?? "");
      return { messageId: `s${sent.length}` };
    },
    editMessage: async () => {},
    deleteMessage: async () => {},
    startTyping: async () => () => {},
    addReaction: async () => {},
    destroyCount: 0,
    destroy: async () => {
      client.destroyCount += 1;
    },
    emit: (msg: DiscordInboundMessage) => {
      handler?.(msg);
    },
    sent,
  };
  return client;
}

const discordJsFixture = {
  user: null as { id: string; tag: string } | null,
  destroyCount: 0,
};

function fakeDiscordJs(): Record<string, unknown> {
  class FakeClient {
    user: { id: string; tag: string } | null;
    channels = { fetch: async () => { throw new Error("channels unavailable in test"); } };
    constructor(_opts: unknown) {
      this.user = discordJsFixture.user;
    }
    on(): void {}
    once(): void {}
    isReady(): boolean {
      return true;
    }
    login(): Promise<string> {
      return Promise.resolve("token");
    }
    destroy(): void {
      discordJsFixture.destroyCount += 1;
    }
  }
  return {
    Client: FakeClient,
    GatewayIntentBits: {
      Guilds: 1,
      GuildMessages: 2,
      GuildMessageReactions: 4,
      DirectMessages: 8,
      DirectMessageReactions: 16,
      GuildMembers: 32,
      MessageContent: 64,
    },
    Partials: { Channel: 1, Message: 2 },
    ChannelType: { GuildText: 0, PublicThread: 11, PrivateThread: 12, AnnouncementThread: 10 },
  };
}

function inboundMessage(overrides: Partial<DiscordInboundMessage>): DiscordInboundMessage {
  return {
    id: `m-${Math.random().toString(36).slice(2)}`,
    channelId: "dm1",
    guildId: null,
    author: { id: "u1", bot: false },
    content: "",
    createdTimestamp: Date.now(),
    ...overrides,
  };
}

async function settle(ms = 30): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 2));
  }
}

async function waitStarted(ch: DiscordChannel, accountId = "default"): Promise<void> {
  const deadline = Date.now() + 2000;
  for (;;) {
    try {
      await ch.sendCoordinatorMessage({ chatKey: `discord:${accountId}:g:__probe__`, text: "" });
      return;
    } catch (error) {
      if (!(error instanceof Error && error.message.includes("not started"))) throw error;
    }
    if (Date.now() > deadline) throw new Error("channel did not start in time");
    await new Promise((r) => setTimeout(r, 2));
  }
}

function makeClient(overrides: Partial<DiscordClientLike> = {}): DiscordClientLike & { destroyCount: number } {
  const client = {
    start: async () => ({ botUserId: "bot1", botTag: "Bot#0001" }),
    probeBot: async () => ({ botUserId: "bot1", botTag: "Bot#0001" }),
    sendMessage: async () => ({ messageId: "m1" }),
    editMessage: async () => {},
    deleteMessage: async () => {},
    startTyping: async () => () => {},
    addReaction: async () => {},
    destroyCount: 0,
    destroy: async () => {
      client.destroyCount += 1;
    },
    ...overrides,
  };
  return client;
}

// Review #3: when all eligible accounts fail to start, start() must reject so
// MessageChannelRegistry.startAll can record the channel startup failure.
test("DiscordChannel.start rejects when all accounts fail to start", async () => {
  const failing = makeClient({
    start: async () => {
      throw new Error("login failed");
    },
    probeBot: async () => ({ botUserId: "" }),
  });
  const logger = makeLogger();
  const abort = new AbortController();
  const ch = new DiscordChannel(
    { token: "x" },
    {
      logger: logger as never,
      createClient: () => failing,
    },
  );

  let thrown: unknown = null;
  try {
    await ch.start(makeStartInput(logger, abort));
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(Error);
  expect((thrown as Error).message).toContain("login failed");
  expect(logger.errors.some((m) => m.includes("all discord accounts failed to start"))).toBe(true);
  // Failed account must be cleaned up, not left half-registered.
  expect(failing.destroyCount).toBeGreaterThanOrEqual(1);
  abort.abort();
});

// Review #3: a healthy account keeps the channel alive.
test("DiscordChannel.start resolves when at least one account starts", async () => {
  const ok = makeClient();
  const logger = makeLogger();
  const abort = new AbortController();
  const ch = new DiscordChannel(
    { token: "x", accounts: { a1: {} } },
    {
      logger: logger as never,
      createClient: () => ok,
    },
  );

  const startPromise = ch.start(makeStartInput(logger, abort));
  abort.abort();
  await startPromise;
});

// Review #3: a failing account is isolated; the healthy one still serves
// messages and routes to the failed account fail fast.
test("DiscordChannel.start isolates a failing account and keeps the healthy one", async () => {
  const bad = makeClient({
    start: async () => {
      throw new Error("bad token");
    },
    probeBot: async () => ({ botUserId: "" }),
  });
  const sentToGood: string[] = [];
  const good = makeClient({
    sendMessage: async (_t, body) => {
      sentToGood.push(body.content ?? "");
      return { messageId: "g1" };
    },
  });
  const logger = makeLogger();
  const abort = new AbortController();
  const ch = new DiscordChannel(
    { accounts: { bad: { token: "tok-bad" }, good: { token: "tok-good" } } },
    {
      logger: logger as never,
      identifyStaggerMs: 0,
      createClient: (account) => (account.accountId === "bad" ? bad : good),
    },
  );

  const startPromise = ch.start(makeStartInput(logger, abort));

  // Wait until the healthy account finished starting.
  await waitStarted(ch, "good");

  // Routes to the failed account must fail fast with a clear message.
  let routeError: unknown = null;
  try {
    await ch.sendCoordinatorMessage({ chatKey: "discord:bad:g:c1", text: "hi" });
  } catch (error) {
    routeError = error;
  }
  expect(routeError).toBeInstanceOf(Error);
  expect((routeError as Error).message).toContain("not started");

  // The healthy account still delivers.
  await ch.sendCoordinatorMessage({ chatKey: "discord:good:g:c1", text: "hi" });
  expect(sentToGood).toEqual(["hi"]);

  abort.abort();
  await startPromise;
});

// Runtime contract: Discord cannot render GFM tables (design D5), so the
// session list must use the plain-text "cards" layout — same precedent as
// weixin. "cards" here is a text format, not a native card API (design F4).
test("MessageChannelRegistry reports 'cards' session list format for discord chat keys", () => {
  const ch = new DiscordChannel({ token: "x" }, { logger: makeLogger() as never });
  expect(ch.nativeSessionListFormat).toBe("cards");
  const registry = new MessageChannelRegistry([ch]);
  expect(registry.nativeSessionListFormat("discord:default:g:c1")).toBe("cards");
  expect(registry.nativeSessionListFormat("discord:default:dm:d1")).toBe("cards");
});

// Round 6 H1: bot identity must come from the Gateway session, never from the
// REST probe. probeBot() can answer "" while login still succeeds, and every
// guard keyed on botUserId (own-message drop, mention gate, reply-to-bot)
// fails open on an empty id — which is how the bot's own echo reached the
// agent and self-looped.
test("H1: own-message guard uses the Gateway identity even when probeBot() returns empty", async () => {
  const client = makeGatewayClient({ botUserId: "bot-123", botTag: "Bot#0001" });
  const chatTexts: string[] = [];
  const agent = {
    chat: async (req: { text: string }) => {
      chatTexts.push(req.text);
      return { text: "ok" };
    },
  };
  const abort = new AbortController();
  const ch = new DiscordChannel(
    { token: "x", allowBots: true, dmPolicy: "open", guildPolicy: "open", requireMention: true },
    { logger: makeLogger() as never, createClient: () => client, identifyStaggerMs: 0 },
  );
  const startPromise = ch.start(makeRuntimeStartInput(agent, { onInbound: () => {} }, abort));
  await waitStarted(ch);

  // Gateway echo of our own message. Before the fix the account ran with
  // botUserId="" (the probe answer) so this fell straight through to the agent.
  client.emit(inboundMessage({ author: { id: "bot-123", bot: true }, content: "my own echo that must never loop" }));
  await settle();
  expect(chatTexts).toEqual([]);

  // A real message still reaches the agent, so the drop above proves the
  // identity is set rather than the channel being dead.
  client.emit(inboundMessage({ author: { id: "u1", bot: false }, content: "hello" }));
  await waitFor(() => chatTexts.length === 1);
  expect(chatTexts).toEqual(["hello"]);

  abort.abort();
  await startPromise;
});

test("H1: an account whose Gateway session has no identity is not started and rejects startup", async () => {
  const client = makeClient({ start: async () => ({ botUserId: "" }) });
  const logger = makeLogger();
  const abort = new AbortController();
  const ch = new DiscordChannel(
    { token: "x" },
    { logger: logger as never, createClient: () => client, identifyStaggerMs: 0 },
  );

  let thrown: unknown = null;
  try {
    await ch.start(makeStartInput(logger, abort));
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(Error);
  expect((thrown as Error).message).toContain("became ready without a bot identity");
  expect(logger.errors.some((m) => m.includes("discord client started without bot identity"))).toBe(true);
  // Half-started state is never left behind: the client is torn down and the
  // account is absent from the runtime map.
  expect(client.destroyCount).toBeGreaterThanOrEqual(1);
  let routeError: unknown = null;
  try {
    await ch.sendCoordinatorMessage({ chatKey: "discord:default:g:c1", text: "hi" });
  } catch (error) {
    routeError = error;
  }
  expect(routeError).toBeInstanceOf(Error);
  expect((routeError as Error).message).toContain("not started");
  abort.abort();
});

test("H1: the Gateway identity drops only our own messages, other bots stay under allowBots", async () => {
  const client = makeGatewayClient({ botUserId: "bot-123" });
  const chatTexts: string[] = [];
  const agent = {
    chat: async (req: { text: string }) => {
      chatTexts.push(req.text);
      return { text: "ok" };
    },
  };
  const abort = new AbortController();
  const ch = new DiscordChannel(
    { token: "x", allowBots: true, dmPolicy: "open", guildPolicy: "open" },
    { logger: makeLogger() as never, createClient: () => client, identifyStaggerMs: 0 },
  );
  const startPromise = ch.start(makeRuntimeStartInput(agent, { onInbound: () => {} }, abort));
  await waitStarted(ch);

  client.emit(inboundMessage({ author: { id: "other-bot", bot: true }, content: "hello from another bot" }));
  await waitFor(() => chatTexts.length === 1);
  client.emit(inboundMessage({ author: { id: "bot-123", bot: true }, content: "self echo" }));
  await settle();
  expect(chatTexts).toEqual(["hello from another bot"]);

  abort.abort();
  await startPromise;
});

// The adapter itself must fail closed, not just the channel wrapper: an
// identity-less Gateway session and an already-aborted start used to resolve
// normally, which is what let an empty botUserId into the runtime map.
test("H1: createDiscordClient fails closed without bot identity and when aborted before login", async () => {
  const restore = mock.module("discord.js", () => fakeDiscordJs());
  try {
    discordJsFixture.user = null;
    discordJsFixture.destroyCount = 0;
    const client = createDiscordClient({ token: "t", intentsMessageContent: true, intentsGuildMembers: false });
    let identityError: unknown = null;
    try {
      await client.start({ handlers: { onMessage: () => {} }, abortSignal: new AbortController().signal });
    } catch (error) {
      identityError = error;
    }
    expect(identityError).toBeInstanceOf(Error);
    expect((identityError as Error).message).toContain("without bot identity");
    expect(discordJsFixture.destroyCount).toBe(1);

    discordJsFixture.user = { id: "bot-123", tag: "Bot#0001" };
    const aborted = new AbortController();
    aborted.abort();
    let abortError: unknown = null;
    try {
      await client.start({ handlers: { onMessage: () => {} }, abortSignal: aborted.signal });
    } catch (error) {
      abortError = error;
    }
    expect(abortError).toBeInstanceOf(Error);
    expect((abortError as Error).message).toContain("aborted");
  } finally {
    restore?.();
  }
});

// Round 6 H2: a Discord turn must be bound to the channel lifecycle. stop()
// used to claim "in-flight turns will settle via abortSignal" while nothing
// ever forwarded that signal, so an abandoned turn kept running and could still
// post its answer and its background completion notice.
interface LifecycleHarness {
  ch: DiscordChannel;
  client: DiscordClientLike & { emit: (msg: DiscordInboundMessage) => void; sent: string[]; destroyCount: number };
  abort: AbortController;
  startPromise: Promise<void>;
  backgroundResults: string[];
}

function startLifecycleChannel(
  agentChat: (req: { text: string; abortSignal: AbortSignal }) => Promise<{ text: string }>,
): LifecycleHarness {
  const client = makeGatewayClient({ botUserId: "bot-123" });
  const abort = new AbortController();
  const backgroundResults: string[] = [];
  // First peek binds the turn to "worker"; the completion check then reports a
  // different current alias, which is what makes the background notice fire.
  let peekCalls = 0;
  const sessions = {
    peekCurrentSessionAlias: () => (peekCalls++ === 0 ? "worker" : "worker-next"),
    setBackgroundResult: async (chatKey: string, alias: string) => {
      backgroundResults.push(`${chatKey}|${alias}`);
    },
  };
  const ch = new DiscordChannel(
    // replyMode static keeps the outbound surface to "final answer + notice" so
    // the assertions below count deliveries, not preview edits.
    { token: "x", dmPolicy: "open", guildPolicy: "open", replyMode: "static" },
    { logger: makeLogger() as never, createClient: () => client, identifyStaggerMs: 0 },
  );
  const startPromise = ch.start({
    logger: makeLogger(),
    abortSignal: abort.signal,
    agent: { chat: agentChat },
    activeTurns: { markActive: () => {}, markInactive: () => {} },
    sessions,
    quota: { onInbound: () => {} },
    locale: "en",
  } as unknown as ChannelStartInput);
  return { ch, client, abort, startPromise, backgroundResults };
}

function emitDmTurn(harness: LifecycleHarness, content: string): void {
  harness.client.emit(inboundMessage({ author: { id: "u1", bot: false }, content }));
}

test("H2 control: a normally completing bound turn delivers its answer and its completion notice", async () => {
  const harness = startLifecycleChannel(async () => ({ text: "the answer" }));
  await waitStarted(harness.ch);
  emitDmTurn(harness, "long job");
  await waitFor(() => harness.client.sent.length >= 2);
  expect(harness.client.sent[0]).toBe("the answer");
  expect(harness.backgroundResults.length).toBe(1);

  harness.abort.abort();
  await harness.startPromise;
});

test("H2: aborting the channel signal cancels the in-flight turn and suppresses late delivery", async () => {
  const turn = Promise.withResolvers<{ text: string }>();
  let turnSignal: AbortSignal | null = null;
  const harness = startLifecycleChannel(async (req) => {
    turnSignal = req.abortSignal;
    await turn.promise;
    return { text: "the answer" };
  });
  await waitStarted(harness.ch);
  emitDmTurn(harness, "long job");
  await waitFor(() => turnSignal !== null);
  expect(turnSignal!.aborted).toBe(false);

  harness.abort.abort();
  // The turn's own signal is what the agent receives — it must be aborted.
  await waitFor(() => turnSignal!.aborted);

  // The agent finishes successfully only after the channel was torn down.
  turn.resolve({ text: "the answer" });
  await harness.startPromise;
  await settle();
  expect(harness.client.sent).toEqual([]);
  expect(harness.backgroundResults).toEqual([]);
});

test("H2: channel.stop() cancels the in-flight turn without waiting for the agent", async () => {
  const never = Promise.withResolvers<{ text: string }>();
  let turnSignal: AbortSignal | null = null;
  const harness = startLifecycleChannel(async (req) => {
    turnSignal = req.abortSignal;
    return never.promise;
  });
  await waitStarted(harness.ch);
  emitDmTurn(harness, "long job");
  await waitFor(() => turnSignal !== null);

  // stop() must resolve even though the agent turn never settles.
  await harness.ch.stop("test-stop");
  expect(turnSignal!.aborted).toBe(true);
  expect(harness.client.destroyCount).toBeGreaterThanOrEqual(1);

  never.resolve({ text: "the answer" });
  harness.abort.abort();
  await harness.startPromise;
  await settle();
  expect(harness.client.sent).toEqual([]);
  expect(harness.backgroundResults).toEqual([]);
});

// Round 6 M4: the abort fast path read account.requireMention while the normal
// gate read the channel-level override, so in an override channel "stop" and
// the turn it was meant to cancel disagreed about whether a mention was needed.
interface GuildTurnState {
  texts: string[];
  signal: AbortSignal | null;
  gate: PromiseWithResolvers<{ text: string }>;
}

function startGuildChannel(options: Record<string, unknown>): {
  ch: DiscordChannel;
  client: ReturnType<typeof makeGatewayClient>;
  abort: AbortController;
  startPromise: Promise<void>;
  state: GuildTurnState;
} {
  const client = makeGatewayClient({ botUserId: "bot-123" });
  const abort = new AbortController();
  const state: GuildTurnState = { texts: [], signal: null, gate: Promise.withResolvers() };
  const agent = {
    chat: async (req: { text: string; abortSignal: AbortSignal }) => {
      state.texts.push(req.text);
      state.signal = req.abortSignal;
      return state.gate.promise;
    },
  };
  const ch = new DiscordChannel(
    { token: "x", guildPolicy: "open", dmPolicy: "open", ...options },
    { logger: makeLogger() as never, createClient: () => client, identifyStaggerMs: 0 },
  );
  const startPromise = ch.start(makeRuntimeStartInput(agent, { onInbound: () => {} }, abort));
  return { ch, client, abort, startPromise, state };
}

function guildMessage(content: string, overrides: Partial<DiscordInboundMessage> = {}): DiscordInboundMessage {
  return inboundMessage({
    channelId: "c1",
    guildId: "g1",
    author: { id: "u1", bot: false },
    content,
    ...overrides,
  });
}

function mention(text: string): Partial<DiscordInboundMessage> {
  return { content: `<@bot-123> ${text}`, mentions: { users: [{ id: "bot-123" }] } };
}

test("M4: channel-level requireMention:false lets a plain 'stop' abort the turn", async () => {
  const h = startGuildChannel({
    requireMention: true,
    guilds: { g1: { channels: { c1: { requireMention: false } } } },
  });
  await waitStarted(h.ch);

  h.client.emit(guildMessage("do the job"));
  await waitFor(() => h.state.signal !== null);
  expect(h.state.texts).toEqual(["do the job"]);

  h.client.emit(guildMessage("stop"));
  await waitFor(() => h.state.signal!.aborted);
  expect(h.state.texts).toEqual(["do the job"]);

  h.state.gate.resolve({ text: "late" });
  h.abort.abort();
  await h.startPromise;
  await settle();
  // Only the abort fast path's own acknowledgement may be outbound; the
  // abandoned turn's answer must never reach the channel.
  expect(h.client.sent.filter((text) => text.includes("late"))).toEqual([]);
});

test("M4: channel-level requireMention:true requires the mention to abort, and a bare 'stop' is dropped", async () => {
  const h = startGuildChannel({
    requireMention: false,
    guilds: { g1: { channels: { c1: { requireMention: true } } } },
  });
  await waitStarted(h.ch);

  h.client.emit(guildMessage("do the job"));
  await settle();
  // The normal gate drops it: an unmentioned message must not start a turn.
  expect(h.state.texts).toEqual([]);

  h.client.emit(guildMessage("", mention("do the job")));
  await waitFor(() => h.state.signal !== null);
  expect(h.state.texts).toEqual(["do the job"]);

  h.client.emit(guildMessage("stop"));
  await settle();
  expect(h.state.signal!.aborted).toBe(false);
  expect(h.state.texts).toEqual(["do the job"]);

  h.client.emit(guildMessage("", mention("stop")));
  await waitFor(() => h.state.signal!.aborted);

  h.state.gate.resolve({ text: "late" });
  h.abort.abort();
  await h.startPromise;
});

test("M4: a thread inherits the parent channel's requireMention override on the abort path", async () => {
  const h = startGuildChannel({
    requireMention: true,
    guilds: { g1: { channels: { p1: { requireMention: false } } } },
  });
  await waitStarted(h.ch);

  const thread = { channelId: "t1", isThread: true, parentChannelId: "p1" };
  h.client.emit(guildMessage("do the job", thread));
  await waitFor(() => h.state.signal !== null);
  expect(h.state.texts).toEqual(["do the job"]);

  h.client.emit(guildMessage("stop", thread));
  await waitFor(() => h.state.signal!.aborted);

  h.state.gate.resolve({ text: "late" });
  h.abort.abort();
  await h.startPromise;
});
