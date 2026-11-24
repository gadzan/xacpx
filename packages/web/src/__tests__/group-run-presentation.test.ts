import { describe, expect, it } from "vitest";
import type { TurnPartDto } from "@ganglion/xacpx-relay-protocol";
import { mergeLiveTraceParts, traceEventsToParts } from "../lib/group-run-presentation";
type ToolPart = Extract<TurnPartDto, { type: "tool" }>;

describe("traceEventsToParts", () => {
  const base = { seq: 0, createdAt: "now" };

  it("coalesces adjacent text and reasoning without changing order", () => {
    const { parts } = traceEventsToParts([
      { ...base, seq: 1, kind: "text", payload: { text: "Hel" } },
      { ...base, seq: 2, kind: "text", payload: { text: "lo" } },
      { ...base, seq: 3, kind: "reasoning", payload: { text: "thi" } },
      { ...base, seq: 4, kind: "reasoning", payload: { text: "nking" } },
      { ...base, seq: 5, kind: "text", payload: { text: " world" } },
    ]);
    expect(parts.map((p) => (p.type === "tool" ? "tool" : `${p.type}:${"text" in p ? p.text : ""}`)))
      .toEqual(["text:Hello", "reasoning:thinking", "text: world"]);
  });

  it("upserts tool updates by toolCallId in stream order", () => {
    const { parts } = traceEventsToParts([
      { ...base, seq: 1, kind: "tool", payload: { step: { toolCallId: "tc1", toolName: "bash", kind: "execute", status: "running", title: "run" } } },
      { ...base, seq: 2, kind: "tool", payload: { step: { toolCallId: "tc1", toolName: "bash", kind: "execute", status: "success", title: "run" } } },
    ]);
    expect(parts[0]).toMatchObject({ type: "tool", step: { toolCallId: "tc1", status: "success" } });
  });

  it("treats plan events as replace-latest and records the terminal marker", () => {
    const first = [{ content: "a", status: "pending" as const }];
    const second = [{ content: "a", status: "completed" as const }, { content: "b", status: "in_progress" as const }];
    const result = traceEventsToParts([
      { ...base, seq: 1, kind: "plan", payload: { entries: first } },
      { ...base, seq: 2, kind: "plan", payload: { entries: second } },
      { ...base, seq: 3, kind: "terminal", payload: { ok: true } },
    ]);
    expect(result.plan).toEqual(second);
    expect(result.terminal).toEqual({ ok: true });
  });
});

describe("mergeLiveTraceParts", () => {
  const tool = (id: string, status: "running" | "success" | "error", title = id): ToolPart => ({
    type: "tool",
    step: { toolCallId: id, toolName: "bash", kind: "execute", status, title },
  });
  const text = (value: string): TurnPartDto => ({ type: "text", text: value });
  const reasoning = (value: string): TurnPartDto => ({ type: "reasoning", text: value });

  it("is transparent when only one channel has parts", () => {
    expect(mergeLiveTraceParts(undefined, undefined)).toBeUndefined();
    expect(mergeLiveTraceParts([text("a")], undefined)).toEqual([text("a")]);
    expect(mergeLiveTraceParts(undefined, [text("b")])).toEqual([text("b")]);
  });

  it("aligns prose-tool-prose overlap block by block without duplicating either paragraph", () => {
    const replay = [text("Alpha narrative"), tool("tc1", "success"), text("Omega narrative")];
    const live = [text("Alpha narrative"), tool("tc1", "success"), text("Omega narrative")];
    expect(mergeLiveTraceParts(replay, live)).toEqual(replay);
  });

  it("matches two prose blocks around a tool even as the second block grows", () => {
    const merged = mergeLiveTraceParts(
      [text("Alpha narrative"), tool("tc1", "success"), text("Omega narrative")],
      [text("Alpha narrative"), tool("tc1", "success"), text("Omega narrative extended")],
    );
    expect(merged).toEqual([
      text("Alpha narrative"), tool("tc1", "success"), text("Omega narrative extended"),
    ]);
  });

  it("upserts a tool by toolCallId so live and durable overlap never duplicates a row", () => {
    const merged = mergeLiveTraceParts(
      [tool("tc1", "running"), text("done")],
      [tool("tc1", "success", "finished run"), text("done")],
    );
    expect(merged).toHaveLength(2);
    expect(merged![0]).toMatchObject({ type: "tool", step: { toolCallId: "tc1", status: "success", title: "finished run" } });
  });

  it("appends live-only events after the durable page", () => {
    const merged = mergeLiveTraceParts([tool("tc1", "success")], [tool("tc1", "success"), tool("tc2", "running")]);
    expect(merged!.map((part) => part.type === "tool" ? part.step.toolCallId : part.type)).toEqual(["tc1", "tc2"]);
  });

  it("appends a genuinely new prose tail once even when it overlaps nothing", () => {
    const merged = mergeLiveTraceParts(
      [text("Alpha narrative"), tool("tc1", "success"), text("Omega narrative")],
      [text("Alpha narrative"), tool("tc1", "success"), text("Omega narrative"), text("live tail")],
    );
    expect(merged).toEqual([
      text("Alpha narrative"), tool("tc1", "success"), text("Omega narrative"), text("live tail"),
    ]);
  });

  it("keeps a durable terminal status when the live snapshot still says running", () => {
    const merged = mergeLiveTraceParts([tool("tc1", "success", "durable")], [tool("tc1", "running", "live")]);
    expect(merged![0]).toMatchObject({ step: { status: "success", title: "durable" } });
  });

  it("keeps a durable error over a lagging live success", () => {
    const merged = mergeLiveTraceParts([tool("tc1", "error", "durable")], [tool("tc1", "success", "live")]);
    expect(merged![0]).toMatchObject({ step: { status: "error", title: "durable" } });
  });

  it("takes the fresher live frame while the durable snapshot is still running", () => {
    const merged = mergeLiveTraceParts([tool("tc1", "running", "durable")], [tool("tc1", "error", "live")]);
    expect(merged![0]).toMatchObject({ step: { status: "error", title: "live" } });
  });

  it("takes the live superset of a grown prose block instead of a second paragraph", () => {
    const merged = mergeLiveTraceParts(
      [text("Alpha narrative"), text("Omega narrative")],
      [text("Alpha narrative"), text("Omega narrative extended")],
    );
    expect(merged).toEqual([text("Alpha narrative"), text("Omega narrative extended")]);
  });

  it("drops a late-subscription prose fragment the durable page already contains", () => {
    const merged = mergeLiveTraceParts([text("Hello world")], [text("world")]);
    expect(merged).toEqual([text("Hello world")]);
  });

  it("keeps reasoning and text blocks on separate tracks", () => {
    const merged = mergeLiveTraceParts(
      [reasoning("plan"), tool("tc1", "success"), text("reply")],
      [reasoning("plan refined"), tool("tc1", "success"), text("reply")],
    );
    expect(merged).toEqual([reasoning("plan refined"), tool("tc1", "success"), text("reply")]);
  });

  it("drops a stale live tail once the member is terminal and the page has content", () => {
    const replay = [text("committed"), tool("tc1", "success")];
    const live = [text("committed"), tool("tc1", "success"), text("stale tail")];
    expect(mergeLiveTraceParts(replay, live, { terminal: true })).toEqual(replay);
  });

  it("keeps the live fallback for a terminal member whose page is empty", () => {
    const live = [text("only live")];
    expect(mergeLiveTraceParts([], live, { terminal: true })).toEqual(live);
    expect(mergeLiveTraceParts(undefined, live, { terminal: true })).toEqual(live);
  });
});
