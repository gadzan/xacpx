import { expect, test } from "bun:test";
import {
  createStreamingPromptState,
  parseStreamingChunks,
} from "../../../src/transport/streaming-prompt";
import type { ToolUseEvent } from "../../../src/channels/types";

test("when onToolEvent is provided, tool_call events do NOT enter state.segments", () => {
  const events: ToolUseEvent[] = [];
  const state = createStreamingPromptState(true, (e) => events.push(e));
  parseStreamingChunks(
    state,
    JSON.stringify({
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "t1",
          kind: "read",
          title: "Read File",
          rawInput: { path: "foo.ts" },
          status: "pending",
        },
      },
    }),
  );
  parseStreamingChunks(
    state,
    JSON.stringify({
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "t1",
          kind: "read",
          title: "Read File",
          rawInput: { path: "foo.ts" },
          status: "completed",
        },
      },
    }),
  );
  expect(state.segments).toEqual([]);
  expect(events).toEqual([
    {
      toolCallId: "t1",
      toolName: "Read File",
      kind: "read",
      summary: "foo.ts",
      rawInput: { path: "foo.ts" },
      status: "running",
    },
    {
      toolCallId: "t1",
      toolName: "Read File",
      kind: "read",
      summary: "foo.ts",
      rawInput: { path: "foo.ts" },
      status: "success",
    },
  ]);
});

test("structured tool events fire even when formatToolCalls is false (non-verbose channels)", () => {
  // The relay web dashboard consumes tool events structurally and renders them in
  // its own UI, so it must receive them regardless of the channel's text replyMode.
  // A channel with replyMode "stream"/"final" sets formatToolCalls=false, which used
  // to suppress the ENTIRE tool_call branch — dropping structured events too.
  const events: ToolUseEvent[] = [];
  const state = createStreamingPromptState(false, (e) => events.push(e));
  parseStreamingChunks(
    state,
    JSON.stringify({
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "t1",
          kind: "execute",
          title: "bash",
          rawInput: { command: "ls" },
          status: "in_progress",
        },
      },
    }),
  );
  // Structured event still emitted; nothing leaks into the text segments.
  expect(state.segments).toEqual([]);
  expect(events).toEqual([
    {
      toolCallId: "t1",
      toolName: "bash",
      kind: "execute",
      summary: "ls",
      rawInput: { command: "ls" },
      status: "running",
    },
  ]);
});

test("inline-text tool rendering stays gated behind formatToolCalls (text mode, non-verbose)", () => {
  // A plain text channel in non-verbose mode must NOT spill tool calls into the reply.
  const state = createStreamingPromptState(false, { mode: "text" });
  parseStreamingChunks(
    state,
    JSON.stringify({
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "t1",
          kind: "read",
          title: "Read File",
          rawInput: { path: "foo.ts" },
          status: "completed",
        },
      },
    }),
  );
  expect(state.segments).toEqual([]);
});

test("when onToolEvent is undefined, tool_call still folds into text segments (backward compat)", () => {
  const state = createStreamingPromptState(true);
  parseStreamingChunks(
    state,
    JSON.stringify({
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "t1",
          kind: "read",
          title: "Read File",
          rawInput: { path: "foo.ts" },
          status: "completed",
        },
      },
    }),
  );
  expect(state.segments.length).toBe(1);
  expect(state.segments[0]).toContain("Read File");
});

test("buildToolUseEvent 透传 locations/rawOutput/content/rawInput", () => {
  const events: ToolUseEvent[] = [];
  const state = createStreamingPromptState(true, (e) => events.push(e));
  const locations = [{ file: "foo.ts", line: 1 }];
  const rawInput = { path: "foo.ts", mode: "r" };
  const content = { type: "text", text: "partial output" };
  const rawOutput = { stdout: "ok", exitCode: 0 };

  parseStreamingChunks(
    state,
    JSON.stringify({
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "t2",
          kind: "execute",
          title: "bash",
          rawInput,
          locations,
          content,
          rawOutput,
          status: "completed",
        },
      },
    }),
  );

  expect(events.length).toBe(1);
  expect(events[0]).toEqual(expect.objectContaining({
    toolCallId: "t2",
    toolName: "bash",
    kind: "execute",
    status: "success",
    rawInput,
    locations,
    content,
    rawOutput,
  }));
});
