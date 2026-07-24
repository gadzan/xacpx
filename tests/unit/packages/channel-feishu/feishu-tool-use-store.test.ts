import { expect, test } from "bun:test";
import { ToolUseStore } from "../../../../packages/channel-feishu/src/card/tool-use-store";
import type { ToolUseEvent } from "../../../../packages/channel-feishu/src/card/tool-use-types";

function event(over: Partial<ToolUseEvent>): ToolUseEvent {
  return { toolCallId: "t1", toolName: "Read", kind: "read", status: "running", ...over };
}

test("first event for a toolCallId creates a step", () => {
  const store = new ToolUseStore(() => 100);
  store.record(event({ toolCallId: "t1", summary: "foo.ts" }));
  expect(store.steps()).toEqual([
    { toolCallId: "t1", toolName: "Read", kind: "read", summary: "foo.ts", status: "running", startedAt: 100 },
  ]);
});

test("subsequent event for the same toolCallId updates the step in place", () => {
  let now = 100;
  const store = new ToolUseStore(() => now);
  store.record(event({ toolCallId: "t1", summary: "foo.ts" }));
  now = 350;
  store.record(event({ toolCallId: "t1", status: "success", summary: "foo.ts", durationMs: 250 }));
  expect(store.steps()).toEqual([
    {
      toolCallId: "t1",
      toolName: "Read",
      kind: "read",
      summary: "foo.ts",
      status: "success",
      startedAt: 100,
      durationMs: 250,
    },
  ]);
});

test("terminal event computes duration when transport does not provide one", () => {
  let now = 100;
  const store = new ToolUseStore(() => now);
  store.record(event({ toolCallId: "t1", summary: "foo.ts" }));
  now = 425;
  store.record(event({ toolCallId: "t1", status: "success", summary: "foo.ts" }));
  expect(store.steps()[0].durationMs).toBe(325);
});

test("revision increments for insertions and same-id updates", () => {
  const store = new ToolUseStore(() => 0);
  expect(store.getRevision()).toBe(0);
  store.record(event({ toolCallId: "t1" }));
  expect(store.getRevision()).toBe(1);
  store.record(event({ toolCallId: "t1", status: "success" }));
  expect(store.getRevision()).toBe(2);
  store.record(event({ toolCallId: "t2" }));
  expect(store.getRevision()).toBe(3);
});

test("steps preserve insertion order across multiple toolCallIds", () => {
  const store = new ToolUseStore(() => 0);
  store.record(event({ toolCallId: "a", summary: "a.ts" }));
  store.record(event({ toolCallId: "b", summary: "b.ts" }));
  store.record(event({ toolCallId: "a", status: "success", summary: "a.ts" }));
  expect(store.steps().map((s) => s.toolCallId)).toEqual(["a", "b"]);
});

test("later summary updates an earlier placeholder summary", () => {
  const store = new ToolUseStore(() => 0);
  store.record(event({ toolCallId: "t1", summary: undefined }));
  store.record(event({ toolCallId: "t1", summary: "foo.ts" }));
  expect(store.steps()[0].summary).toBe("foo.ts");
});

test("late-arriving subagent classification upgrades an existing step", () => {
  // Kimi's opening tool_call ships a sparse rawInput, so the transport can't
  // classify the delegation until a later merged frame — the step must promote
  // isSubagent/parentToolCallId when they finally appear.
  const store = new ToolUseStore(() => 0);
  store.record(event({ toolCallId: "task-1", toolName: "Task", kind: "other" }));
  expect(store.steps()[0].isSubagent).toBeUndefined();
  store.record(
    event({ toolCallId: "task-1", toolName: "Task", kind: "other", isSubagent: true, parentToolCallId: "root" }),
  );
  expect(store.steps()[0].isSubagent).toBe(true);
  expect(store.steps()[0].parentToolCallId).toBe("root");
});

test("subagent classification is never cleared by a later sparse frame", () => {
  const store = new ToolUseStore(() => 0);
  store.record(event({ toolCallId: "task-1", isSubagent: true, parentToolCallId: "root" }));
  // A terminal frame that omits the subagent fields must not regress them.
  store.record(event({ toolCallId: "task-1", status: "success" }));
  expect(store.steps()[0].isSubagent).toBe(true);
  expect(store.steps()[0].parentToolCallId).toBe("root");
});
