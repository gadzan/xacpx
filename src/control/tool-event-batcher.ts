/**
 * Micro-batching for structured tool events (spec 2026-09-20 P2-1).
 *
 * ACP `tool_call_update` frames arrive at high frequency — a single Kimi tool call
 * was measured at up to 2468 frames — and every frame currently becomes a
 * `tool-event` control event, a hub broadcast, and a web store upsert. Most of
 * those frames change nothing the user can see (they only grow a partial-JSON
 * argument echo, which P0-2 now drops upstream anyway).
 *
 * This coalescer publishes a frame only when it changes what the card shows:
 *  - the first frame that carries a title (the card appears),
 *  - any status transition (a spinner starts/stops, an error appears),
 *  - content growth past `CONTENT_DELTA_BYTES` since the last publish.
 * Everything else is held and flushed in arrival order on a short timer, or
 * immediately when the turn ends.
 *
 * Ordering is preserved strictly (FIFO, never reordered, never dropped), so the
 * hub's `pushToolPart` / the web's `upsertTool` build the same `parts` array in
 * the same order as an unbatched stream — which also keeps `MAX_TOOL_STEPS`
 * truncation picking the same steps.
 */

/** Minimum content growth (bytes) between publishes for the same tool call. */
const CONTENT_DELTA_BYTES = 512;

/** Flush cadence for held frames. Below the threshold of human perception. */
const FLUSH_INTERVAL_MS = 120;

export interface ToolEventBatchSink<T> {
  emit(event: T): void;
}

/** Per-turn tool-event coalescer. One instance per prompt turn. */
export class ToolEventBatcher<T> {
  private readonly pending: T[] = [];
  private readonly publishedContentLength = new Map<string, number>();
  private readonly publishedStatus = new Map<string, string>();
  private timer: NodeJS.Timeout | undefined;
  private disposed = false;

  constructor(
    private readonly sink: ToolEventBatchSink<T>,
    /** Identity of the tool call an event belongs to. */
    private readonly toolCallIdOf: (event: T) => string,
    /** Status of the tool call an event belongs to. */
    private readonly statusOf: (event: T) => string,
    /** Rough size of the event's displayable payload, for the growth check. */
    private readonly contentLengthOf: (event: T) => number,
  ) {}

  /** Offer one event. Returns immediately; publication may be deferred. */
  offer(event: T): void {
    if (this.disposed) {
      this.sink.emit(event);
      return;
    }
    if (this.shouldPublishNow(event)) {
      // A published event must overtake anything already queued without
      // reordering the queue itself: drain in order, then publish this one last.
      this.flush();
      this.publish(event);
      return;
    }
    this.pending.push(event);
    this.schedule();
  }

  /** Flush everything held, in arrival order. Safe to call more than once. */
  flush(): void {
    this.cancel();
    while (this.pending.length > 0) {
      this.publish(this.pending.shift()!);
    }
  }

  /** Stop the timer. A later `offer` publishes synchronously again. */
  dispose(): void {
    this.cancel();
    this.disposed = true;
    this.pending.length = 0;
    this.publishedContentLength.clear();
    this.publishedStatus.clear();
  }

  private shouldPublishNow(event: T): boolean {
    const id = this.toolCallIdOf(event);
    const status = this.statusOf(event);
    const knownStatus = this.publishedStatus.get(id);
    // First sighting, or a status change (spinner start/stop, error) — both are
    // visible immediately. A missing status counts as a change so a frame that
    // only later gains one still publishes.
    if (knownStatus === undefined || knownStatus !== status) return true;
    const previousLength = this.publishedContentLength.get(id) ?? 0;
    return this.contentLengthOf(event) - previousLength >= CONTENT_DELTA_BYTES;
  }

  private publish(event: T): void {
    const id = this.toolCallIdOf(event);
    this.publishedStatus.set(id, this.statusOf(event));
    this.publishedContentLength.set(id, this.contentLengthOf(event));
    this.sink.emit(event);
  }

  private schedule(): void {
    if (this.timer !== undefined || this.disposed) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, FLUSH_INTERVAL_MS);
    // A pending flush must never hold the process open on its own.
    const timer = this.timer as unknown as { unref?: () => void };
    timer.unref?.();
  }

  private cancel(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
