import { expect, mock, test, beforeAll, afterAll } from "bun:test";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { setLocale } from "../../../src/i18n";

// One assertion (line ~721) checks the localized pagination heads-up text, which
// is produced via t().misc and is English by default. Pin zh so it renders the
// expected Chinese; all other assertions here echo mock-provided text and are
// locale-independent.
beforeAll(() => { setLocale("zh"); });
afterAll(() => { setLocale("en"); });

import {
  getWeixinMessageTurnLane,
  handleWeixinMessageTurn,
  resolveMediaTempDir,
} from "../../../src/weixin/messaging/handle-weixin-message-turn";
import type { Agent, ChatRequestMetadata, ChatResponse } from "../../../src/weixin/agent/interface";
import type { HandleWeixinMessageTurnDeps } from "../../../src/weixin/messaging/handle-weixin-message-turn";
import type { WeixinMessage } from "../../../src/weixin/api/types";
import { MessageItemType } from "../../../src/weixin/api/types";

function makeMessage(text: string, contextToken = "ctx-token-123"): WeixinMessage {
  return {
    from_user_id: "test-user",
    to_user_id: "bot",
    msg_id: "msg-1",
    create_time_ms: Date.now(),
    context_token: contextToken,
    item_list: [
      {
        type: MessageItemType.TEXT,
        text_item: { text },
      },
    ],
  };
}

test("handleWeixinMessageTurn wraps turns with perf tracer and emits reply marks", async () => {
  const sentTexts: string[] = [];
  const marks: Array<{ event: string; context?: Record<string, unknown> }> = [];
  const wrapSeeds: unknown[] = [];

  mock.module("../../../src/weixin/messaging/send.ts", () => ({
    markdownToPlainText: (text: string) => text,
    sendMessageWeixin: async ({ text }: { text: string }) => {
      sentTexts.push(text);
      return { messageId: `msg-${sentTexts.length}` };
    },
  }));

  try {
    const { handleWeixinMessageTurn: handleWithMock } = await import(
      "../../../src/weixin/messaging/handle-weixin-message-turn"
    );

    const agent: Agent = {
      async chat(request): Promise<ChatResponse> {
        expect(request.perfSpan?.traceId).toBe("trace-test");
        await request.reply?.("mid progress");
        return { text: "final answer" };
      },
    };

    await handleWithMock(makeMessage("hello"), {
      accountId: "test-account",
      agent,
      baseUrl: "https://example.com",
      cdnBaseUrl: "https://cdn.example.com",
      token: "test-token",
      log: () => {},
      errLog: () => {},
      perfTracer: {
        async wrapTurn(seed, run) {
          wrapSeeds.push(seed);
          return run({
            traceId: "trace-test",
            mark: (event, context) => marks.push({ event, context }),
            setOutcome: () => {},
          });
        },
        async flush() {},
        async cleanup() {},
      },
    });

    expect(wrapSeeds).toEqual([{ chatKey: "weixin:test-account:test-user", kind: "prompt" }]);
    expect(sentTexts).toEqual(["mid progress", "final answer"]);
    expect(marks.map((m) => m.event)).toEqual([
      "turn.received",
      "reply.mid_first_sent",
      "reply.final_first_sent",
      "reply.final_done",
    ]);
    expect(marks[0]!.context).toMatchObject({ textLen: 5, hasMedia: false, mediaCount: 0 });
    expect(marks.at(-1)!.context).toMatchObject({ chunksSent: 1, chunksPending: 0, dropped: false });
  } finally {
    mock.restore();
  }
});

test("handled slash commands still produce a perf turn with only turn.received", async () => {
  const marks: string[] = [];
  const seeds: unknown[] = [];
  mock.module("../../../src/weixin/messaging/slash-commands.ts", () => ({
    handleSlashCommand: async () => ({ handled: true }),
  }));

  try {
    const { handleWeixinMessageTurn: handleWithMock } = await import(
      "../../../src/weixin/messaging/handle-weixin-message-turn"
    );

    const agent: Agent = {
      async chat(): Promise<ChatResponse> {
        throw new Error("should not call agent");
      },
    };

    await handleWithMock(makeMessage("/help"), {
      accountId: "test-account",
      agent,
      baseUrl: "https://example.com",
      cdnBaseUrl: "https://cdn.example.com",
      token: "test-token",
      log: () => {},
      errLog: () => {},
      perfTracer: {
        async wrapTurn(seed, run) {
          seeds.push(seed);
          return run({ traceId: "t", mark: (event) => marks.push(event), setOutcome: () => {} });
        },
        async flush() {},
        async cleanup() {},
      },
    });

    expect(seeds).toEqual([{ chatKey: "weixin:test-account:test-user", kind: "command" }]);
    expect(marks).toEqual(["turn.received"]);
  } finally {
    mock.restore();
  }
});

test("handleWeixinMessageTurn sets perf outcome to error when agent turn fails", async () => {
  const outcomes: Array<{ outcome: string; context?: Record<string, unknown> }> = [];
  const agent: Agent = {
    async chat(): Promise<ChatResponse> {
      throw new Error("agent exploded");
    },
  };

  await handleWeixinMessageTurn(makeMessage("hello", undefined), {
    accountId: "test-account",
    agent,
    baseUrl: "https://example.com",
    cdnBaseUrl: "https://cdn.example.com",
    token: "test-token",
    log: () => {},
    errLog: () => {},
    perfTracer: {
      async wrapTurn(_seed, run) {
        return run({
          traceId: "trace-error",
          mark: () => {},
          setOutcome: (outcome, context) => outcomes.push({ outcome, context }),
        });
      },
      async flush() {},
      async cleanup() {},
    },
  });

  expect(outcomes).toEqual([{ outcome: "error", context: { reason: "turn_error" } }]);
});

test("handleWeixinMessageTurn sets perf outcome to aborted and skips error notice on AbortError", async () => {
  const outcomes: Array<{ outcome: string; context?: Record<string, unknown> }> = [];
  const sentTexts: string[] = [];
  const logs: string[] = [];

  mock.module("../../../src/weixin/messaging/send.ts", () => ({
    markdownToPlainText: (text: string) => text,
    sendMessageWeixin: async ({ text }: { text: string }) => {
      sentTexts.push(text);
      return { messageId: `msg-${sentTexts.length}` };
    },
  }));

  try {
    const { handleWeixinMessageTurn: handleWithMock } = await import(
      "../../../src/weixin/messaging/handle-weixin-message-turn"
    );

    const agent: Agent = {
      async chat(): Promise<ChatResponse> {
        throw new DOMException("user stopped", "AbortError");
      },
    };

    await handleWithMock(makeMessage("hello"), {
      accountId: "test-account",
      agent,
      baseUrl: "https://example.com",
      cdnBaseUrl: "https://cdn.example.com",
      token: "test-token",
      log: (line) => logs.push(line),
      errLog: () => {},
      perfTracer: {
        async wrapTurn(_seed, run) {
          return run({
            traceId: "trace-abort",
            mark: () => {},
            setOutcome: (outcome, context) => outcomes.push({ outcome, context }),
          });
        },
        async flush() {},
        async cleanup() {},
      },
    });

    expect(outcomes).toEqual([{ outcome: "aborted", context: { reason: "user_cancel" } }]);
    expect(sentTexts).toEqual([]);
    expect(logs.some((line) => line.includes("turn aborted"))).toBe(true);
  } finally {
    mock.restore();
  }
});

