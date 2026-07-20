import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  followClaudeBackgroundTurn,
  isClaudeAsyncAgentLaunch,
} from "../../../src/transport/claude-background-followup";
import type { ToolUseEvent } from "../../../src/channels/types";

const TASK_A = "toolu_agent_a";
const TASK_B = "toolu_agent_b";

test("detects Claude's async Agent launch result", () => {
  const event: ToolUseEvent = {
    toolCallId: TASK_A,
    toolName: "Fetch docs",
    kind: "think",
    rawOutput: [{ type: "text", text: "Async agent launched successfully. agentId: abc" }],
    status: "success",
  };
  expect(isClaudeAsyncAgentLaunch(event)).toBe(true);
});

test("recovers already-written background continuation after the ACP end_turn boundary", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xacpx-claude-followup-"));
  const transcript = join(dir, "session.jsonl");
  const records = [
    user("original request"),
    assistant([
      { type: "tool_use", id: TASK_A, name: "Agent", input: { description: "docs" } },
      { type: "tool_use", id: TASK_B, name: "Agent", input: { description: "code" } },
    ], "tool_use"),
    assistant([{ type: "text", text: "两个任务在后台运行。" }], "end_turn"),
    user(`<task-notification><tool-use-id>${TASK_A}</tool-use-id></task-notification>`),
    assistant([{ type: "text", text: "文档任务完成，继续等待。" }], "end_turn"),
    user(`<task-notification><tool-use-id>${TASK_B}</tool-use-id></task-notification>`),
    assistant([{ type: "tool_use", id: "read-1", name: "Read", input: { file_path: "src/a.ts" } }], "tool_use"),
    user([{ type: "tool_result", tool_use_id: "read-1", content: "source", is_error: false }]),
    assistant([{ type: "text", text: "这是最终迁移方案。" }], "end_turn"),
  ];
  await writeFile(transcript, records.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");

  const texts: string[] = [];
  const tools: ToolUseEvent[] = [];
  const result = await followClaudeBackgroundTurn({
    cwd: "E:\\projects\\demo",
    sessionId: "session",
    launchedToolCallIds: [TASK_A, TASK_B],
    transcriptPath: transcript,
    pollIntervalMs: 1,
    timeoutMs: 100,
    onText: (text) => { texts.push(text); },
    onToolEvent: (event) => { tools.push(event); },
  });

  expect(result.status).toBe("completed");
  expect(result.completedToolCallIds.sort()).toEqual([TASK_A, TASK_B].sort());
  expect(texts).toEqual(["文档任务完成，继续等待。", "这是最终迁移方案。"]);
  expect(tools.find((event) => event.toolCallId === "read-1" && event.status === "running")).toBeTruthy();
  expect(tools.find((event) => event.toolCallId === "read-1" && event.status === "success")).toBeTruthy();
});

test("an aborted turn stops the background transcript follower", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xacpx-claude-followup-abort-"));
  const transcript = join(dir, "session.jsonl");
  await writeFile(transcript, [
    assistant([{ type: "tool_use", id: TASK_A, name: "Agent", input: {} }], "tool_use"),
    assistant([{ type: "text", text: "后台运行中" }], "end_turn"),
  ].map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
  const controller = new AbortController();
  controller.abort();

  await expect(followClaudeBackgroundTurn({
    cwd: "E:\\projects\\demo",
    sessionId: "session",
    launchedToolCallIds: [TASK_A],
    transcriptPath: transcript,
    signal: controller.signal,
    pollIntervalMs: 1,
    timeoutMs: 100,
  })).rejects.toMatchObject({ name: "AbortError" });
});

function assistant(content: unknown[], stopReason: string) {
  return {
    type: "assistant",
    isSidechain: false,
    message: { role: "assistant", content, stop_reason: stopReason },
  };
}

function user(content: unknown) {
  return {
    type: "user",
    isSidechain: false,
    message: { role: "user", content: typeof content === "string" ? [{ type: "text", text: content }] : content },
  };
}
