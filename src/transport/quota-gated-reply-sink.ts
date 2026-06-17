// Wraps streaming reply path with WeChat outbound quota + segment aggregation.
//
// Mid-segment messages from the streaming agent (agent_message chunks /
// tool_call updates) are batched through SegmentAggregator and then gated by
// QuotaManager.reserveMidSegment. When the per-chatKey mid-budget is
// exhausted, further segments are counted as overflow and the caller is
// expected to surface that count in the final outbound message via
// `buildOverflowSummary()`.
//
// v1.3: heads-up notice is INLINED into the tail of the last in-budget mid
// message (i.e. the 6th, when MID_BUDGET=6) instead of consuming a dedicated
// slot. The aggregator's flush window also widens as mid slots drain — the
// first segment burst is forwarded quickly (~3s) but the last few stretch out
// over a minute each so the 6 mid slots cover ~2.5 minutes of fast-burst
// activity (and longer if segments arrive slowly enough to flush within their
// active window). Rationale:
//   1. one fewer async send → less risk of out-of-order or dropped messages;
//   2. the heads-up text is guaranteed to appear on a message the user will
//      see (the trailing visible progress entry) without depending on a
//      separate independent message;
//   3. total messages per inbound window stay at 10 (6 mid + 4 final); the
//      4 final slots are reserved for paginated long final answers.

import type { ReplyQuotaContext } from "./types";
import { SegmentAggregator } from "./segment-aggregator";
import { isQuotaDeferredError, QuotaDeferredError } from "../weixin/messaging/quota-errors";
import { t } from "../i18n/index.js";

export interface QuotaGatedReplySinkOptions {
  reply: (text: string) => Promise<void>;
  replyContext?: ReplyQuotaContext;
  // Either a fixed window or a function that returns the next window each
  // time the aggregator needs to schedule a flush. Defaults to an adaptive
  // schedule keyed off the live mid-tier quota (see
  // ADAPTIVE_WINDOW_SCHEDULE_MS) when replyContext is provided, or 5_000ms
  // when it is not.
  windowMs?: number | (() => number);
  now?: () => number;
  onSendError?: (err: unknown, text: string) => void;
  // Override the heads-up message text. Leave undefined to use
  // DEFAULT_HEADS_UP_TEXT.
  headsUpText?: string;
}

// Cumulative window schedule for mid slots: ~3+6+12+24+48+60 ≈ 153s (~2.5 min)
// before all 6 mids are exhausted in a fast-burst stream. For slower streams,
// segments naturally arrive within the active window and use less of the
// schedule. Indexed by midUsed (0 → 3s for the very first segment, 5+ → 60s).
export const ADAPTIVE_WINDOW_SCHEDULE_MS = [3_000, 6_000, 12_000, 24_000, 48_000, 60_000];

// Appended to the tail of the last in-budget mid message when the next mid
// reservation would exceed MID_BUDGET. Replaces the silent black hole between
// the last sent segment and the final answer with an explicit notice that:
//   1. tells the user the task is still running, and
//   2. tells them how to reset the quota window if they want to keep watching
//      live progress without polluting the agent's input context.
// The leading separator line keeps the heads-up visually distinct from the
// progress text it rides on.
//
// /jx is a control-lane no-op slash command: it triggers monitor.onInbound to
// reset the quota window but is dropped before reaching the agent, so the
// task isn't fed a stray prompt.
// The default heads-up text is resolved lazily from the i18n catalog so it
// respects the runtime locale. Callers may override via headsUpText option.
export function getDefaultHeadsUpText(): string {
  return t().misc.quotaHeadsUp;
}

// Keep the const for backward-compat (tests + external callers that read it
// as a static value). It resolves at module evaluation time (en locale).
export const DEFAULT_HEADS_UP_TEXT = "—\n⏳ Push limit reached. Reply /jx to continue watching, or wait for the final result.";

