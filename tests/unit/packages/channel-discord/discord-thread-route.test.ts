import { beforeAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiscordChannel } from "../../../../packages/channel-discord/src/channel";
import type { DiscordClientLike } from "../../../../packages/channel-discord/src/discord-client";
import type { DiscordInboundMessage, OutboundBody } from "../../../../packages/channel-discord/src/types";
import { registerKnownChannelId } from "../../../../src/channels/channel-scope";
import type { ChannelStartInput } from "xacpx/plugin-api";

beforeAll(() => {
  // Production registers this via registerChannelFactory when the plugin loads.
  registerKnownChannelId("discord");
});

// Round 7 F7: the archived-thread fallback must be ONE helper, called lazily,
// that every outbound surface shares — final text, outbound media and the
// coordinator route. Before this round media bypassed it entirely: an archived
// thread meant the attachment was logged away and dropped, and the text path
// re-sent to the thread a second time before falling back.

type Attempt = {
  channelId: string;
  content?: string;
  fileNames: string[];
  fileSizes: number[];
  mentionParse?: string[];
  delivered: boolean;
};

function archivedThreadError(): Error {
  return Object.assign(new Error("Cannot send messages to this archived thread"), { code: 50083 });
}

function makeLogger(errors: string[] = []) {
  return {
    info: async () => {},
    warn: async () => {},
    error: async (_event: string, msg: string) => {
      errors.push(msg);
    },
    debug: async () => {},
    errors,
  };
}

function makeThreadClient(input: {
  identity: { botUserId: string };
  failingChannelIds?: string[];
  parentOf?: Record<string, string>;
}) {
  const attempts: Attempt[] = [];
  const failing = new Set(input.failingChannelIds ?? []);
  let parentLookups = 0;
  let handler: ((msg: DiscordInboundMessage) => void) | null = null;

  const client = {
    start: async (startInput: { handlers: { onMessage(m: DiscordInboundMessage): void } }) => {
      handler = startInput.handlers.onMessage;
      return input.identity;
    },
    probeBot: async () => ({ botUserId: "" }),
    sendMessage: async (target: { channelId: string }, body: OutboundBody) => {
      const files = body.files ?? [];
      const attempt: Attempt = {
        channelId: target.channelId,
        content: body.content,
        fileNames: files.map((f) => f.name ?? ""),
        fileSizes: files.map((f) => (Buffer.isBuffer(f.attachment) ? f.attachment.byteLength : Buffer.byteLength(String(f.attachment)))),
        mentionParse: body.allowedMentions?.parse,
        delivered: !failing.has(target.channelId),
      };
      attempts.push(attempt);
      if (failing.has(target.channelId)) throw archivedThreadError();
      return { messageId: `a${attempts.length}` };
    },
    editMessage: async () => {},
    deleteMessage: async () => {},
    startTyping: async () => () => {},
    addReaction: async () => {},
    destroy: async () => {},
    getParentChannelId: async (threadId: string) => {
      parentLookups += 1;
      return input.parentOf?.[threadId] ?? null;
    },
    attempts,
    get parentLookups() {
      return parentLookups;
    },
    delivered: (channelId: string) => attempts.filter((a) => a.channelId === channelId && a.delivered),
    tried: (channelId: string) => attempts.filter((a) => a.channelId === channelId),
    emit: (msg: DiscordInboundMessage) => {
      handler?.(msg);
    },
  };
  return client;
}

type ThreadClient = ReturnType<typeof makeThreadClient> & {
  attempts: Attempt[];
  parentLookups: number;
};

function threadMessage(overrides: Partial<DiscordInboundMessage> = {}): DiscordInboundMessage {
  return {
    id: `m-${Math.random().toString(36).slice(2)}`,
    channelId: "thread-1",
    guildId: "g1",
    isThread: true,
    parentChannelId: "parent-1",
    author: { id: "u1", bot: false },
    content: "go",
    createdTimestamp: Date.now(),
    ...overrides,
  };
}

async function settle(ms = 40): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await settle(2);
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
    await settle(2);
  }
}

const mediaDir = mkdtempSync(join(tmpdir(), "discord-thread-route-"));
const mediaPath = join(mediaDir, "chart.png");
const MEDIA_BYTES = 24;
writeFileSync(mediaPath, Buffer.alloc(MEDIA_BYTES, 7));

