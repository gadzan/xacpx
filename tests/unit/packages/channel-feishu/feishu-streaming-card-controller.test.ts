import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { setChannelLocale, t as feishuT } from "../../../../packages/channel-feishu/src/i18n/index";

import {
  StreamingCardController,
  type StreamingCardClient,
} from "../../../../packages/channel-feishu/src/card/streaming-card-controller";
import {
  isMessageUnavailable,
  markMessageUnavailable,
  resetMessageUnavailableCacheForTests,
} from "../../../../packages/channel-feishu/src/message-unavailable";
import {
  __resetShutdownHooksForTests,
  fireShutdownHooksForTests,
} from "../../../../packages/channel-feishu/src/card/shutdown-hooks";

beforeAll(() => {
  setChannelLocale("zh");
});

afterAll(() => {
  setChannelLocale("en");
});

beforeEach(() => {
  resetMessageUnavailableCacheForTests();
  __resetShutdownHooksForTests();
});

interface FakeClientCalls {
  cardCreate: Array<{ data: string }>;
  cardUpdate: Array<{ cardId: string; sequence: number; cardJson: Record<string, unknown> }>;
  elementContent: Array<{ cardId: string; elementId: string; content: string; sequence: number }>;
  messageReply: Array<{ replyTo: string; content: string }>;
  messageCreate: Array<{ receiveIdType: string; receiveId: string; content: string }>;
}

function createFakeClient(options: { failReply?: unknown; failUpdate?: unknown; omitElementApi?: boolean; failElement?: unknown } = {}): { client: StreamingCardClient; calls: FakeClientCalls } {
  const calls: FakeClientCalls = {
    cardCreate: [],
    cardUpdate: [],
    elementContent: [],
    messageReply: [],
    messageCreate: [],
  };
  let createSeq = 0;
  const client: StreamingCardClient = {
    cardkit: {
      v1: {
        card: {
          create: async (input) => {
            calls.cardCreate.push({ data: input.data.data });
            createSeq += 1;
            return { data: { card_id: `card_${createSeq}` } };
          },
          update: async (input) => {
            if (options.failUpdate) throw options.failUpdate;
            calls.cardUpdate.push({
              cardId: input.path.card_id,
              sequence: input.data.sequence,
              cardJson: JSON.parse(input.data.card.data) as Record<string, unknown>,
            });
            return {};
          },
        },
        ...(options.omitElementApi
          ? {}
          : {
              cardElement: {
                content: async (input) => {
                  if (options.failElement) throw options.failElement;
                  calls.elementContent.push({
                    cardId: input.path.card_id,
                    elementId: input.path.element_id,
                    content: input.data.content,
                    sequence: input.data.sequence,
                  });
                  return {};
                },
              },
            }),
      },
    },
    im: {
      message: {
        reply: async (input) => {
          if (options.failReply) throw options.failReply;
          calls.messageReply.push({ replyTo: input.path.message_id, content: input.data.content });
          return { data: { message_id: "om_card", chat_id: "oc_chat" } };
        },
        create: async (input) => {
          calls.messageCreate.push({
            receiveIdType: input.params.receive_id_type,
            receiveId: input.data.receive_id,
            content: input.data.content,
          });
          return { data: { message_id: "om_card_fresh", chat_id: "oc_chat" } };
        },
      },
    },
  };
  return { client, calls };
}

test("seed uses reply path when replyToMessageId is provided and available", async () => {
  const { client, calls } = createFakeClient();
  const controller = new StreamingCardController({ client, flushIntervalMs: 10 });
  const result = await controller.seed({ to: "oc_chat", replyToMessageId: "om_in" });

  expect(calls.cardCreate).toHaveLength(1);
  expect(calls.messageReply).toHaveLength(1);
  expect(calls.messageReply[0].replyTo).toBe("om_in");
  expect(calls.messageCreate).toHaveLength(0);
  expect(result.cardId).toBe("card_1");
  expect(result.messageId).toBe("om_card");
});

test("seed falls back to fresh send when reply fails", async () => {
  const { client, calls } = createFakeClient({ failReply: new Error("forbidden") });
  const controller = new StreamingCardController({ client, flushIntervalMs: 10 });
  const result = await controller.seed({ to: "oc_chat", replyToMessageId: "om_in" });

  expect(calls.messageCreate).toHaveLength(1);
  expect(result.messageId).toBe("om_card_fresh");
});

test("seed ignores unavailable mark from a different account scope", async () => {
  // A different bot marked om_in as recalled. Our bot (account "a") should
  // still attempt the reply path because the cache is scoped per account.
  markMessageUnavailable("om_in", 230011, "b");
  const { client, calls } = createFakeClient();
  const controller = new StreamingCardController({
    client,
    flushIntervalMs: 10,
    accountId: "a",
  });
  await controller.seed({ to: "oc_chat", replyToMessageId: "om_in" });
  expect(calls.messageReply).toHaveLength(1);
  expect(calls.messageCreate).toHaveLength(0);
});

test("seed honors unavailable mark from the same account scope", async () => {
  markMessageUnavailable("om_in", 231003, "a");
  const { client, calls } = createFakeClient();
  const controller = new StreamingCardController({
    client,
    flushIntervalMs: 10,
    accountId: "a",
  });
  await controller.seed({ to: "oc_chat", replyToMessageId: "om_in" });
  expect(calls.messageReply).toHaveLength(0);
  expect(calls.messageCreate).toHaveLength(1);
});

test("seed reply failure marks unavailable under the controller's account scope", async () => {
  const err = { code: 230011, msg: "recalled" };
  const { client } = createFakeClient({ failReply: err });
  const controller = new StreamingCardController({
    client,
    flushIntervalMs: 10,
    accountId: "a",
  });
  await controller.seed({ to: "oc_chat", replyToMessageId: "om_in" });
  expect(isMessageUnavailable("om_in", "a")).toBe(true);
  expect(isMessageUnavailable("om_in", "b")).toBe(false);
  expect(isMessageUnavailable("om_in")).toBe(false);
});

