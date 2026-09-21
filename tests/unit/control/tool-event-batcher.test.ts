import { describe, expect, it, vi, beforeEach, afterEach } from "bun:test";
import { ToolEventBatcher } from "../../../src/control/tool-event-batcher";
import type { ToolUseEvent } from "../../../src/channels/types";

function toolEvent(over: Partial<ToolUseEvent> = {}): ToolUseEvent {
  return {
    toolCallId: "t1",
    toolName: "Bash",
    kind: "execute",
    status: "running",
    ...over,
  } as ToolUseEvent;
}

/** Payload big enough to clear the batcher's growth threshold. */
const BIG = "x".repeat(600);

describe("ToolEventBatcher", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("publishes the first frame for a tool call immediately", () => {
    const emitted: ToolUseEvent[] = [];
    const batcher = new ToolEventBatcher<ToolUseEvent>(
      { emit: (e) => emitted.push(e) },
      (e) => e.toolCallId,
      (e) => e.status,
      (e) => (e.summary?.length ?? 0),
    );
    batcher.offer(toolEvent());
    expect(emitted).toHaveLength(1);
  });

  it("holds low-signal frames and flushes them in arrival order", () => {
    const emitted: ToolUseEvent[] = [];
    const batcher = new ToolEventBatcher<ToolUseEvent>(
      { emit: (e) => emitted.push(e) },
      (e) => e.toolCallId,
      (e) => e.status,
      (e) => (e.summary?.length ?? 0),
    );
    batcher.offer(toolEvent({ summary: "a" }));
    batcher.offer(toolEvent({ summary: "ab" }));
    batcher.offer(toolEvent({ summary: "abc" }));
    // Only the first was published; the rest wait.
    expect(emitted).toHaveLength(1);

    vi.advanceTimersByTime(200);
    expect(emitted.map((e) => e.summary)).toEqual(["a", "ab", "abc"]);
  });

  it("publishes a status transition immediately, ahead of held frames, without reordering them", () => {
    const emitted: ToolUseEvent[] = [];
    const batcher = new ToolEventBatcher<ToolUseEvent>(
      { emit: (e) => emitted.push(e) },
      (e) => e.toolCallId,
      (e) => e.status,
      (e) => (e.summary?.length ?? 0),
    );
    batcher.offer(toolEvent({ summary: "a" }));
    batcher.offer(toolEvent({ summary: "ab" }));
    batcher.offer(toolEvent({ status: "success", summary: "abc" }));
    // Held frames drain first, then the status change — order preserved.
    expect(emitted.map((e) => e.summary)).toEqual(["a", "ab", "abc"]);
    expect(emitted[2]!.status).toBe("success");
  });

  it("publishes immediately once the payload grows past the threshold", () => {
    const emitted: ToolUseEvent[] = [];
    const batcher = new ToolEventBatcher<ToolUseEvent>(
      { emit: (e) => emitted.push(e) },
      (e) => e.toolCallId,
      (e) => e.status,
      (e) => (e.summary?.length ?? 0),
    );
    batcher.offer(toolEvent({ summary: "short" }));
    batcher.offer(toolEvent({ summary: BIG }));
    expect(emitted).toHaveLength(2);
  });

  it("keeps separate tool calls independent", () => {
    const emitted: ToolUseEvent[] = [];
    const batcher = new ToolEventBatcher<ToolUseEvent>(
      { emit: (e) => emitted.push(e) },
      (e) => e.toolCallId,
      (e) => e.status,
      (e) => (e.summary?.length ?? 0),
    );
    batcher.offer(toolEvent({ toolCallId: "t1", summary: "a" }));
    batcher.offer(toolEvent({ toolCallId: "t2", summary: "b" }));
    batcher.offer(toolEvent({ toolCallId: "t1", summary: "aa" }));
    // Both first sightings publish immediately; the t1 update is held.
    expect(emitted.map((e) => e.toolCallId)).toEqual(["t1", "t2"]);
    vi.advanceTimersByTime(200);
    expect(emitted.map((e) => e.toolCallId)).toEqual(["t1", "t2", "t1"]);
  });

  it("flush() delivers everything held, in order, and is idempotent", () => {
    const emitted: ToolUseEvent[] = [];
    const batcher = new ToolEventBatcher<ToolUseEvent>(
      { emit: (e) => emitted.push(e) },
      (e) => e.toolCallId,
      (e) => e.status,
      (e) => (e.summary?.length ?? 0),
    );
    batcher.offer(toolEvent({ summary: "a" }));
    batcher.offer(toolEvent({ summary: "ab" }));
    batcher.flush();
    batcher.flush();
    expect(emitted.map((e) => e.summary)).toEqual(["a", "ab"]);
  });

  it("dispose() drops held frames and makes later offers synchronous", () => {
    const emitted: ToolUseEvent[] = [];
    const batcher = new ToolEventBatcher<ToolUseEvent>(
      { emit: (e) => emitted.push(e) },
      (e) => e.toolCallId,
      (e) => e.status,
      (e) => (e.summary?.length ?? 0),
    );
    batcher.offer(toolEvent({ summary: "a" }));
    batcher.offer(toolEvent({ summary: "ab" }));
    batcher.dispose();
    vi.advanceTimersByTime(1000);
    // Only the already-published first frame survives; held frames are discarded
    // because dispose means the caller flushed (or abandoned) the turn.
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.summary).toBe("a");
    batcher.offer(toolEvent({ summary: "c" }));
    expect(emitted).toHaveLength(2);
  });

  it("a terminal frame is never lost even when disposed mid-flight", () => {
    const emitted: ToolUseEvent[] = [];
    const batcher = new ToolEventBatcher<ToolUseEvent>(
      { emit: (e) => emitted.push(e) },
      (e) => e.toolCallId,
      (e) => e.status,
      (e) => (e.summary?.length ?? 0),
    );
    batcher.dispose();
    batcher.offer(toolEvent({ status: "error" }));
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.status).toBe("error");
  });
});