const outboundMedia = [
  { kind: "image", filePath: mediaPath, fileName: "chart.png", caption: "the chart", mimeType: "image/png" },
];

function makeHarness(input: {
  client: ThreadClient;
  agentResult: { text?: string; media?: unknown };
}) {
  const logger = makeLogger();
  const abort = new AbortController();
  // Typed through DiscordClientLike so a real client-signature drift breaks
  // this file instead of silently narrowing what the fake has to satisfy.
  const createClient = (): DiscordClientLike => input.client;
  const ch = new DiscordChannel(
    // replyMode "static" keeps the outbound surface to the final answer, so the
    // assertions below count deliveries rather than preview edits.
    { token: "x", dmPolicy: "open", guildPolicy: "open", requireMention: false, replyMode: "static" },
    {
      logger: logger as never,
      createClient,
      identifyStaggerMs: 0,
      allowedMediaRoots: [mediaDir],
    },
  );
  const startPromise = ch.start({
    logger,
    abortSignal: abort.signal,
    agent: { chat: async () => input.agentResult },
    activeTurns: null,
    sessions: null,
    quota: { onInbound: () => {} },
    locale: "en",
  } as unknown as ChannelStartInput);
  return { ch, client: input.client, logger, abort, startPromise };
}

type Harness = ReturnType<typeof makeHarness>;

async function runTurn(harness: Harness, msg: DiscordInboundMessage): Promise<void> {
  await waitStarted(harness.ch);
  harness.client.emit(msg);
  await waitFor(() => harness.client.attempts.length > 0);
  await settle();
}

// Test A: final text in an archived thread must land in the parent channel, and
// the thread must be attempted exactly once — the fallback helper owns the
// first try, so the caller may not pre-send and then call it as well.
test("archived thread: final text falls back to the parent without a second send to the thread", async () => {
  const client = makeThreadClient({ identity: { botUserId: "bot-1" }, failingChannelIds: ["thread-1"] });
  const harness = makeHarness({ client, agentResult: { text: "the answer" } });

  await runTurn(harness, threadMessage());

  expect(client.tried("thread-1").length).toBe(1);
  expect(client.tried("thread-1")[0].delivered).toBe(false);
  expect(client.delivered("parent-1").map((a) => a.content)).toEqual(["the answer"]);
  // The parent came from the turn's own message metadata, not from a REST lookup.
  expect(client.parentLookups).toBe(0);

  harness.abort.abort();
  await harness.startPromise;
});

// Test B: text and media of the same turn share one fallback, so an archived
// thread delivers both to the parent with the media body intact.
test("archived thread: text and media both reach the parent with the media body unchanged", async () => {
  const client = makeThreadClient({ identity: { botUserId: "bot-1" }, failingChannelIds: ["thread-1"] });
  const harness = makeHarness({ client, agentResult: { text: "the answer", media: outboundMedia } });

  await runTurn(harness, threadMessage());

  const parentDeliveries = client.delivered("parent-1");
  expect(parentDeliveries.map((a) => a.content)).toEqual(["the answer", "the chart"]);
  const media = parentDeliveries.find((a) => a.fileNames.length > 0);
  expect(media?.fileNames).toEqual(["chart.png"]);
  expect(media?.fileSizes).toEqual([MEDIA_BYTES]);
  expect(media?.mentionParse).toEqual([]);
  expect(client.tried("thread-1").length).toBe(2);
  expect(client.tried("thread-1").every((a) => !a.delivered)).toBe(true);

  harness.abort.abort();
  await harness.startPromise;
});