test("first terminal transition wins; subsequent complete/abort/fail are no-ops", async () => {
  const { client, calls } = createFakeClient();
  const controller = new StreamingCardController({ client, flushIntervalMs: 5 });
  await controller.seed({ to: "oc_chat" });
  controller.appendStream("partial");
  // Fire abort then complete back-to-back. The synchronous transitionTo step
  // in abort flips state to "aborted" before complete runs, so complete must
  // become a no-op.
  const a = controller.abort("stopped");
  const b = controller.complete("ignored final");
  await Promise.all([a, b]);
  const last = calls.cardUpdate[calls.cardUpdate.length - 1];
  const summary = (last.cardJson as { config?: { summary?: { i18n_content?: Record<string, string> } } })
    .config?.summary?.i18n_content;
  expect(summary?.zh_cn ?? "").toBe("已停止");
  // Streamed content is preserved across abort (the abort message is only a
  // fallback when streamedText is empty). The losing complete() must not
  // append its "ignored final" tail either.
  const bodyElements = (last.cardJson as { body?: { elements?: Array<Record<string, unknown>> } }).body?.elements ?? [];
  const streamingElement = bodyElements.find((el) => (el as { element_id?: string }).element_id === "streaming_content");
  const content = (streamingElement as { content?: string } | undefined)?.content ?? "";
  expect(content).toBe("partial");
  expect(content).not.toContain("stopped");
  expect(content).not.toContain("ignored final");
});

test("abort with no prior streamed content uses message as fallback display", async () => {
  const { client, calls } = createFakeClient();
  const controller = new StreamingCardController({ client, flushIntervalMs: 5 });
  await controller.seed({ to: "oc_chat" });
  await controller.abort("stopped");
  const last = calls.cardUpdate[calls.cardUpdate.length - 1];
  const elements = (last.cardJson.body as { elements: Array<{ content: string; element_id?: string }> }).elements;
  const streaming = elements.find((el) => el.element_id === "streaming_content");
  expect(streaming?.content).toBe("stopped");
});

test("appendStream after complete is rejected", async () => {
  const { client, calls } = createFakeClient();
  const controller = new StreamingCardController({ client, flushIntervalMs: 5 });
  await controller.seed({ to: "oc_chat" });
  await controller.complete("done");
  const updatesBefore = calls.cardUpdate.length;
  controller.appendStream("zombie chunk");
  // Give any errant flush a chance to fire.
  await new Promise((r) => setTimeout(r, 20));
  expect(calls.cardUpdate.length).toBe(updatesBefore);
});

test("appendStream joins each segment with a paragraph break and complete force-flushes", async () => {
  const { client, calls } = createFakeClient();
  const controller = new StreamingCardController({ client, flushIntervalMs: 30 });
  await controller.seed({ to: "oc_chat" });

  // Each appendStream call is one complete aggregator batch (paragraph), not a
  // partial token chunk. They must render as visually distinct blocks.
  controller.appendStream("hel");
  controller.appendStream("lo ");
  controller.appendStream("world");

  await controller.complete();

  expect(calls.cardUpdate.length).toBeGreaterThanOrEqual(1);
  const last = calls.cardUpdate[calls.cardUpdate.length - 1];
  expect((last.cardJson.config as { streaming_mode: boolean }).streaming_mode).toBe(false);
  expect((last.cardJson.config as { summary: { content: string } }).summary.content).toBe(feishuT().summaryComplete);
  const elements = (last.cardJson.body as { elements: Array<{ content: string }> }).elements;
  expect(elements[0].content).toBe("hel\n\nlo \n\nworld");
});

test("complete with explicit finalText appends below streamed content", async () => {
  const { client, calls } = createFakeClient();
  const controller = new StreamingCardController({ client, flushIntervalMs: 30 });
  await controller.seed({ to: "oc_chat" });

  controller.appendStream("intermediate");
  await controller.complete("final answer");

  const last = calls.cardUpdate[calls.cardUpdate.length - 1];
  const elements = (last.cardJson.body as { elements: Array<{ content: string }> }).elements;
  expect(elements[0].content).toBe("intermediate\n\nfinal answer");
});

test("complete() with empty string preserves streamed content", async () => {
  // Regression: in streaming mode the transport returns text:"" after pushing
  // every segment via reply(). The card body must keep the streamed progress
  // — replacing it with "" would leave the user staring at just a "已完成"
  // footer.
  const { client, calls } = createFakeClient();
  const controller = new StreamingCardController({ client, flushIntervalMs: 30 });
  await controller.seed({ to: "oc_chat" });

  controller.appendStream("step 1");
  controller.appendStream("step 2");
  await controller.complete("");

  const last = calls.cardUpdate[calls.cardUpdate.length - 1];
  const elements = (last.cardJson.body as { elements: Array<{ content: string }> }).elements;
  expect(elements[0].content).toBe("step 1\n\nstep 2");
});

test("complete() with undefined preserves streamed content", async () => {
  const { client, calls } = createFakeClient();
  const controller = new StreamingCardController({ client, flushIntervalMs: 30 });
  await controller.seed({ to: "oc_chat" });

  controller.appendStream("step 1");
  await controller.complete();

  const last = calls.cardUpdate[calls.cardUpdate.length - 1];
  const elements = (last.cardJson.body as { elements: Array<{ content: string }> }).elements;
  expect(elements[0].content).toBe("step 1");
});

test("abort emits an 'aborted' final-state card", async () => {
  const { client, calls } = createFakeClient();
  const controller = new StreamingCardController({ client, flushIntervalMs: 30 });
  await controller.seed({ to: "oc_chat" });

  controller.appendStream("partial");
  await controller.abort();

  const last = calls.cardUpdate[calls.cardUpdate.length - 1];
  expect((last.cardJson.config as { summary: { content: string } }).summary.content).toBe(feishuT().summaryStopped);
  const elements = (last.cardJson.body as { elements: Array<{ content: string }> }).elements;
  expect(elements[0].content).toBe("partial");
  expect(elements[1].content).toContain(feishuT().summaryStopped);
});

