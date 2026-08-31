import { beforeAll, expect, test } from "bun:test";
import { DiscordChannel } from "../../../../packages/channel-discord/src/channel";
import type { DiscordClientLike } from "../../../../packages/channel-discord/src/discord-client";
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

function makeClient(overrides: Partial<DiscordClientLike> = {}): DiscordClientLike & { destroyCount: number } {
  const client = {
    start: async () => {},
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
  for (let i = 0; i < 200 && !(await probeStarted(ch, "good")); i++) {
    await new Promise((r) => setTimeout(r, 1));
  }

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

async function probeStarted(ch: DiscordChannel, accountId: string): Promise<boolean> {
  let started = false;
  try {
    await ch.sendCoordinatorMessage({ chatKey: `discord:${accountId}:g:__probe__`, text: "" });
    started = true;
  } catch (error) {
    started = !(error instanceof Error && error.message.includes("not started"));
  }
  return started;
}

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
