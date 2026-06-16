import { expect, test } from "bun:test";
import {
  createStreamingPromptState,
  parseStreamingChunks,
  parseStreamingDataChunk,
} from "../../../src/transport/streaming-prompt";

function makeChunkLine(text: string): string {
  return JSON.stringify({
    method: "session/update",
    params: {
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    },
  });
}

function makeToolCallLine(title: string, kind = "read", extra?: Record<string, unknown>): string {
  return JSON.stringify({
    method: "session/update",
    params: {
      update: {
        sessionUpdate: "tool_call",
        title,
        kind,
        ...(extra ?? {}),
      },
    },
  });
}

function makeThoughtLine(text: string): string {
  return JSON.stringify({
    method: "session/update",
    params: {
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text },
      },
    },
  });
}

test("parseStreamingChunks accumulates text and detects paragraph boundary", () => {
  const state = createStreamingPromptState();

  parseStreamingChunks(state, makeChunkLine("Hello"));
  parseStreamingChunks(state, makeChunkLine(" World\n\n"));
  parseStreamingChunks(state, makeChunkLine("New paragraph"));

  expect(state.segments).toEqual(["Hello World"]);
  expect(state.buffer).toBe("New paragraph");
  expect(state.hasAgentMessage).toBe(true);
});

test("rawStream keeps text verbatim in the buffer (no paragraph split/trim)", () => {
  const state = createStreamingPromptState(false, { rawStream: true });

  parseStreamingChunks(state, makeChunkLine("Hello"));
  parseStreamingChunks(state, makeChunkLine(" World\n\n"));
  parseStreamingChunks(state, makeChunkLine("New paragraph"));

  // Nothing is split off into segments; the live consumer drains `buffer` verbatim.
  expect(state.segments).toEqual([]);
  expect(state.buffer).toBe("Hello World\n\nNew paragraph");
  // finalize() returns the buffer untrimmed in raw mode.
  parseStreamingChunks(state, makeChunkLine("  trailing  "));
  expect(state.finalize()).toBe("Hello World\n\nNew paragraph  trailing  ");
});

test("parseStreamingChunks handles multiple paragraph boundaries", () => {
  const state = createStreamingPromptState();

  parseStreamingChunks(state, makeChunkLine("Para 1\n\nPara 2\n\nPara 3"));

  expect(state.segments).toEqual(["Para 1", "Para 2"]);
  expect(state.buffer).toBe("Para 3");
});

test("parseStreamingChunks ignores non-chunk JSON lines", () => {
  const state = createStreamingPromptState();

  parseStreamingChunks(state, '{"method":"session/update","params":{"update":{"sessionUpdate":"status","content":{"type":"text","text":"thinking"}}}}');
  parseStreamingChunks(state, makeChunkLine("actual content"));

  expect(state.segments).toEqual([]);
  expect(state.buffer).toBe("actual content");
});

test("parseStreamingChunks ignores non-JSON lines", () => {
  const state = createStreamingPromptState();

  parseStreamingChunks(state, "not json at all");
  parseStreamingChunks(state, makeChunkLine("real content"));

  expect(state.segments).toEqual([]);
  expect(state.buffer).toBe("real content");
});

test("finalize returns remaining buffer", () => {
  const state = createStreamingPromptState();
  parseStreamingChunks(state, makeChunkLine("remaining text"));
  const result = state.finalize();
  expect(result).toBe("remaining text");
});

test("finalize returns empty string when buffer is empty", () => {
  const state = createStreamingPromptState();
  const result = state.finalize();
  expect(result).toBe("");
});

test("parseStreamingDataChunk preserves partial JSON lines across stdout chunks", () => {
  const state = createStreamingPromptState();
  const line = makeChunkLine("split json still works");
  const splitAt = Math.floor(line.length / 2);

  parseStreamingDataChunk(state, line.slice(0, splitAt));
  expect(state.buffer).toBe("");
  expect(state.segments).toEqual([]);

  parseStreamingDataChunk(state, `${line.slice(splitAt)}\n`);

  expect(state.buffer).toBe("split json still works");
  expect(state.segments).toEqual([]);
  expect(state.hasAgentMessage).toBe(true);
});