test("handleWeixinMessageTurn emits media perf marks for outbound media", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-perf-media-"));
  const imgPath = join(dir, "photo.png");
  await writeFile(imgPath, Buffer.from("89504e47", "hex"));
  const marks: Array<{ event: string; context?: Record<string, unknown> }> = [];

  mock.module("../../../src/weixin/messaging/send.ts", () => ({
    markdownToPlainText: (text: string) => text,
    sendMessageWeixin: async () => ({ messageId: "text-1" }),
  }));
  mock.module("../../../src/weixin/messaging/send-media.ts", () => ({
    sendWeixinMediaFile: async () => ({ messageId: "media-1" }),
  }));

  const { handleWeixinMessageTurn: h } = await import(
    "../../../src/weixin/messaging/handle-weixin-message-turn"
  );
  const agent: Agent = {
    async chat(): Promise<ChatResponse> {
      return { media: { kind: "image", filePath: imgPath } };
    },
  };

  try {
    await h(makeMessage("send media"), {
      accountId: "test-account",
      agent,
      baseUrl: "https://example.com",
      cdnBaseUrl: "https://cdn.example.com",
      token: "test-token",
      mediaTempDir: dir,
      log: () => {},
      errLog: () => {},
      perfTracer: {
        async wrapTurn(_seed, run) {
          return run({
            traceId: "trace-media",
            mark: (event, context) => marks.push({ event, context }),
            setOutcome: () => {},
          });
        },
        async flush() {},
        async cleanup() {},
      },
    });

    expect(marks.find((m) => m.event === "reply.media_sent")?.context).toMatchObject({
      kind: "image",
      index: 1,
      messageId: "media-1",
    });
    expect(marks.find((m) => m.event === "reply.media_done")?.context).toMatchObject({
      mediaCount: 1,
      sent: 1,
      failed: 0,
      rejected: 0,
      dropped: 0,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
    mock.restore();
  }
});

test("handleWeixinMessageTurn emits media_done with rejected outbound media", async () => {
  const marks: Array<{ event: string; context?: Record<string, unknown> }> = [];
  const agent: Agent = {
    async chat(): Promise<ChatResponse> {
      return { media: { kind: "image", filePath: "https://evil.example.com/steal.png" } };
    },
  };

  await handleWeixinMessageTurn(makeMessage("send media"), {
    accountId: "test-account",
    agent,
    baseUrl: "https://example.com",
    cdnBaseUrl: "https://cdn.example.com",
    token: "test-token",
    log: () => {},
    errLog: () => {},
    perfTracer: {
      async wrapTurn(_seed, run) {
        return run({
          traceId: "trace-media",
          mark: (event, context) => marks.push({ event, context }),
          setOutcome: () => {},
        });
      },
      async flush() {},
      async cleanup() {},
    },
  });

  expect(marks.some((m) => m.event === "reply.media_sent")).toBe(false);
  expect(marks.find((m) => m.event === "reply.media_done")?.context).toMatchObject({
    mediaCount: 1,
    sent: 0,
    failed: 0,
    rejected: 1,
    dropped: 0,
  });
});

test("handleWeixinMessageTurn passes reply callback to agent.chat", async () => {
  let capturedReply: ((text: string) => Promise<void>) | undefined;
  let capturedReplyContextToken: string | undefined;
  let capturedAccountId: string | undefined;
  const agent: Agent = {
    async chat(request): Promise<ChatResponse> {
      capturedReply = request.reply;
      capturedReplyContextToken = request.replyContextToken;
      capturedAccountId = request.accountId;
      return {};
    },
  };

  const deps: HandleWeixinMessageTurnDeps = {
    accountId: "test-account",
    agent,
    baseUrl: "https://example.com",
    cdnBaseUrl: "https://cdn.example.com",
    token: "test-token",
    log: () => {},
    errLog: () => {},
  };

  await handleWeixinMessageTurn(makeMessage("hello"), deps);
  expect(typeof capturedReply).toBe("function");
  expect(capturedReplyContextToken).toBe("ctx-token-123");
  expect(capturedAccountId).toBe("test-account");
});

test("handleWeixinMessageTurn sends channel-prefixed conversation id", async () => {
  const requests: unknown[] = [];
  const agent: Agent = {
    async chat(request): Promise<ChatResponse> {
      requests.push(request);
      return {};
    },
  };

  const deps: HandleWeixinMessageTurnDeps = {
    accountId: "default",
    agent,
    baseUrl: "https://example.com",
    cdnBaseUrl: "https://cdn.example.com",
    token: "test-token",
    log: () => {},
    errLog: () => {},
  };

  await handleWeixinMessageTurn(makeMessage("hello"), deps);

  expect(requests[0]).toMatchObject({
    accountId: "default",
    conversationId: "weixin:default:test-user",
  });
});

test("getWeixinMessageTurnLane classifies /cancel as control", () => {
  expect(getWeixinMessageTurnLane(makeMessage("/cancel"))).toBe("control");
});

test("getWeixinMessageTurnLane classifies /stop as control", () => {
  expect(getWeixinMessageTurnLane(makeMessage("/stop"))).toBe("control");
});

test("getWeixinMessageTurnLane keeps normal text on the normal lane", () => {
  expect(getWeixinMessageTurnLane(makeMessage("hello there"))).toBe("normal");
});

test("getWeixinMessageTurnLane keeps /clear on the normal lane", () => {
  expect(getWeixinMessageTurnLane(makeMessage("/clear"))).toBe("normal");
});

test("resolveMediaTempDir uses injected root when provided", () => {
  expect(resolveMediaTempDir("C:/temp/weacpx-test")).toBe("C:/temp/weacpx-test");
});

test("resolveMediaTempDir falls back to the system temp dir", () => {
  expect(resolveMediaTempDir()).toBe(join(tmpdir(), "xacpx", "media"));
});

test("handleWeixinMessageTurn reports agent failures via errLog", async () => {
  const errors: string[] = [];
  const agent: Agent = {
    async chat(): Promise<ChatResponse> {
      throw new Error("agent exploded");
    },
  };

  const deps: HandleWeixinMessageTurnDeps = {
    accountId: "test-account",
    agent,
    baseUrl: "https://example.com",
    cdnBaseUrl: "https://cdn.example.com",
    token: "test-token",
    log: () => {},
    errLog: (msg) => {
      errors.push(msg);
    },
  };

  await handleWeixinMessageTurn(makeMessage("hello", undefined), deps);
  expect(errors.some((msg) => msg.includes("agent exploded"))).toBe(true);
});

test("handleWeixinMessageTurn does NOT call onInbound (fired by monitor before lane queueing)", async () => {
  // onInbound was moved to monitor.ts so a user reply during a long-running
  // prompt resets quota immediately rather than waiting for the queued turn
  // to drain. The dep field remains on this surface for backward compatibility
  // but is intentionally not invoked here.
  const calls: { kind: string; chat: string }[] = [];

  mock.module("../../../src/weixin/messaging/send.ts", () => ({
    markdownToPlainText: (text: string) => text,
    sendMessageWeixin: async () => ({ messageId: "msg-x" }),
  }));
  mock.module("../../../src/weixin/messaging/slash-commands.ts", () => ({
    handleSlashCommand: async () => ({ handled: true }),
  }));

  const { handleWeixinMessageTurn: handleWithMock } = await import(
    "../../../src/weixin/messaging/handle-weixin-message-turn"
  );

  const agent: Agent = {
    async chat(): Promise<ChatResponse> {
      return { text: "ok" };
    },
  };

  const deps: HandleWeixinMessageTurnDeps = {
    accountId: "test-account",
    agent,
    baseUrl: "https://example.com",
    cdnBaseUrl: "https://cdn.example.com",
    token: "test-token",
    log: () => {},
    errLog: () => {},
    onInbound: (chat) => {
      calls.push({ kind: "onInbound", chat });
    },
  };

  await handleWithMock(makeMessage("/help"), deps);
  expect(calls).toEqual([]);
  mock.restore();
});

test("handleWeixinMessageTurn no longer gates mid-segments (mid quota lives at transport sink)", async () => {
  // After P0-1 fix, sendReplySegment no longer consults a reserveMidSegment dep —
  // mid-tier quota is enforced exclusively at the transport quota-gated reply
  // sink. handle-weixin-message-turn is a thin send shim for any reply() the
  // agent calls.
  const sentTexts: string[] = [];
  const order: string[] = [];

  mock.module("../../../src/weixin/messaging/send.ts", () => ({
    markdownToPlainText: (text: string) => text,
    sendMessageWeixin: async ({ text }: { text: string }) => {
      sentTexts.push(text);
      return { messageId: `msg-${sentTexts.length}` };
    },
  }));

  const { handleWeixinMessageTurn: handleWithMock } = await import(
    "../../../src/weixin/messaging/handle-weixin-message-turn"
  );

  const agent: Agent = {
    async chat(request): Promise<ChatResponse> {
      await request.reply?.("mid progress");
      return { text: "final" };
    },
  };

  const deps: HandleWeixinMessageTurnDeps = {
    accountId: "test-account",
    agent,
    baseUrl: "https://example.com",
    cdnBaseUrl: "https://cdn.example.com",
    token: "test-token",
    log: () => {},
    errLog: () => {},
    onInbound: (chat) => order.push(`inbound:${chat}`),
    reserveFinal: (chat) => {
      order.push(`final:${chat}`);
      return true;
    },
  };

  await handleWithMock(makeMessage("hello"), deps);

  // Both mid and final make it through — no double-counting on this layer.
  // mid goes via reply(); final comes back as turn.text and is gated by
  // reserveFinal in handle-weixin-message-turn (final quota slot is intended
  // for exactly this case so it always reaches the user).
  expect(sentTexts).toEqual(["mid progress", "final"]);
  // onInbound is fired by monitor.ts now, not handle-weixin-message-turn.
  expect(order).toEqual(["final:test-user"]);
  // reserveMidSegment is no longer part of the dep surface.
  expect("reserveMidSegment" in deps).toBe(false);
  mock.restore();
});

test("v1.3: short final → single reserveFinal + single send (no pagination prefix)", async () => {
  const sentTexts: string[] = [];
  const reserveCalls: string[] = [];

  mock.module("../../../src/weixin/messaging/send.ts", () => ({
    markdownToPlainText: (text: string) => text,
    sendMessageWeixin: async ({ text }: { text: string }) => {
      sentTexts.push(text);
      return { messageId: `msg-${sentTexts.length}` };
    },
  }));

  const { handleWeixinMessageTurn: h } = await import(
    "../../../src/weixin/messaging/handle-weixin-message-turn"
  );

  const agent: Agent = {
    async chat(): Promise<ChatResponse> {
      return { text: "短答" };
    },
  };

  const deps: HandleWeixinMessageTurnDeps = {
    accountId: "test-account",
    agent,
    baseUrl: "https://example.com",
    cdnBaseUrl: "https://cdn.example.com",
    token: "test-token",
    log: () => {},
    errLog: () => {},
    reserveFinal: (chatKey) => {
      reserveCalls.push(chatKey);
      return true;
    },
  };

  await h(makeMessage("hi"), deps);
  expect(sentTexts).toEqual(["短答"]);
  expect(reserveCalls).toEqual(["test-user"]);
  // No pagination prefix on a single chunk.
  expect(sentTexts[0]!.startsWith("(")).toBe(false);
  mock.restore();
});

test("v1.3: very long final is paginated; each chunk reserves and carries (i/N) prefix", async () => {
  const sentTexts: string[] = [];
  const reserveCalls: string[] = [];

  mock.module("../../../src/weixin/messaging/send.ts", () => ({
    markdownToPlainText: (text: string) => text,
    sendMessageWeixin: async ({ text }: { text: string }) => {
      sentTexts.push(text);
      return { messageId: `msg-${sentTexts.length}` };
    },
  }));

  const { handleWeixinMessageTurn: h } = await import(
    "../../../src/weixin/messaging/handle-weixin-message-turn"
  );

  // Build a final around 4000 bytes split across two paragraphs (~2 chunks).
  const para = "字".repeat(600); // 1800 bytes (3 bytes/char * 600)
  const longFinal = `${para}\n\n${para}`;

  const agent: Agent = {
    async chat(): Promise<ChatResponse> {
      return { text: longFinal };
    },
  };

  const deps: HandleWeixinMessageTurnDeps = {
    accountId: "test-account",
    agent,
    baseUrl: "https://example.com",
    cdnBaseUrl: "https://cdn.example.com",
    token: "test-token",
    log: () => {},
    errLog: () => {},
    reserveFinal: (chatKey) => {
      reserveCalls.push(chatKey);
      return true;
    },
  };

  await h(makeMessage("review please"), deps);
  expect(sentTexts.length).toBe(2);
  expect(sentTexts[0]!.startsWith("(1/2) ")).toBe(true);
  expect(sentTexts[1]!.startsWith("(2/2) ")).toBe(true);
  expect(reserveCalls.length).toBe(2);
  mock.restore();
});

test("v1.3: reserveFinal returning false mid-pagination stops sends and logs weixin.final.dropped", async () => {
  const sentTexts: string[] = [];
  const errLogs: string[] = [];
  let reserved = 0;

  mock.module("../../../src/weixin/messaging/send.ts", () => ({
    markdownToPlainText: (text: string) => text,
    sendMessageWeixin: async ({ text }: { text: string }) => {
      sentTexts.push(text);
      return { messageId: `m-${sentTexts.length}` };
    },
  }));

  const { handleWeixinMessageTurn: h } = await import(
    "../../../src/weixin/messaging/handle-weixin-message-turn"
  );

  // 3 chunks worth of payload.
  const para = "字".repeat(600);
  const longFinal = `${para}\n\n${para}\n\n${para}`;

  const agent: Agent = {
    async chat(): Promise<ChatResponse> {
      return { text: longFinal };
    },
  };

  const deps: HandleWeixinMessageTurnDeps = {
    accountId: "test-account",
    agent,
    baseUrl: "https://example.com",
    cdnBaseUrl: "https://cdn.example.com",
    token: "test-token",
    log: () => {},
    errLog: (m) => errLogs.push(m),
    // Allow first 2 reservations; reject the 3rd.
    reserveFinal: () => {
      reserved += 1;
      return reserved <= 2;
    },
  };

  await h(makeMessage("review please"), deps);
  expect(sentTexts.length).toBe(2);
  expect(errLogs.some((m) => m.includes("weixin.final.dropped"))).toBe(true);
  expect(errLogs.some((m) => m.includes("text_paginated"))).toBe(true);
  mock.restore();
});

test("v1.4: long final (8 segments) sends first 4 with heads-up tail; rest parked in pending", async () => {
  const sentTexts: string[] = [];
  const enqueued: { chatKey: string; chunks: { text: string; seq: number; total: number }[] }[] = [];

  mock.module("../../../src/weixin/messaging/send.ts", () => ({
    markdownToPlainText: (text: string) => text,
    sendMessageWeixin: async ({ text }: { text: string }) => {
      sentTexts.push(text);
      return { messageId: `m-${sentTexts.length}` };
    },
  }));

  const { handleWeixinMessageTurn: h } = await import(
    "../../../src/weixin/messaging/handle-weixin-message-turn"
  );

  // 8 paragraphs ~1800 bytes each → 8 raw chunks.
  const para = "字".repeat(600);
  const massiveFinal = Array.from({ length: 8 }, () => para).join("\n\n");

  const agent: Agent = {
    async chat(): Promise<ChatResponse> {
      return { text: massiveFinal };
    },
  };

  const deps: HandleWeixinMessageTurnDeps = {
    accountId: "test-account",
    agent,
    baseUrl: "https://example.com",
    cdnBaseUrl: "https://cdn.example.com",
    token: "test-token",
    log: () => {},
    errLog: () => {},
    reserveFinal: () => true,
    finalRemaining: () => 4,
    enqueuePendingFinal: (chatKey, chunks) => {
      enqueued.push({
        chatKey,
        chunks: chunks.map((c) => ({ text: c.text, seq: c.seq, total: c.total })),
      });
    },
  };

  await h(makeMessage("review"), deps);

  // Wave 1: 4 messages.
  expect(sentTexts.length).toBe(4);
  expect(sentTexts[0]!.startsWith("(1/8) ")).toBe(true);
  expect(sentTexts[3]!.startsWith("(4/8) ")).toBe(true);
  // 4th carries heads-up (still 4 pending).
  expect(sentTexts[3]!).toContain("📄 结果共 8 段，已发 4 段");
  expect(sentTexts[3]!).toContain("/jx");
  // First 3 do NOT carry heads-up.
  expect(sentTexts[0]!).not.toContain("📄");
  expect(sentTexts[2]!).not.toContain("📄");
  // 4 chunks parked in pending with continuous numbering 5..8.
  expect(enqueued.length).toBe(1);
  const parked = enqueued[0]!.chunks;
  expect(parked.length).toBe(4);
  expect(parked.map((c) => c.seq)).toEqual([5, 6, 7, 8]);
  expect(parked.every((c) => c.total === 8)).toBe(true);
  expect(parked[0]!.text.startsWith("(5/8) ")).toBe(true);
  expect(parked[3]!.text.startsWith("(8/8) ")).toBe(true);
  mock.restore();
});

test("v1.4: short final (≤4 segments) sends all without heads-up and without enqueueing", async () => {
  const sentTexts: string[] = [];
  const enqueued: unknown[] = [];

  mock.module("../../../src/weixin/messaging/send.ts", () => ({
    markdownToPlainText: (text: string) => text,
    sendMessageWeixin: async ({ text }: { text: string }) => {
      sentTexts.push(text);
      return { messageId: `m-${sentTexts.length}` };
    },
  }));

  const { handleWeixinMessageTurn: h } = await import(
    "../../../src/weixin/messaging/handle-weixin-message-turn"
  );

  const para = "字".repeat(600);
  const final3 = `${para}\n\n${para}\n\n${para}`;

  const agent: Agent = {
    async chat(): Promise<ChatResponse> {
      return { text: final3 };
    },
  };

  const deps: HandleWeixinMessageTurnDeps = {
    accountId: "test-account",
    agent,
    baseUrl: "https://example.com",
    cdnBaseUrl: "https://cdn.example.com",
    token: "test-token",
    log: () => {},
    errLog: () => {},
    reserveFinal: () => true,
    finalRemaining: () => 4,
    enqueuePendingFinal: (...args) => {
      enqueued.push(args);
    },
  };

  await h(makeMessage("review"), deps);
  expect(sentTexts.length).toBe(3);
  expect(sentTexts[0]!.startsWith("(1/3) ")).toBe(true);
  expect(sentTexts[2]!.startsWith("(3/3) ")).toBe(true);
  expect(sentTexts.some((t) => t.includes("📄"))).toBe(false);
  expect(enqueued.length).toBe(0);
  mock.restore();
});

test("v1.5: zero final quota parks every page and sends exactly one uncharged parked notice", async () => {
  const sentTexts: string[] = [];
  const reserveCalls: string[] = [];
  const enqueued: { chatKey: string; chunks: { text: string; seq: number; total: number }[] }[] = [];

  mock.module("../../../src/weixin/messaging/send.ts", () => ({
    markdownToPlainText: (text: string) => text,
    sendMessageWeixin: async ({ text }: { text: string }) => {
      sentTexts.push(text);
      return { messageId: `m-${sentTexts.length}` };
    },
  }));

  const { handleWeixinMessageTurn: h } = await import(
    "../../../src/weixin/messaging/handle-weixin-message-turn"
  );
  const { t: tt } = await import("../../../src/i18n");

  // 8 paragraphs ~1800 bytes each → 8 raw chunks.
  const para = "字".repeat(600);
  const massiveFinal = Array.from({ length: 8 }, () => para).join("\n\n");

  const agent: Agent = {
    async chat(): Promise<ChatResponse> {
      return { text: massiveFinal };
    },
  };

  const deps: HandleWeixinMessageTurnDeps = {
    accountId: "test-account",
    agent,
    baseUrl: "https://example.com",
    cdnBaseUrl: "https://cdn.example.com",
    token: "test-token",
    log: () => {},
    errLog: () => {},
    reserveFinal: (chatKey) => {
      reserveCalls.push(chatKey);
      return false;
    },
    finalRemaining: () => 0,
    enqueuePendingFinal: (chatKey, chunks) => {
      enqueued.push({
        chatKey,
        chunks: chunks.map((c) => ({ text: c.text, seq: c.seq, total: c.total })),
      });
    },
  };

  await h(makeMessage("review"), deps);

  // All 8 pages parked with continuous numbering 1..8.
  expect(enqueued.length).toBe(1);
  const parked = enqueued[0]!.chunks;
  expect(parked.length).toBe(8);
  expect(parked.map((c) => c.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  expect(parked[0]!.text.startsWith("(1/8) ")).toBe(true);
  // Exactly one notice sent, and it bypasses the final quota counter.
  expect(sentTexts.length).toBe(1);
  expect(sentTexts[0]!).toBe(tt().misc.finalAllParked(8));
  expect(sentTexts[0]!).toContain("/jx");
  expect(reserveCalls.length).toBe(0);
  mock.restore();
});

test("v1.5: single-chunk final with zero quota is parked (not dropped) and the notice is sent", async () => {
  const sentTexts: string[] = [];
  const errLogs: string[] = [];
  const enqueued: { chatKey: string; chunks: { text: string; seq: number; total: number }[] }[] = [];

  mock.module("../../../src/weixin/messaging/send.ts", () => ({
    markdownToPlainText: (text: string) => text,
    sendMessageWeixin: async ({ text }: { text: string }) => {
      sentTexts.push(text);
      return { messageId: `m-${sentTexts.length}` };
    },
  }));

  const { handleWeixinMessageTurn: h } = await import(
    "../../../src/weixin/messaging/handle-weixin-message-turn"
  );
  const { t: tt } = await import("../../../src/i18n");

  const agent: Agent = {
    async chat(): Promise<ChatResponse> {
      return { text: "short final answer" };
    },
  };

  const deps: HandleWeixinMessageTurnDeps = {
    accountId: "test-account",
    agent,
    baseUrl: "https://example.com",
    cdnBaseUrl: "https://cdn.example.com",
    token: "test-token",
    log: () => {},
    errLog: (m) => errLogs.push(m),
    reserveFinal: () => false,
    finalRemaining: () => 0,
    enqueuePendingFinal: (chatKey, chunks) => {
      enqueued.push({
        chatKey,
        chunks: chunks.map((c) => ({ text: c.text, seq: c.seq, total: c.total })),
      });
    },
  };

  await h(makeMessage("hi"), deps);

  expect(enqueued.length).toBe(1);
  expect(enqueued[0]!.chunks).toEqual([{ text: "short final answer", seq: 1, total: 1 }]);
  expect(sentTexts.length).toBe(1);
  expect(sentTexts[0]!).toBe(tt().misc.finalAllParked(1));
  expect(errLogs.some((m) => m.includes("weixin.final.dropped"))).toBe(false);
  mock.restore();
});

test("v1.5: single-chunk final with zero quota and no pending queue keeps the drop behavior", async () => {
  const sentTexts: string[] = [];
  const errLogs: string[] = [];

  mock.module("../../../src/weixin/messaging/send.ts", () => ({
    markdownToPlainText: (text: string) => text,
    sendMessageWeixin: async ({ text }: { text: string }) => {
      sentTexts.push(text);
      return { messageId: `m-${sentTexts.length}` };
    },
  }));

  const { handleWeixinMessageTurn: h } = await import(
    "../../../src/weixin/messaging/handle-weixin-message-turn"
  );

  const agent: Agent = {
    async chat(): Promise<ChatResponse> {
      return { text: "short final answer" };
    },
  };

  const deps: HandleWeixinMessageTurnDeps = {
    accountId: "test-account",
    agent,
    baseUrl: "https://example.com",
    cdnBaseUrl: "https://cdn.example.com",
    token: "test-token",
    log: () => {},
    errLog: (m) => errLogs.push(m),
    reserveFinal: () => false,
  };

  await h(makeMessage("hi"), deps);

  expect(sentTexts.length).toBe(0);
  expect(errLogs.some((m) => m.includes("weixin.final.dropped"))).toBe(true);
  mock.restore();
});

test("handleWeixinMessageTurn forwards a distinct final text through reply when reply was used for progress", async () => {
  // A handler that uses reply() for progress messages and returns a distinct final
  // message (e.g. session creation with ensureSession progress + error renderer)
  // must have that final message delivered. Streaming prompt handlers that want
  // dedup should return text: undefined.
  const sentTexts: string[] = [];

  mock.module("../../../src/weixin/messaging/send.ts", () => ({
    markdownToPlainText: (text: string) => text,
    sendMessageWeixin: async ({ text }: { text: string }) => {
      sentTexts.push(text);
      return { messageId: `msg-${sentTexts.length}` };
    },
  }));

  const { handleWeixinMessageTurn: handleWeixinMessageTurnWithMock } = await import("../../../src/weixin/messaging/handle-weixin-message-turn");

  const agent: Agent = {
    async chat(request): Promise<ChatResponse> {
      await request.reply?.("🚀 working…");
      return { text: "✅ final result" };
    },
  };

  const deps: HandleWeixinMessageTurnDeps = {
    accountId: "test-account",
    agent,
    baseUrl: "https://example.com",
    cdnBaseUrl: "https://cdn.example.com",
    token: "test-token",
    log: () => {},
    errLog: () => {},
  };

  await handleWeixinMessageTurnWithMock(makeMessage("hello"), deps);

  expect(sentTexts).toEqual(["🚀 working…", "✅ final result"]);
  mock.restore();
});

test("Weixin media download failure adds attachment note but still prompts agent", async () => {
  let capturedText: string | undefined;
  let capturedMedia: unknown;

  mock.module("../../../src/weixin/media/media-download.ts", () => ({
    downloadMediaFromItem: async () => ({}),
  }));
  mock.module("../../../src/weixin/messaging/send.ts", () => ({
    markdownToPlainText: (text: string) => text,
    sendMessageWeixin: async () => ({ messageId: "msg-ok" }),
  }));

  const { handleWeixinMessageTurn: h } = await import(
    "../../../src/weixin/messaging/handle-weixin-message-turn"
  );

  const imageOnlyMessage: WeixinMessage = {
    from_user_id: "test-user",
    to_user_id: "bot",
    msg_id: "msg-image",
    create_time_ms: Date.now(),
    context_token: "ctx-token-123",
    item_list: [
      {
        type: MessageItemType.IMAGE,
        image_item: {
          media: {
            full_url: "https://cdn.example.com/image",
          },
        },
      },
    ],
  };
  const agent: Agent = {
    async chat(request): Promise<ChatResponse> {
      capturedText = request.text;
      capturedMedia = request.media;
      return { text: "" };
    },
  };

  await h(imageOnlyMessage, {
    accountId: "test-account",
    agent,
    baseUrl: "https://example.com",
    cdnBaseUrl: "https://cdn.example.com",
    token: "test-token",
    log: () => {},
    errLog: () => {},
  });

  expect(capturedText).toContain("Attachment notes:");
  expect(capturedText).toContain("Skipped image: media was unavailable.");
  expect(capturedMedia).toBeUndefined();
  mock.restore();
});

test("oversized Weixin media adds attachment note but still prompts agent", async () => {
  let capturedText: string | undefined;

  mock.module("../../../src/weixin/media/media-download.ts", () => ({
    downloadMediaFromItem: async () => {
      throw new Error("inbound image: CDN download exceeds 104857600 bytes");
    },
  }));
  mock.module("../../../src/weixin/messaging/send.ts", () => ({
    markdownToPlainText: (text: string) => text,
    sendMessageWeixin: async () => ({ messageId: "msg-ok" }),
  }));

  const { handleWeixinMessageTurn: h } = await import(
    "../../../src/weixin/messaging/handle-weixin-message-turn"
  );

  const imageOnlyMessage: WeixinMessage = {
    from_user_id: "test-user",
    to_user_id: "bot",
    msg_id: "msg-image-large",
    create_time_ms: Date.now(),
    context_token: "ctx-token-123",
    item_list: [
      {
        type: MessageItemType.IMAGE,
        image_item: {
          media: {
            full_url: "https://cdn.example.com/image",
          },
        },
      },
    ],
  };
  const agent: Agent = {
    async chat(request): Promise<ChatResponse> {
      capturedText = request.text;
      return { text: "" };
    },
  };

  await h(imageOnlyMessage, {
    accountId: "test-account",
    agent,
    baseUrl: "https://example.com",
    cdnBaseUrl: "https://cdn.example.com",
    token: "test-token",
    log: () => {},
    errLog: () => {},
  });

  expect(capturedText).toContain("Attachment notes:");
  expect(capturedText).toContain("exceeds 104857600 bytes");
  mock.restore();
});

test("oversize download error from real downloader adds attachment note and still prompts agent", async () => {
  let capturedText: string | undefined;

  mock.module("../../../src/weixin/media/media-download.ts", () => ({
    downloadMediaFromItem: async () => {
      throw new Error("inbound image: CDN download exceeds 104857600 bytes");
    },
  }));
  mock.module("../../../src/weixin/messaging/send.ts", () => ({
    markdownToPlainText: (text: string) => text,
    sendMessageWeixin: async () => ({ messageId: "msg-ok" }),
  }));

  const { handleWeixinMessageTurn: h } = await import(
    "../../../src/weixin/messaging/handle-weixin-message-turn"
  );

  const imageOnlyMessage: WeixinMessage = {
    from_user_id: "test-user",
    to_user_id: "bot",
    msg_id: "msg-image-real-large",
    create_time_ms: Date.now(),
    context_token: "ctx-token-123",
    item_list: [
      {
        type: MessageItemType.IMAGE,
        image_item: {
          media: {
            full_url: "https://cdn.example.com/image",
            aes_key: Buffer.from("0123456789abcdef").toString("base64"),
          },
        },
      },
    ],
  };
  const agent: Agent = {
    async chat(request): Promise<ChatResponse> {
      capturedText = request.text;
      return { text: "" };
    },
  };

  await h(imageOnlyMessage, {
    accountId: "test-account",
    agent,
    baseUrl: "https://example.com",
    cdnBaseUrl: "https://cdn.example.com",
    token: "test-token",
    log: () => {},
    errLog: () => {},
  });

  expect(capturedText).toContain("Attachment notes:");
  expect(capturedText).toContain("exceeds 104857600 bytes");
  mock.restore();
});

test("handleWeixinMessageTurn passes successfully downloaded image media to the agent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-img-ok-"));
  const filePath = join(dir, "image.png");
  await writeFile(filePath, Buffer.from("89504e470d0a1a0a", "hex"));
  let capturedMedia: unknown;

  mock.module("../../../src/weixin/media/media-download.ts", () => ({
    downloadMediaFromItem: async () => ({
      decryptedPicPath: filePath,
    }),
  }));
  mock.module("../../../src/weixin/messaging/send.ts", () => ({
    markdownToPlainText: (text: string) => text,
    sendMessageWeixin: async () => ({ messageId: "msg-ok" }),
  }));
  mock.module("../../../src/channels/media-store.ts", () => ({
    RuntimeMediaStore: class {
      async saveMediaBuffer(input: unknown) {
        return {
          kind: (input as { kind: string }).kind,
          filePath: "/media/stored.png",
          mimeType: (input as { mimeType: string }).mimeType,
          fileName: "image.png",
          sizeBytes: (input as { buffer: Buffer }).buffer.length,
          source: {
            channelId: "weixin",
            accountId: (input as { accountId: string }).accountId,
            chatKey: (input as { chatKey: string }).chatKey,
            messageId: (input as { messageId: string }).messageId,
          },
        };
      }
    },
    DEFAULT_IMAGE_MAX_BYTES: 20 * 1024 * 1024,
    DEFAULT_ATTACHMENT_MAX_BYTES: 100 * 1024 * 1024,
    DEFAULT_MAX_ATTACHMENTS_PER_MESSAGE: 10,
  }));

  const { handleWeixinMessageTurn: h } = await import(
    "../../../src/weixin/messaging/handle-weixin-message-turn"
  );

  const imageOnlyMessage: WeixinMessage = {
    from_user_id: "test-user",
    to_user_id: "bot",
    msg_id: "msg-image-ok",
    create_time_ms: Date.now(),
    context_token: "ctx-token-123",
    item_list: [
      {
        type: MessageItemType.IMAGE,
        image_item: {
          media: {
            full_url: "https://cdn.example.com/image",
          },
        },
      },
    ],
  };
  const agent: Agent = {
    async chat(request): Promise<ChatResponse> {
      capturedMedia = request.media;
      return { text: "" };
    },
  };

  try {
    await h(imageOnlyMessage, {
      accountId: "test-account",
      agent,
      baseUrl: "https://example.com",
      cdnBaseUrl: "https://cdn.example.com",
      token: "test-token",
      log: () => {},
      errLog: () => {},
    });

    const mediaArray = capturedMedia as { kind: string; filePath: string; mimeType: string; source: { messageId: string } }[];
    expect(Array.isArray(mediaArray)).toBe(true);
    expect(mediaArray).toHaveLength(1);
    expect(mediaArray[0].kind).toBe("image");
    expect(mediaArray[0].mimeType).toBe("image/*");
    expect(mediaArray[0].source.messageId).toBe("ctx-token-123");
  } finally {
    await rm(dir, { recursive: true, force: true });
    mock.restore();
  }
});