test("once terminated, subsequent appends are no-ops", async () => {
  const { client, calls } = createFakeClient();
  const controller = new StreamingCardController({ client, flushIntervalMs: 30 });
  await controller.seed({ to: "oc_chat" });

  controller.appendStream("a");
  await controller.complete("done");
  const updatesAfterComplete = calls.cardUpdate.length;

  controller.appendStream("ignored");
  await controller.waitIdle();
  expect(calls.cardUpdate.length).toBe(updatesAfterComplete);
});

test("card.update errors are swallowed", async () => {
  const { client } = createFakeClient({ failUpdate: new Error("network") });
  const controller = new StreamingCardController({ client, flushIntervalMs: 10 });
  await controller.seed({ to: "oc_chat" });

  controller.appendStream("a");
  await expect(controller.complete("final")).resolves.toBeUndefined();
});

test("repeated card.update failures fire onCardDegraded with the buffered text", async () => {
  const degradeCalls: Array<{ buffer: string; consecutiveFailures: number }> = [];
  const { client } = createFakeClient({ failUpdate: new Error("network") });
  const controller = new StreamingCardController({
    client,
    flushIntervalMs: 5,
    failureThreshold: 3,
    onCardDegraded: (input) => degradeCalls.push(input),
  });
  await controller.seed({ to: "oc_chat" });
  for (let i = 0; i < 5; i++) {
    controller.appendStream(`chunk${i}`);
    await new Promise((r) => setTimeout(r, 15));
  }
  await controller.complete("final answer text");
  expect(controller.isDegraded()).toBe(true);
  expect(degradeCalls.length).toBe(1);
  expect(degradeCalls[0].consecutiveFailures).toBeGreaterThanOrEqual(3);
  expect(degradeCalls[0].buffer.length).toBeGreaterThan(0);
});

test("recalled (230011) update errors do not count as failures", async () => {
  const degradeCalls: number[] = [];
  const recalledError = { code: 230011, msg: "recalled" };
  const { client } = createFakeClient({ failUpdate: recalledError });
  const controller = new StreamingCardController({
    client,
    flushIntervalMs: 5,
    failureThreshold: 2,
    onCardDegraded: () => degradeCalls.push(1),
  });
  await controller.seed({ to: "oc_chat" });
  controller.appendStream("a");
  await new Promise((r) => setTimeout(r, 15));
  controller.appendStream("b");
  await new Promise((r) => setTimeout(r, 15));
  controller.appendStream("c");
  await controller.complete("done");
  // Once marked unavailable, pushUpdate short-circuits and doesn't even try
  // the update — so neither path counts. Degraded callback must not fire.
  expect(degradeCalls).toEqual([]);
  expect(controller.isDegraded()).toBe(false);
});

test("subsequent streaming pushes use cardElement.content (not full card.update)", async () => {
  const { client, calls } = createFakeClient();
  // Pin clock so the streaming footer label ("Xms"/"X.Ys") stays in the same
  // bucket between pushes — otherwise the footerChanged guard would force a
  // full card.update each tick and the fast-path would never engage. We're
  // proving the fast-path works when nothing visible has changed.
  const controller = new StreamingCardController({ client, flushIntervalMs: 10, now: () => 1_000 });
  await controller.seed({ to: "oc_chat" });

  controller.appendStream("first");
  await new Promise((r) => setTimeout(r, 30));
  controller.appendStream("second");
  await new Promise((r) => setTimeout(r, 30));
  await controller.complete();

  // First streaming push goes through card.update (transitioning thinking→streaming);
  // subsequent pure-text pushes go through cardElement.content; complete is a full card.update again.
  expect(calls.cardUpdate.length).toBeGreaterThanOrEqual(2);
  expect(calls.elementContent.length).toBeGreaterThanOrEqual(1);
  const lastElement = calls.elementContent[calls.elementContent.length - 1];
  expect(lastElement.elementId).toBe("streaming_content");
  expect(lastElement.content).toContain("first\n\nsecond");
});

test("falls back to full card.update when cardElement.content is unavailable", async () => {
  const { client, calls } = createFakeClient({ omitElementApi: true });
  const controller = new StreamingCardController({ client, flushIntervalMs: 10 });
  await controller.seed({ to: "oc_chat" });

  controller.appendStream("first");
  await new Promise((r) => setTimeout(r, 30));
  controller.appendStream(" second");
  await new Promise((r) => setTimeout(r, 30));
  await controller.complete();

  expect(calls.elementContent).toHaveLength(0);
  expect(calls.cardUpdate.length).toBeGreaterThanOrEqual(2);
});

test("falls back to full card.update when cardElement.content throws", async () => {
  const { client, calls } = createFakeClient({ failElement: new Error("element gone") });
  const controller = new StreamingCardController({ client, flushIntervalMs: 10 });
  await controller.seed({ to: "oc_chat" });

  controller.appendStream("a");
  await new Promise((r) => setTimeout(r, 30));
  controller.appendStream("b");
  await new Promise((r) => setTimeout(r, 30));
  await controller.complete();

  // element call attempted but failed; card.update should have been used as fallback.
  expect(calls.cardUpdate.length).toBeGreaterThanOrEqual(2);
});

test("complete final card includes elapsed footer", async () => {
  const { client, calls } = createFakeClient();
  let t = 1_000;
  const controller = new StreamingCardController({ client, flushIntervalMs: 5, now: () => t });
  await controller.seed({ to: "oc_chat" });
  t += 2_500; // simulate 2.5s passing
  controller.appendStream("hello");
  await controller.complete();

  const last = calls.cardUpdate[calls.cardUpdate.length - 1];
  const body = last.cardJson.body as { elements: Array<{ content: string }> };
  expect(body.elements[1].content).toContain(feishuT().summaryComplete);
  expect(body.elements[1].content).toContain("2.5s");
});

test("aborted card includes elapsed footer", async () => {
  const { client, calls } = createFakeClient();
  let t = 5_000;
  const controller = new StreamingCardController({ client, flushIntervalMs: 5, now: () => t });
  await controller.seed({ to: "oc_chat" });
  t += 750;
  await controller.abort();

  const last = calls.cardUpdate[calls.cardUpdate.length - 1];
  const body = last.cardJson.body as { elements: Array<{ content: string }> };
  expect(body.elements[1].content).toContain(feishuT().summaryStopped);
  expect(body.elements[1].content).toContain("750ms");
});

