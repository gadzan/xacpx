import { expect, test } from "bun:test";
import type { ToolUseEvent } from "../../../../src/channels/types";
import {
  toolUseEventToStepDto,
  TRUNCATED_PREFIX_MARK,
  TRUNCATED_SUFFIX_MARK,
  type PublicToolUseEvent,
  type ToolStepDto,
} from "../../../../packages/relay-protocol/src/index";
import { toolUseEventToStepDto as channelConverter } from "../../../../packages/channel-relay/src/tool-presentation";

const fixtures: Array<{ name: string; event: PublicToolUseEvent; expected: ToolStepDto }> = [
  {
    name: "diff",
    event: { toolCallId: "diff", toolName: "Edit", kind: "edit", status: "success", content: [{ type: "diff", path: "a.ts", oldText: "old", newText: "new" }] },
    expected: { toolCallId: "diff", toolName: "Edit", kind: "edit", status: "success", title: "a.ts", titleIsPath: true, detail: { type: "diff", path: "a.ts", oldText: "old", newText: "new" } },
  },
  {
    name: "command",
    event: { toolCallId: "cmd", toolName: "Bash", kind: "execute", status: "success", rawInput: { command: "pwd" }, rawOutput: { stdout: "/workspace", exitCode: 0 } },
    expected: { toolCallId: "cmd", toolName: "Bash", kind: "execute", status: "success", title: "pwd", detail: { type: "command", command: "pwd", output: "/workspace", exitCode: 0 } },
  },
  {
    name: "read",
    event: { toolCallId: "read", toolName: "Read", kind: "read", status: "success", rawInput: { path: "a.ts", offset: 2, limit: 3 }, content: { type: "text", text: "body" } },
    expected: { toolCallId: "read", toolName: "Read", kind: "read", status: "success", title: "a.ts", titleIsPath: true, detail: { type: "read", path: "a.ts", lines: "2–5", preview: "body" } },
  },
  {
    name: "search",
    event: { toolCallId: "search", toolName: "Grep", kind: "search", status: "success", rawInput: { pattern: "needle", path: "src" }, rawOutput: { stdout: "a.ts:needle", metadata: { count: 1, truncated: false } } },
    expected: { toolCallId: "search", toolName: "Grep", kind: "search", status: "success", title: "needle in src", detail: { type: "search", query: "needle in src", output: "a.ts:needle", count: 1, truncated: false } },
  },
  {
    name: "error",
    event: { toolCallId: "error", toolName: "Bash", kind: "execute", status: "error", rawInput: { command: "false" }, rawOutput: { error: "denied" } },
    expected: { toolCallId: "error", toolName: "Bash", kind: "execute", status: "error", title: "false", error: "denied" },
  },
  {
    name: "subagent",
    event: { toolCallId: "agent", parentToolCallId: "parent", toolName: "Task", kind: "other", status: "running", isSubagent: true, rawInput: { prompt: "Review" }, rawOutput: { text: "Working" } },
    expected: { toolCallId: "agent", parentToolCallId: "parent", toolName: "Task", kind: "other", status: "running", isSubagent: true, title: "Task", detail: { type: "text", text: "Review", output: "Working" } },
  },
  {
    name: "agent_send",
    event: { toolCallId: "send", toolName: "Send message", machineToolName: "mcp__xacpx__agent_send", kind: "other", status: "success", rawOutput: { structuredContent: { messageId: "msg_test", status: "queued", privateMetadata: "secret" } } },
    expected: { toolCallId: "send", toolName: "Send message", kind: "other", status: "success", title: "Send message", agentMessageId: "msg_test" },
  },
  {
    name: "terminal-only",
    event: { toolCallId: "terminal", toolName: "shell", kind: "execute", status: "error", content: [{ type: "terminal", terminalId: "term_1" }] },
    expected: { toolCallId: "terminal", toolName: "shell", kind: "execute", status: "error", title: "shell", terminalId: "term_1", error: "[terminal term_1]", detail: { type: "command", command: "shell", output: "[terminal term_1]" } },
  },
];

for (const { name, event, expected } of fixtures) {
  test(`shared converter golden: ${name}`, () => {
    // Core's event satisfies the shared structural contract without a runtime dependency.
    const coreEvent: ToolUseEvent = event;
    expect(toolUseEventToStepDto(coreEvent)).toEqual(expected);
    expect(channelConverter(coreEvent)).toEqual(expected);
  });
}

test("normalization keeps only existing display fields, excluding raw and private metadata", () => {
  const event = {
    toolCallId: "safe", toolName: "Read", kind: "read", status: "success",
    rawInput: { path: "safe.ts", _toolName: "private-machine", privateMetadata: { token: "input-secret" } },
    rawOutput: { stdout: "public preview", privateMetadata: { token: "output-secret" } },
    content: [{ type: "image", data: "image-secret" }],
    privateMetadata: { token: "event-secret" },
  } as const;
  const step = toolUseEventToStepDto(event);
  expect(step).toEqual({ toolCallId: "safe", toolName: "Read", kind: "read", status: "success", title: "safe.ts", titleIsPath: true, detail: { type: "read", path: "safe.ts", preview: "public preview" } });
  const serialized = JSON.stringify(step);
  for (const excluded of ["rawInput", "rawOutput", "privateMetadata", "input-secret", "output-secret", "event-secret", "image-secret", "private-machine"]) {
    expect(serialized).not.toContain(excluded);
  }
});

test("shared normalization preserves head and tail truncation boundaries", () => {
  const diff = toolUseEventToStepDto({ toolCallId: "diff", toolName: "Edit", kind: "edit", status: "success", rawInput: { path: "a.ts", oldText: "a".repeat(4001), newText: "b".repeat(4001), instruction: "i".repeat(301) } });
  expect(diff.detail).toEqual({ type: "diff", path: "a.ts", oldText: "a".repeat(4000) + TRUNCATED_SUFFIX_MARK, newText: "b".repeat(4000) + TRUNCATED_SUFFIX_MARK, instruction: "i".repeat(300) + TRUNCATED_SUFFIX_MARK });
  const agent = toolUseEventToStepDto({ toolCallId: "agent", toolName: "Task", kind: "other", status: "error", isSubagent: true, rawInput: { prompt: "p".repeat(8001) }, rawOutput: { text: "discard" + "o".repeat(8000), error: "e".repeat(2001) } });
  expect(agent.detail).toEqual({ type: "text", text: "p".repeat(8000) + TRUNCATED_SUFFIX_MARK, output: TRUNCATED_PREFIX_MARK + "o".repeat(8000) });
  expect(agent.error).toBe("e".repeat(2000) + TRUNCATED_SUFFIX_MARK);
});

test("unrelated or malformed receipts cannot create agent message correlation", () => {
  for (const machineToolName of ["Read", "agent_send"]) {
    const step = toolUseEventToStepDto({ toolCallId: "receipt", toolName: "agent_send", machineToolName, kind: "other", status: "success", rawOutput: { structuredContent: { messageId: "msg_wrong", status: "unknown", token: "secret" } } });
    expect(step.agentMessageId).toBeUndefined();
    expect(JSON.stringify(step)).not.toContain("secret");
  }
});