test("handleWeixinMessageTurn removes downloaded inbound image after saving to media store", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-inbound-cleanup-"));
  const filePath = join(dir, "image.png");
  await writeFile(filePath, Buffer.from("89504e470d0a1a0a", "hex"));

  mock.module("../../../src/weixin/media/media-download.ts", () => ({
    downloadMediaFromItem: async () => ({
      decryptedPicPath: filePath,
    }),
  }));
  mock.module("../../../src/weixin/messaging/send.ts", () => ({
    markdownToPlainText: (text: string) => text,
    sendMessageWeixin: async () => ({ messageId: "msg-ok" }),
  }));
  mock.module("../../../src/channels/media-store.ts", () => ({
    RuntimeMediaStore: class {
      async saveMediaBuffer() {
        return {
          kind: "image",
          filePath: "/media/stored.png",
          mimeType: "image/*",
          fileName: "image.png",
          sizeBytes: 8,
          source: { channelId: "weixin", accountId: "test-account", chatKey: "weixin:test-account:test-user", messageId: "msg-image-cleanup" },
        };
      }
    },
    DEFAULT_IMAGE_MAX_BYTES: 20 * 1024 * 1024,
    DEFAULT_ATTACHMENT_MAX_BYTES: 100 * 1024 * 1024,
    DEFAULT_MAX_ATTACHMENTS_PER_MESSAGE: 10,
  }));

  const { handleWeixinMessageTurn: h } = await import(
    "../../../src/weixin/messaging/handle-weixin-message-turn"
  );

  const imageOnlyMessage: WeixinMessage = {
    from_user_id: "test-user",
    to_user_id: "bot",
    msg_id: "msg-image-cleanup",
    create_time_ms: Date.now(),
    context_token: "ctx-token-123",
    item_list: [
      {
        type: MessageItemType.IMAGE,
        image_item: {
          media: {
            full_url: "https://cdn.example.com/image",
          },
        },
      },
    ],
  };
  const agent: Agent = {
    async chat(): Promise<ChatResponse> {
      return { text: "" };
    },
  };

  try {
    await h(imageOnlyMessage, {
      accountId: "test-account",
      agent,
      baseUrl: "https://example.com",
      cdnBaseUrl: "https://cdn.example.com",
      token: "test-token",
      log: () => {},
      errLog: () => {},
    });

    await expect(access(filePath)).rejects.toThrow();
  } finally {
    await rm(dir, { recursive: true, force: true });
    mock.restore();
  }
});

