import { afterAll, beforeAll, expect, test } from "bun:test";
import { setChannelLocale, t } from "../../../../packages/channel-feishu/src/i18n/index";

import {
  CARD_BODY_MAX_CHARS,
  REASONING_ELEMENT_ID,
  STREAMING_ELEMENT_ID,
  buildCard,
  buildCardMessageContent,
  formatElapsedMs,
  formatUsageSegment,
  truncateForCardBody,
} from "../../../../packages/channel-feishu/src/card/card-builder";

beforeAll(() => {
  setChannelLocale("zh");
});

afterAll(() => {
  setChannelLocale("en");
});

test("buildCard 'thinking' returns streaming-mode card with empty body and processing footer", () => {
  const card = buildCard({ state: "thinking", text: "" }) as {
    schema: string;
    config: { streaming_mode: boolean; summary: { content: string } };
    body: { elements: Array<{ tag: string; element_id?: string; content: string }> };
  };
  expect(card.schema).toBe("2.0");
  expect(card.config.streaming_mode).toBe(true);
  expect(card.config.summary.content).toBe(t().summaryProcessing);
  expect(card.body.elements[0]).toMatchObject({
    tag: "markdown",
    element_id: STREAMING_ELEMENT_ID,
    content: "",
  });
  expect(card.body.elements[1].content).toContain(t().summaryProcessing);
});

test("buildCard 'streaming' renders text body without footer", () => {
  const card = buildCard({ state: "streaming", text: "hello world" }) as {
    body: { elements: Array<{ content: string; element_id?: string }> };
    config: { streaming_mode: boolean };
  };
  expect(card.config.streaming_mode).toBe(true);
  expect(card.body.elements).toHaveLength(1);
  expect(card.body.elements[0].content).toBe("hello world");
});

test("buildCard 'complete' disables streaming_mode and shows final summary", () => {
  const card = buildCard({ state: "complete", text: "final answer" }) as {
    body: { elements: Array<{ content: string }> };
    config: { streaming_mode: boolean; summary: { content: string } };
  };
  expect(card.config.streaming_mode).toBe(false);
  expect(card.config.summary.content).toBe(t().summaryComplete);
  expect(card.body.elements).toHaveLength(1);
  expect(card.body.elements[0].content).toBe("final answer");
});

test("buildCard 'aborted' shows stopped footer", () => {
  const card = buildCard({ state: "aborted", text: "partial output" }) as {
    body: { elements: Array<{ content: string }> };
    config: { streaming_mode: boolean };
  };
  expect(card.config.streaming_mode).toBe(false);
  expect(card.body.elements[0].content).toBe("partial output");
  expect(card.body.elements[1].content).toContain(t().summaryStopped);
});

test("buildCard 'error' shows error footer", () => {
  const card = buildCard({ state: "error", text: "stack trace" }) as {
    body: { elements: Array<{ content: string }> };
  };
  expect(card.body.elements[1].content).toContain(t().summaryError);
});

test("truncateForCardBody clips at the limit and appends marker", () => {
  const long = "a".repeat(CARD_BODY_MAX_CHARS + 100);
  const out = truncateForCardBody(long);
  expect(out.length).toBeLessThanOrEqual(CARD_BODY_MAX_CHARS);
  expect(out.endsWith("(truncated)")).toBe(true);
});

test("truncateForCardBody is a no-op for short text", () => {
  expect(truncateForCardBody("short")).toBe("short");
});

test("buildCard truncates oversized body", () => {
  const long = "x".repeat(CARD_BODY_MAX_CHARS + 500);
  const card = buildCard({ state: "streaming", text: long }) as {
    body: { elements: Array<{ content: string }> };
  };
  expect(card.body.elements[0].content.length).toBeLessThanOrEqual(CARD_BODY_MAX_CHARS);
  expect(card.body.elements[0].content.endsWith("(truncated)")).toBe(true);
});

test("buildCardMessageContent wraps card_id in interactive payload", () => {
  expect(buildCardMessageContent("card_abc")).toBe(JSON.stringify({ type: "card", data: { card_id: "card_abc" } }));
});

test("formatElapsedMs formats sub-second / second / minute / mixed", () => {
  expect(formatElapsedMs(0)).toBe("0ms");
  expect(formatElapsedMs(450)).toBe("450ms");
  expect(formatElapsedMs(3400)).toBe("3.4s");
  expect(formatElapsedMs(59_500)).toBe("59.5s");
  expect(formatElapsedMs(60_000)).toBe("1m");
  expect(formatElapsedMs(83_000)).toBe("1m 23s");
});