export interface QuotaGatedReplySink {
  feedSegment(segment: string): void;
  // Drains the aggregator's pending content. Returns the trailing text that
  // would be a mid-segment if quota were unlimited; caller may inline this in
  // the final message instead of sending it separately.
  finalize(): { trailing: string; overflowCount: number };
  getOverflowCount(): number;
  // If any reply() call rejected with a QuotaDeferredError (the outbound
  // pushReply path detected mid-stream that quota was exhausted), return the
  // first such error so the transport can reject its prompt() promise instead
  // of silently swallowing it. Generic send errors are NOT captured here —
  // they continue to flow through `onSendError` for backward compatibility.
  getPendingError(): QuotaDeferredError | undefined;
  // Awaits all in-flight reply() promises spawned via send(). Callers should
  // invoke this before reading `getPendingError()` to ensure deferred catches
  // have settled (reply() resolution is async even when the rejection is
  // synchronous in spirit).
  //
  // `timeoutMs` (default 30_000) bounds the wait so a hung reply() — for
  // example a network send that never settles — cannot wedge transport.prompt
  // forever. On timeout, drain() simply returns; any still-pending reply()
  // continues to run in the background and routes errors through onSendError
  // / pendingError as usual once it eventually settles.
  drain(opts?: { timeoutMs?: number }): Promise<void>;
}