test("image items without downloadable media add attachment note but still prompt agent", async () => {
  let capturedText: string | undefined;
  let capturedMedia: unknown;

  mock.module("../../../src/weixin/media/media-download.ts", () => ({
    downloadMediaFromItem: async () => ({}),
  }));
  mock.module("../../../src/weixin/messaging/send.ts", () => ({
    markdownToPlainText: (text: string) => text,
    sendMessageWeixin: async () => ({ messageId: "msg-ok" }),
  }));

  const { handleWeixinMessageTurn: h } = await import(
    "../../../src/weixin/messaging/handle-weixin-message-turn"
  );

  const imageWithoutDownloadInfo: WeixinMessage = {
    from_user_id: "test-user",
    to_user_id: "bot",
    msg_id: "msg-image-missing-media",
    create_time_ms: Date.now(),
    context_token: "ctx-token-123",
    item_list: [
      {
        type: MessageItemType.IMAGE,
        image_item: {},
      },
    ],
  };
  const agent: Agent = {
    async chat(request): Promise<ChatResponse> {
      capturedText = request.text;
      capturedMedia = request.media;
      return { text: "" };
    },
  };

  await h(imageWithoutDownloadInfo, {
    accountId: "test-account",
    agent,
    baseUrl: "https://example.com",
    cdnBaseUrl: "https://cdn.example.com",
    token: "test-token",
    log: () => {},
    errLog: () => {},
  });

  expect(capturedText).toContain("Attachment notes:");
  expect(capturedText).toContain("Skipped image: media was unavailable.");
  expect(capturedMedia).toBeUndefined();
  mock.restore();
});