test("finalize parses a complete pending JSON line when the stream ends without a trailing newline", () => {
  const state = createStreamingPromptState();

  parseStreamingDataChunk(state, makeChunkLine("eof without newline"));

  const result = state.finalize();

  expect(result).toBe("eof without newline");
  expect(state.pendingLine).toBe("");
  expect(state.hasAgentMessage).toBe(true);
});

// --- tool_call formatting tests ---

test("formatToolCalls is off by default — tool_call events are ignored", () => {
  const state = createStreamingPromptState();

  parseStreamingChunks(state, makeToolCallLine("Read SKILL.md", "read"));
  parseStreamingChunks(state, makeChunkLine("done"));

  expect(state.segments).toEqual([]);
  expect(state.buffer).toBe("done");
});

test("formatToolCalls formats read tool_call with emoji", () => {
  const state = createStreamingPromptState(true);

  parseStreamingChunks(state, makeToolCallLine("Read SKILL.md", "read", {
    rawInput: {
      parsed_cmd: [{ type: "read", cmd: "sed -n '1,220p' SKILL.md", name: "SKILL.md" }],
    },
  }));

  expect(state.segments).toEqual(["📖 Read SKILL.md: sed -n '1,220p' SKILL.md"]);
});

test("formatToolCalls waits for read file path when initial pending event is generic", () => {
  const state = createStreamingPromptState(true);
  const toolCallId = "toolu_read_file_1";

  parseStreamingChunks(state, JSON.stringify({
    method: "session/update",
    params: {
      update: {
        sessionUpdate: "tool_call",
        toolCallId,
        title: "Read File",
        kind: "read",
        status: "pending",
        rawInput: {},
      },
    },
  }));
  parseStreamingChunks(state, JSON.stringify({
    method: "session/update",
    params: {
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId,
        title: "Read src\\mcp\\weacpx-mcp-server.ts",
        kind: "read",
        rawInput: { file_path: "E:\\projects\\weacpx-github\\src\\mcp\\weacpx-mcp-server.ts" },
      },
    },
  }));

  expect(state.segments).toEqual([
    "📖 Read src\\mcp\\weacpx-mcp-server.ts: E:\\projects\\weacpx-github\\src\\mcp\\weacpx-mcp-server.ts",
  ]);
});

test("formatToolCalls formats search tool_call", () => {
  const state = createStreamingPromptState(true);

  parseStreamingChunks(state, makeToolCallLine("Search session in src", "search", {
    rawInput: {
      parsed_cmd: [{ type: "search", cmd: "rg -n 'session' src" }],
    },
  }));

  expect(state.segments).toEqual(["🔍 Search session in src: rg -n 'session' src"]);
});

test("formatToolCalls waits for task details and formats Agent task calls", () => {
  const state = createStreamingPromptState(true);
  const toolCallId = "toolu_task_1";

  parseStreamingChunks(state, JSON.stringify({
    method: "session/update",
    params: {
      update: {
        sessionUpdate: "tool_call",
        toolCallId,
        title: "Task",
        kind: "think",
        status: "pending",
        rawInput: {},
      },
    },
  }));
  parseStreamingChunks(state, JSON.stringify({
    method: "session/update",
    params: {
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId,
        title: "Explore MCP service code",
        kind: "think",
        rawInput: {
          description: "Explore MCP service code",
          prompt: "Very long task prompt that should not be shown in verbose progress",
          subagent_type: "Explore",
        },
      },
    },
  }));

  expect(state.segments).toEqual(["🧠 Explore MCP service code: Explore"]);
});

test("formatToolCalls formats execute tool_call", () => {
  const state = createStreamingPromptState(true);

  parseStreamingChunks(state, makeToolCallLine("Run bun test", "execute", {
    rawInput: {
      parsed_cmd: [{ type: "unknown", cmd: "bun test tests/unit/formatting/render-text.test.ts" }],
    },
  }));

  expect(state.segments).toEqual(["💻 Run bun test: bun test tests/unit/formatting/render-text.test.ts"]);
});

