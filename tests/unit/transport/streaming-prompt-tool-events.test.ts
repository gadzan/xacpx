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

test("usage_update fires onUsage with the latest used/size, ignoring malformed frames", () => {
  const seen: { used: number; size: number }[] = [];
  const state = createStreamingPromptState(false, { onUsage: (u) => seen.push(u) });
  const usage = (used: unknown, size: unknown) =>
    JSON.stringify({ method: "session/update", params: { update: { sessionUpdate: "usage_update", used, size } } });
  parseStreamingChunks(state, usage(34606, 200000));
  parseStreamingChunks(state, usage(34612, 1000000)); // model corrects the window mid-turn
  parseStreamingChunks(state, usage(40000, 0));       // zero window — dropped
  parseStreamingChunks(state, usage("nope", 200000)); // non-numeric — dropped
  expect(seen).toEqual([
    { used: 34606, size: 200000 },
    { used: 34612, size: 1000000 },
  ]);
});

test("usage_update surfaces cost and token breakdown", () => {
  const seen: unknown[] = [];
  const state = createStreamingPromptState(false, { onUsage: (u) => { seen.push(u); } });
  parseStreamingChunks(
    state,
    JSON.stringify({
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "usage_update",
          used: 1000,
          size: 200000,
          cost: { amount: 0.42, currency: "USD" },
          _meta: { usage: { input_tokens: 800, output_tokens: 120, cache_read_input_tokens: 5000, total_tokens: 920 } },
        },
      },
    }),
  );
  expect(seen).toEqual([
    {
      used: 1000,
      size: 200000,
      cost: { amount: 0.42, currency: "USD" },
      breakdown: { inputTokens: 800, outputTokens: 120, cachedReadTokens: 5000, totalTokens: 920 },
    },
  ]);
});

test("usage_update without extras stays a bare used/size payload", () => {
  const seen: unknown[] = [];
  const state = createStreamingPromptState(false, { onUsage: (u) => { seen.push(u); } });
  parseStreamingChunks(
    state,
    JSON.stringify({
      method: "session/update",
      params: { update: { sessionUpdate: "usage_update", used: 10, size: 100 } },
    }),
  );
  expect(seen).toEqual([{ used: 10, size: 100 }]);
});

test("available_commands_update surfaces agent slash commands", () => {
  const seen: unknown[] = [];
  const state = createStreamingPromptState(false, { onCommands: (c) => { seen.push(c); } });
  parseStreamingChunks(
    state,
    JSON.stringify({
      method: "session/update",
      params: { update: { sessionUpdate: "available_commands_update", availableCommands: [
        { name: "compact", description: "Compact the conversation" },
        { name: "run", input: { hint: "args" } },
        { description: "no name — dropped" },
      ] } },
    }),
  );
  expect(seen).toEqual([[
    { name: "compact", description: "Compact the conversation", hasInput: false },
    { name: "run", hasInput: true },
  ]]);
});

test("available_commands_update with an empty list emits a clear", () => {
  const seen: unknown[] = [];
  const state = createStreamingPromptState(false, { onCommands: (c) => { seen.push(c); } });
  parseStreamingChunks(state, JSON.stringify({
    method: "session/update",
    params: { update: { sessionUpdate: "available_commands_update", availableCommands: [] } },
  }));
  expect(seen).toEqual([[]]); // explicit clear propagates, so a stale list doesn't linger
});

test("available_commands_update with no array is ignored", () => {
  const seen: unknown[] = [];
  const state = createStreamingPromptState(false, { onCommands: (c) => { seen.push(c); } });
  parseStreamingChunks(state, JSON.stringify({
    method: "session/update",
    params: { update: { sessionUpdate: "available_commands_update" } },
  }));
  expect(seen).toEqual([]);
});