test("buildCard 'complete' with elapsedMs renders footer", () => {
  const card = buildCard({ state: "complete", text: "ok", elapsedMs: 3400 }) as {
    body: { elements: Array<{ content: string }> };
  };
  expect(card.body.elements).toHaveLength(2);
  expect(card.body.elements[1].content).toContain(t().summaryComplete);
  expect(card.body.elements[1].content).toContain("3.4s");
});

test("buildCard 'complete' without elapsedMs omits the footer", () => {
  const card = buildCard({ state: "complete", text: "ok" }) as {
    body: { elements: Array<{ content: string }> };
  };
  expect(card.body.elements).toHaveLength(1);
});

test("buildCard 'aborted' / 'error' embed elapsed when provided", () => {
  const aborted = buildCard({ state: "aborted", text: "...", elapsedMs: 1200 }) as {
    body: { elements: Array<{ content: string }> };
  };
  expect(aborted.body.elements[1].content).toContain(t().summaryStopped);
  expect(aborted.body.elements[1].content).toContain("1.2s");

  const err = buildCard({ state: "error", text: "...", elapsedMs: 800 }) as {
    body: { elements: Array<{ content: string }> };
  };
  expect(err.body.elements[1].content).toContain(t().summaryError);
  expect(err.body.elements[1].content).toContain("800ms");
});

test("buildCard streaming state with elapsedMs renders a ticking footer", () => {
  const card = buildCard({ state: "streaming", text: "abc", elapsedMs: 4_000 });
  const elements = (card.body as { elements: Array<{ content?: string; tag: string }> }).elements;
  const footer = elements[elements.length - 1];
  expect(footer.tag).toBe("markdown");
  expect(footer.content).toContain(t().summaryProcessing);
  expect(footer.content).toContain("4.0s");
});

test("buildCard thinking state with elapsedMs renders elapsed too", () => {
  const card = buildCard({ state: "thinking", text: "", elapsedMs: 1_500 });
  const elements = (card.body as { elements: Array<{ content?: string; tag: string }> }).elements;
  const footer = elements[elements.length - 1];
  expect(footer.content).toContain("1.5s");
});

test("buildCard streaming with no elapsedMs renders no footer (or omits time)", () => {
  const card = buildCard({ state: "streaming", text: "abc" });
  const elements = (card.body as { elements: Array<{ tag: string; element_id?: string; content?: string }> }).elements;
  // The streaming_content element is always present; footer is the only
  // optional trailing markdown. Either there is no footer at all, or it has
  // no time suffix.
  const last = elements[elements.length - 1];
  if (last.element_id !== "streaming_content") {
    expect(last.content ?? "").not.toMatch(/\d+(?:\.\d+)?(?:ms|s|m)/);
  }
});

test("buildCard with toolSteps renders a collapsible panel above the body", () => {
  const card = buildCard({
    state: "streaming",
    text: "hello",
    elapsedMs: 1_000,
    toolSteps: [
      { toolCallId: "t1", toolName: "Read File", kind: "read", summary: "foo.ts", status: "success", startedAt: 0, durationMs: 30 },
      { toolCallId: "t2", toolName: "Bash", kind: "execute", summary: "npm test", status: "running", startedAt: 100 },
    ],
  });
  const elements = (card.body as { elements: Array<Record<string, unknown>> }).elements;
  expect(elements[0].tag).toBe("collapsible_panel");
  expect(String(JSON.stringify(elements[0]))).toContain("Read File");
  expect(String(JSON.stringify(elements[0]))).toContain("foo.ts");
  expect(String(JSON.stringify(elements[0]))).toContain("Bash");
  expect(String(JSON.stringify(elements[0]))).toContain("npm test");
  expect((elements[1] as { tag: string }).tag).toBe("hr");
  expect((elements[2] as { element_id?: string }).element_id).toBe("streaming_content");
});

test("buildCard with no toolSteps omits the panel entirely", () => {
  const card = buildCard({ state: "streaming", text: "hello", elapsedMs: 1_000 });
  const elements = (card.body as { elements: Array<{ tag: string }> }).elements;
  expect(elements.find((el) => el.tag === "collapsible_panel")).toBeUndefined();
});