test("voice messages with transcript are downloaded and forwarded to agent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-voice-ok-"));
  const voicePath = join(dir, "voice.wav");
  await writeFile(voicePath, Buffer.from("52494646", "hex"));
  let capturedText: string | undefined;
  let capturedMedia: unknown;
  let downloadCalled = false;

  mock.module("../../../src/weixin/media/media-download.ts", () => ({
    downloadMediaFromItem: async () => {
      downloadCalled = true;
      return { decryptedVoicePath: voicePath, voiceMediaType: "audio/wav" };
    },
  }));
  mock.module("../../../src/weixin/messaging/send.ts", () => ({
    markdownToPlainText: (text: string) => text,
    sendMessageWeixin: async () => ({ messageId: "msg-ok" }),
  }));
  mock.module("../../../src/channels/media-store.ts", () => ({
    RuntimeMediaStore: class {
      async saveMediaBuffer(input: unknown) {
        return {
          kind: (input as { kind: string }).kind,
          filePath: "/media/voice.wav",
          mimeType: (input as { mimeType: string }).mimeType,
          fileName: "attachment.wav",
          sizeBytes: 100,
          source: { channelId: "weixin", accountId: "test-account", chatKey: "weixin:test-account:test-user", messageId: "msg-voice" },
        };
      }
    },
    DEFAULT_IMAGE_MAX_BYTES: 20 * 1024 * 1024,
    DEFAULT_ATTACHMENT_MAX_BYTES: 100 * 1024 * 1024,
    DEFAULT_MAX_ATTACHMENTS_PER_MESSAGE: 10,
  }));

  const { handleWeixinMessageTurn: h } = await import(
    "../../../src/weixin/messaging/handle-weixin-message-turn"
  );

  const voiceWithTranscript: WeixinMessage = {
    from_user_id: "test-user",
    to_user_id: "bot",
    msg_id: "msg-voice",
    create_time_ms: Date.now(),
    context_token: "ctx-token-123",
    item_list: [
      {
        type: MessageItemType.VOICE,
        voice_item: {
          text: "语音转写",
          media: { full_url: "https://cdn.example.com/voice" },
        },
      },
    ],
  };
  const agent: Agent = {
    async chat(request): Promise<ChatResponse> {
      capturedText = request.text;
      capturedMedia = request.media;
      return { text: "" };
    },
  };

  try {
    await h(voiceWithTranscript, {
      accountId: "test-account",
      agent,
      baseUrl: "https://example.com",
      cdnBaseUrl: "https://cdn.example.com",
      token: "test-token",
      log: () => {},
      errLog: () => {},
    });

    expect(downloadCalled).toBe(true);
    expect(capturedText).toBe("语音转写");
    const mediaArray = capturedMedia as { kind: string }[];
    expect(Array.isArray(mediaArray)).toBe(true);
    expect(mediaArray).toHaveLength(1);
    expect(mediaArray[0].kind).toBe("audio");
  } finally {
    await rm(dir, { recursive: true, force: true });
    mock.restore();
  }
});

