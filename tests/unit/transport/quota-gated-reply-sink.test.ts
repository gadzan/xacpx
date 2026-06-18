import { describe, expect, test, beforeEach } from "bun:test";

import {
  ADAPTIVE_WINDOW_SCHEDULE_MS,
  createQuotaGatedReplySink,
  createVerbatimReplySink,
  getDefaultHeadsUpText,
} from "../../../src/transport/quota-gated-reply-sink";
import { QuotaDeferredError } from "../../../src/weixin/messaging/quota-errors";
import { QuotaManager } from "../../../src/weixin/messaging/quota-manager";
import { setLocale } from "../../../src/i18n";

beforeEach(() => {
  setLocale("zh");
});

function makeClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("QuotaGatedReplySink deferred-error propagation", () => {
  test("captures QuotaDeferredError from reply() in pendingError", async () => {
    const deferred = new QuotaDeferredError({
      chatKey: "wx:user-d",
      reason: "outbound budget exhausted",
    });

    const sink = createQuotaGatedReplySink({
      reply: async () => {
        throw deferred;
      },
      // No replyContext: aggregator forwards segments directly to send().
      windowMs: 0,
    });

    sink.feedSegment("hello");
    sink.finalize();
    await sink.drain();

    expect(sink.getPendingError()).toBe(deferred);
  });

  test("first deferred error wins, later deferred errors do not overwrite", async () => {
    const first = new QuotaDeferredError({ chatKey: "wx:a", reason: "first" });
    const second = new QuotaDeferredError({ chatKey: "wx:a", reason: "second" });
    const errors: QuotaDeferredError[] = [first, second];

    const sink = createQuotaGatedReplySink({
      reply: async () => {
        const next = errors.shift();
        if (next) throw next;
      },
      windowMs: 0,
    });

    sink.feedSegment("one");
    sink.feedSegment("two");
    sink.finalize();
    await sink.drain();

    expect(sink.getPendingError()).toBe(first);
  });

  test("generic Error does not become pendingError; flows to onSendError", async () => {
    const generic = new Error("network blew up");
    const captured: Array<{ err: unknown; text: string }> = [];

    const sink = createQuotaGatedReplySink({
      reply: async () => {
        throw generic;
      },
      onSendError: (err, text) => {
        captured.push({ err, text });
      },
      windowMs: 0,
    });

    sink.feedSegment("payload");
    sink.finalize();
    await sink.drain();

    expect(sink.getPendingError()).toBeUndefined();
    expect(captured).toHaveLength(1);
    expect(captured[0]!.err).toBe(generic);
    expect(captured[0]!.text).toBe("payload");
  });

  test("deferred captured even when later replies succeed", async () => {
    const deferred = new QuotaDeferredError({ chatKey: "wx:b", reason: "x" });
    let calls = 0;

    const sink = createQuotaGatedReplySink({
      reply: async () => {
        calls += 1;
        if (calls === 1) throw deferred;
      },
      windowMs: 0,
    });

    sink.feedSegment("a");
    sink.feedSegment("b");
    sink.finalize();
    await sink.drain();

    expect(sink.getPendingError()).toBe(deferred);
  });

  test("12 segments → 6 sent (6th carries heads-up tail) + 6 overflow + midUsed=6 (no double-counting)", async () => {
    // Regression guard: the sink is the single owner of mid-segment quota
    // reservation. A future change that mistakenly reserved again inside the
    // reply callback (or in a downstream layer that wraps reply) would push
    // midUsed past MID_BUDGET=9. Spy on reserveMidSegment to catch that
    // regression cheaply, in lieu of a full transport-level e2e.
    const flushed: string[] = [];
    const clock = makeClock();
    const quota = new QuotaManager();
    const chatKey = "wx:user-spy";
    quota.onInbound(chatKey);

    let reserveCalls = 0;
    const realReserve = quota.reserveMidSegment.bind(quota);
    quota.reserveMidSegment = (key: string) => {
      reserveCalls += 1;
      return realReserve(key);
    };

    const sink = createQuotaGatedReplySink({
      reply: async (text) => {
        flushed.push(text);
      },
      replyContext: { chatKey, quota },
      now: clock.now,
      windowMs: 5_000,
    });

    for (let i = 0; i < 12; i += 1) {
      sink.feedSegment(`📖 file-${i}`);
      clock.advance(6_000);
      sink.feedSegment(`flush-trigger-${i}`);
    }
    sink.finalize();
    await sink.drain();

    // 12 distinct mid-segment attempts: first 6 reserved, last 6 overflow.
    expect(reserveCalls).toBe(12);
    expect(quota.snapshot(chatKey).midUsed).toBe(6);
    expect(sink.getOverflowCount()).toBe(6);

    // Exactly 6 file-* messages flushed.
    const fileMessages = flushed.filter((m) => m.includes("📖 file-"));
    expect(fileMessages.length).toBe(6);

    // The first 5 must NOT contain the heads-up tail; only the 6th (last) does.
    for (let i = 0; i < 5; i += 1) {
      expect(fileMessages[i]!.includes(getDefaultHeadsUpText())).toBe(false);
    }
    expect(fileMessages[5]!.endsWith(getDefaultHeadsUpText())).toBe(true);
    expect(flushed.filter((m) => m.includes(getDefaultHeadsUpText())).length).toBe(1);
  });

  test("custom headsUpText option is appended to the 6th message", async () => {
    const flushed: string[] = [];
    const clock = makeClock();
    const quota = new QuotaManager();
    const chatKey = "wx:user-custom";
    quota.onInbound(chatKey);

    const customText = "custom heads-up message";
    const sink = createQuotaGatedReplySink({
      reply: async (text) => {
        flushed.push(text);
      },
      replyContext: { chatKey, quota },
      headsUpText: customText,
      now: clock.now,
      windowMs: 5_000,
    });

    for (let i = 0; i < 10; i += 1) {
      sink.feedSegment(`📖 file-${i}`);
      clock.advance(6_000);
      sink.feedSegment(`tail-${i}`);
    }
    sink.finalize();
    await sink.drain();

    const withCustom = flushed.filter((m) => m.includes(customText));
    expect(withCustom.length).toBe(1);
    expect(withCustom[0]!.endsWith(customText)).toBe(true);
    expect(flushed.filter((m) => m.includes(getDefaultHeadsUpText())).length).toBe(0);
  });

  test("finalize trailing on the 6th mid also carries heads-up tail", async () => {
    const flushed: string[] = [];
    const clock = makeClock();
    const quota = new QuotaManager();
    const chatKey = "wx:user-trailing";
    quota.onInbound(chatKey);

    // Pre-consume 5 mid slots so the trailing reservation in finalize() lands
    // at the 6th (midRemaining=0 after success).
    for (let i = 0; i < 5; i += 1) {
      quota.reserveMidSegment(chatKey);
    }

    const sink = createQuotaGatedReplySink({
      reply: async (text) => {
        flushed.push(text);
      },
      replyContext: { chatKey, quota },
      now: clock.now,
      windowMs: 5_000,
    });

    // Single feed; finalize() drains as trailing, takes the 9th and final mid
    // slot, and must append the heads-up tail.
    sink.feedSegment("only-trailing-content");
    sink.finalize();
    await sink.drain();

    expect(flushed).toHaveLength(1);
    expect(flushed[0]!.startsWith("only-trailing-content")).toBe(true);
    expect(flushed[0]!.endsWith(getDefaultHeadsUpText())).toBe(true);
    expect(quota.snapshot(chatKey).midUsed).toBe(6);
    expect(sink.getOverflowCount()).toBe(0);
  });

  test("after mid budget already drained, further mids only count overflow (no extra heads-up)", async () => {
    const flushed: string[] = [];
    const clock = makeClock();
    const quota = new QuotaManager();
    const chatKey = "wx:user-saturated";
    quota.onInbound(chatKey);

    // Drain all 6 mid slots without going through the sink (so heads-up was
    // never appended via the sink's path).
    for (let i = 0; i < 6; i += 1) {
      quota.reserveMidSegment(chatKey);
    }

    const sink = createQuotaGatedReplySink({
      reply: async (text) => {
        flushed.push(text);
      },
      replyContext: { chatKey, quota },
      now: clock.now,
      windowMs: 5_000,
    });

    for (let i = 0; i < 3; i += 1) {
      sink.feedSegment(`📖 over-${i}`);
      clock.advance(6_000);
      sink.feedSegment(`tail-${i}`);
    }
    sink.finalize();
    await sink.drain();

    // No mids fit, no sends at all, only overflow accounting.
    expect(flushed).toHaveLength(0);
    expect(sink.getOverflowCount()).toBe(3);
  });

  test("drain resolves when no replies have been sent", async () => {
    const sink = createQuotaGatedReplySink({
      reply: async () => {},
      windowMs: 0,
    });
    await sink.drain();
    expect(sink.getPendingError()).toBeUndefined();
  });

  test("drain returns within timeoutMs when a reply() never settles", async () => {
    // A hung reply() must not wedge transport.prompt forever; drain falls
    // through after timeoutMs so the caller can finish the turn.
    const sink = createQuotaGatedReplySink({
      reply: () => new Promise<void>(() => {}), // never resolves
      windowMs: 0,
    });

    sink.feedSegment("payload");
    sink.finalize();

    const start = Date.now();
    await sink.drain({ timeoutMs: 50 });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(2_000);
  });

  test("default windowMs follows ADAPTIVE_WINDOW_SCHEDULE_MS keyed off live midUsed", async () => {
    // Simulate the adaptive window: each successive mid reservation should
    // produce a longer aggregator window. We probe this indirectly by feeding
    // segments under the fake clock and checking when the time-window flush
    // path triggers (feed sees `now - lastFlushAt >= window`).
    const flushed: string[] = [];
    const clock = makeClock();
    const quota = new QuotaManager();
    const chatKey = "wx:user-adaptive";
    quota.onInbound(chatKey);

    const sink = createQuotaGatedReplySink({
      reply: async (text) => {
        flushed.push(text);
      },
      replyContext: { chatKey, quota },
      now: clock.now,
      // No windowMs override — exercise the adaptive default.
    });

    // Step through each mid slot. Before each feed, midUsed=i, so the active
    // window is ADAPTIVE_WINDOW_SCHEDULE_MS[i]. Advance just past that window
    // before the second feed to trigger a flush.
    for (let i = 0; i < ADAPTIVE_WINDOW_SCHEDULE_MS.length; i += 1) {
      const expectedWindow = ADAPTIVE_WINDOW_SCHEDULE_MS[i]!;
      sink.feedSegment(`📖 step-${i}-a`);
      // Advance just shy of the window — should NOT flush.
      const before = flushed.length;
      clock.advance(expectedWindow - 1);
      sink.feedSegment(`📖 step-${i}-b`);
      expect(flushed.length).toBe(before);
      // Cross the boundary on the next feed — should flush now.
      clock.advance(2);
      sink.feedSegment(`📖 step-${i}-c`);
      expect(flushed.length).toBe(before + 1);
    }
    // After 6 reservations the mid pool is exhausted; further attempts overflow.
    expect(quota.snapshot(chatKey).midUsed).toBe(6);
  });

  test("drain resolves immediately once all replies settle, well before timeoutMs", async () => {
    let resolveReply!: () => void;
    const sink = createQuotaGatedReplySink({
      reply: () =>
        new Promise<void>((r) => {
          resolveReply = r;
        }),
      windowMs: 0,
    });

    sink.feedSegment("payload");
    sink.finalize();

    const drainPromise = sink.drain({ timeoutMs: 10_000 });
    // Settle the in-flight reply soon after; drain should observe the
    // allSettled win the race against the 10s timeout.
    setTimeout(() => resolveReply(), 20);
    const start = Date.now();
    await drainPromise;
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1_000);
  });
});