// Test C (the decisive one): a media-only final answer has no text chunk to
// carry the fallback, so before this round the attachment was logged away and
// dropped. The parent channel must receive the file.
test("archived thread: a media-only final answer still delivers the attachment to the parent", async () => {
  const client = makeThreadClient({ identity: { botUserId: "bot-1" }, failingChannelIds: ["thread-1"] });
  const harness = makeHarness({ client, agentResult: { media: outboundMedia } });

  await runTurn(harness, threadMessage());

  const parentDeliveries = client.delivered("parent-1");
  expect(parentDeliveries.length).toBe(1);
  expect(parentDeliveries[0].fileNames).toEqual(["chart.png"]);
  expect(parentDeliveries[0].fileSizes).toEqual([MEDIA_BYTES]);
  expect(parentDeliveries[0].content).toBe("the chart");
  expect(parentDeliveries[0].mentionParse).toEqual([]);
  expect(harness.logger.errors.filter((m) => m.includes("failed to send discord media"))).toEqual([]);

  harness.abort.abort();
  await harness.startPromise;
});

// Test D: the fallback is scoped to threads. A plain channel or DM send must
// not resolve — let alone deliver to — some parent channel. Media only, so the
// media loop is the surface under test.
test("non-thread media failure never resolves or uses a parent channel", async () => {
  const client = makeThreadClient({
    identity: { botUserId: "bot-1" },
    failingChannelIds: ["chan-9"],
    parentOf: { "chan-9": "parent-1" },
  });
  const harness = makeHarness({ client, agentResult: { media: outboundMedia } });

  await runTurn(harness, threadMessage({ channelId: "chan-9", isThread: false, parentChannelId: null }));

  expect(client.tried("chan-9").length).toBe(1);
  expect(client.delivered("chan-9")).toEqual([]);
  expect(client.attempts.filter((a) => a.channelId === "parent-1")).toEqual([]);
  expect(client.parentLookups).toBe(0);
  expect(harness.logger.errors.some((m) => m.includes("failed to send discord media"))).toBe(true);

  harness.abort.abort();
  await harness.startPromise;
});

// Test E: the resolver is lazy. A thread that is alive pays nothing for the
// fallback — no parent lookup, no second delivery.
test("live thread: a healthy thread send resolves no parent and delivers nothing elsewhere", async () => {
  const client = makeThreadClient({
    identity: { botUserId: "bot-1" },
    parentOf: { "thread-1": "parent-1" },
  });
  const harness = makeHarness({ client, agentResult: { text: "the answer", media: outboundMedia } });

  await runTurn(harness, threadMessage());

  expect(client.delivered("thread-1").map((a) => a.content)).toEqual(["the answer", "the chart"]);
  expect(client.delivered("thread-1")[1].fileNames).toEqual(["chart.png"]);
  expect(client.attempts.filter((a) => a.channelId === "parent-1")).toEqual([]);
  expect(client.parentLookups).toBe(0);

  harness.abort.abort();
  await harness.startPromise;
});

// Test F: the coordinator route uses the same helper, so it too attempts the
// thread once and resolves the parent only after that attempt fails.
test("coordinator text to an archived thread uses the same single-attempt fallback", async () => {
  const client = makeThreadClient({
    identity: { botUserId: "bot-1" },
    failingChannelIds: ["thread-1"],
    parentOf: { "thread-1": "parent-1" },
  });
  const harness = makeHarness({ client, agentResult: { text: "unused" } });
  await waitStarted(harness.ch);

  await harness.ch.sendCoordinatorMessage({ chatKey: "discord:default:t:thread-1", text: "coordinated note" });
  await settle();

  expect(client.tried("thread-1").length).toBe(1);
  expect(client.delivered("parent-1").map((a) => a.content)).toEqual(["coordinated note"]);
  expect(client.parentLookups).toBe(1);

  harness.abort.abort();
  await harness.startPromise;
});

// Test G: with no discoverable parent the original Discord error must still
// reach the caller — falling back is best effort, never a silent success.
test("archived thread with no discoverable parent rethrows the original error", async () => {
  const client = makeThreadClient({ identity: { botUserId: "bot-1" }, failingChannelIds: ["thread-1"] });
  const harness = makeHarness({ client, agentResult: { text: "the answer" } });
  await waitStarted(harness.ch);

  let thrown: unknown = null;
  try {
    await harness.ch.sendCoordinatorMessage({ chatKey: "discord:default:t:thread-1", text: "coordinated note" });
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(Error);
  expect((thrown as Error).message).toContain("archived thread");
  expect(client.attempts.filter((a) => a.channelId === "parent-1")).toEqual([]);

  harness.abort.abort();
  await harness.startPromise;
});
