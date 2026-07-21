import { expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
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

test("waits for a partially-written ACP end_turn boundary before forwarding continuation text", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xacpx-claude-followup-boundary-"));
  const transcript = join(dir, "session.jsonl");
  const acknowledgement = JSON.stringify(assistant(
    [{ type: "text", text: "already delivered through ACP" }],
    "end_turn",
  ));
  const split = Math.floor(acknowledgement.length / 2);
  await writeFile(transcript, [
    JSON.stringify(assistant(
      [{ type: "tool_use", id: TASK_A, name: "Agent", input: { description: "docs" } }],
      "tool_use",
    )),
    acknowledgement.slice(0, split),
  ].join("\n"), "utf8");

  const texts: string[] = [];
  const following = followClaudeBackgroundTurn({
    cwd: dir,
    sessionId: "session",
    launchedToolCallIds: [TASK_A],
    transcriptPath: transcript,
    pollIntervalMs: 2,
    timeoutMs: 200,
    onText: (text) => { texts.push(text); },
  });

  // Let the follower capture the initial offset while the boundary record is partial.
  await new Promise((resolve) => setTimeout(resolve, 10));
  await appendFile(transcript, acknowledgement.slice(split) + "\n", "utf8");
  await appendFile(transcript, JSON.stringify(user(
    `<task-notification><tool-use-id>${TASK_A}</tool-use-id></task-notification>`,
  )) + "\n", "utf8");
  await appendFile(transcript, JSON.stringify(assistant(
    [{ type: "text", text: "actual recovered final" }],
    "end_turn",
  )) + "\n", "utf8");

  expect((await following).status).toBe("completed");
  expect(texts).toEqual(["actual recovered final"]);
});

test("reports a failed background Agent from its task notification", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xacpx-claude-followup-failed-"));
  const transcript = join(dir, "session.jsonl");
  await writeFile(transcript, [
    assistant([{ type: "tool_use", id: TASK_A, name: "Agent", input: {} }], "tool_use"),
    assistant([{ type: "text", text: "后台运行中" }], "end_turn"),
    user(`<task-notification><tool-use-id>${TASK_A}</tool-use-id><status>failed</status></task-notification>`),
    assistant([{ type: "text", text: "任务失败，已说明原因。" }], "end_turn"),
  ].map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");

  const result = await followClaudeBackgroundTurn({
    cwd: dir,
    sessionId: "session",
    launchedToolCallIds: [TASK_A],
    transcriptPath: transcript,
    pollIntervalMs: 1,
    timeoutMs: 100,
  });

  expect(result.status).toBe("completed");
  expect(result.failedToolCallIds).toEqual([TASK_A]);
});

