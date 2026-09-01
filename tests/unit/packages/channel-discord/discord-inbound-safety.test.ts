import { expect, test } from "bun:test";
import { DiscordChannel } from "../../../../packages/channel-discord/src/channel";
import type { DiscordClientLike } from "../../../../packages/channel-discord/src/discord-client";
import type { DiscordInboundMessage } from "../../../../packages/channel-discord/src/types";
import type { ChannelStartInput } from "xacpx/plugin-api";

// Channel-level regressions for review round 2: self-message loop (#1) and
// abort fast-path reply precision (#2). These run a STARTED channel with a
// captured Gateway onMessage handler, so they exercise handleMessageEvent end
// to end — the layer where the earlier unit tests could not reach.

function makeLogger() {
  return {
    info: async () => {},
    warn: async () => {},
    error: async () => {},
    debug: async () => {},
  };
}

interface CapturingClient extends DiscordClientLike {
  emit: (msg: DiscordInboundMessage) => void;
  sent: Array<{ channelId: string; content: string }>;
}

function makeCapturingClient(): CapturingClient {
  let handler: ((msg: DiscordInboundMessage) => void) | null = null;
  const sent: Array<{ channelId: string; content: string }> = [];
  const client: CapturingClient = {
    start: async (input) => {
      handler = input.handlers.onMessage;
      return { botUserId: "bot1", botTag: "Bot#0001" };
    },
    probeBot: async () => ({ botUserId: "bot1", botTag: "Bot#0001" }),
    sendMessage: async (target, body) => {
      sent.push({ channelId: target.channelId, content: body.content ?? "" });
      return { messageId: `s${sent.length}` };
    },
    editMessage: async () => {},
    deleteMessage: async () => {},
    startTyping: async () => () => {},
    addReaction: async () => {},
    destroy: async () => {},
    emit: (msg) => {
      if (handler) handler(msg);
    },
    sent,
  };
  return client;
}

function makeStartInput(agent: unknown, abort: AbortController, quota: unknown): ChannelStartInput {
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

function inbound(overrides: Partial<DiscordInboundMessage>): DiscordInboundMessage {
  return {
    id: "m1",
    channelId: "c1",
    guildId: null,
    author: { id: "u1", bot: false },
    content: "",
    createdTimestamp: Date.now(),
    ...overrides,
  };
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 2));
  }
}

async function settle(ms = 30): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