test("slash commands with file media are handled by slash handler (media not downloaded)", async () => {
  let slashCalled = false;
  let agentCalled = false;

  mock.module("../../../src/weixin/messaging/slash-commands.ts", () => ({
    handleSlashCommand: async () => {
      slashCalled = true;
      return { handled: true };
    },
  }));
  mock.module("../../../src/weixin/media/media-download.ts", () => ({
    downloadMediaFromItem: async () => {
      throw new Error("download should not be called for slash commands");
    },
  }));
  mock.module("../../../src/weixin/messaging/send.ts", () => ({
    markdownToPlainText: (text: string) => text,
    sendMessageWeixin: async () => ({ messageId: "msg-ok" }),
  }));

  const { handleWeixinMessageTurn: h } = await import(
    "../../../src/weixin/messaging/handle-weixin-message-turn"
  );

  const slashWithFile: WeixinMessage = {
    from_user_id: "test-user",
    to_user_id: "bot",
    msg_id: "msg-slash-file",
    create_time_ms: Date.now(),
    context_token: "ctx-token-123",
    item_list: [
      {
        type: MessageItemType.TEXT,
        text_item: { text: "/status" },
      },
      {
        type: MessageItemType.FILE,
        file_item: {
          media: {
            full_url: "https://cdn.example.com/file",
          },
          file_name: "doc.pdf",
        },
      },
    ],
  };
  const agent: Agent = {
    async chat(): Promise<ChatResponse> {
      agentCalled = true;
      return { text: "" };
    },
  };

  await h(slashWithFile, {
    accountId: "test-account",
    agent,
    baseUrl: "https://example.com",
    cdnBaseUrl: "https://cdn.example.com",
    token: "test-token",
    log: () => {},
    errLog: () => {},
  });

  expect(slashCalled).toBe(true);
  expect(agentCalled).toBe(false);
  mock.restore();
});