test("recovers tool activity from the completed background subagent transcript", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xacpx-claude-followup-trace-"));
  const transcript = join(dir, "session.jsonl");
  const subagentsDir = join(dir, "session", "subagents");
  await mkdir(subagentsDir, { recursive: true });
  await writeFile(transcript, [
    assistant([{ type: "tool_use", id: TASK_A, name: "Agent", input: {} }], "tool_use"),
    assistant([{ type: "text", text: "后台运行中" }], "end_turn"),
    user(`<task-notification><tool-use-id>${TASK_A}</tool-use-id><status>completed</status></task-notification>`),
    assistant([{ type: "text", text: "最终答案" }], "end_turn"),
  ].map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
  await writeFile(join(subagentsDir, "agent-agent-a.jsonl"), [
    assistant([{ type: "tool_use", id: "grep-1", name: "Grep", input: { pattern: "wechat" } }], "tool_use"),
    user([{ type: "tool_result", tool_use_id: "grep-1", content: "src/a.ts", is_error: false }]),
  ].map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");

  const tools: ToolUseEvent[] = [];
  await followClaudeBackgroundTurn({
    cwd: dir,
    sessionId: "session",
    launchedToolCallIds: [TASK_A],
    subagentIdsByToolCallId: [[TASK_A, "agent-a"]],
    transcriptPath: transcript,
    pollIntervalMs: 1,
    timeoutMs: 100,
    onToolEvent: (event) => { tools.push(event); },
  });

  expect(tools).toContainEqual(expect.objectContaining({
    toolCallId: "grep-1",
    parentToolCallId: TASK_A,
    status: "running",
  }));
  expect(tools).toContainEqual(expect.objectContaining({
    toolCallId: "grep-1",
    parentToolCallId: TASK_A,
    status: "success",
  }));
});

test("subagent transcript replay preserves richer terminal ACP tool events", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xacpx-claude-followup-rich-trace-"));
  const transcript = join(dir, "session.jsonl");
  const subagentsDir = join(dir, "session", "subagents");
  await mkdir(subagentsDir, { recursive: true });
  await writeFile(transcript, [
    assistant([{ type: "tool_use", id: TASK_A, name: "Agent", input: {} }], "tool_use"),
    assistant([{ type: "text", text: "后台运行中" }], "end_turn"),
    user(`<task-notification><tool-use-id>${TASK_A}</tool-use-id><status>completed</status></task-notification>`),
    assistant([{ type: "text", text: "最终答案" }], "end_turn"),
  ].map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
  await writeFile(join(subagentsDir, "agent-agent-a.jsonl"), [
    assistant([{ type: "tool_use", id: "edit-1", name: "Edit", input: { file_path: "src/a.ts" } }], "tool_use"),
    user([{ type: "tool_result", tool_use_id: "edit-1", content: "updated", is_error: false }]),
  ].map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");

  const richEvent: ToolUseEvent = {
    toolCallId: "edit-1",
    parentToolCallId: TASK_A,
    toolName: "Edit",
    kind: "edit",
    rawInput: { file_path: "src/a.ts", old_string: "a", new_string: "b" },
    content: { type: "diff", oldText: "a", newText: "b" },
    locations: [{ path: "src/a.ts", line: 1 }],
    rawOutput: "updated",
    status: "success",
    durationMs: 12,
  };
  const tools: ToolUseEvent[] = [];
  await followClaudeBackgroundTurn({
    cwd: dir,
    sessionId: "session",
    launchedToolCallIds: [TASK_A],
    initialToolEvents: [richEvent],
    subagentIdsByToolCallId: [[TASK_A, "agent-a"]],
    transcriptPath: transcript,
    pollIntervalMs: 1,
    timeoutMs: 100,
    onToolEvent: (event) => { tools.push(event); },
  });

  const replayed = tools.filter((event) => event.toolCallId === "edit-1");
  expect(replayed.length).toBeGreaterThan(0);
  expect(replayed.every((event) => event.status === "success")).toBe(true);
  expect(replayed.at(-1)).toEqual(expect.objectContaining({
    content: richEvent.content,
    locations: richEvent.locations,
    durationMs: 12,
  }));
});

test("streams subagent tool activity written after the ACP request closes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xacpx-claude-followup-live-trace-"));
  const transcript = join(dir, "session.jsonl");
  const subagentsDir = join(dir, "session", "subagents");
  await mkdir(subagentsDir, { recursive: true });
  await writeFile(transcript, [
    assistant([{ type: "tool_use", id: TASK_A, name: "Agent", input: {} }], "tool_use"),
    assistant([{ type: "text", text: "后台运行中" }], "end_turn"),
  ].map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");

  const tools: ToolUseEvent[] = [];
  const following = followClaudeBackgroundTurn({
    cwd: dir,
    sessionId: "session",
    launchedToolCallIds: [TASK_A],
    subagentIdsByToolCallId: [[TASK_A, "agent-a"]],
    transcriptPath: transcript,
    pollIntervalMs: 2,
    timeoutMs: 200,
    onToolEvent: (event) => { tools.push(event); },
  });

  await new Promise((resolve) => setTimeout(resolve, 10));
  await writeFile(join(subagentsDir, "agent-agent-a.jsonl"), [
    assistant([{ type: "tool_use", id: "read-live", name: "Read", input: { file_path: "src/a.ts" } }], "tool_use"),
    user([{ type: "tool_result", tool_use_id: "read-live", content: "source", is_error: false }]),
  ].map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
  await appendFile(transcript, JSON.stringify(user(
    `<task-notification><tool-use-id>${TASK_A}</tool-use-id><status>completed</status></task-notification>`,
  )) + "\n", "utf8");
  await appendFile(transcript, JSON.stringify(assistant(
    [{ type: "text", text: "最终答案" }],
    "end_turn",
  )) + "\n", "utf8");

  expect((await following).status).toBe("completed");
  expect(tools).toContainEqual(expect.objectContaining({
    toolCallId: "read-live",
    parentToolCallId: TASK_A,
    status: "success",
  }));
});

test("drains a subagent transcript that appears after the main turn becomes complete", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xacpx-claude-followup-final-drain-"));
  const transcript = join(dir, "session.jsonl");
  const subagentsDir = join(dir, "session", "subagents");
  await mkdir(subagentsDir, { recursive: true });
  await writeFile(transcript, [
    assistant([{ type: "tool_use", id: TASK_A, name: "Agent", input: {} }], "tool_use"),
    assistant([{ type: "text", text: "后台运行中" }], "end_turn"),
    user(`<task-notification><tool-use-id>${TASK_A}</tool-use-id><status>completed</status></task-notification>`),
    assistant([{ type: "text", text: "最终答案" }], "end_turn"),
  ].map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");

  const tools: ToolUseEvent[] = [];
  const result = await followClaudeBackgroundTurn({
    cwd: dir,
    sessionId: "session",
    launchedToolCallIds: [TASK_A],
    subagentIdsByToolCallId: [[TASK_A, "agent-a"]],
    transcriptPath: transcript,
    pollIntervalMs: 2,
    timeoutMs: 100,
    onText: async (text) => {
      if (text !== "最终答案") return;
      await writeFile(join(subagentsDir, "agent-agent-a.jsonl"), [
        assistant([{ type: "tool_use", id: "late-read", name: "Read", input: { file_path: "src/late.ts" } }], "tool_use"),
        user([{ type: "tool_result", tool_use_id: "late-read", content: "source", is_error: false }]),
      ].map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
    },
    onToolEvent: (event) => { tools.push(event); },
  });

  expect(result.status).toBe("completed");
  expect(tools).toContainEqual(expect.objectContaining({
    toolCallId: "late-read",
    parentToolCallId: TASK_A,
    status: "success",
  }));
});

test("recovers nested Agent transcripts with their immediate parent tool call", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xacpx-claude-followup-nested-trace-"));
  const transcript = join(dir, "session.jsonl");
  const subagentsDir = join(dir, "session", "subagents");
  const nestedDir = join(subagentsDir, "workflows", "run-1");
  await mkdir(nestedDir, { recursive: true });
  await writeFile(transcript, [
    assistant([{ type: "tool_use", id: TASK_A, name: "Agent", input: {} }], "tool_use"),
    assistant([{ type: "text", text: "后台运行中" }], "end_turn"),
    user(`<task-notification><tool-use-id>${TASK_A}</tool-use-id><status>completed</status></task-notification>`),
    assistant([{ type: "text", text: "最终答案" }], "end_turn"),
  ].map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
  await writeFile(join(subagentsDir, "agent-agent-a.jsonl"), [
    assistant([{ type: "tool_use", id: "nested-agent", name: "Agent", input: { description: "inspect protocol" } }], "tool_use"),
    user([{ type: "tool_result", tool_use_id: "nested-agent", content: { status: "async_launched", agentId: "agent-b" }, is_error: false }]),
  ].map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
  await writeFile(join(nestedDir, "agent-agent-b.jsonl"), [
    assistant([{ type: "tool_use", id: "nested-read", name: "Read", input: { file_path: "src/protocol.ts" } }], "tool_use"),
    user([{ type: "tool_result", tool_use_id: "nested-read", content: "source", is_error: false }]),
  ].map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");

  const tools: ToolUseEvent[] = [];
  await followClaudeBackgroundTurn({
    cwd: dir,
    sessionId: "session",
    launchedToolCallIds: [TASK_A],
    subagentIdsByToolCallId: [[TASK_A, "agent-a"]],
    transcriptPath: transcript,
    pollIntervalMs: 1,
    timeoutMs: 100,
    onToolEvent: (event) => { tools.push(event); },
  });

  expect(tools).toContainEqual(expect.objectContaining({
    toolCallId: "nested-agent",
    parentToolCallId: TASK_A,
    isSubagent: true,
  }));
  expect(tools).toContainEqual(expect.objectContaining({
    toolCallId: "nested-read",
    parentToolCallId: "nested-agent",
    status: "success",
  }));
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