export function createQuotaGatedReplySink(
  options: QuotaGatedReplySinkOptions,
): QuotaGatedReplySink {
  const { reply, replyContext, onSendError } = options;
  const now = options.now;
  // Resolve the windowMs source. Priority:
  //   1. caller-supplied value (number or function) — used as-is.
  //   2. when replyContext is present, an adaptive function backed by the
  //      live quota snapshot.
  //   3. otherwise, the legacy 5_000ms fixed default.
  const windowMs: number | (() => number) =
    options.windowMs !== undefined
      ? options.windowMs
      : replyContext
        ? () => {
            const snap = replyContext.quota.snapshot(replyContext.chatKey);
            const idx = Math.min(snap.midUsed, ADAPTIVE_WINDOW_SCHEDULE_MS.length - 1);
            return ADAPTIVE_WINDOW_SCHEDULE_MS[idx]!;
          }
        : 5_000;
  const headsUpText = options.headsUpText ?? getDefaultHeadsUpText();
  let overflowCount = 0;
  let pendingError: QuotaDeferredError | undefined;
  // Idempotency guard: heads-up should appear exactly once per inbound window
  // (when reserveMidSegment lands the final mid slot). Defend against any
  // accidental re-trigger from finalize() trailing path or future refactors.
  let headsUpAppended = false;
  const inFlight = new Set<Promise<void>>();

  const send = (text: string): void => {
    const p = reply(text).catch((err) => {
      if (isQuotaDeferredError(err)) {
        // Capture the first deferred error so transport.prompt can reject and
        // the wake-coordinator orchestration retains injectionPending for a
        // future retry. Do not call onSendError for deferred — this is not a
        // failed delivery, it's a quota-window deferral.
        if (!pendingError) {
          pendingError = err;
        }
        return;
      }
      onSendError?.(err, text);
    });
    inFlight.add(p);
    void p.finally(() => {
      inFlight.delete(p);
    });
  };

  // Wrap `text` with the heads-up tail iff this reservation just consumed the
  // last mid slot (snapshot.midRemaining === 0). Idempotent: only attaches
  // once per inbound window.
  const sendMidAfterReserved = (text: string): void => {
    if (replyContext && !headsUpAppended) {
      const snap = replyContext.quota.snapshot(replyContext.chatKey);
      if (snap.midRemaining === 0) {
        headsUpAppended = true;
        send(`${text}\n\n${headsUpText}`);
        return;
      }
    }
    send(text);
  };

  const tryReplyMid = (text: string): void => {
    if (text.length === 0) return;
    if (replyContext) {
      if (!replyContext.quota.reserveMidSegment(replyContext.chatKey)) {
        overflowCount += 1;
        return;
      }
    }
    sendMidAfterReserved(text);
  };

  const aggregatorOptions: ConstructorParameters<typeof SegmentAggregator>[0] = {
    windowMs,
    flush: tryReplyMid,
    ...(now ? { now } : {}),
  };
  const aggregator = new SegmentAggregator(aggregatorOptions);

  return {
    feedSegment(segment: string): void {
      aggregator.feed(segment);
    },
    finalize(): { trailing: string; overflowCount: number } {
      const trailing = aggregator.finalize();
      // Apply the same quota gate so trailing aggregator content either goes
      // out as a final mid-segment or is counted into overflow. The returned
      // `trailing` is diagnostic/summary context for callers; it does NOT mean
      // the text was sent. Check overflowCount to know whether it was dropped.
      if (trailing.length > 0) {
        if (replyContext) {
          if (!replyContext.quota.reserveMidSegment(replyContext.chatKey)) {
            overflowCount += 1;
            return { trailing, overflowCount };
          }
        }
        sendMidAfterReserved(trailing);
      }
      return { trailing, overflowCount };
    },
    getOverflowCount(): number {
      return overflowCount;
    },
    getPendingError(): QuotaDeferredError | undefined {
      return pendingError;
    },
    async drain(opts?: { timeoutMs?: number }): Promise<void> {
      const timeoutMs = opts?.timeoutMs ?? 30_000;
      const deadline = Date.now() + timeoutMs;
      while (inFlight.size > 0) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<void>((resolve) => {
          timer = setTimeout(resolve, remaining);
        });
        try {
          await Promise.race([
            Promise.allSettled(Array.from(inFlight)).then(() => undefined),
            timeout,
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
    },
  };
}

// Stream-mode (relay/control) reply sink. Unlike createQuotaGatedReplySink,
// this does NOT route segments through SegmentAggregator (which is built for
// WeChat's paragraph-batched, 9-message-budget output and \n-joins fine-grained
// token drains, shredding multi-line markdown). Each segment is forwarded to
// reply() IMMEDIATELY and VERBATIM in feed order — no \n-join, no (×N) folding,
// no quota gating. The returned object is structurally compatible with the
// QuotaGatedReplySink shape the transports rely on.
export function createVerbatimReplySink(
  reply: (text: string) => Promise<void>,
): QuotaGatedReplySink {
  let pendingError: QuotaDeferredError | undefined;
  const inFlight = new Set<Promise<void>>();

  const send = (text: string): void => {
    const p = reply(text).catch((err) => {
      if (isQuotaDeferredError(err)) {
        if (!pendingError) {
          pendingError = err;
        }
        return;
      }
      // Swallow generic send errors so a failed reply doesn't crash the prompt,
      // mirroring createQuotaGatedReplySink (which routes them to onSendError;
      // stream mode has no onSendError, so they are simply dropped).
    });
    inFlight.add(p);
    void p.finally(() => {
      inFlight.delete(p);
    });
  };

  return {
    feedSegment(segment: string): void {
      // Fire reply() synchronously in feed order to preserve ordering.
      if (segment.length === 0) return;
      send(segment);
    },
    finalize(): { trailing: string; overflowCount: number } {
      // Everything was sent immediately; nothing buffered.
      return { trailing: "", overflowCount: 0 };
    },
    getOverflowCount(): number {
      return 0;
    },
    getPendingError(): QuotaDeferredError | undefined {
      return pendingError;
    },
    async drain(opts?: { timeoutMs?: number }): Promise<void> {
      const timeoutMs = opts?.timeoutMs ?? 30_000;
      const deadline = Date.now() + timeoutMs;
      while (inFlight.size > 0) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<void>((resolve) => {
          timer = setTimeout(resolve, remaining);
        });
        try {
          await Promise.race([
            Promise.allSettled(Array.from(inFlight)).then(() => undefined),
            timeout,
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
    },
  };
}

export function buildOverflowSummary(overflowCount: number): string | undefined {
  if (overflowCount <= 0) return undefined;
  return t().misc.quotaOverflowSummary(overflowCount);
}