// start() keeps alive until abort by design; poll the account runtime via a
// coordinator probe instead of awaiting start().
async function probeStarted(ch: DiscordChannel, accountId = "default"): Promise<void> {
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

test("own messages are always dropped even with allowBots:true (no self-loop)", async () => {
  const client = makeCapturingClient();
  const chatTexts: string[] = [];
  const quotaKeys: string[] = [];
  const agent = {
    chat: async (req: { text: string }) => {
      chatTexts.push(req.text);
      return { text: "ok" };
    },
  };
  const quota = { onInbound: (chatKey: string) => quotaKeys.push(chatKey) };
  const abort = new AbortController();
  const ch = new DiscordChannel(
    // allowBots:true is exactly the dangerous config: without an unconditional
    // self-check the bot's own MESSAGE_CREATE echo re-enters the agent. DM is
    // the worst path because it needs no mention.
    { token: "x", allowBots: true, dmPolicy: "open", guildPolicy: "open", requireMention: true },
    { logger: makeLogger() as never, createClient: () => client, identifyStaggerMs: 0 },
  );
  const startPromise = ch.start(makeStartInput(agent, abort, quota));
  await probeStarted(ch);

  // Gateway echo of the bot's own outbound message.
  client.emit(
    inbound({
      id: "self1",
      channelId: "dm1",
      guildId: null,
      author: { id: "bot1", bot: true },
      content: "my own echo that must never loop",
    }),
  );
  await settle();
  expect(chatTexts).toEqual([]);
  expect(quotaKeys).toEqual([]);

  // allowBots:true must still admit OTHER bots — the self-check is specific
  // to our own bot user id, not a blanket bot filter.
  client.emit(
    inbound({
      id: "other1",
      channelId: "dm1",
      guildId: null,
      author: { id: "other-bot", bot: true },
      content: "hello from another bot",
    }),
  );
  await waitFor(() => chatTexts.length === 1);
  expect(chatTexts).toEqual(["hello from another bot"]);

  abort.abort();
  await startPromise;
});

test("guild abort fast path: reply to a human must not abort, reply to the bot must", async () => {
  const client = makeCapturingClient();
  let seenSignal: AbortSignal | null = null;
  const agent = {
    chat: (req: { abortSignal: AbortSignal }) => {
      seenSignal = req.abortSignal;
      // Keep the turn alive until aborted, like a long-running agent turn.
      return new Promise((_resolve, reject) => {
        req.abortSignal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    },
  };
  const quota = { onInbound: () => {} };
  const abort = new AbortController();
  const ch = new DiscordChannel(
    { token: "x", dmPolicy: "open", guildPolicy: "open", requireMention: true },
    { logger: makeLogger() as never, createClient: () => client, identifyStaggerMs: 0 },
  );
  const startPromise = ch.start(makeStartInput(agent, abort, quota));
  await probeStarted(ch);

  // Human starts a turn by mentioning the bot in a guild channel.
  client.emit(
    inbound({
      id: "turn1",
      channelId: "c1",
      guildId: "g1",
      author: { id: "u1", bot: false },
      content: "<@bot1> do the long job",
      mentions: { users: [{ id: "bot1" }] },
    }),
  );
  await waitFor(() => seenSignal !== null);

  // "stop" replied to ANOTHER HUMAN must not abort the active turn
  // (review round 2 #2: Boolean(referencedMessageId) was too wide).
  client.emit(
    inbound({
      id: "stop1",
      channelId: "c1",
      guildId: "g1",
      author: { id: "u1", bot: false },
      content: "stop",
      referencedMessageId: "some-other-humans-message",
      repliedUserId: "human2",
    }),
  );
  await settle();
  expect(seenSignal!.aborted).toBe(false);

  // "stop" replied to the bot must abort.
  client.emit(
    inbound({
      id: "stop2",
      channelId: "c1",
      guildId: "g1",
      author: { id: "u1", bot: false },
      content: "stop",
      referencedMessageId: "bot-answer-message",
      repliedUserId: "bot1",
    }),
  );
  await waitFor(() => seenSignal!.aborted);

  abort.abort();
  await startPromise;
});

// Review round 6 (Minor): quota.onInbound resets the OUTBOUND budget for this
// chat, so it must fire the moment the message is accepted. It used to sit
// after downloadInboundAttachments, where one slow attachment fetch delayed
// the reset for every later reply in the same channel.
test("accepted message resets the outbound budget before the attachment fetch", async () => {
  const client = makeCapturingClient();
  const events: string[] = [];
  const agent = { chat: async () => ({ text: "ok" }) };
  const quota = {
    onInbound: (chatKey: string) => {
      events.push(`budget-reset:${chatKey}`);
    },
  };

  let releaseFetch: (() => void) | null = null;
  const fetchImpl = (async () => {
    events.push("attachment-fetch:started");
    await new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    events.push("attachment-fetch:resolved");
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: { get: () => null },
      arrayBuffer: async () => new ArrayBuffer(8),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  const mediaStore = {
    saveMediaBuffer: async () => {
      events.push("attachment:saved");
      return { filePath: "/tmp/a.png", kind: "image", fileName: "a.png" };
    },
  } as never;

  const abort = new AbortController();
  const ch = new DiscordChannel(
    { token: "x", dmPolicy: "open", guildPolicy: "open", requireMention: false },
    { logger: makeLogger() as never, createClient: () => client, identifyStaggerMs: 0, fetchImpl, mediaStore },
  );
  const startPromise = ch.start(makeStartInput(agent, abort, quota));
  await probeStarted(ch);

  client.emit(
    inbound({
      id: "att1",
      channelId: "dm1",
      guildId: null,
      author: { id: "u1", bot: false },
      content: "look at this image",
      attachments: [{ id: "a1", url: "https://cdn.discord.test/a.png", name: "a.png", size: 8 }],
    }),
  );
  await waitFor(() => events.includes("attachment-fetch:started"));
  // A rejected message must not reset the budget (asserted by the self-loop
  // test above); an accepted one must reset it while the fetch is pending.
  expect(events).toEqual(["budget-reset:discord:default:dm:dm1", "attachment-fetch:started"]);

  releaseFetch!();
  await waitFor(() => events.includes("attachment:saved"));
  // Exactly once: moving the call must not leave the old one behind.
  expect(events.filter((event) => event.startsWith("budget-reset:"))).toEqual([
    "budget-reset:discord:default:dm:dm1",
  ]);

  abort.abort();
  await startPromise;
});