test("buildCard caps visible tool panel rows while preserving total count", () => {
  const card = buildCard({
    state: "streaming",
    text: "hello",
    elapsedMs: 1_000,
    toolSteps: Array.from({ length: 55 }, (_, i) => ({
      toolCallId: `t${i}`,
      toolName: `Tool ${i}`,
      kind: "other" as const,
      status: "success" as const,
      startedAt: 0,
    })),
  });
  const panel = ((card.body as { elements: Array<Record<string, unknown>> }).elements[0]);
  const serialized = JSON.stringify(panel);
  expect(serialized).toContain(t().toolPanelHeader(55));
  expect(serialized).toContain("Tool 49");
  expect(serialized).not.toContain("Tool 50");
  expect(serialized).toContain(t().toolPanelOmitted(5));
});

test("buildCard renders reasoningText as an always-collapsed collapsible_panel", () => {
  const card = buildCard({ state: "streaming", text: "the answer", reasoningText: "step one\nstep two" });
  const elements = (card.body as { elements: Array<Record<string, unknown>> }).elements;
  const panel = elements.find((el) => el.tag === "collapsible_panel");
  expect(panel).toBeDefined();
  expect(panel!.expanded).toBe(false);
  const json = JSON.stringify(panel);
  expect(json).toContain(t().reasoningHeader);
  expect(json).toContain("step one");
  expect(json).toContain("step two");
  // Inner markdown element keeps the reasoning element id.
  const inner = (panel!.elements as Array<Record<string, unknown>>)[0];
  expect(inner.element_id).toBe(REASONING_ELEMENT_ID);
});

test("buildCard reasoning header shows elapsed when reasoningElapsedMs is provided", () => {
  const card = buildCard({
    state: "streaming",
    text: "the answer",
    reasoningText: "thinking",
    reasoningElapsedMs: 8_400,
  });
  const elements = (card.body as { elements: Array<Record<string, unknown>> }).elements;
  const panel = elements.find((el) => el.tag === "collapsible_panel")!;
  const headerJson = JSON.stringify(panel.header);
  expect(headerJson).toContain(t().reasoningHeaderElapsed("8.4s"));
  expect(headerJson).toContain("8.4s");
});

test("buildCard reasoning header omits elapsed when reasoningElapsedMs is absent", () => {
  const card = buildCard({ state: "streaming", text: "the answer", reasoningText: "thinking" });
  const elements = (card.body as { elements: Array<Record<string, unknown>> }).elements;
  const panel = elements.find((el) => el.tag === "collapsible_panel")!;
  const headerJson = JSON.stringify(panel.header);
  expect(headerJson).toContain(t().reasoningHeader);
  expect(headerJson).not.toContain(t().reasoningHeaderElapsed(""));
});

// ---- usage footer (P0) ----

test("formatUsageSegment renders token breakdown and context fill", () => {
  const seg = formatUsageSegment({
    used: 12_000,
    size: 200_000,
    breakdown: { inputTokens: 1234, outputTokens: 800 },
  });
  expect(seg).toBe("↑1.2k · ↓800 · ctx 12k/200k 6%");
});

test("formatUsageSegment shows only context when breakdown is absent (codex)", () => {
  const seg = formatUsageSegment({ used: 50_000, size: 100_000 });
  expect(seg).toBe("ctx 50k/100k 50%");
});

test("formatUsageSegment omits zero token fields", () => {
  const seg = formatUsageSegment({ used: 0, size: 128_000, breakdown: { inputTokens: 0, outputTokens: 42 } });
  expect(seg).toBe("↓42 · ctx 0/128k 0%");
});

test("formatUsageSegment returns empty string when nothing usable", () => {
  expect(formatUsageSegment({ used: 0, size: 0 })).toBe("");
});

test("formatUsageSegment clamps context percent to 100 when used exceeds size", () => {
  const seg = formatUsageSegment({ used: 250_000, size: 200_000 });
  expect(seg).toBe("ctx 250k/200k 100%");
});

test("formatUsageSegment promotes 999_999 tokens to 1m instead of 1000k", () => {
  const seg = formatUsageSegment({ used: 999_999, size: 1_000_000 });
  expect(seg).toBe("ctx 1m/1m 100%");
});