describe("createVerbatimReplySink", () => {
  test("forwards fine-grained segments verbatim and in order (no \\n-join, no folding)", async () => {
    const received: string[] = [];
    const sink = createVerbatimReplySink(async (text) => {
      received.push(text);
    });

    const fed = ["| # | 功能 |", "\n", " 说明 |", "x", "x"];
    for (const seg of fed) sink.feedSegment(seg);

    const finalized = sink.finalize();
    await sink.drain();

    // Every segment reached reply() verbatim and in order.
    expect(received).toEqual(fed);
    // No \n inserted between segments; concatenation is exact.
    expect(received.join("")).toBe(fed.join(""));
    // Two identical "x" arrive as two separate calls — no "x (×2)" folding.
    expect(received.filter((r) => r === "x")).toHaveLength(2);
    // finalize() reports nothing buffered.
    expect(finalized).toEqual({ trailing: "", overflowCount: 0 });
    expect(sink.getOverflowCount()).toBe(0);
    expect(sink.getPendingError()).toBeUndefined();
  });

  test("skips empty segments", async () => {
    const received: string[] = [];
    const sink = createVerbatimReplySink(async (text) => {
      received.push(text);
    });
    sink.feedSegment("");
    sink.feedSegment("hi");
    sink.feedSegment("");
    sink.finalize();
    await sink.drain();
    expect(received).toEqual(["hi"]);
  });

  test("captures QuotaDeferredError from reply() in pendingError", async () => {
    const deferred = new QuotaDeferredError({ chatKey: "wx:v", reason: "exhausted" });
    const sink = createVerbatimReplySink(async () => {
      throw deferred;
    });
    sink.feedSegment("hello");
    sink.finalize();
    await sink.drain();
    expect(sink.getPendingError()).toBe(deferred);
  });

  test("swallows generic reply() errors without crashing the prompt", async () => {
    const sink = createVerbatimReplySink(async () => {
      throw new Error("network blew up");
    });
    sink.feedSegment("payload");
    sink.finalize();
    await sink.drain();
    expect(sink.getPendingError()).toBeUndefined();
  });

  test("drain() resolves once in-flight replies settle", async () => {
    let resolveReply: (() => void) | undefined;
    const sink = createVerbatimReplySink(
      () =>
        new Promise<void>((resolve) => {
          resolveReply = resolve;
        }),
    );
    sink.feedSegment("slow");
    sink.finalize();
    const drainPromise = sink.drain({ timeoutMs: 1_000 });
    resolveReply?.();
    await drainPromise;
    expect(sink.getPendingError()).toBeUndefined();
  });
});