test("complete with <think> tags renders reasoning above the answer", async () => {
  const { client, calls } = createFakeClient();
  const controller = new StreamingCardController({ client, flushIntervalMs: 5 });
  await controller.seed({ to: "oc_chat" });
  await controller.complete("<think>balancing tradeoffs</think>Use option B.");

  const last = calls.cardUpdate[calls.cardUpdate.length - 1];
  const body = last.cardJson.body as { elements: Array<{ tag: string; element_id?: string; content: string }> };
  // [collapsible_panel (reasoning), hr, answer markdown, footer?]
  expect(body.elements[0].tag).toBe("collapsible_panel");
  expect(JSON.stringify(body.elements[0])).toContain("balancing tradeoffs");
  expect(body.elements[1].tag).toBe("hr");
  expect(body.elements[2].element_id).toBe("streaming_content");
  expect(body.elements[2].content).toBe("Use option B.");
});

test("complete with plain text has no reasoning element", async () => {
  const { client, calls } = createFakeClient();
  const controller = new StreamingCardController({ client, flushIntervalMs: 5 });
  await controller.seed({ to: "oc_chat" });
  await controller.complete("just the answer");

  const last = calls.cardUpdate[calls.cardUpdate.length - 1];
  const body = last.cardJson.body as { elements: Array<{ tag: string; element_id?: string; content: string }> };
  // No reasoning_content present
  expect(body.elements.find((e) => e.element_id === "reasoning_content")).toBeUndefined();
  const answer = body.elements.find((e) => e.element_id === "streaming_content");
  expect(answer?.content).toBe("just the answer");
});

test("complete() with empty text still renders complete-state card", async () => {
  const { client, calls } = createFakeClient();
  const controller = new StreamingCardController({ client, flushIntervalMs: 5 });
  await controller.seed({ to: "oc_chat" });
  await controller.complete("");

  const final = calls.cardUpdate[calls.cardUpdate.length - 1];
  expect((final.cardJson.config as { streaming_mode: boolean }).streaming_mode).toBe(false);
  expect((final.cardJson.config as { summary: { content: string } }).summary.content).toBe(feishuT().summaryComplete);
});

test("fail() preserves partial streamed buffer", async () => {
  const { client, calls } = createFakeClient();
  const controller = new StreamingCardController({ client, flushIntervalMs: 5 });
  await controller.seed({ to: "oc_chat" });
  controller.appendStream("partial output so far");
  await controller.fail("network exploded");

  const last = calls.cardUpdate[calls.cardUpdate.length - 1];
  const body = last.cardJson.body as { elements: Array<{ content: string }> };
  expect(body.elements[0].content).toContain("partial output so far");
  expect(body.elements[0].content).toContain("network exploded");
});

test("complete() awaits image upload so final card carries the resolved image_key", async () => {
  const { client, calls } = createFakeClient();
  let imgCounter = 0;
  // Attach im.image.create to the fake client so the resolver can upload.
  (client.im as unknown as { image: { create: (input: { data: { image_type: string; image: unknown } }) => Promise<unknown> } }).image = {
    create: async () => {
      imgCounter += 1;
      return { data: { image_key: `img_${imgCounter}` } };
    },
  };

  const controller = new StreamingCardController({
    client,
    flushIntervalMs: 5,
    imageResolveTimeoutMs: 500,
    fetchUrl: async () => Buffer.from([0xff, 0xd8, 0xff]),
  });
  await controller.seed({ to: "oc_chat" });

  controller.appendStream("see this image: ![cat](https://example.com/cat.png)");
  await controller.complete();

  const final = calls.cardUpdate[calls.cardUpdate.length - 1];
  const body = final.cardJson.body as { elements: Array<{ content: string }> };
  expect(body.elements[0].content).toContain("![cat](img_1)");
  expect(body.elements[0].content).not.toContain("example.com");
});

test("resolveImages=false disables URL resolution entirely", async () => {
  const { client, calls } = createFakeClient();
  (client.im as unknown as { image: { create: (input: { data: { image_type: string; image: unknown } }) => Promise<unknown> } }).image = {
    create: async () => {
      throw new Error("should not be called");
    },
  };
  const controller = new StreamingCardController({
    client,
    flushIntervalMs: 5,
    resolveImages: false,
    fetchUrl: async () => {
      throw new Error("fetchUrl should not be called");
    },
  });
  await controller.seed({ to: "oc_chat" });
  controller.appendStream("![cat](https://example.com/cat.png)");
  await controller.complete();
  // The optimizer's stripInvalidImageKeys safety net will still strip the URL ref,
  // but no upload was attempted.
  expect(calls.cardUpdate.length).toBeGreaterThanOrEqual(1);
});

test("sequence numbers are monotonically increasing", async () => {
  const { client, calls } = createFakeClient();
  const controller = new StreamingCardController({ client, flushIntervalMs: 10 });
  await controller.seed({ to: "oc_chat" });

  controller.appendStream("a");
  await new Promise((r) => setTimeout(r, 30));
  controller.appendStream("b");
  await new Promise((r) => setTimeout(r, 30));
  await controller.complete();

  const sequences = calls.cardUpdate.map((c) => c.sequence);
  for (let i = 1; i < sequences.length; i++) {
    expect(sequences[i]).toBeGreaterThan(sequences[i - 1]);
  }
});

test("cardBodyMaxChars tuning override truncates oversized output", async () => {
  const { client, calls } = createFakeClient();
  const controller = new StreamingCardController({
    client,
    flushIntervalMs: 5,
    cardBodyMaxChars: 100,
  });
  await controller.seed({ to: "oc_chat" });
  const longText = "x".repeat(500);
  await controller.complete(longText);

  const last = calls.cardUpdate[calls.cardUpdate.length - 1];
  const elements = (last.cardJson as { body?: { elements?: Array<Record<string, unknown>> } }).body?.elements ?? [];
  const streaming = elements.find((el) => (el as { element_id?: string }).element_id === "streaming_content");
  const content = (streaming as { content?: string } | undefined)?.content ?? "";
  // Body was capped to ~100 chars (minus truncation marker).
  expect(content.length).toBeLessThan(150);
  expect(content).toContain("(truncated)");
});

