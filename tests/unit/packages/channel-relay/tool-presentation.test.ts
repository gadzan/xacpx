import { expect, test } from "bun:test";
import type { ToolUseEvent } from "../../../../src/channels/types";
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

test("edit builds a diff from raw old_string/new_string when no diff block", () => {
  const step = toolUseEventToStepDto({
    toolCallId: "e1", toolName: "Edit", kind: "edit", status: "success",
    rawInput: { file_path: "src/a.ts", old_string: "let a = 1", new_string: "let a = 2" },
  });
  expect(step.title).toBe("src/a.ts");
  expect(step.detail).toMatchObject({ type: "diff", path: "src/a.ts", oldText: "let a = 1", newText: "let a = 2" });
});

test("edit carries a capped instruction on the diff detail", () => {
  const step = toolUseEventToStepDto({
    toolCallId: "e2", toolName: "Edit", kind: "edit", status: "success",
    rawInput: { file_path: "src/a.ts", old_string: "a", new_string: "b", instruction: "x".repeat(500) },
  });
  const detail = step.detail as { type: "diff"; instruction?: string };
  expect(detail.type).toBe("diff");
  expect(detail.instruction?.startsWith("x".repeat(300))).toBe(true);
  expect(detail.instruction?.length).toBeLessThanOrEqual(320); // 300 + "…(truncated)"
});

test("edit falls back to fields when neither diff block nor old/new text exist", () => {
  const step = toolUseEventToStepDto({
    toolCallId: "e3", toolName: "Edit", kind: "edit", status: "success",
    rawInput: { file_path: "src/a.ts", mode: "insert" },
  });
  expect(step.detail?.type).toBe("fields");
});

test("edit keeps the input path when the title came from locations", () => {
  const step = toolUseEventToStepDto({
    toolCallId: "e6", toolName: "Edit", kind: "edit", status: "success",
    locations: [{ path: "actual.ts" }],
    rawInput: { file_path: "requested.ts", mode: "insert" },
  });
  expect(step.title).toBe("actual.ts");
  expect(step.detail).toMatchObject({
    type: "fields",
    fields: [
      { label: "file_path", value: "requested.ts" },
      { label: "mode", value: "insert" },
    ],
  });
});

test("edit maps Write-style rawInput.content to the diff newText with empty oldText", () => {
  const step = toolUseEventToStepDto({
    toolCallId: "e4", toolName: "Write", kind: "edit", status: "success",
    rawInput: { file_path: "src/new.ts", content: "export const x = 1\n" },
  });
  expect(step.title).toBe("src/new.ts");
  expect(step.detail).toMatchObject({ type: "diff", path: "src/new.ts", oldText: "", newText: "export const x = 1\n" });
});

test("edit prefers the ACP diff block over conflicting rawInput old/new text", () => {
  const step = toolUseEventToStepDto({
    toolCallId: "e5", toolName: "Edit", kind: "edit", status: "success",
    content: [{ type: "diff", path: "src/b.ts", oldText: "block old", newText: "block new" }],
    rawInput: { file_path: "src/ignored.ts", old_string: "raw old", new_string: "raw new" },
  });
  expect(step.detail).toMatchObject({ type: "diff", path: "src/b.ts", oldText: "block old", newText: "block new" });
});

test("edit omits the detail for an empty Write (empty content, no instruction)", () => {
  const step = toolUseEventToStepDto({
    toolCallId: "e7", toolName: "Write", kind: "edit", status: "success",
    rawInput: { file_path: "empty.txt", content: "" },
  });
  expect(step.title).toBe("empty.txt");
  expect(step.detail).toBeUndefined();
});

test("edit omits the detail for an empty diff block without instruction", () => {
  const step = toolUseEventToStepDto({
    toolCallId: "e8", toolName: "Edit", kind: "edit", status: "success",
    content: [{ type: "diff", path: "src/empty.ts", oldText: "", newText: "" }],
  });
  expect(step.title).toBe("src/empty.ts");
  expect(step.detail).toBeUndefined();
});