test("formatToolCalls waits for tool_call_update command when pending execute tool_call is generic", () => {
  const state = createStreamingPromptState(true);
  const toolCallId = "toolu_shell_1";

  parseStreamingChunks(state, JSON.stringify({
    method: "session/update",
    params: {
      update: {
        sessionUpdate: "tool_call",
        toolCallId,
        title: "bash",
        kind: "execute",
        status: "pending",
        locations: [],
        rawInput: {},
      },
    },
  }));
  parseStreamingChunks(state, JSON.stringify({
    method: "session/update",
    params: {
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId,
        title: "bash",
        kind: "execute",
        status: "in_progress",
        locations: [],
        rawInput: { command: "git status", description: "Show git status" },
      },
    },
  }));
  parseStreamingChunks(state, JSON.stringify({
    method: "session/update",
    params: {
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId,
        title: "bash",
        kind: "execute",
        status: "in_progress",
        locations: [],
        rawInput: { command: "git status", description: "Show git status" },
      },
    },
  }));

  expect(state.segments).toEqual(["💻 bash (in_progress): git status"]);
});

test("formatToolCalls suppresses generic search titles like 'grep'", () => {
  const state = createStreamingPromptState(true);
  const toolCallId = "toolu_grep_1";

  parseStreamingChunks(state, JSON.stringify({
    method: "session/update",
    params: {
      update: {
        sessionUpdate: "tool_call",
        toolCallId,
        title: "grep",
        kind: "search",
        status: "pending",
        rawInput: {},
      },
    },
  }));
  parseStreamingChunks(state, JSON.stringify({
    method: "session/update",
    params: {
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId,
        title: "grep",
        kind: "search",
        status: "in_progress",
        rawInput: { command: "grep -r 'pattern' src/" },
      },
    },
  }));

  expect(state.segments).toEqual(["🔍 grep (in_progress): grep -r 'pattern' src/"]);
});

test("formatToolCalls suppresses generic read titles like 'read'", () => {
  const state = createStreamingPromptState(true);
  const toolCallId = "toolu_read_1";

  parseStreamingChunks(state, JSON.stringify({
    method: "session/update",
    params: {
      update: {
        sessionUpdate: "tool_call",
        toolCallId,
        title: "read",
        kind: "read",
        status: "pending",
        rawInput: {},
      },
    },
  }));
  parseStreamingChunks(state, JSON.stringify({
    method: "session/update",
    params: {
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId,
        title: "read",
        kind: "read",
        status: "in_progress",
        rawInput: { command: "cat src/file.ts" },
      },
    },
  }));

  expect(state.segments).toEqual(["📖 read (in_progress): cat src/file.ts"]);
});

test("formatToolCalls formats edit tool_call", () => {
  const state = createStreamingPromptState(true);

  parseStreamingChunks(state, makeToolCallLine("Edit parse-command.ts", "edit"));

  expect(state.segments).toEqual(["✏️ Edit parse-command.ts"]);
});

test("formatToolCalls truncates long commands to 60 chars", () => {
  const state = createStreamingPromptState(true);
  const longCmd = "a".repeat(80);

  parseStreamingChunks(state, makeToolCallLine("Run something", "execute", {
    rawInput: {
      parsed_cmd: [{ type: "unknown", cmd: longCmd }],
    },
  }));

  expect(state.segments.length).toBe(1);
  expect(state.segments[0]).toContain("...");
  expect(state.segments[0]).toContain("Run something:");
});

test("formatToolCalls falls back to title when no parsed_cmd", () => {
  const state = createStreamingPromptState(true);

  parseStreamingChunks(state, makeToolCallLine("Some unknown tool", "unknown"));

  expect(state.segments).toEqual(["🔧 Some unknown tool"]);
});