test("failureThreshold override fires onCardDegraded after the configured count", async () => {
  const degradeCalls: number[] = [];
  const { client } = createFakeClient({ failUpdate: new Error("net") });
  const controller = new StreamingCardController({
    client,
    flushIntervalMs: 5,
    failureThreshold: 2,
    onCardDegraded: ({ consecutiveFailures }) => degradeCalls.push(consecutiveFailures),
  });
  await controller.seed({ to: "oc_chat" });
  controller.appendStream("a");
  await new Promise((r) => setTimeout(r, 15));
  controller.appendStream("b");
  await new Promise((r) => setTimeout(r, 15));
  await controller.complete("c");
  // Threshold=2 should fire onCardDegraded once consecutive failures hit 2.
  expect(degradeCalls.length).toBe(1);
  expect(degradeCalls[0]).toBeGreaterThanOrEqual(2);
});

test("truncateForCardBody drops marker when maxChars is smaller than the marker", async () => {
  // Re-using the controller path: with maxChars=3, even an empty buffer +
  // marker would be longer. Output must be <= 3.
  const { client, calls } = createFakeClient();
  const controller = new StreamingCardController({
    client,
    flushIntervalMs: 5,
    cardBodyMaxChars: 3,
  });
  await controller.seed({ to: "oc_chat" });
  await controller.complete("abcdefghij");
  const last = calls.cardUpdate[calls.cardUpdate.length - 1];
  const elements = (last.cardJson as { body?: { elements?: Array<Record<string, unknown>> } }).body?.elements ?? [];
  const streaming = elements.find((el) => (el as { element_id?: string }).element_id === "streaming_content");
  const content = (streaming as { content?: string } | undefined)?.content ?? "";
  expect(content.length).toBeLessThanOrEqual(3);
});

test("cardBodyMaxChars also caps the element-content fast-path", async () => {
  const { client, calls } = createFakeClient();
  const controller = new StreamingCardController({
    client,
    flushIntervalMs: 5,
    cardBodyMaxChars: 50,
  });
  await controller.seed({ to: "oc_chat" });
  // First chunk goes through the full card.update path (thinking → streaming).
  controller.appendStream("a".repeat(20));
  await new Promise((r) => setTimeout(r, 15));
  // Second chunk should go through element-content fast-path; with a total
  // buffer now well over 50 chars, the fast-path payload must be capped too.
  controller.appendStream("b".repeat(200));
  await new Promise((r) => setTimeout(r, 15));
  await controller.complete();
  const fastPathContents = calls.elementContent.map((e) => e.content);
  for (const c of fastPathContents) {
    // Strict cap: truncateForCardBody guarantees `result.length <= maxChars`.
    expect(c.length).toBeLessThanOrEqual(50);
  }
});

test("a shutdown signal aborts a still-streaming card", async () => {
  const { client, calls } = createFakeClient();
  const controller = new StreamingCardController({ client, flushIntervalMs: 30 });
  await controller.seed({ to: "oc_chat" });
  controller.appendStream("mid-flight progress");

  await fireShutdownHooksForTests();

  expect(controller.isTerminated()).toBe(true);
  const last = calls.cardUpdate[calls.cardUpdate.length - 1];
  expect((last.cardJson.config as { summary: { content: string } }).summary.content).toBe(feishuT().summaryStopped);
  const elements = (last.cardJson.body as { elements: Array<{ content: string; element_id?: string }> }).elements;
  const streaming = elements.find((el) => el.element_id === "streaming_content");
  expect(streaming?.content).toBe("mid-flight progress");
});

test("firing shutdown on a completed controller is a no-op", async () => {
  const { client, calls } = createFakeClient();
  const controller = new StreamingCardController({ client, flushIntervalMs: 30 });
  await controller.seed({ to: "oc_chat" });
  controller.appendStream("done early");
  await controller.complete();

  const updatesBefore = calls.cardUpdate.length;
  await fireShutdownHooksForTests();
  // No additional updates after the hook fires — controller already terminal.
  expect(calls.cardUpdate.length).toBe(updatesBefore);
});

test("streaming pushUpdate carries elapsed footer that ticks with time", async () => {
  const { client, calls } = createFakeClient();
  let t = 0;
  const controller = new StreamingCardController({ client, flushIntervalMs: 10, now: () => t });
  t = 1_000;
  await controller.seed({ to: "oc_chat" });

  t = 3_500; // 2.5s after seed
  controller.appendStream("first");
  await new Promise((r) => setTimeout(r, 30));

  // First push (thinking→streaming) goes through card.update; assert footer.
  const firstFull = calls.cardUpdate[calls.cardUpdate.length - 1];
  const elements = (firstFull.cardJson.body as { elements: Array<{ content?: string }> }).elements;
  const footer = elements[elements.length - 1];
  expect(footer.content).toContain("2.5s");

  // Time jumps; new push should ALSO be a full card.update (footer changed
  // from "2.5s" to "10.0s"), not a fast-path elementContent call.
  t = 11_000;
  const fullBefore = calls.cardUpdate.length;
  controller.appendStream("second");
  await new Promise((r) => setTimeout(r, 30));
  expect(calls.cardUpdate.length).toBeGreaterThan(fullBefore);
});

test("live footer timer refreshes elapsed even when no new text arrives", async () => {
  const { client, calls } = createFakeClient();
  let t = 1_000;
  let timer: (() => void) | null = null;
  const controller = new StreamingCardController({
    client,
    flushIntervalMs: 0,
    now: () => t,
    liveFooterTickMs: 1000,
    setTimer: (cb) => {
      timer = cb;
      return 1;
    },
    clearTimer: () => {
      timer = null;
    },
  });
  await controller.seed({ to: "oc_chat" });
  controller.appendStream("first");
  await controller.waitIdle();
  const fullBeforeTick = calls.cardUpdate.length;

  t = 3_000;
  timer?.();
  await controller.waitIdle();

  expect(calls.cardUpdate.length).toBeGreaterThan(fullBeforeTick);
  const last = calls.cardUpdate[calls.cardUpdate.length - 1];
  const elements = (last.cardJson.body as { elements: Array<{ content?: string }> }).elements;
  expect(elements[elements.length - 1].content).toContain("2.0s");
  await controller.complete();
});

