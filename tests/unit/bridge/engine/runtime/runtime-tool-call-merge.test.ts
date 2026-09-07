import { describe, expect, test } from "bun:test";
import {
  normalizeRuntimeToolCallEvent,
  mergeTitle,
  isMeaningfulTitle,
  type RuntimeToolCallSnapshot,
} from "../../../../../src/bridge/engine/runtime/runtime-tool-call-merge";
import type { XacpxRuntimeEvent } from "../../../../../src/bridge/engine/runtime/runtime-contract";

describe("Runtime Tool Call Snapshot Normalization (spec §5-§7, §12)", () => {
  test("isMeaningfulTitle correctly filters generic placeholders and whitespace", () => {
    expect(isMeaningfulTitle(undefined)).toBe(false);
    expect(isMeaningfulTitle(null)).toBe(false);
    expect(isMeaningfulTitle("")).toBe(false);
    expect(isMeaningfulTitle("   ")).toBe(false);
    expect(isMeaningfulTitle("tool call")).toBe(false);
    expect(isMeaningfulTitle("Tool Call")).toBe(false);
    expect(isMeaningfulTitle("TOOL CALL")).toBe(false);
    expect(isMeaningfulTitle("  tool call  ")).toBe(false);

    expect(isMeaningfulTitle("Read")).toBe(true);
    expect(isMeaningfulTitle("Bash")).toBe(true);
    expect(isMeaningfulTitle("Edit")).toBe(true);
    expect(isMeaningfulTitle("Read configuration")).toBe(true);
  });

  test("mergeTitle semantics", () => {
    // Missing new title keeps previous
    expect(mergeTitle("Read", undefined)).toBe("Read");
    expect(mergeTitle("Read", "")).toBe("Read");
    expect(mergeTitle("Read", "   ")).toBe("Read");

    // Meaningful new title overwrites previous
    expect(mergeTitle("Read", "Read configuration")).toBe("Read configuration");

    // Generic placeholder new title does not overwrite meaningful previous
    expect(mergeTitle("Read", "tool call")).toBe("Read");
    expect(mergeTitle("Read", "Tool Call")).toBe("Read");

    // Meaningful new title overwrites previous generic placeholder
    expect(mergeTitle("tool call", "Read")).toBe("Read");

    // Initial generic placeholder when no previous exists returns trimmed generic title
    expect(mergeTitle(undefined, "tool call")).toBe("tool call");
  });

  // Spec Test 1 — Read sparse terminal update
  test("Test 1: Read sparse terminal update retains title, kind, rawInput, and updates status", () => {
    const toolCalls = new Map<string, RuntimeToolCallSnapshot>();

    const event1 = normalizeRuntimeToolCallEvent(toolCalls, {
      type: "tool_call",
      text: "reading file",
      toolCallId: "read-1",
      title: "Read",
      kind: "read",
      rawInput: { path: "/tmp/a.ts" },
    });

    expect(event1).toMatchObject({
      type: "tool_call",
      toolCallId: "read-1",
      title: "Read",
      kind: "read",
      rawInput: { path: "/tmp/a.ts" },
    });

    const event2 = normalizeRuntimeToolCallEvent(toolCalls, {
      type: "tool_call",
      text: "tool call (completed)",
      tag: "tool_call_update",
      toolCallId: "read-1",
      title: "tool call",
      status: "completed",
    });

    expect(event2).toMatchObject({
      type: "tool_call",
      toolCallId: "read-1",
      title: "Read",
      kind: "read",
      rawInput: { path: "/tmp/a.ts" },
      status: "completed",
      tag: "tool_call_update",
    });
  });

  // Spec Test 2 — Execute keeps input and gains output
  test("Test 2: Execute keeps rawInput.command and gains rawOutput.formatted_output", () => {
    const toolCalls = new Map<string, RuntimeToolCallSnapshot>();

    normalizeRuntimeToolCallEvent(toolCalls, {
      type: "tool_call",
      text: "running bash",
      toolCallId: "bash-1",
      title: "Bash",
      kind: "execute",
      rawInput: { command: "bun test" },
    });

    const terminal = normalizeRuntimeToolCallEvent(toolCalls, {
      type: "tool_call",
      text: "tool call (completed)",
      tag: "tool_call_update",
      toolCallId: "bash-1",
      title: "tool call",
      status: "completed",
      rawOutput: { formatted_output: "42 pass", exit_code: 0 },
    });

    expect(terminal).toMatchObject({
      type: "tool_call",
      toolCallId: "bash-1",
      title: "Bash",
      kind: "execute",
      rawInput: { command: "bun test" },
      rawOutput: { formatted_output: "42 pass", exit_code: 0 },
      status: "completed",
    });
  });

  // Spec Test 3 — Edit rich frame survives sparse completion
  test("Test 3: Edit rich frame survives sparse completion", () => {
    const toolCalls = new Map<string, RuntimeToolCallSnapshot>();

    normalizeRuntimeToolCallEvent(toolCalls, {
      type: "tool_call",
      text: "editing file",
      toolCallId: "edit-1",
      title: "Edit",
      kind: "edit",
      rawInput: { file_path: "src/foo.ts", old_string: "let a = 1", new_string: "let a = 2" },
      content: [{ type: "diff", path: "src/foo.ts", oldText: "let a = 1", newText: "let a = 2" }],
      locations: [{ path: "src/foo.ts" }],
    });

    const terminal = normalizeRuntimeToolCallEvent(toolCalls, {
      type: "tool_call",
      text: "tool call (completed)",
      tag: "tool_call_update",
      toolCallId: "edit-1",
      title: "tool call",
      status: "completed",
    });

    expect(terminal).toMatchObject({
      type: "tool_call",
      toolCallId: "edit-1",
      title: "Edit",
      kind: "edit",
      rawInput: { file_path: "src/foo.ts", old_string: "let a = 1", new_string: "let a = 2" },
      content: [{ type: "diff", path: "src/foo.ts", oldText: "let a = 1", newText: "let a = 2" }],
      locations: [{ path: "src/foo.ts" }],
      status: "completed",
    });
  });

  // Spec Test 4 — Real title update wins
  test("Test 4: Real title update wins over initial title", () => {
    const toolCalls = new Map<string, RuntimeToolCallSnapshot>();

    normalizeRuntimeToolCallEvent(toolCalls, {
      type: "tool_call",
      text: "reading",
      toolCallId: "call-4",
      title: "Read",
    });

    const update = normalizeRuntimeToolCallEvent(toolCalls, {
      type: "tool_call",
      text: "reading config",
      tag: "tool_call_update",
      toolCallId: "call-4",
      title: "Read configuration",
    });

    expect(update.title).toBe("Read configuration");
  });

  // Spec Test 5 — Synthetic placeholder does not win
  test("Test 5: Synthetic placeholder 'tool call' does not win over rich initial title", () => {
    const toolCalls = new Map<string, RuntimeToolCallSnapshot>();

    normalizeRuntimeToolCallEvent(toolCalls, {
      type: "tool_call",
      text: "executing",
      toolCallId: "call-5",
      title: "Bash",
    });

    const update = normalizeRuntimeToolCallEvent(toolCalls, {
      type: "tool_call",
      text: "tool call",
      toolCallId: "call-5",
      title: "tool call",
    });

    expect(update.title).toBe("Bash");
  });

  // Spec Test 6 — Missing fields preserve old fields
  test("Test 6: Update with omitted/empty fields preserves all previous fields", () => {
    const toolCalls = new Map<string, RuntimeToolCallSnapshot>();

    normalizeRuntimeToolCallEvent(toolCalls, {
      type: "tool_call",
      text: "initial text",
      tag: "tool_call",
      toolCallId: "call-6",
      title: "CustomTool",
      kind: "search",
      rawInput: { query: "worker fence" },
      content: [{ type: "text", text: "searching" }],
      locations: ["src/index.ts"],
    });

    const update = normalizeRuntimeToolCallEvent(toolCalls, {
      type: "tool_call",
      text: "",
      toolCallId: "call-6",
      status: "in_progress",
      rawInput: {}, // Empty object should not clobber
      content: [],  // Empty array should not clobber
    });

    expect(update).toMatchObject({
      toolCallId: "call-6",
      title: "CustomTool",
      kind: "search",
      rawInput: { query: "worker fence" },
      content: [{ type: "text", text: "searching" }],
      locations: ["src/index.ts"],
      status: "in_progress",
    });
  });

  // Spec Test 7 — New rawOutput is appended to snapshot
  test("Test 7: New rawOutput coexists with previous rawInput", () => {
    const toolCalls = new Map<string, RuntimeToolCallSnapshot>();

    normalizeRuntimeToolCallEvent(toolCalls, {
      type: "tool_call",
      text: "executing",
      toolCallId: "call-7",
      rawInput: { cmd: "echo 123" },
    });

    const update = normalizeRuntimeToolCallEvent(toolCalls, {
      type: "tool_call",
      text: "done",
      toolCallId: "call-7",
      rawOutput: { stdout: "123\n" },
    });

    expect(update.rawInput).toEqual({ cmd: "echo 123" });
    expect(update.rawOutput).toEqual({ stdout: "123\n" });
  });

  // Spec Test 8 — Same toolCallId across two turns does not merge
  test("Test 8: Same toolCallId across two turns does not merge (per-turn isolation)", () => {
    // Turn A
    const turnAToolCalls = new Map<string, RuntimeToolCallSnapshot>();
    normalizeRuntimeToolCallEvent(turnAToolCalls, {
      type: "tool_call",
      text: "reading",
      toolCallId: "1",
      title: "Read",
      kind: "read",
      rawInput: { path: "/turn-a.ts" },
    });

    // Turn B (fresh map)
    const turnBToolCalls = new Map<string, RuntimeToolCallSnapshot>();
    const turnBEvent = normalizeRuntimeToolCallEvent(turnBToolCalls, {
      type: "tool_call",
      text: "executing",
      toolCallId: "1",
      title: "Bash",
      kind: "execute",
      rawInput: { command: "ls" },
    });

    expect(turnBEvent.title).toBe("Bash");
    expect(turnBEvent.kind).toBe("execute");
    expect(turnBEvent.rawInput).toEqual({ command: "ls" });
    expect(turnBEvent.rawInput).not.toEqual({ path: "/turn-a.ts" });
  });

  // Spec Test 9 — No toolCallId stays passthrough
  test("Test 9: Events without toolCallId stay passthrough and do not mutate map", () => {
    const toolCalls = new Map<string, RuntimeToolCallSnapshot>();

    const eventWithoutId = normalizeRuntimeToolCallEvent(toolCalls, {
      type: "tool_call",
      text: "no id event",
      title: "NoIdTool",
      status: "in_progress",
    });

    expect(eventWithoutId.toolCallId).toBeUndefined();
    expect(eventWithoutId.title).toBe("NoIdTool");
    expect(toolCalls.size).toBe(0);
  });
});