test("mixed image and file media are both downloaded and forwarded as array", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-mixed-"));
  const imgPath = join(dir, "image.png");
  const filePath = join(dir, "doc.pdf");
  await writeFile(imgPath, Buffer.from("89504e47", "hex"));
  await writeFile(filePath, Buffer.from("25504446", "hex"));
  let capturedMedia: unknown;
  const downloadCalls: unknown[] = [];

  mock.module("../../../src/weixin/media/media-download.ts", () => ({
    downloadMediaFromItem: async (item: unknown) => {
      downloadCalls.push(item);
      const typed = item as { type: number };
      if (typed.type === MessageItemType.IMAGE) return { decryptedPicPath: imgPath };
      if (typed.type === MessageItemType.FILE) return { decryptedFilePath: filePath, fileMediaType: "application/pdf" };
      return {};
    },
  }));
  mock.module("../../../src/weixin/messaging/send.ts", () => ({
    markdownToPlainText: (text: string) => text,
    sendMessageWeixin: async () => ({ messageId: "msg-ok" }),
  }));
  mock.module("../../../src/channels/media-store.ts", () => ({
    RuntimeMediaStore: class {
      async saveMediaBuffer(input: unknown) {
        return {
          kind: (input as { kind: string }).kind,
          filePath: "/media/stored",
          mimeType: (input as { mimeType: string }).mimeType,
          fileName: "attachment",
          sizeBytes: 100,
          source: { channelId: "weixin", accountId: "test-account", chatKey: "weixin:test-account:test-user", messageId: "msg-mixed" },
        };
      }
    },
    DEFAULT_IMAGE_MAX_BYTES: 20 * 1024 * 1024,
    DEFAULT_ATTACHMENT_MAX_BYTES: 100 * 1024 * 1024,
    DEFAULT_MAX_ATTACHMENTS_PER_MESSAGE: 10,
  }));

  const { handleWeixinMessageTurn: h } = await import(
    "../../../src/weixin/messaging/handle-weixin-message-turn"
  );

  const mixedMediaMessage: WeixinMessage = {
    from_user_id: "test-user",
    to_user_id: "bot",
    msg_id: "msg-mixed",
    create_time_ms: Date.now(),
    context_token: "ctx-token-123",
    item_list: [
      {
        type: MessageItemType.IMAGE,
        image_item: {
          media: {
            full_url: "https://cdn.example.com/image",
          },
        },
      },
      {
        type: MessageItemType.FILE,
        file_item: {
          media: {
            full_url: "https://cdn.example.com/file",
          },
          file_name: "doc.pdf",
        },
      },
    ],
  };
  const agent: Agent = {
    async chat(request): Promise<ChatResponse> {
      capturedMedia = request.media;
      return { text: "" };
    },
  };

  try {
    await h(mixedMediaMessage, {
      accountId: "test-account",
      agent,
      baseUrl: "https://example.com",
      cdnBaseUrl: "https://cdn.example.com",
      token: "test-token",
      log: () => {},
      errLog: () => {},
    });

    expect(downloadCalls).toHaveLength(2);
    const mediaArray = capturedMedia as { kind: string }[];
    expect(Array.isArray(mediaArray)).toBe(true);
    expect(mediaArray).toHaveLength(2);
    expect(mediaArray[0].kind).toBe("image");
    expect(mediaArray[1].kind).toBe("file");
  } finally {
    await rm(dir, { recursive: true, force: true });
    mock.restore();
  }
});

test("rejects agent-provided remote media URLs before downloading or sending", async () => {
  const errLogs: string[] = [];
  let downloadCalled = false;
  let sendMediaCalled = false;

  mock.module("../../../src/weixin/cdn/upload.ts", () => ({
    downloadRemoteImageToTemp: async () => {
      downloadCalled = true;
      return "/tmp/downloaded.png";
    },
  }));
  mock.module("../../../src/weixin/messaging/send-media.ts", () => ({
    sendWeixinMediaFile: async () => {
      sendMediaCalled = true;
    },
  }));

  const { handleWeixinMessageTurn: h } = await import(
    "../../../src/weixin/messaging/handle-weixin-message-turn"
  );

  const agent: Agent = {
    async chat(): Promise<ChatResponse> {
      return { media: { kind: "image", filePath: "https://metadata.google.internal/latest/meta-data" } };
    },
  };

  await h(makeMessage("draw"), {
    accountId: "test-account",
    agent,
    baseUrl: "https://example.com",
    cdnBaseUrl: "https://cdn.example.com",
    token: "test-token",
    log: () => {},
    errLog: (msg) => errLogs.push(msg),
  });

  expect(downloadCalled).toBe(false);
  expect(sendMediaCalled).toBe(false);
  expect(errLogs.some((msg) => msg.includes("outbound media rejected"))).toBe(true);
  mock.restore();
});

test("rejects agent-provided local media outside the media temp directory", async () => {
  const errLogs: string[] = [];
  let sendMediaCalled = false;

  mock.module("../../../src/weixin/messaging/send-media.ts", () => ({
    sendWeixinMediaFile: async () => {
      sendMediaCalled = true;
    },
  }));

  const { handleWeixinMessageTurn: h } = await import(
    "../../../src/weixin/messaging/handle-weixin-message-turn"
  );

  const agent: Agent = {
    async chat(): Promise<ChatResponse> {
      return { media: { kind: "file", filePath: "/etc/passwd" } };
    },
  };

  await h(makeMessage("send file"), {
    accountId: "test-account",
    agent,
    baseUrl: "https://example.com",
    cdnBaseUrl: "https://cdn.example.com",
    token: "test-token",
    mediaTempDir: join(tmpdir(), "weacpx-safe-media-test"),
    log: () => {},
    errLog: (msg) => errLogs.push(msg),
  });

  expect(sendMediaCalled).toBe(false);
  expect(errLogs.some((msg) => msg.includes("outbound media rejected"))).toBe(true);
  mock.restore();
});

test("downloads multiple Weixin media items and forwards media array", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-multi-"));
  const imgPath = join(dir, "image.png");
  const filePath = join(dir, "file.pdf");
  await writeFile(imgPath, Buffer.from("89504e47", "hex"));
  await writeFile(filePath, Buffer.from("25504446", "hex"));
  let capturedText: string | undefined;
  let capturedMedia: unknown;
  const downloadCalls: { type: number }[] = [];

  mock.module("../../../src/weixin/media/media-download.ts", () => ({
    downloadMediaFromItem: async (item: { type: number }) => {
      downloadCalls.push(item);
      if (item.type === MessageItemType.IMAGE) return { decryptedPicPath: imgPath };
      if (item.type === MessageItemType.FILE) return { decryptedFilePath: filePath, fileMediaType: "application/pdf" };
      return {};
    },
  }));
  mock.module("../../../src/weixin/messaging/send.ts", () => ({
    markdownToPlainText: (text: string) => text,
    sendMessageWeixin: async () => ({ messageId: "msg-ok" }),
  }));
  mock.module("../../../src/channels/media-store.ts", () => ({
    RuntimeMediaStore: class {
      async saveMediaBuffer(input: unknown) {
        const inp = input as { kind: string; mimeType: string; accountId: string; chatKey: string; messageId: string };
        return {
          kind: inp.kind,
          filePath: `/media/${inp.kind}`,
          mimeType: inp.mimeType,
          fileName: "attachment",
          sizeBytes: 100,
          source: { channelId: "weixin", accountId: inp.accountId, chatKey: inp.chatKey, messageId: inp.messageId },
        };
      }
    },
    DEFAULT_IMAGE_MAX_BYTES: 20 * 1024 * 1024,
    DEFAULT_ATTACHMENT_MAX_BYTES: 100 * 1024 * 1024,
    DEFAULT_MAX_ATTACHMENTS_PER_MESSAGE: 10,
  }));

  const { handleWeixinMessageTurn: h } = await import(
    "../../../src/weixin/messaging/handle-weixin-message-turn"
  );

  const message: WeixinMessage = {
    from_user_id: "test-user",
    to_user_id: "bot",
    msg_id: "msg-multi",
    create_time_ms: Date.now(),
    context_token: "ctx-token-123",
    item_list: [
      {
        type: MessageItemType.TEXT,
        text_item: { text: "check these files" },
      },
      {
        type: MessageItemType.IMAGE,
        image_item: {
          media: { full_url: "https://cdn.example.com/image" },
        },
      },
      {
        type: MessageItemType.FILE,
        file_item: {
          media: { full_url: "https://cdn.example.com/file" },
          file_name: "report.pdf",
        },
      },
    ],
  };
  const agent: Agent = {
    async chat(request): Promise<ChatResponse> {
      capturedText = request.text;
      capturedMedia = request.media;
      return { text: "" };
    },
  };

  try {
    await h(message, {
      accountId: "test-account",
      agent,
      baseUrl: "https://example.com",
      cdnBaseUrl: "https://cdn.example.com",
      token: "test-token",
      log: () => {},
      errLog: () => {},
    });

    expect(downloadCalls).toHaveLength(2);
    expect(capturedText).toBe("check these files");
    const mediaArray = capturedMedia as { kind: string; mimeType: string }[];
    expect(Array.isArray(mediaArray)).toBe(true);
    expect(mediaArray).toHaveLength(2);
    expect(mediaArray[0].kind).toBe("image");
    expect(mediaArray[0].mimeType).toBe("image/*");
    expect(mediaArray[1].kind).toBe("file");
    expect(mediaArray[1].mimeType).toBe("application/pdf");
  } finally {
    await rm(dir, { recursive: true, force: true });
    mock.restore();
  }
});