test("recordToolEvent surfaces a tool-use panel on the next push", async () => {
  const { client, calls } = createFakeClient();
  const controller = new StreamingCardController({ client, flushIntervalMs: 10 });
  await controller.seed({ to: "oc_chat" });

  controller.recordToolEvent({
    toolCallId: "t1",
    toolName: "Read File",
    kind: "read",
    summary: "foo.ts",
    status: "running",
  });
  controller.appendStream("agent says hi");

  await new Promise((r) => setTimeout(r, 30));
  await controller.complete();

  const last = calls.cardUpdate[calls.cardUpdate.length - 1];
  const elements = (last.cardJson.body as { elements: Array<{ tag: string; content?: string; element_id?: string }> }).elements;
  const panel = elements.find((el) => el.tag === "collapsible_panel");
  expect(panel).toBeDefined();
  expect(JSON.stringify(panel)).toContain("Read File");
  expect(JSON.stringify(panel)).toContain("foo.ts");
  const body = elements.find((el) => el.element_id === "streaming_content");
  expect(body?.content).toBe("agent says hi");
});

test("recordToolEvent forces full update path (not fast-path)", async () => {
  const { client, calls } = createFakeClient();
  const controller = new StreamingCardController({ client, flushIntervalMs: 10, now: () => 1_000 });
  await controller.seed({ to: "oc_chat" });
  controller.appendStream("first");
  await new Promise((r) => setTimeout(r, 30));
  const fullBefore = calls.cardUpdate.length;
  controller.recordToolEvent({ toolCallId: "t1", toolName: "Bash", kind: "execute", status: "running" });
  controller.appendStream("second");
  await new Promise((r) => setTimeout(r, 30));
  expect(calls.cardUpdate.length).toBeGreaterThan(fullBefore);
});

test("same toolCallId status update forces full panel refresh", async () => {
  const { client, calls } = createFakeClient();
  const controller = new StreamingCardController({
    client,
    flushIntervalMs: 10,
    now: () => 1_000,
    liveFooterTickMs: 0,
  });
  await controller.seed({ to: "oc_chat" });
  controller.recordToolEvent({ toolCallId: "t1", toolName: "Bash", kind: "execute", status: "running" });
  controller.appendStream("first");
  await new Promise((r) => setTimeout(r, 30));
  const fullBefore = calls.cardUpdate.length;
  controller.recordToolEvent({ toolCallId: "t1", toolName: "Bash", kind: "execute", status: "success" });
  controller.appendStream("second");
  await new Promise((r) => setTimeout(r, 30));
  expect(calls.cardUpdate.length).toBeGreaterThan(fullBefore);
  const last = calls.cardUpdate[calls.cardUpdate.length - 1];
  expect(JSON.stringify(last.cardJson)).toContain("✅");
  await controller.complete();
});

test("shutdown while streaming flush is blocked still aborts card", async () => {
  // This test validates the NON-terminal scenario: state is still "streaming"
  // when the shutdown fires, so abortForShutdown() should call abort() and
  // the card should ultimately show "Stopped".
  const { client, calls } = createFakeClient();
  let releaseUpdate: (() => void) | null = null;
  const originalUpdate = client.cardkit.v1.card.update;
  let blockNextUpdate = false;
  client.cardkit.v1.card.update = async (input) => {
    if (blockNextUpdate) {
      blockNextUpdate = false;
      await new Promise<void>((resolve) => {
        releaseUpdate = resolve;
      });
    }
    return originalUpdate(input);
  };
  const controller = new StreamingCardController({ client, flushIntervalMs: 0 });
  await controller.seed({ to: "oc_chat" });
  controller.appendStream("partial");
  // Block the streaming push so state is still "streaming" when shutdown fires.
  blockNextUpdate = true;
  const idlePromise = controller.waitIdle();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await fireShutdownHooksForTests({ perHandlerTimeoutMs: 50 });
  releaseUpdate?.();
  await idlePromise;

  const summaries = calls.cardUpdate.map((u) => (u.cardJson.config as { summary: { content: string } }).summary.content);
  expect(summaries).toContain(feishuT().summaryStopped);
});

test("shutdown during pending complete does not overwrite state to aborted", async () => {
  // Bug R4: abortForShutdown() was overwriting state to "aborted" even when
  // complete() had already transitioned to "complete". The shutdown hook's job
  // is to flush the existing terminal state to Feishu, not to force "已停止".
  const { client, calls } = createFakeClient();
  let releaseUpdate: (() => void) | null = null;
  const originalUpdate = client.cardkit.v1.card.update;
  let blockNextUpdate = false;
  client.cardkit.v1.card.update = async (input) => {
    if (blockNextUpdate) {
      blockNextUpdate = false;
      await new Promise<void>((resolve) => {
        releaseUpdate = resolve;
      });
    }
    return originalUpdate(input);
  };
  const controller = new StreamingCardController({ client, flushIntervalMs: 0 });
  await controller.seed({ to: "oc_chat" });
  controller.appendStream("partial");
  await controller.waitIdle();

  // Block the complete's forceFlush so the shutdown hook fires while state is
  // already "complete" but terminalUpdateDelivered is still false.
  blockNextUpdate = true;
  const completing = controller.complete();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await fireShutdownHooksForTests({ perHandlerTimeoutMs: 50 });
  releaseUpdate?.();
  await completing;
  await controller.waitIdle();

  const summaries = calls.cardUpdate.map((u) => (u.cardJson.config as { summary: { content: string } }).summary.content);
  // The card was actually completed successfully; the user must see "Done", not "Stopped".
  expect(summaries).toContain(feishuT().summaryComplete);
  expect(summaries).not.toContain(feishuT().summaryStopped);
});