test("formatToolCalls uses rawInput hints when command is absent", () => {
  const state = createStreamingPromptState(true);

  parseStreamingChunks(state, JSON.stringify({
    method: "session/update",
    params: {
      update: {
        sessionUpdate: "tool_call",
        title: "ToolSearch",
        kind: "search",
        status: "in_progress",
        rawInput: { query: "weixin quota" },
      },
    },
  }));

  expect(state.segments).toEqual(["🔍 ToolSearch (in_progress): weixin quota"]);
});

test("formatToolCalls mixes tool_call and text segments", () => {
  const state = createStreamingPromptState(true);

  parseStreamingChunks(state, makeToolCallLine("Read file", "read"));
  parseStreamingChunks(state, makeChunkLine("I found the issue.\n\n"));
  parseStreamingChunks(state, makeToolCallLine("Edit file.ts", "edit"));

  expect(state.segments).toEqual(["📖 Read file", "I found the issue.", "✏️ Edit file.ts"]);
});

// --- toolEventMode routing tests ---

const TOOL_CALL_LINE = JSON.stringify({
  method: "session/update",
  params: {
    update: {
      sessionUpdate: "tool_call",
      title: "Read File",
      kind: "read",
      toolCallId: "id-1",
      rawInput: { path: "foo.ts" },
      status: "completed",
    },
  },
});

test("back-compat: positional callback → structured (callback receives event, no segment)", () => {
  let received: unknown = null;
  const cb = (ev: unknown) => { received = ev; };
  const state = createStreamingPromptState(true, cb);

  parseStreamingChunks(state, TOOL_CALL_LINE);

  expect(received).not.toBeNull();
  expect(state.segments).toEqual([]);
});

test("mode 'text' with callback → text segment pushed, callback NOT invoked", () => {
  let received: unknown = null;
  const cb = (ev: unknown) => { received = ev; };
  const state = createStreamingPromptState(true, { mode: "text", onToolEvent: cb });

  parseStreamingChunks(state, TOOL_CALL_LINE);

  expect(received).toBeNull();
  expect(state.segments.length).toBe(1);
  expect(state.segments[0]).toContain("Read File");
});

test("mode 'structured' with callback → callback invoked, no segment", () => {
  let received: unknown = null;
  const cb = (ev: unknown) => { received = ev; };
  const state = createStreamingPromptState(true, { mode: "structured", onToolEvent: cb });

  parseStreamingChunks(state, TOOL_CALL_LINE);

  expect(received).not.toBeNull();
  expect(state.segments).toEqual([]);
});

test("mode 'both' with callback → callback invoked AND segment pushed", () => {
  let received: unknown = null;
  const cb = (ev: unknown) => { received = ev; };
  const state = createStreamingPromptState(true, { mode: "both", onToolEvent: cb });

  parseStreamingChunks(state, TOOL_CALL_LINE);

  expect(received).not.toBeNull();
  expect(state.segments.length).toBe(1);
  expect(state.segments[0]).toContain("Read File");
});

test("mode 'structured' without callback → no segment, no throw (silently dropped)", () => {
  const state = createStreamingPromptState(true, { mode: "structured" });

  expect(() => parseStreamingChunks(state, TOOL_CALL_LINE)).not.toThrow();
  expect(state.segments).toEqual([]);
});

test("no second arg → text behavior (default mode 'text')", () => {
  const state = createStreamingPromptState(true);

  parseStreamingChunks(state, TOOL_CALL_LINE);

  expect(state.segments.length).toBe(1);
  expect(state.segments[0]).toContain("Read File");
});

test("options object with callback but no mode → structured (preserves Phase 0)", () => {
  let received: unknown = null;
  const cb = (ev: unknown) => { received = ev; };
  const state = createStreamingPromptState(true, { onToolEvent: cb });

  parseStreamingChunks(state, TOOL_CALL_LINE);

  expect(received).not.toBeNull();
  expect(state.segments).toEqual([]);
});