test("edit keeps an empty diff when an instruction gives the drawer content", () => {
  const step = toolUseEventToStepDto({
    toolCallId: "e9", toolName: "Edit", kind: "edit", status: "success",
    rawInput: { file_path: "empty.txt", content: "", instruction: "touch the file" },
  });
  expect(step.detail).toMatchObject({ type: "diff", path: "empty.txt", instruction: "touch the file" });
});

test("edit keeps an empty diff on error so the card can still surface the failure", () => {
  const step = toolUseEventToStepDto({
    toolCallId: "e10", toolName: "Write", kind: "edit", status: "error",
    rawInput: { file_path: "empty.txt", content: "" },
    rawOutput: { error: "disk full" },
  });
  expect(step.title).toBe("empty.txt");
  expect(step.error).toContain("disk full");
  expect(step.detail).toBeUndefined();
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

test("execute reads Codex terminal result (formatted_output + exit_code)", () => {
  // Codex runs the command in a terminal: content is a bare terminal block with no
  // text, and the result lands in rawOutput.formatted_output / exit_code (snake_case).
  const step = toolUseEventToStepDto({
    toolCallId: "tc1", toolName: "shell", kind: "execute", status: "success",
    summary: "git status --short",
    content: [{ type: "terminal", terminalId: "tc1" }],
    rawInput: { command: "git status --short", cwd: "/repo" },
    rawOutput: { formatted_output: " M src/a.ts\n?? b.ts", exit_code: 0 },
  });
  expect(step.title).toBe("git status --short");
  expect(step.detail).toEqual({ type: "command", command: "git status --short", output: " M src/a.ts\n?? b.ts", exitCode: 0 });
});

test("search shows Codex terminal output even with empty rawInput", () => {
  // Codex search frames carry no rawInput/content; the query is only in the title,
  // and the matches arrive in rawOutput.formatted_output.
  const step = toolUseEventToStepDto({
    toolCallId: "tc2", toolName: "shell", kind: "search", status: "success",
    summary: "Search for 'session' in relay-web",
    rawOutput: { formatted_output: "a.ts:1:session\nb.ts:9:session", exit_code: 0 },
  });
  expect(step.detail).toEqual({ type: "search", query: "Search for 'session' in relay-web", output: "a.ts:1:session\nb.ts:9:session" });
});

test("read (list) shows Codex terminal output as the preview", () => {
  const step = toolUseEventToStepDto({
    toolCallId: "tc3", toolName: "shell", kind: "read", status: "success",
    summary: "List files in 'relay-web'",
    rawOutput: { formatted_output: "src/main.ts\nsrc/App.vue", exit_code: 0 },
  });
  expect(step.detail).toMatchObject({ type: "read", path: "List files in 'relay-web'", preview: "src/main.ts\nsrc/App.vue" });
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

test("read stamps titleIsPath when the title is the resolved path", () => {
  const step = toolUseEventToStepDto({
    toolCallId: "t3p", toolName: "Read", kind: "read", status: "success",
    rawInput: { file_path: "src/a.ts" },
    content: { type: "text", text: "file contents" },
  });
  expect(step.titleIsPath).toBe(true);
});

test("read withholds titleIsPath for a prose summary echoing the path", () => {
  // The Codex list call has no file input: the summary lands in both title
  // and detail.path, but it is prose — the web must keep tail ellipsis.
  const step = toolUseEventToStepDto({
    toolCallId: "tc3p", toolName: "shell", kind: "read", status: "success",
    summary: "List files in 'relay-web'",
    rawOutput: { formatted_output: "src/main.ts\nsrc/App.vue", exit_code: 0 },
  });
  expect(step.title).toBe("List files in 'relay-web'");
  expect(step.titleIsPath).toBeUndefined();
});

test("execute keeps a divergent progress summary while the detail carries the real command", () => {
  const step = toolUseEventToStepDto({
    toolCallId: "t-exec-div", toolName: "bash", kind: "execute", status: "success",
    summary: "Running: ls packages/relay-web/src --with --many --flags --that --overflows",
    rawInput: { command: "ls packages/relay-web/src" },
    rawOutput: { stdout: "a.ts" },
  });
  expect(step.title).toBe("Running: ls packages/relay-web/src --with --many --flags --that --overflows");
  expect(step.detail).toMatchObject({ type: "command", command: "ls packages/relay-web/src" });
});

test("search shows the parsed_cmd query in the header without a drawer until output lands", () => {
  const step = toolUseEventToStepDto({
    toolCallId: "t4", toolName: "Search", kind: "search", status: "success",
    rawInput: { parsed_cmd: [{ type: "search", cmd: "rg -n session src", name: "src" }] },
  });
  expect(step.title).toBe("rg -n session src");
  expect(step.detail).toBeUndefined();
});

test("Cursor Glob shows its pattern and target directory in the header without a drawer", () => {
  const step = toolUseEventToStepDto({
    toolCallId: "glob-1", toolName: "Glob", kind: "search", status: "running",
    rawInput: { glob_pattern: "**/*.vue", target_directory: "packages/relay-web" },
  });
  expect(step.title).toBe("**/*.vue in packages/relay-web");
  expect(step.detail).toBeUndefined();
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
  const detail = step.detail;
  if (detail === undefined || detail.type !== "command") throw new Error("expected a command detail");
  const out = detail.output ?? "";
  expect(out.length).toBeLessThan(9000);
  // Tail cap: the newest content (a test's failure summary, an error stack) is what
  // the user reads, so the marker leads and the head is dropped.
  expect(out.startsWith("(truncated)…")).toBe(true);
  expect(out.endsWith("x".repeat(100))).toBe(true);
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

test("Cursor SwitchMode shows its target mode and explanation", () => {
  const step = toolUseEventToStepDto({
    toolCallId: "mode-1", toolName: "SwitchMode", kind: "think", status: "success",
    rawInput: { target_mode_id: "plan", explanation: "Inspect the UI before editing" },
  });
  expect(step.detail).toEqual({ type: "text", text: "plan: Inspect the UI before editing" });
});

test("Cursor read shows the file body it returns as rawOutput.content", () => {
  const step = toolUseEventToStepDto({
    toolCallId: "r-cursor", toolName: "Read File", kind: "read", status: "success",
    rawInput: {},
    rawOutput: { content: "127.0.0.1\tlocalhost\n" },
  });
  expect(step.detail).toMatchObject({ type: "read", preview: "127.0.0.1\tlocalhost\n" });
});

test("Cursor search summarizes count-only results instead of rendering nothing", () => {
  const grep = toolUseEventToStepDto({
    toolCallId: "s1", toolName: "grep", kind: "search", status: "success",
    rawInput: {}, rawOutput: { totalMatches: 4, truncated: false },
  });
  expect(grep.detail).toMatchObject({ type: "search", output: "4 matches" });

  const find = toolUseEventToStepDto({
    toolCallId: "s2", toolName: "Find", kind: "search", status: "success",
    rawInput: {}, rawOutput: { totalFiles: 3087, truncated: true },
  });
  expect(find.detail).toMatchObject({ type: "search", output: "3087 files · truncated" });
});

test("drops the adapter's internal _toolName marker from rendered fields", () => {
  const step = toolUseEventToStepDto({
    toolCallId: "m1", toolName: "MCP: tool", kind: "other", status: "success",
    rawInput: { _toolName: "mcp_do_thing", scope: "repo" },
  });
  expect(step.detail).toEqual({ type: "fields", fields: [{ label: "scope", value: "repo" }] });
});

test("omits the detail entirely when the adapter sent nothing to show", () => {
  const think = toolUseEventToStepDto({
    toolCallId: "todo-1", toolName: "Update TODOs", kind: "think", status: "success",
    rawInput: { _toolName: "updateTodos" },
  });
  expect(think.detail).toBeUndefined();
  expect(think.title).toBe("Update TODOs");

  const other = toolUseEventToStepDto({
    toolCallId: "o1", toolName: "MCP: tool", kind: "other", status: "success",
    rawInput: { _toolName: "mcp_thing" },
  });
  expect(other.detail).toBeUndefined();

  const edit = toolUseEventToStepDto({
    toolCallId: "e1", toolName: "Edit", kind: "edit", status: "success",
    rawInput: { _toolName: "edit" },
  });
  expect(edit.detail).toBeUndefined();
  expect(edit.title).toBe("Edit");

  // The header already shows path/command/query: a detail with nothing below
  // it would echo the same line in the drawer.
  const read = toolUseEventToStepDto({
    toolCallId: "r0", toolName: "Read", kind: "read", status: "success",
    rawInput: { file_path: "src/a.ts" },
  });
  expect(read.title).toBe("src/a.ts");
  expect(read.detail).toBeUndefined();

  const execute = toolUseEventToStepDto({
    toolCallId: "x0", toolName: "Bash", kind: "execute", status: "success",
    rawInput: { command: "git status --short" },
  });
  expect(execute.title).toBe("git status --short");
  expect(execute.detail).toBeUndefined();

  const search = toolUseEventToStepDto({
    toolCallId: "s0", toolName: "Search", kind: "search", status: "success",
    rawInput: { query: "session" },
  });
  expect(search.title).toBe("session");
  expect(search.detail).toBeUndefined();
});

test("preserves subagent ownership metadata for Relay Web grouping", () => {
  const parent = toolUseEventToStepDto({
    toolCallId: "agent-1", toolName: "Task", kind: "think", status: "running",
    isSubagent: true, rawInput: { description: "Inspect notifications" },
  });
  const child = toolUseEventToStepDto({
    toolCallId: "grep-1", parentToolCallId: "agent-1", toolName: "Grep", kind: "search", status: "success",
    rawInput: { pattern: "wechat" },
  });
  expect(parent).toMatchObject({ toolCallId: "agent-1", isSubagent: true });
  expect(child).toMatchObject({ toolCallId: "grep-1", parentToolCallId: "agent-1" });
});

test("subagent step carries the delegated prompt and streamed output (Qoder shape)", () => {
  const step = toolUseEventToStepDto({
    toolCallId: "agent-q", toolName: "Agent", kind: "think", status: "running",
    isSubagent: true,
    rawInput: { prompt: "Investigate the notification flow", subagent_type: "Explore" },
    content: [{ type: "content", content: { type: "text", text: "Found 3 handlers in notify.ts" } }],
  });
  expect(step.detail).toEqual({ type: "text", text: "Investigate the notification flow", output: "Found 3 handlers in notify.ts" });
});

test("subagent output falls back to rawOutput.text (Kimi shape)", () => {
  const step = toolUseEventToStepDto({
    toolCallId: "agent-k", toolName: "Task", kind: "think", status: "success",
    isSubagent: true,
    rawInput: { prompt: "Summarize the diff", subagent_type: "general-purpose" },
    rawOutput: { text: "The diff renames two symbols." },
  });
  expect(step.detail).toEqual({ type: "text", text: "Summarize the diff", output: "The diff renames two symbols." });
});

test("subagent output falls back to Codex terminal formatted_output", () => {
  const step = toolUseEventToStepDto({
    toolCallId: "agent-c", toolName: "Agent", kind: "think", status: "success",
    isSubagent: true, summary: "Delegate: audit deps",
    rawOutput: { formatted_output: "no vulnerable packages", exit_code: 0 },
  });
  expect(step.detail).toEqual({ type: "text", text: "Delegate: audit deps", output: "no vulnerable packages" });
});

test("subagent step omits output when the adapter reports none", () => {
  const step = toolUseEventToStepDto({
    toolCallId: "agent-p", toolName: "Task", kind: "think", status: "running",
    isSubagent: true, rawInput: { prompt: "Kick off a long task" },
  });
  expect(step.detail).toEqual({ type: "text", text: "Kick off a long task" });
});

test("subagent prompt and output are capped at TEXT_CAP", () => {
  const step = toolUseEventToStepDto({
    toolCallId: "agent-big", toolName: "Agent", kind: "think", status: "running",
    isSubagent: true,
    rawInput: { prompt: "p".repeat(9000) },
    rawOutput: { stdout: "o".repeat(8500) + "TAIL-MARKER" },
  });
  const d = step.detail as { type: "text"; text: string; output?: string };
  expect(d.type).toBe("text");
  expect(d.text.length).toBeLessThanOrEqual(8100);
  expect(d.text.endsWith("…(truncated)")).toBe(true);
  // Output is tail-truncated (not head-truncated): the newest streamed content keeps
  // changing after the cap is hit, so the web card's tail line/heartbeat stay alive.
  expect(d.output?.length).toBeLessThanOrEqual(8100);
  expect(d.output?.startsWith("(truncated)…\n")).toBe(true);
  expect(d.output?.endsWith("TAIL-MARKER")).toBe(true);
});

test("subagent detail keeps the output even when a child-tool trace exists", () => {
  // Claude emits parent-linked child events alongside the parent's own streamed output;
  // the parent step must still carry `output` so the dialog can show the result report
  // next to the timeline.
  const parent = toolUseEventToStepDto({
    toolCallId: "agent-t", toolName: "Task", kind: "think", status: "success",
    isSubagent: true,
    rawInput: { prompt: "Audit the deps" },
    content: [{ type: "content", content: { type: "text", text: "All dependencies are clean." } }],
  });
  const child = toolUseEventToStepDto({
    toolCallId: "grep-t", parentToolCallId: "agent-t", toolName: "Grep", kind: "search", status: "success",
    rawInput: { pattern: "lodash" },
  });
  expect(parent.detail).toEqual({ type: "text", text: "Audit the deps", output: "All dependencies are clean." });
  expect(child).toMatchObject({ parentToolCallId: "agent-t" });
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

// --- agent_send receipt correlation (Agent Messaging v0.3) ---

const MSG_ID = "msg_3f2a9c1e-7b4d-4e5f-8a6b-2c1d0e9f8a7b";

function agentSendEvent(overrides: Partial<ToolUseEvent> = {}): ToolUseEvent {
  return {
    toolCallId: "as1",
    toolName: "agent_send",
    kind: "other",
    status: "success",
    rawInput: { to: "agent:node_1:endpoint_peer", message: "ping" },
    ...overrides,
  };
}

test("agent_send extracts the receipt messageId from MCP structuredContent", () => {
  const step = toolUseEventToStepDto(agentSendEvent({
    rawOutput: { structuredContent: { messageId: MSG_ID, status: "queued", modeUsed: "queue", route: "local" } },
  }));
  expect(step.agentMessageId).toBe(MSG_ID);
});

test("agent_send extracts the messageId when rawOutput IS the receipt", () => {
  const step = toolUseEventToStepDto(agentSendEvent({
    rawOutput: { messageId: MSG_ID, status: "injected", modeUsed: "queue", route: "local" },
  }));
  expect(step.agentMessageId).toBe(MSG_ID);
});

test("agent_send extracts the messageId from an MCP JSON-RPC result envelope", () => {
  const viaStructured = toolUseEventToStepDto(agentSendEvent({
    rawOutput: { result: { structuredContent: { messageId: MSG_ID, status: "queued", route: "relay" } } },
  }));
  expect(viaStructured.agentMessageId).toBe(MSG_ID);
  const viaTopLevel = toolUseEventToStepDto(agentSendEvent({
    rawOutput: { result: { messageId: MSG_ID, status: "failed", errorCode: "TARGET_NOT_FOUND" } },
  }));
  expect(viaTopLevel.agentMessageId).toBe(MSG_ID);
});

test("agent_send parses a single JSON receipt text block", () => {
  const step = toolUseEventToStepDto(agentSendEvent({
    content: [{ type: "text", text: JSON.stringify({ messageId: MSG_ID, status: "queued", route: "local" }) }],
  }));
  expect(step.agentMessageId).toBe(MSG_ID);
});

test("agent_send never parses the display line for a messageId", () => {
  const display = `Peer message msg_${"0".repeat(32)} accepted with status=queued`;
  const viaRawOutput = toolUseEventToStepDto(agentSendEvent({ rawOutput: display }));
  expect(viaRawOutput.agentMessageId).toBeUndefined();
  const viaContentBlock = toolUseEventToStepDto(agentSendEvent({
    content: [{ type: "text", text: display }],
  }));
  expect(viaContentBlock.agentMessageId).toBeUndefined();
});

test("malformed receipts are ignored (bad id, missing or unknown status)", () => {
  // v0.3: ids are opaque — msg_cli_1-style short ids and msg_message-1 are
  // legal. Genuinely malformed ids (wrong prefix, unsafe charset, oversize)
  // are still rejected.
  const badPrefix = toolUseEventToStepDto(agentSendEvent({
    rawOutput: { structuredContent: { messageId: "id_123", status: "queued" } },
  }));
  expect(badPrefix.agentMessageId).toBeUndefined();
  const badCharset = toolUseEventToStepDto(agentSendEvent({
    rawOutput: { structuredContent: { messageId: "msg_bad id!", status: "queued" } },
  }));
  expect(badCharset.agentMessageId).toBeUndefined();
  const oversize = toolUseEventToStepDto(agentSendEvent({
    rawOutput: { structuredContent: { messageId: `msg_${"a".repeat(125)}`, status: "queued" } },
  }));
  expect(oversize.agentMessageId).toBeUndefined();
  const shortOpaqueStillValid = toolUseEventToStepDto(agentSendEvent({
    rawOutput: { structuredContent: { messageId: "msg_cli_1", status: "queued" } },
  }));
  expect(shortOpaqueStillValid.agentMessageId).toBe("msg_cli_1");
  const badId = toolUseEventToStepDto(agentSendEvent({
    rawOutput: { structuredContent: { messageId: "msg_123", status: "queued" } },
  }));
  expect(badId.agentMessageId).toBe("msg_123");
  const missingStatus = toolUseEventToStepDto(agentSendEvent({
    rawOutput: { structuredContent: { messageId: MSG_ID } },
  }));
  expect(missingStatus.agentMessageId).toBeUndefined();
  const unknownStatus = toolUseEventToStepDto(agentSendEvent({
    rawOutput: { messageId: MSG_ID, status: "weird" },
  }));
  expect(unknownStatus.agentMessageId).toBeUndefined();
  const nonStringId = toolUseEventToStepDto(agentSendEvent({
    rawOutput: { messageId: 42, status: "queued" },
  }));
  expect(nonStringId.agentMessageId).toBeUndefined();
});

test("other tools never carry agentMessageId even with receipt-shaped output", () => {
  const step = toolUseEventToStepDto({
    toolCallId: "x1", toolName: "Bash", kind: "execute", status: "success",
    rawInput: { command: "ls" },
    rawOutput: { structuredContent: { messageId: MSG_ID, status: "queued", route: "local" } },
  });
  expect(step.agentMessageId).toBeUndefined();
});

test("MCP-qualified mcp__xacpx__agent_send is recognized", () => {
  const step = toolUseEventToStepDto(agentSendEvent({
    toolName: "mcp__xacpx__agent_send",
    rawOutput: { structuredContent: { messageId: MSG_ID, status: "queued", route: "local" } },
  }));
  expect(step.agentMessageId).toBe(MSG_ID);
});

test("agentMessageId survives every detail-variant path via the base spread", () => {
  const variants: Array<Partial<ToolUseEvent>> = [
    { kind: "other", rawInput: { to: "peer", message: "hi" } },
    { kind: "edit", rawInput: { file_path: "src/a.ts", old_string: "a", new_string: "b" } },
    { kind: "read", rawInput: { file_path: "src/a.ts" }, rawOutput: { stdout: "body" } },
    { kind: "execute", rawInput: { command: "ls" } },
    { kind: "search", rawInput: { query: "foo" }, rawOutput: { stdout: "a.ts:1" } },
    { kind: "think", rawInput: { explanation: "hmm" } },
  ];
  for (const variant of variants) {
    const step = toolUseEventToStepDto(agentSendEvent({
      ...variant,
      rawOutput: { structuredContent: { messageId: MSG_ID, status: "queued", route: "local" } },
    }));
    expect(step.agentMessageId).toBe(MSG_ID);
  }
});

test("delete drops the title path from detail fields", () => {
  const step = toolUseEventToStepDto({
    toolCallId: "d1", toolName: "Delete", kind: "delete", status: "success",
    rawInput: { file_path: "temp/cache.json", recursive: true },
  });
  expect(step.title).toBe("temp/cache.json");
  expect(step.kind).toBe("delete");
  expect(step.detail).toMatchObject({
    type: "fields",
    fields: [
      { label: "recursive", value: "true" },
    ],
  });
});

test("move omits the detail when only title paths were sent", () => {
  const step = toolUseEventToStepDto({
    toolCallId: "m1", toolName: "Move", kind: "move", status: "success",
    rawInput: { source: "src/old.ts", destination: "src/new.ts" },
  });
  expect(step.title).toBe("src/old.ts → src/new.ts");
  expect(step.kind).toBe("move");
  expect(step.detail).toBeUndefined();
});

test("move keeps non-title fields alongside the output", () => {
  const step = toolUseEventToStepDto({
    toolCallId: "m2", toolName: "Move", kind: "move", status: "success",
    rawInput: { source: "src/old.ts", destination: "src/new.ts", overwrite: true },
  });
  expect(step.detail).toMatchObject({
    type: "fields",
    fields: [
      { label: "overwrite", value: "true" },
    ],
  });
});

test("fetch drops the title url from detail fields", () => {
  const step = toolUseEventToStepDto({
    toolCallId: "f1", toolName: "Fetch", kind: "fetch", status: "success",
    rawInput: { url: "https://api.example.com/v1/health" },
    rawOutput: { stdout: '{"status":"ok"}' },
  });
  expect(step.title).toBe("https://api.example.com/v1/health");
  expect(step.kind).toBe("fetch");
  expect(step.detail).toMatchObject({
    type: "fields",
    fields: [],
    output: '{"status":"ok"}',
  });
});

test("fetch keeps a conflicting alias the title did not consume", () => {
  const step = toolUseEventToStepDto({
    toolCallId: "f2", toolName: "Fetch", kind: "fetch", status: "success",
    rawInput: { url: "https://api.example.com/v1/health", uri: "https://cdn.example.com/v1/health" },
    rawOutput: { stdout: "ok" },
  });
  expect(step.title).toBe("https://api.example.com/v1/health");
  expect(step.detail).toMatchObject({
    type: "fields",
    fields: [{ label: "uri", value: "https://cdn.example.com/v1/health" }],
  });
});

test("move keeps a conflicting alias the title did not consume", () => {
  const step = toolUseEventToStepDto({
    toolCallId: "m3", toolName: "Move", kind: "move", status: "success",
    rawInput: { source: "src/old.ts", src: "legacy/old.ts", destination: "src/new.ts" },
  });
  expect(step.title).toBe("src/old.ts → src/new.ts");
  expect(step.detail).toMatchObject({
    type: "fields",
    fields: [{ label: "src", value: "legacy/old.ts" }],
  });
});

test("delete keeps a conflicting alias the title did not consume", () => {
  const step = toolUseEventToStepDto({
    toolCallId: "d2", toolName: "Delete", kind: "delete", status: "success",
    rawInput: { file_path: "temp/cache.json", path: "other/cache.json" },
  });
  expect(step.title).toBe("temp/cache.json");
  expect(step.detail).toMatchObject({
    type: "fields",
    fields: [{ label: "path", value: "other/cache.json" }],
  });
});

test("end-to-end: runtime sparse Read sequence results in rich Read step DTO", () => {
  const { normalizeRuntimeToolCallEvent } = require("../../../../src/bridge/engine/runtime/runtime-tool-call-merge");
  const { mapRuntimeToolEvent } = require("../../../../src/bridge/engine/runtime-engine");

  const toolCalls = new Map();
  normalizeRuntimeToolCallEvent(toolCalls, {
    type: "tool_call",
    toolCallId: "read-1",
    title: "Read",
    kind: "read",
    rawInput: { path: "/tmp/a.ts" },
    text: "reading",
  });

  const terminalSnapshot = normalizeRuntimeToolCallEvent(toolCalls, {
    type: "tool_call",
    tag: "tool_call_update",
    toolCallId: "read-1",
    title: "tool call",
    status: "completed",
    text: "tool call (completed)",
  });

  const toolEvent = mapRuntimeToolEvent(terminalSnapshot);
  const step = toolUseEventToStepDto(toolEvent);

  expect(step.title).toBe("/tmp/a.ts");
  expect(step.status).toBe("success");
  expect(step.kind).toBe("read");
  // A running read carries only its path until the terminal frame lands —
  // the header owns it, so there is no detail drawer to echo it.
  expect(step.detail).toBeUndefined();
});
test("end-to-end: runtime sparse Execute sequence results in rich Command step DTO", () => {
  const { normalizeRuntimeToolCallEvent } = require("../../../../src/bridge/engine/runtime/runtime-tool-call-merge");
  const { mapRuntimeToolEvent } = require("../../../../src/bridge/engine/runtime-engine");

  const toolCalls = new Map();
  normalizeRuntimeToolCallEvent(toolCalls, {
    type: "tool_call",
    toolCallId: "bash-1",
    title: "Bash",
    kind: "execute",
    rawInput: { command: "bun test" },
    text: "running",
  });

  const terminalSnapshot = normalizeRuntimeToolCallEvent(toolCalls, {
    type: "tool_call",
    tag: "tool_call_update",
    toolCallId: "bash-1",
    title: "tool call",
    status: "completed",
    rawOutput: { formatted_output: "42 pass", exit_code: 0 },
    text: "tool call (completed)",
  });

  const toolEvent = mapRuntimeToolEvent(terminalSnapshot);
  const step = toolUseEventToStepDto(toolEvent);

  expect(step.title).toBe("bun test");
  expect(step.status).toBe("success");
  expect(step.kind).toBe("execute");
  expect(step.detail).toMatchObject({
    type: "command",
    command: "bun test",
    output: "42 pass",
    exitCode: 0,
  });
});

test("a degraded adapter title falls back to the specific argument", () => {
  // OpenCode's terminal grep frame replaces the title with the bare regex.
  const step = toolUseEventToStepDto({
    toolCallId: "t-search", toolName: "grep", kind: "search", status: "success",
    summary: "display_name|displayName",
    rawInput: { pattern: "display_name|displayName", path: "packages/relay-web/src" },
  });
  // The bare regex is noise; the derived query names the pattern AND its scope.
  expect(step.title).toBe("display_name|displayName in packages/relay-web/src");
  // No output text and no driver metadata: the detail would only echo the header,
  // so the connector drops it entirely rather than repeating the query.
  expect(step.detail).toBeUndefined();
});

test("a search with driver metadata keeps its detail even without output text", () => {
  const step = toolUseEventToStepDto({
    toolCallId: "t-meta-only", toolName: "grep", kind: "search", status: "success",
    summary: "display_name|displayName",
    rawInput: { pattern: "display_name|displayName", path: "packages/relay-web/src" },
    rawOutput: { metadata: { matches: 100, truncated: true } },
  });
  expect(step.detail).toMatchObject({ type: "search", count: 100, truncated: true });
});

test("a progress-describing adapter title is kept (it is not degraded)", () => {
  const step = toolUseEventToStepDto({
    toolCallId: "t-exec", toolName: "bash", kind: "execute", status: "running",
    summary: "Running: ls packages/relay-web/src",
    rawInput: { command: "ls packages/relay-web/src" },
  });
  expect(step.title).toBe("Running: ls packages/relay-web/src");
});

test("a search carries the driver's machine count and truncation flag", () => {
  const step = toolUseEventToStepDto({
    toolCallId: "t-meta", toolName: "grep", kind: "search", status: "success",
    summary: "rg foo",
    rawInput: { pattern: "foo", path: "src" },
    rawOutput: { output: "a.ts:1", metadata: { matches: 100, truncated: true } },
  });
  expect(step.detail).toMatchObject({ type: "search", count: 100, truncated: true });
});

test("a terminal-routed step exposes its terminal id", () => {
  const step = toolUseEventToStepDto({
    toolCallId: "t-term", toolName: "bash", kind: "execute", status: "error",
    summary: "cargo build",
    rawInput: { command: "cargo build" },
    content: [{ type: "terminal", terminalId: "77f1f365" }],
  });
  expect(step.terminalId).toBe("77f1f365");
});

test("a running step carries the first-seen stamp", () => {
  const startedAt = Date.parse("2026-09-20T00:00:00Z");
  const step = toolUseEventToStepDto({
    toolCallId: "t-run", toolName: "bash", kind: "execute", status: "running",
    summary: "sleep 30", rawInput: { command: "sleep 30" }, startedAt,
  });
  expect(step.startedAt).toBe(startedAt);
  expect(step.durationMs).toBeUndefined();
});
