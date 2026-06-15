import { expect, test } from "bun:test";
import { toolUseEventToStepDto } from "../../../../packages/channel-relay/src/tool-presentation";

test("edit reads the content diff block", () => {
  const step = toolUseEventToStepDto({
    toolCallId: "t1", toolName: "Edit", kind: "edit", status: "success", durationMs: 400,
    content: [{ type: "diff", path: "src/parser.ts", oldText: "const x = 1", newText: "const x = 2" }],
  });
  expect(step).toMatchObject({
    toolCallId: "t1", kind: "edit", status: "success", durationMs: 400, title: "src/parser.ts",
    detail: { type: "diff", path: "src/parser.ts", oldText: "const x = 1", newText: "const x = 2" },
  });
});

test("execute reads command + stdout + exit code", () => {
  const step = toolUseEventToStepDto({
    toolCallId: "t2", toolName: "Bash", kind: "execute", status: "success",
    rawInput: { command: "npm test", description: "run tests" },
    rawOutput: { stdout: "12 passed", exitCode: 0 },
  });
  expect(step.title).toBe("npm test");
  expect(step.detail).toEqual({ type: "command", command: "npm test", output: "12 passed", exitCode: 0 });
});

test("read derives path from file_path and a content array preview", () => {
  const step = toolUseEventToStepDto({
    toolCallId: "t3", toolName: "Read", kind: "read", status: "success",
    rawInput: { file_path: "src/a.ts" },
    content: { type: "text", text: "file contents" },
  });
  expect(step.title).toBe("src/a.ts");
  expect(step.detail).toMatchObject({ type: "read", path: "src/a.ts", preview: "file contents" });
});

test("search uses Codex parsed_cmd for the query", () => {
  const step = toolUseEventToStepDto({
    toolCallId: "t4", toolName: "Search", kind: "search", status: "success",
    rawInput: { parsed_cmd: [{ type: "search", cmd: "rg -n session src", name: "src" }] },
  });
  expect(step.detail).toMatchObject({ type: "search", query: "rg -n session src" });
});

test("unknown tool falls back to primitive fields only (no nested JSON)", () => {
  const step = toolUseEventToStepDto({
    toolCallId: "t5", toolName: "Mystery", kind: "other", status: "running",
    rawInput: { name: "thing", count: 3, nested: { a: 1 }, arr: [1, 2] },
  });
  expect(step.detail).toMatchObject({ type: "fields" });
  const fields = (step.detail as { type: "fields"; fields: Array<{ label: string; value: string }> }).fields;
  expect(fields).toEqual([{ label: "name", value: "thing" }, { label: "count", value: "3" }]);
});

test("caps long output with a truncated marker", () => {
  const big = "x".repeat(9000);
  const step = toolUseEventToStepDto({
    toolCallId: "t6", toolName: "Bash", kind: "execute", status: "success",
    rawInput: { command: "cat big" }, rawOutput: { stdout: big },
  });
  const out = (step.detail as { output: string }).output;
  expect(out.length).toBeLessThan(9000);
  expect(out.endsWith("…(truncated)")).toBe(true);
});

test("read derives preview from a resource content block", () => {
  const step = toolUseEventToStepDto({
    toolCallId: "t8", toolName: "Read", kind: "read", status: "success",
    rawInput: { file_path: "src/b.ts" },
    content: [{ type: "content", content: { type: "resource", resource: { uri: "file://src/b.ts", text: "resource body" } } }],
  });
  expect(step.detail).toMatchObject({ type: "read", path: "src/b.ts", preview: "resource body" });
});

test("read shows a resource_link's title when it has no inline text", () => {
  const step = toolUseEventToStepDto({
    toolCallId: "t9", toolName: "Read", kind: "read", status: "success",
    rawInput: { file_path: "src/c.ts" },
    content: [{ type: "content", content: { type: "resource_link", uri: "file://src/c.ts", title: "c.ts" } }],
  });
  expect(step.detail).toMatchObject({ type: "read", path: "src/c.ts", preview: "c.ts" });
});

test("execute keeps a bare-string rawOutput as the command output", () => {
  const step = toolUseEventToStepDto({
    toolCallId: "t10", toolName: "Bash", kind: "execute", status: "success",
    rawInput: { command: "echo hi" },
    rawOutput: "hi\n",
  });
  expect(step.detail).toMatchObject({ type: "command", command: "echo hi", output: "hi\n" });
});

test("think uses description as prose text", () => {
  const step = toolUseEventToStepDto({
    toolCallId: "t7", toolName: "Task", kind: "think", status: "success",
    rawInput: { description: "Explore code", subagent_type: "Explore" },
  });
  expect(step.detail).toEqual({ type: "text", text: "Explore code" });
});

test("a failed read surfaces the error message from rawOutput.error", () => {
  const step = toolUseEventToStepDto({
    toolCallId: "t9", toolName: "read", kind: "read", status: "error",
    rawInput: { filePath: "/tmp/missing.txt" },
    content: [{ type: "content", content: { type: "text", text: "Error: File not found: /tmp/missing.txt" } }],
    rawOutput: { error: "Error: File not found: /tmp/missing.txt" },
  });
  expect(step.status).toBe("error");
  expect(step.error).toBe("Error: File not found: /tmp/missing.txt");
});

test("error field is omitted on success", () => {
  const step = toolUseEventToStepDto({
    toolCallId: "t10", toolName: "Bash", kind: "execute", status: "success",
    rawInput: { command: "ls" }, rawOutput: { stdout: "a b", exitCode: 0, error: "ignored when not error" },
  });
  expect(step.error).toBeUndefined();
});