test("buildCard 'complete' appends usage segment to the footer", () => {
  const card = buildCard({
    state: "complete",
    text: "answer",
    elapsedMs: 3400,
    usage: { used: 12_000, size: 200_000, breakdown: { inputTokens: 1234, outputTokens: 800 } },
  }) as { body: { elements: Array<{ content: string }> } };
  const footer = card.body.elements[card.body.elements.length - 1];
  expect(footer.content).toContain(t().summaryComplete);
  expect(footer.content).toContain("3.4s");
  expect(footer.content).toContain("↑1.2k");
  expect(footer.content).toContain("ctx 12k/200k 6%");
});

test("buildCard 'complete' renders footer from usage even without elapsed", () => {
  const card = buildCard({
    state: "complete",
    text: "answer",
    usage: { used: 50_000, size: 100_000 },
  }) as { body: { elements: Array<{ content: string; element_id?: string }> } };
  const last = card.body.elements[card.body.elements.length - 1];
  expect(last.element_id).not.toBe(STREAMING_ELEMENT_ID);
  expect(last.content).toContain("ctx 50k/100k 50%");
});

test("buildCard streaming footer carries usage alongside elapsed", () => {
  const card = buildCard({
    state: "streaming",
    text: "abc",
    elapsedMs: 4000,
    usage: { used: 8_000, size: 200_000 },
  }) as { body: { elements: Array<{ content: string }> } };
  const footer = card.body.elements[card.body.elements.length - 1];
  expect(footer.content).toContain("4.0s");
  expect(footer.content).toContain("ctx 8k/200k 4%");
});

// ---- plan panel (P1) ----

test("buildCard with planEntries renders an expanded plan panel above the tool panel", () => {
  const card = buildCard({
    state: "streaming",
    text: "working",
    elapsedMs: 1000,
    planEntries: [
      { content: "Read the spec", status: "completed" },
      { content: "Write the code", status: "in_progress" },
      { content: "Add tests", status: "pending" },
    ],
    toolSteps: [
      { toolCallId: "t1", toolName: "Bash", kind: "execute", status: "running", startedAt: 0 },
    ],
  });
  const elements = (card.body as { elements: Array<Record<string, unknown>> }).elements;
  const panel = elements[0];
  expect(panel.tag).toBe("collapsible_panel");
  expect(panel.expanded).toBe(true);
  const json = JSON.stringify(panel);
  expect(json).toContain(t().planPanelHeader(1, 3));
  expect(json).toContain("Read the spec");
  expect(json).toContain("~~Read the spec~~"); // completed struck through
  expect(json).toContain("Write the code");
  // Plan panel precedes the tool panel.
  expect(JSON.stringify(elements[2])).toContain(t().toolPanelHeader(1));
});

test("buildCard with no planEntries omits the plan panel", () => {
  const card = buildCard({ state: "streaming", text: "hi", elapsedMs: 1000 });
  const elements = (card.body as { elements: Array<Record<string, unknown>> }).elements;
  const planHeaderPresent = elements.some((el) => JSON.stringify(el).includes(t().planPanelHeader(0, 0)));
  expect(planHeaderPresent).toBe(false);
});

test("buildCard caps the plan panel rows while preserving the total in the header", () => {
  const card = buildCard({
    state: "streaming",
    text: "hi",
    elapsedMs: 1000,
    planEntries: Array.from({ length: 35 }, (_, i) => ({
      content: `Step ${i}`,
      status: "pending" as const,
    })),
  });
  const panel = (card.body as { elements: Array<Record<string, unknown>> }).elements[0];
  const json = JSON.stringify(panel);
  expect(json).toContain(t().planPanelHeader(0, 35));
  expect(json).toContain("Step 29");
  expect(json).not.toContain("Step 30");
  expect(json).toContain(t().planPanelOmitted(5));
});

test("buildCard reasoning header omits elapsed when reasoningElapsedMs is zero", () => {
  const card = buildCard({
    state: "streaming",
    text: "the answer",
    reasoningText: "thinking",
    reasoningElapsedMs: 0,
  });
  const elements = (card.body as { elements: Array<Record<string, unknown>> }).elements;
  const panel = elements.find((el) => el.tag === "collapsible_panel")!;
  const headerJson = JSON.stringify(panel.header);
  expect(headerJson).toContain(t().reasoningHeader);
  expect(headerJson).not.toContain(t().reasoningHeaderElapsed(""));
});
