import { expect, test } from "bun:test";
import { formatSubagentNotice, SubagentNoticeTracker } from "../../../src/channels/subagent-notice";
import type { ToolUseEvent } from "../../../src/channels/types";

function event(overrides: Partial<ToolUseEvent>): ToolUseEvent {
  return {
    toolCallId: "sa",
    toolName: "Task",
    kind: "other",
    status: "running",
    ...overrides,
  };
}

test("formatSubagentNotice prefers summary, falls back to tool name", () => {
  expect(formatSubagentNotice(event({ summary: "research the API", status: "running" }))).toBe(
    "↳ [subagent] research the API (running)",
  );
  expect(formatSubagentNotice(event({ status: "success" }))).toBe("↳ [subagent] Task (done)");
  expect(formatSubagentNotice(event({ status: "error" }))).toBe("↳ [subagent] Task (failed)");
});

test("formatSubagentNotice truncates an overlong title", () => {
  const line = formatSubagentNotice(event({ summary: "x".repeat(200) }));
  expect(line.endsWith("… (running)")).toBe(true);
  expect(line.length).toBeLessThan(150);
});

test("tracker ignores non-subagent events", () => {
  const tracker = new SubagentNoticeTracker();
  expect(tracker.notice(event({ isSubagent: false }))).toBeNull();
  expect(tracker.notice(event({}))).toBeNull();
});

test("tracker emits exactly once per delegation, swallowing later frames", () => {
  const tracker = new SubagentNoticeTracker();
  const first = tracker.notice(event({ isSubagent: true, status: "running", summary: "job" }));
  expect(first).toBe("↳ [subagent] job (running)");
  // Repeated running updates are suppressed.
  expect(tracker.notice(event({ isSubagent: true, status: "running", summary: "job" }))).toBeNull();
  // The terminal transition must NOT produce a second line — one notice per delegation.
  expect(tracker.notice(event({ isSubagent: true, status: "success", summary: "job" }))).toBeNull();
  expect(tracker.notice(event({ isSubagent: true, status: "error", summary: "job" }))).toBeNull();
});

test("tracker emits a single line when a delegation is first seen already terminal", () => {
  const tracker = new SubagentNoticeTracker();
  const only = tracker.notice(event({ isSubagent: true, status: "success" }));
  expect(only).toBe("↳ [subagent] Task (done)");
  expect(tracker.notice(event({ isSubagent: true, status: "success" }))).toBeNull();
});

test("tracker keys by toolCallId so parallel delegations each emit", () => {
  const tracker = new SubagentNoticeTracker();
  expect(tracker.notice(event({ toolCallId: "a", isSubagent: true, summary: "A" }))).toBe("↳ [subagent] A (running)");
  expect(tracker.notice(event({ toolCallId: "b", isSubagent: true, summary: "B" }))).toBe("↳ [subagent] B (running)");
});