test("toolEventMode 'both' calls structured per event but dedupes text by toolCallId", () => {
  const events: unknown[] = [];
  const state = createStreamingPromptState(true, {
    mode: "both",
    onToolEvent: (event) => { events.push(event); },
  });

  const firstUpdate = JSON.stringify({
    method: "session/update",
    params: { update: {
      sessionUpdate: "tool_call",
      title: "Read File",
      kind: "read",
      toolCallId: "dup-id",
      rawInput: { path: "foo.ts" },
      status: "pending",
    } },
  });
  const secondUpdate = JSON.stringify({
    method: "session/update",
    params: { update: {
      sessionUpdate: "tool_call_update",
      title: "Read File",
      kind: "read",
      toolCallId: "dup-id",
      rawInput: { path: "foo.ts" },
      status: "completed",
    } },
  });

  parseStreamingChunks(state, firstUpdate);
  parseStreamingChunks(state, secondUpdate);

  // Structured side sees both updates (channel can key by toolCallId for in-place updates).
  expect(events.length).toBe(2);
  // Text side dedupes — only one segment for the same toolCallId.
  expect(state.segments.length).toBe(1);
});

test("onThought receives raw agent_thought_chunk text in order", () => {
  const chunks: string[] = [];
  const state = createStreamingPromptState(false, {
    onThought: (c) => {
      chunks.push(c);
    },
  });

  parseStreamingChunks(state, makeThoughtLine("Let me "));
  parseStreamingChunks(state, makeThoughtLine("think about"));
  parseStreamingChunks(state, makeThoughtLine(" this\n\nstep two"));

  // Raw chunks — no \n\n splitting, no buffering, no segment emission.
  expect(chunks).toEqual(["Let me ", "think about", " this\n\nstep two"]);
  expect(state.segments).toEqual([]);
  expect(state.buffer).toBe("");
  expect(state.hasAgentMessage).toBe(false);
});

test("thought chunks are dropped when no onThought is registered", () => {
  const state = createStreamingPromptState();

  parseStreamingChunks(state, makeThoughtLine("internal reasoning"));
  parseStreamingChunks(state, makeChunkLine("real answer"));

  expect(state.segments).toEqual([]);
  expect(state.buffer).toBe("real answer");
  expect(state.hasAgentMessage).toBe(true);
  expect(state.finalize()).toBe("real answer");
});

test("thought chunks reach onThought regardless of formatToolCalls", () => {
  const chunks: string[] = [];
  const state = createStreamingPromptState(true, {
    onThought: (c) => {
      chunks.push(c);
    },
  });

  parseStreamingChunks(state, makeThoughtLine("reasoning"));

  expect(chunks).toEqual(["reasoning"]);
});

test("empty thought chunk does not invoke onThought", () => {
  let calls = 0;
  const state = createStreamingPromptState(false, {
    onThought: () => {
      calls += 1;
    },
  });

  parseStreamingChunks(state, makeThoughtLine(""));

  expect(calls).toBe(0);
});

test("interleaved stream: thoughts reach onThought in order, agent message lands in segments, thoughts do not appear in segments or buffer", () => {
  const thoughts: string[] = [];
  const state = createStreamingPromptState(true, {
    onThought: (c) => {
      thoughts.push(c);
    },
  });

  parseStreamingChunks(state, makeThoughtLine("first thought"));
  parseStreamingChunks(state, makeToolCallLine("Read file", "read"));
  parseStreamingChunks(state, makeThoughtLine("second thought"));
  parseStreamingChunks(state, makeChunkLine("agent answer\n\n"));

  // Both thought chunks must arrive in order.
  expect(thoughts).toEqual(["first thought", "second thought"]);

  // The agent message text must land in segments (paragraph completed by \n\n).
  expect(state.segments).toContain("agent answer");
  // Tool call segment is also present since formatToolCalls is true.
  expect(state.segments.some((s) => s.includes("Read file"))).toBe(true);

  // Thoughts must NOT appear anywhere in segments or buffer.
  const allText = [...state.segments, state.buffer].join("");
  expect(allText).not.toContain("first thought");
  expect(allText).not.toContain("second thought");
});