test("shutdown during pending fail does not overwrite state to aborted", async () => {
  // Same as the complete case but for fail() → state "error".
  const { client, calls } = createFakeClient();
  let releaseUpdate: (() => void) | null = null;
  const originalUpdate = client.cardkit.v1.card.update;
  let blockNextUpdate = false;
  client.cardkit.v1.card.update = async (input) => {
    if (blockNextUpdate) {
      blockNextUpdate = false;
      await new Promise<void>((resolve) => {
        releaseUpdate = resolve;
      });
    }
    return originalUpdate(input);
  };
  const controller = new StreamingCardController({ client, flushIntervalMs: 0 });
  await controller.seed({ to: "oc_chat" });
  controller.appendStream("partial");
  await controller.waitIdle();

  // Block the fail's forceFlush so the shutdown hook fires while state is
  // already "error" but terminalUpdateDelivered is still false.
  blockNextUpdate = true;
  const failing = controller.fail("something went wrong");
  await new Promise((resolve) => setTimeout(resolve, 0));
  await fireShutdownHooksForTests({ perHandlerTimeoutMs: 50 });
  releaseUpdate?.();
  await failing;
  await controller.waitIdle();

  const summaries = calls.cardUpdate.map((u) => (u.cardJson.config as { summary: { content: string } }).summary.content);
  // The actual result was an error; the user must see "Error", not "Stopped".
  expect(summaries).toContain(feishuT().summaryError);
  expect(summaries).not.toContain(feishuT().summaryStopped);
});

test("shutdown without prior terminal transition aborts a streaming card (regression)", async () => {
  // Regression guard: the non-terminal path in abortForShutdown() must still
  // work — a streaming card that gets shut down before complete/fail/abort
  // must end up in the "aborted" state.
  const { client, calls } = createFakeClient();
  const controller = new StreamingCardController({ client, flushIntervalMs: 0 });
  await controller.seed({ to: "oc_chat" });
  controller.appendStream("in progress");
  await controller.waitIdle();

  await fireShutdownHooksForTests({ perHandlerTimeoutMs: 500 });

  expect(controller.isTerminated()).toBe(true);
  const last = calls.cardUpdate[calls.cardUpdate.length - 1];
  expect((last.cardJson.config as { summary: { content: string } }).summary.content).toBe(feishuT().summaryStopped);
});

test("appendReasoning accumulates thought chunks into the reasoning panel", async () => {
  const { client, calls } = createFakeClient();
  const controller = new StreamingCardController({ client, flushIntervalMs: 10 });
  await controller.seed({ to: "oc_chat" });

  controller.appendReasoning("part one ");
  controller.appendReasoning("part two");
  controller.appendStream("the final answer");

  await new Promise((r) => setTimeout(r, 30));
  await controller.complete();

  const last = calls.cardUpdate[calls.cardUpdate.length - 1];
  const elements = (last.cardJson.body as { elements: Array<{ tag: string; content?: string; element_id?: string }> }).elements;
  const panel = elements.find((el) => el.tag === "collapsible_panel");
  expect(panel).toBeDefined();
  expect(JSON.stringify(panel)).toContain("part one part two");
  const body = elements.find((el) => el.element_id === "streaming_content");
  expect(body?.content).toBe("the final answer");
});

test("appendReasoning content change forces a full update (not fast-path)", async () => {
  const { client, calls } = createFakeClient();
  const controller = new StreamingCardController({ client, flushIntervalMs: 10, now: () => 1_000 });
  await controller.seed({ to: "oc_chat" });
  controller.appendStream("first");
  await new Promise((r) => setTimeout(r, 30));
  const fullBefore = calls.cardUpdate.length;
  controller.appendReasoning("a thought");
  controller.appendStream("second");
  await new Promise((r) => setTimeout(r, 30));
  expect(calls.cardUpdate.length).toBeGreaterThan(fullBefore);
});

test("reasoning falls back to <think> tags when no onThought chunks arrive", async () => {
  const { client, calls } = createFakeClient();
  const controller = new StreamingCardController({ client, flushIntervalMs: 10 });
  await controller.seed({ to: "oc_chat" });

  controller.appendStream("<think>inline reasoning</think>visible answer");
  await new Promise((r) => setTimeout(r, 30));
  await controller.complete();

  const last = calls.cardUpdate[calls.cardUpdate.length - 1];
  const elements = (last.cardJson.body as { elements: Array<{ tag: string; content?: string; element_id?: string }> }).elements;
  const panel = elements.find((el) => el.tag === "collapsible_panel");
  expect(panel).toBeDefined();
  expect(JSON.stringify(panel)).toContain("inline reasoning");
  const body = elements.find((el) => el.element_id === "streaming_content");
  expect(body?.content).toContain("visible answer");
  expect(body?.content).not.toContain("inline reasoning");
});

test("appendReasoning header reports elapsed from first to last thought chunk", async () => {
  let nowValue = 1_000;
  const { client, calls } = createFakeClient();
  const controller = new StreamingCardController({
    client,
    flushIntervalMs: 10,
    now: () => nowValue,
  });
  await controller.seed({ to: "oc_chat" });

  controller.appendReasoning("starting to think");
  nowValue = 1_000 + 8_400;
  controller.appendReasoning(" still thinking");
  controller.appendStream("answer");
  await new Promise((r) => setTimeout(r, 30));
  await controller.complete();

  const last = calls.cardUpdate[calls.cardUpdate.length - 1];
  const elements = (last.cardJson.body as { elements: Array<Record<string, unknown>> }).elements;
  const panel = elements.find((el) => el.tag === "collapsible_panel")!;
  expect(JSON.stringify(panel.header)).toContain(feishuT().reasoningHeaderElapsed("8.4s"));
  expect(JSON.stringify(panel.header)).toContain("8.4s");
});

test("appendReasoning after termination does not push a card update", async () => {
  const { client, calls } = createFakeClient();
  const controller = new StreamingCardController({ client, flushIntervalMs: 10 });
  await controller.seed({ to: "oc_chat" });
  controller.appendStream("answer");
  await new Promise((r) => setTimeout(r, 30));
  await controller.complete();
  const updatesAfterComplete = calls.cardUpdate.length;

  controller.appendReasoning("a late thought");
  await new Promise((r) => setTimeout(r, 30));
  expect(calls.cardUpdate.length).toBe(updatesAfterComplete);
});

