import { describe, expect, test } from "bun:test";
import { mapEvents } from "../../../../../src/bridge/engine/runtime/runtime-adapter";
import type { AcpRuntimeEvent } from "acpx/runtime";
import type { XacpxRuntimeEvent } from "../../../../../src/bridge/engine/runtime/runtime-contract";

async function collectEvents(events: AsyncIterable<AcpRuntimeEvent>): Promise<XacpxRuntimeEvent[]> {
  const result: XacpxRuntimeEvent[] = [];
  for await (const event of mapEvents(events)) {
    result.push(event);
  }
  return result;
}

async function* asyncStream<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) {
    yield item;
  }
}

describe("Runtime Text / Ordered Transcript Parity (spec §25-§33)", () => {
  // Spec T1 — Runtime forwards text metadata
  test("T1: Runtime forwards text metadata (tag, messageId, meta allowlist)", async () => {
    const inputEvents: AcpRuntimeEvent[] = [
      {
        type: "text_delta",
        text: "Hello from worker",
        tag: "agent_message_chunk" as never,
        messageId: "m1",
        meta: {
          origin: "subagent",
          kind: "explore",
          source: "worker",
          // Non-allowlisted / extra fields that must be stripped
          secretKey: "forbidden",
        } as never,
      },
    ];

    const mapped = await collectEvents(asyncStream(inputEvents));
    expect(mapped).toHaveLength(1);
    const event = mapped[0];
    expect(event.type).toBe("text_delta");
    if (event.type === "text_delta") {
      expect(event.text).toBe("Hello from worker");
      expect(event.tag).toBe("agent_message_chunk");
      expect(event.messageId).toBe("m1");
      expect(event.meta).toEqual({
        origin: "subagent",
        kind: "explore",
        source: "worker",
      });
      // Ensure extra keys are not present
      expect((event.meta as Record<string, unknown>).secretKey).toBeUndefined();
    }
  });

  // Spec T2 — Same message stays contiguous
  test("T2: Same message stays contiguous without inserting paragraph breaks", async () => {
    const inputEvents: AcpRuntimeEvent[] = [
      { type: "text_delta", text: "Hello ", messageId: "m1" },
      { type: "text_delta", text: "world.", messageId: "m1" },
    ];

    const mapped = await collectEvents(asyncStream(inputEvents));
    expect(mapped).toHaveLength(2);
    expect(mapped.map((e) => (e.type === "text_delta" ? e.text : "")).join("")).toBe("Hello world.");
    expect(mapped[0]).toMatchObject({ type: "text_delta", text: "Hello " });
    expect(mapped[1]).toMatchObject({ type: "text_delta", text: "world." });
  });

  // Spec T3 — Different messageIds regain paragraph
  test("T3: Different messageIds regain paragraph separation", async () => {
    const inputEvents: AcpRuntimeEvent[] = [
      { type: "text_delta", text: "One.", messageId: "m1" },
      { type: "text_delta", text: "Two.", messageId: "m2" },
    ];

    const mapped = await collectEvents(asyncStream(inputEvents));
    expect(mapped).toHaveLength(2);
    expect(mapped[0]).toMatchObject({ type: "text_delta", text: "One." });
    expect(mapped[1]).toMatchObject({ type: "text_delta", text: "\n\nTwo." });
    expect(mapped.map((e) => (e.type === "text_delta" ? e.text : "")).join("")).toBe("One.\n\nTwo.");
  });

  // Spec T4 — Existing paragraph is not duplicated
  test("T4: Existing paragraph boundary is not duplicated when messageId changes", async () => {
    // Case 1: Trailing \n\n on first message
    const inputEvents1: AcpRuntimeEvent[] = [
      { type: "text_delta", text: "One.\n\n", messageId: "m1" },
      { type: "text_delta", text: "Two.", messageId: "m2" },
    ];
    const mapped1 = await collectEvents(asyncStream(inputEvents1));
    expect(mapped1[0]).toMatchObject({ type: "text_delta", text: "One.\n\n" });
    expect(mapped1[1]).toMatchObject({ type: "text_delta", text: "Two." });
    expect(mapped1.map((e) => (e.type === "text_delta" ? e.text : "")).join("")).toBe("One.\n\nTwo.");

    // Case 2: Boundary split across join
    const inputEvents2: AcpRuntimeEvent[] = [
      { type: "text_delta", text: "One.\n", messageId: "m1" },
      { type: "text_delta", text: "\nTwo.", messageId: "m2" },
    ];
    const mapped2 = await collectEvents(asyncStream(inputEvents2));
    expect(mapped2[0]).toMatchObject({ type: "text_delta", text: "One.\n" });
    expect(mapped2[1]).toMatchObject({ type: "text_delta", text: "\nTwo." });
    expect(mapped2.map((e) => (e.type === "text_delta" ? e.text : "")).join("")).toBe("One.\n\nTwo.");
  });

  // Spec T5 — Tool activity fallback without messageId
  test("T5: Tool activity fallback inserts paragraph when messageId is absent and text ends with sentence terminal", async () => {
    const inputEvents: AcpRuntimeEvent[] = [
      { type: "text_delta", text: "I'll inspect it." },
      {
        type: "tool_call",
        text: "reading",
        toolCallId: "tool-1",
        title: "Read",
        kind: "read" as never,
        rawInput: { path: "src/foo.ts" },
      },
      { type: "text_delta", text: "Found it." },
    ];

    const mapped = await collectEvents(asyncStream(inputEvents));
    expect(mapped).toHaveLength(3);
    expect(mapped[0]).toMatchObject({ type: "text_delta", text: "I'll inspect it." });
    expect(mapped[1]).toMatchObject({ type: "tool_call", toolCallId: "tool-1" });
    expect(mapped[2]).toMatchObject({ type: "text_delta", text: "\n\nFound it." });

    // Non-sentence-terminal fallback: does NOT insert \n\n
    const nonSentenceEvents: AcpRuntimeEvent[] = [
      { type: "text_delta", text: "Result: " },
      {
        type: "tool_call",
        text: "computing",
        toolCallId: "tool-calc",
        title: "Calc",
        kind: "other" as never,
      },
      { type: "text_delta", text: "42" },
    ];
    const nonSentenceMapped = await collectEvents(asyncStream(nonSentenceEvents));
    expect(nonSentenceMapped[2]).toMatchObject({ type: "text_delta", text: "42" });
  });

  // Spec T6 — Tool update does not create another activity boundary
  test("T6: Tool update does not create another activity boundary", async () => {
    const inputEvents: AcpRuntimeEvent[] = [
      { type: "text_delta", text: "I'll inspect it." },
      {
        type: "tool_call",
        text: "reading",
        toolCallId: "tool-1",
        title: "Read",
        kind: "read" as never,
        rawInput: { path: "src/foo.ts" },
      },
      {
        type: "tool_call",
        text: "reading update",
        tag: "tool_call_update" as never,
        toolCallId: "tool-1",
        status: "in_progress",
      },
      {
        type: "tool_call",
        text: "reading completed",
        tag: "tool_call_update" as never,
        toolCallId: "tool-1",
        status: "completed",
        rawOutput: { lines: 100 },
      },
      { type: "text_delta", text: "Found it." },
      { type: "text_delta", text: " It has 100 lines." },
    ];

    const mapped = await collectEvents(asyncStream(inputEvents));
    expect(mapped).toHaveLength(6);
    expect(mapped[0]).toMatchObject({ type: "text_delta", text: "I'll inspect it." });
    // First tool event (initial)
    expect(mapped[1]).toMatchObject({ type: "tool_call", toolCallId: "tool-1", title: "Read" });
    // Updates
    expect(mapped[2]).toMatchObject({ type: "tool_call", toolCallId: "tool-1", status: "in_progress" });
    expect(mapped[3]).toMatchObject({ type: "tool_call", toolCallId: "tool-1", status: "completed" });
    // Text after tool: gains single \n\n
    expect(mapped[4]).toMatchObject({ type: "text_delta", text: "\n\nFound it." });
    // Subsequent text without activity: contiguous, no extra separator
    expect(mapped[5]).toMatchObject({ type: "text_delta", text: " It has 100 lines." });
  });

  // Spec T7 — Thought boundary parity
  test("T7: Thought chunks create activity boundary matching CLI behavior", async () => {
    const inputEvents: AcpRuntimeEvent[] = [
      { type: "text_delta", text: "Thinking through this." },
      { type: "text_delta", text: "let's check the code...", stream: "thought" },
      { type: "text_delta", text: "Here is the answer." },
    ];

    const mapped = await collectEvents(asyncStream(inputEvents));
    expect(mapped).toHaveLength(3);
    expect(mapped[0]).toMatchObject({ type: "text_delta", text: "Thinking through this." });
    expect(mapped[1]).toMatchObject({ type: "text_delta", text: "let's check the code...", stream: "thought" });
    expect(mapped[2]).toMatchObject({ type: "text_delta", text: "\n\nHere is the answer." });
  });

  // Spec T8 — Ordered Relay timeline including tool snapshot merge
  test("T8: Ordered timeline preserves event arrival order and snapshot merge", async () => {
    const inputEvents: AcpRuntimeEvent[] = [
      { type: "text_delta", text: "Step 1: start." },
      {
        type: "tool_call",
        text: "editing",
        toolCallId: "edit-1",
        title: "Edit",
        kind: "edit" as never,
        rawInput: { file: "test.ts", change: "foo -> bar" },
        status: "in_progress",
      },
      {
        type: "tool_call",
        text: "completed",
        tag: "tool_call_update" as never,
        toolCallId: "edit-1",
        status: "completed",
        rawOutput: { success: true },
      },
      { type: "text_delta", text: "Step 2: done." },
    ];

    const mapped = await collectEvents(asyncStream(inputEvents));
    expect(mapped).toHaveLength(4);

    // Sequence check: Text -> Tool in-progress -> Tool completed -> Text
    expect(mapped[0].type).toBe("text_delta");
    expect((mapped[0] as { text: string }).text).toBe("Step 1: start.");

    expect(mapped[1].type).toBe("tool_call");
    expect(mapped[1]).toMatchObject({
      type: "tool_call",
      toolCallId: "edit-1",
      title: "Edit",
      kind: "edit",
      status: "in_progress",
      rawInput: { file: "test.ts", change: "foo -> bar" },
    });

    expect(mapped[2].type).toBe("tool_call");
    expect(mapped[2]).toMatchObject({
      type: "tool_call",
      toolCallId: "edit-1",
      title: "Edit",
      kind: "edit",
      status: "completed",
      rawInput: { file: "test.ts", change: "foo -> bar" },
      rawOutput: { success: true },
    });

    expect(mapped[3].type).toBe("text_delta");
    expect((mapped[3] as { text: string }).text).toBe("\n\nStep 2: done.");
  });

  // Spec T9 — Consecutive logical messages coalesce keeps A\n\nB
  test("T9: Consecutive logical messages coalesce retains paragraph separation", async () => {
    const inputEvents: AcpRuntimeEvent[] = [
      { type: "text_delta", text: "Message A.", messageId: "m1" },
      { type: "text_delta", text: "Message B.", messageId: "m2" },
      { type: "text_delta", text: "Message C.", messageId: "m3" },
    ];

    const mapped = await collectEvents(asyncStream(inputEvents));
    const coalesced = mapped
      .filter((e): e is Extract<XacpxRuntimeEvent, { type: "text_delta" }> => e.type === "text_delta")
      .map((e) => e.text)
      .join("");

    expect(coalesced).toBe("Message A.\n\nMessage B.\n\nMessage C.");
  });

  // Spec T10 — Stream mode remains immediate
  test("T10: First text delta is emitted immediately without waiting for paragraph or turn completion", async () => {
    // Create an async generator that pauses before emitting second event
    let firstEmitted = false;
    let releaseSecond: () => void;
    const secondPromise = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });

    async function* slowStream(): AsyncIterable<AcpRuntimeEvent> {
      yield { type: "text_delta", text: "First chunk" };
      await secondPromise;
      yield { type: "text_delta", text: " Second chunk" };
    }

    const generator = mapEvents(slowStream());
    const firstResult = await generator[Symbol.asyncIterator]().next();

    expect(firstResult.done).toBe(false);
    expect(firstResult.value).toMatchObject({
      type: "text_delta",
      text: "First chunk",
    });
    firstEmitted = true;

    // Release the second chunk now
    releaseSecond!();
    const secondResult = await generator[Symbol.asyncIterator]().next();
    expect(secondResult.done).toBe(false);
    expect(secondResult.value).toMatchObject({
      type: "text_delta",
      text: " Second chunk",
    });

    expect(firstEmitted).toBe(true);
  });
});