test("download failure for one of multiple media adds note but still forwards the rest", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-partial-"));
  const imgPath = join(dir, "image.png");
  await writeFile(imgPath, Buffer.from("89504e47", "hex"));
  let capturedText: string | undefined;
  let capturedMedia: unknown;

  mock.module("../../../src/weixin/media/media-download.ts", () => ({
    downloadMediaFromItem: async (item: { type: number }) => {
      if (item.type === MessageItemType.IMAGE) return { decryptedPicPath: imgPath };
      throw new Error("file download failed");
    },
  }));
  mock.module("../../../src/weixin/messaging/send.ts", () => ({
    markdownToPlainText: (text: string) => text,
    sendMessageWeixin: async () => ({ messageId: "msg-ok" }),
  }));
  mock.module("../../../src/channels/media-store.ts", () => ({
    RuntimeMediaStore: class {
      async saveMediaBuffer(input: unknown) {
        const inp = input as { kind: string; mimeType: string; accountId: string; chatKey: string; messageId: string };
        return {
          kind: inp.kind,
          filePath: `/media/${inp.kind}`,
          mimeType: inp.mimeType,
          fileName: "attachment",
          sizeBytes: 100,
          source: { channelId: "weixin", accountId: inp.accountId, chatKey: inp.chatKey, messageId: inp.messageId },
        };
      }
    },
    DEFAULT_IMAGE_MAX_BYTES: 20 * 1024 * 1024,
    DEFAULT_ATTACHMENT_MAX_BYTES: 100 * 1024 * 1024,
    DEFAULT_MAX_ATTACHMENTS_PER_MESSAGE: 10,
  }));

  const { handleWeixinMessageTurn: h } = await import(
    "../../../src/weixin/messaging/handle-weixin-message-turn"
  );

  const message: WeixinMessage = {
    from_user_id: "test-user",
    to_user_id: "bot",
    msg_id: "msg-partial-fail",
    create_time_ms: Date.now(),
    context_token: "ctx-token-123",
    item_list: [
      {
        type: MessageItemType.TEXT,
        text_item: { text: "see attached" },
      },
      {
        type: MessageItemType.IMAGE,
        image_item: {
          media: { full_url: "https://cdn.example.com/image" },
        },
      },
      {
        type: MessageItemType.FILE,
        file_item: {
          media: { full_url: "https://cdn.example.com/file" },
          file_name: "doc.pdf",
        },
      },
    ],
  };
  const agent: Agent = {
    async chat(request): Promise<ChatResponse> {
      capturedText = request.text;
      capturedMedia = request.media;
      return { text: "" };
    },
  };

  try {
    await h(message, {
      accountId: "test-account",
      agent,
      baseUrl: "https://example.com",
      cdnBaseUrl: "https://cdn.example.com",
      token: "test-token",
      log: () => {},
      errLog: () => {},
    });

    expect(capturedText).toContain("see attached");
    expect(capturedText).toContain("Attachment notes:");
    expect(capturedText).toContain("file download failed");
    const mediaArray = capturedMedia as { kind: string }[];
    expect(Array.isArray(mediaArray)).toBe(true);
    expect(mediaArray).toHaveLength(1);
    expect(mediaArray[0].kind).toBe("image");
  } finally {
    await rm(dir, { recursive: true, force: true });
    mock.restore();
  }
});

test("sends multiple outbound media attachments after text", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-multi-outbound-"));
  const imgPath = join(dir, "photo.png");
  const filePath = join(dir, "report.pdf");
  await writeFile(imgPath, Buffer.from("89504e47", "hex"));
  await writeFile(filePath, Buffer.from("25504446", "hex"));

  const sends: { kind: string; text?: string }[] = [];

  mock.module("../../../src/weixin/messaging/send.ts", () => ({
    markdownToPlainText: (text: string) => text,
    sendMessageWeixin: async ({ text }: { text: string }) => {
      sends.push({ kind: "text", text });
      return { messageId: `msg-${sends.length}` };
    },
  }));
  mock.module("../../../src/weixin/messaging/send-media.ts", () => ({
    sendWeixinMediaFile: async (params: { filePath: string; text: string }) => {
      sends.push({ kind: "media", text: params.filePath });
      return { messageId: `media-${sends.length}` };
    },
  }));

  const { handleWeixinMessageTurn: h } = await import(
    "../../../src/weixin/messaging/handle-weixin-message-turn"
  );

  const agent: Agent = {
    async chat(): Promise<ChatResponse> {
      return {
        text: "done",
        media: [
          { kind: "image", filePath: imgPath },
          { kind: "file", filePath: filePath },
        ],
      };
    },
  };

  try {
    await h(makeMessage("generate"), {
      accountId: "test-account",
      agent,
      baseUrl: "https://example.com",
      cdnBaseUrl: "https://cdn.example.com",
      token: "test-token",
      mediaTempDir: dir,
      log: () => {},
      errLog: () => {},
    });

    expect(sends).toHaveLength(3);
    expect(sends[0].kind).toBe("text");
    expect(sends[0].text).toBe("done");
    expect(sends[1].kind).toBe("media");
    expect(sends[2].kind).toBe("media");
  } finally {
    await rm(dir, { recursive: true, force: true });
    mock.restore();
  }
});

test("rejects outbound remote media urls per-item without aborting other sends", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-remote-reject-"));
  const localPath = join(dir, "local.png");
  await writeFile(localPath, Buffer.from("89504e47", "hex"));

  const errLogs: string[] = [];
  const sends: { kind: string }[] = [];

  mock.module("../../../src/weixin/messaging/send.ts", () => ({
    markdownToPlainText: (text: string) => text,
    sendMessageWeixin: async () => {
      sends.push({ kind: "text" });
      return { messageId: `msg-${sends.length}` };
    },
  }));
  mock.module("../../../src/weixin/messaging/send-media.ts", () => ({
    sendWeixinMediaFile: async () => {
      sends.push({ kind: "media" });
      return { messageId: `media-${sends.length}` };
    },
  }));

  const { handleWeixinMessageTurn: h } = await import(
    "../../../src/weixin/messaging/handle-weixin-message-turn"
  );

  const agent: Agent = {
    async chat(): Promise<ChatResponse> {
      return {
        text: "summary",
        media: [
          { kind: "image", filePath: "https://evil.example.com/steal.png" },
          { kind: "image", filePath: localPath },
        ],
      };
    },
  };

  try {
    await h(makeMessage("send both"), {
      accountId: "test-account",
      agent,
      baseUrl: "https://example.com",
      cdnBaseUrl: "https://cdn.example.com",
      token: "test-token",
      mediaTempDir: dir,
      log: () => {},
      errLog: (msg) => errLogs.push(msg),
    });

    // Remote URL rejected, local file sent, text sent.
    expect(errLogs.some((msg) => msg.includes("outbound media rejected"))).toBe(true);
    expect(errLogs.some((msg) => msg.includes("https://evil.example.com/steal.png"))).toBe(true);
    // Text + 1 local media = 2 sends total.
    expect(sends).toHaveLength(2);
    expect(sends[0].kind).toBe("text");
    expect(sends[1].kind).toBe("media");
  } finally {
    await rm(dir, { recursive: true, force: true });
    mock.restore();
  }
});

test("handleWeixinMessageTurn forwards direct-chat route metadata to agent.chat", async () => {
  let captured: ChatRequestMetadata | undefined;
  const agent: Agent = {
    async chat(request): Promise<ChatResponse> {
      captured = request.metadata;
      return { text: "" };
    },
  };

  await handleWeixinMessageTurn(makeMessage("hello"), {
    accountId: "test-account",
    agent,
    baseUrl: "https://example.com",
    cdnBaseUrl: "https://cdn.example.com",
    token: "test-token",
    log: () => {},
    errLog: () => {},
  });

  expect(captured).toMatchObject({
    channel: "weixin",
    chatType: "direct",
    senderId: "test-user",
    origin: "human",
  });
  expect(captured?.groupId).toBeUndefined();
});

test("handleWeixinMessageTurn forwards group-chat route metadata to agent.chat", async () => {
  let captured: ChatRequestMetadata | undefined;
  const agent: Agent = {
    async chat(request): Promise<ChatResponse> {
      captured = request.metadata;
      return { text: "" };
    },
  };

  await handleWeixinMessageTurn({ ...makeMessage("hello"), group_id: "group-42" }, {
    accountId: "test-account",
    agent,
    baseUrl: "https://example.com",
    cdnBaseUrl: "https://cdn.example.com",
    token: "test-token",
    log: () => {},
    errLog: () => {},
  });

  expect(captured).toMatchObject({
    channel: "weixin",
    chatType: "group",
    senderId: "test-user",
    groupId: "group-42",
    origin: "human",
  });
});