test("onThought buffer takes precedence over inline <think> tags", async () => {
  const { client, calls } = createFakeClient();
  const controller = new StreamingCardController({ client, flushIntervalMs: 10 });
  await controller.seed({ to: "oc_chat" });

  controller.appendReasoning("side channel thought");
  controller.appendStream("<think>inline thought</think>visible answer");
  await new Promise((r) => setTimeout(r, 30));
  await controller.complete();

  const last = calls.cardUpdate[calls.cardUpdate.length - 1];
  const elements = (last.cardJson.body as { elements: Array<{ tag: string; content?: string; element_id?: string }> }).elements;
  const panel = elements.find((el) => el.tag === "collapsible_panel");
  expect(panel).toBeDefined();
  expect(JSON.stringify(panel)).toContain("side channel thought");
  expect(JSON.stringify(panel)).not.toContain("inline thought");
  const body = elements.find((el) => el.element_id === "streaming_content");
  expect(body?.content).toContain("visible answer");
  expect(body?.content).not.toContain("inline thought");
});

test("reasoning panel renders while the card is still in the thinking state", async () => {
  const { client, calls } = createFakeClient();
  const controller = new StreamingCardController({ client, flushIntervalMs: 10 });
  await controller.seed({ to: "oc_chat" });

  controller.appendReasoning("thinking before any answer");
  await new Promise((r) => setTimeout(r, 30));

  const last = calls.cardUpdate[calls.cardUpdate.length - 1];
  const elements = (last.cardJson.body as { elements: Array<{ tag: string; content?: string; element_id?: string }> }).elements;
  const panel = elements.find((el) => el.tag === "collapsible_panel");
  expect(panel).toBeDefined();
  expect(JSON.stringify(panel)).toContain("thinking before any answer");
  // No answer streamed yet: buildCard emits streaming_content with empty
  // content when state is "thinking". Assert the real behavior.
  const body = elements.find((el) => el.element_id === "streaming_content");
  expect(body?.content ?? "").toBe("");
});

test("recordUsage surfaces the usage segment in the terminal card footer", async () => {
  const { client, calls } = createFakeClient();
  const controller = new StreamingCardController({ client, flushIntervalMs: 10 });
  await controller.seed({ to: "oc_chat" });

  controller.appendStream("the answer");
  controller.recordUsage({ used: 12_000, size: 200_000, breakdown: { inputTokens: 1234, outputTokens: 800 } });
  await controller.complete();

  const last = calls.cardUpdate[calls.cardUpdate.length - 1];
  const elements = (last.cardJson.body as { elements: Array<{ content?: string }> }).elements;
  const footer = elements[elements.length - 1];
  expect(footer.content).toContain("↑1.2k");
  expect(footer.content).toContain("ctx 12k/200k 6%");
});

test("recordUsage forces a full card.update off the streaming fast-path", async () => {
  const { client, calls } = createFakeClient();
  // Pin the clock so the elapsed footer label can't change between pushes —
  // that isolates usage as the ONLY thing that can force a full card.update
  // (same technique as "subsequent streaming pushes use cardElement.content").
  const controller = new StreamingCardController({ client, flushIntervalMs: 10, now: () => 1_000 });
  await controller.seed({ to: "oc_chat" });
  controller.appendStream("first");
  await new Promise((r) => setTimeout(r, 30));
  const fullBefore = calls.cardUpdate.length;

  controller.recordUsage({ used: 5_000, size: 100_000 });
  controller.appendStream("second");
  await new Promise((r) => setTimeout(r, 30));

  // Usage lives in the footer, not streaming_content — it must take the full
  // card.update path, not the element-content fast-path.
  expect(calls.cardUpdate.length).toBeGreaterThan(fullBefore);
  const last = calls.cardUpdate[calls.cardUpdate.length - 1];
  expect(JSON.stringify(last.cardJson)).toContain("ctx 5k/100k 5%");

  // Control: with usage now stable and the clock pinned, a further pure-text
  // change rides the element-content fast-path — proving the increment above
  // was caused by the usage change, not an unconditional full update.
  const fastBefore = calls.elementContent.length;
  controller.appendStream("third");
  await new Promise((r) => setTimeout(r, 30));
  expect(calls.elementContent.length).toBeGreaterThan(fastBefore);
});

test("recordPlan forces a full update and replaces the whole list", async () => {
  const { client, calls } = createFakeClient();
  const controller = new StreamingCardController({ client, flushIntervalMs: 10, now: () => 1_000 });
  await controller.seed({ to: "oc_chat" });
  controller.appendStream("first");
  await new Promise((r) => setTimeout(r, 30));
  const fullBefore = calls.cardUpdate.length;

  controller.recordPlan([
    { content: "Investigate", status: "completed" },
    { content: "Implement", status: "in_progress" },
  ]);
  controller.appendStream("second");
  await new Promise((r) => setTimeout(r, 30));
  // Plan renders as its own panel (not streaming_content): forces full update.
  expect(calls.cardUpdate.length).toBeGreaterThan(fullBefore);

  // Re-send the WHOLE list (replace, not append) — second item now done.
  controller.recordPlan([
    { content: "Investigate", status: "completed" },
    { content: "Implement", status: "completed" },
  ]);
  await controller.complete();

  const last = calls.cardUpdate[calls.cardUpdate.length - 1];
  const elements = (last.cardJson.body as { elements: Array<Record<string, unknown>> }).elements;
  const panel = elements.find((el) => el.tag === "collapsible_panel" && JSON.stringify(el).includes(feishuT().planPanelHeader(2, 2)));
  expect(panel).toBeDefined();
  expect(panel!.expanded).toBe(true);
  const panelJson = JSON.stringify(panel);
  // Replace semantics: both prior entries present and completed, header reads
  // 2/2 — an append would have produced 4 entries (and a 2/4 header).
  expect(panelJson).toContain("~~Investigate~~");
  expect(panelJson).toContain("~~Implement~~");
  expect(panelJson).toContain(feishuT().planPanelHeader(2, 2));
});
