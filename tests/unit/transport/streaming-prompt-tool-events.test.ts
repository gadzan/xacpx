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

test("partial ACP tool_call_update frames merge per toolCallId (terminal frame must not erase title/diff)", () => {
  // Reproduces acpx's real Claude Code edit sequence: a pending frame with empty
  // payload, an in-progress frame carrying the rich title + diff content, then a
  // terminal frame that only sets status + rawOutput (no kind/title/content). Before
  // merging, the terminal frame clobbered the step into a generic kind:"other"
  // "Tool" with no diff. The final emitted event must retain the edit title + diff.
  const events: ToolUseEvent[] = [];
  const state = createStreamingPromptState(false, (e) => events.push(e));
  const send = (update: Record<string, unknown>) =>
    parseStreamingChunks(state, JSON.stringify({ method: "session/update", params: { update } }));

  send({ sessionUpdate: "tool_call", toolCallId: "e1", kind: "edit", title: "Edit", content: [], rawInput: {}, locations: [], status: "pending" });
  send({
    sessionUpdate: "tool_call_update",
    toolCallId: "e1",
    kind: "edit",
    title: "Edit skills/preflight.js",
    content: [{ type: "diff", path: "skills/preflight.js", oldText: "const a = 1;", newText: "const a = 2;" }],
    rawInput: { file_path: "skills/preflight.js", old_string: "const a = 1;", new_string: "const a = 2;" },
    locations: [{ path: "skills/preflight.js" }],
  });
  // Terminal frame: ACP partial update — only status + rawOutput, no kind/title/content.
  send({ sessionUpdate: "tool_call_update", toolCallId: "e1", rawOutput: { ok: true }, status: "completed" });

  const last = events.at(-1)!;
  expect(last.status).toBe("success");
  expect(last.kind).toBe("edit"); // not clobbered to "other"
  expect(last.toolName).toBe("Edit skills/preflight.js"); // rich title preserved
  // The diff content from the in-progress frame survives the terminal frame.
  expect(last.content).toEqual([
    { type: "diff", path: "skills/preflight.js", oldText: "const a = 1;", newText: "const a = 2;" },
  ]);
  expect(last.rawOutput).toEqual({ ok: true });
});

test("a bare tool_call_update (only toolCallId) re-emits the accumulated call", () => {
  const events: ToolUseEvent[] = [];
  const state = createStreamingPromptState(false, (e) => events.push(e));
  const send = (update: Record<string, unknown>) =>
    parseStreamingChunks(state, JSON.stringify({ method: "session/update", params: { update } }));

  send({ sessionUpdate: "tool_call", toolCallId: "s1", kind: "search", title: "grep", rawInput: { pattern: "TODO" }, status: "pending" });
  send({ sessionUpdate: "tool_call_update", toolCallId: "s1" }); // bare keep-alive frame
  const last = events.at(-1)!;
  expect(last.kind).toBe("search");
  expect(last.toolName).toBe("grep");
  expect(last.rawInput).toEqual({ pattern: "TODO" });
});

test("interleaved frames for two toolCallIds keep separate accumulators", () => {
  const events: ToolUseEvent[] = [];
  const state = createStreamingPromptState(false, (e) => events.push(e));
  const send = (update: Record<string, unknown>) =>
    parseStreamingChunks(state, JSON.stringify({ method: "session/update", params: { update } }));

  // Two tools in flight at once; a frame for one must not pollute the other's state.
  send({ sessionUpdate: "tool_call", toolCallId: "a", kind: "read", title: "Read a.ts", rawInput: { path: "a.ts" }, status: "pending" });
  send({ sessionUpdate: "tool_call", toolCallId: "b", kind: "search", title: "grep", rawInput: { pattern: "TODO" }, status: "pending" });
  send({ sessionUpdate: "tool_call_update", toolCallId: "a", status: "completed" }); // partial: only status
  send({ sessionUpdate: "tool_call_update", toolCallId: "b", status: "completed" }); // partial: only status

  const lastA = [...events].reverse().find((e) => e.toolCallId === "a")!;
  const lastB = [...events].reverse().find((e) => e.toolCallId === "b")!;
  expect(lastA).toMatchObject({ toolCallId: "a", kind: "read", toolName: "Read a.ts", status: "success" });
  expect(lastB).toMatchObject({ toolCallId: "b", kind: "search", toolName: "grep", status: "success" });
});

test("a search whose terminal frame carries only status keeps its kind/title/query", () => {
  const events: ToolUseEvent[] = [];
  const state = createStreamingPromptState(false, (e) => events.push(e));
  const send = (update: Record<string, unknown>) =>
    parseStreamingChunks(state, JSON.stringify({ method: "session/update", params: { update } }));

  send({ sessionUpdate: "tool_call", toolCallId: "s1", kind: "search", title: "grep", content: [], rawInput: {}, status: "pending" });
  send({ sessionUpdate: "tool_call_update", toolCallId: "s1", kind: "search", title: 'grep "TODO" src/', rawInput: { pattern: "TODO", path: "src/" } });
  send({ sessionUpdate: "tool_call_update", toolCallId: "s1", status: "completed", rawOutput: { matches: 3 } });

  const last = events.at(-1)!;
  expect(last.kind).toBe("search");
  expect(last.toolName).toBe('grep "TODO" src/');
  expect(last.rawInput).toEqual({ pattern: "TODO", path: "src/" });
  expect(last.status).toBe("success");
});

test("Claude sparse toolResponse update is terminal even when status is omitted", () => {
  const events: ToolUseEvent[] = [];
  const state = createStreamingPromptState(false, (e) => events.push(e));
  const send = (update: Record<string, unknown>) =>
    parseStreamingChunks(state, JSON.stringify({ method: "session/update", params: { update } }));

  send({
    sessionUpdate: "tool_call",
    toolCallId: "grep-1",
    kind: "search",
    title: 'grep -i -l "wechat" repo',
    rawInput: { pattern: "wechat" },
    status: "pending",
  });
  send({
    sessionUpdate: "tool_call_update",
    toolCallId: "grep-1",
    _meta: { claudeCode: { toolName: "Grep", toolResponse: { filenames: [], numFiles: 0 } } },
  });

  expect(events.at(-1)).toMatchObject({
    toolCallId: "grep-1",
    toolName: 'grep -i -l "wechat" repo',
    kind: "search",
    status: "success",
    rawOutput: { filenames: [], numFiles: 0 },
  });
});

test("Claude Agent and its nested tools preserve subagent hierarchy across sparse updates", () => {
  const events: ToolUseEvent[] = [];
  const state = createStreamingPromptState(false, (event) => events.push(event));
  const send = (update: Record<string, unknown>) =>
    parseStreamingChunks(state, JSON.stringify({ method: "session/update", params: { update } }));

  send({
    sessionUpdate: "tool_call",
    toolCallId: "agent-1",
    kind: "think",
    title: "Task",
    status: "pending",
    _meta: { claudeCode: { toolName: "Agent" } },
  });
  send({
    sessionUpdate: "tool_call_update",
    toolCallId: "agent-1",
    title: "Find notification code",
    rawInput: { description: "Find notification code", subagent_type: "Explore" },
    _meta: { claudeCode: { toolName: "Agent" } },
  });
  send({
    sessionUpdate: "tool_call_update",
    toolCallId: "agent-1",
    status: "completed",
    _meta: { claudeCode: { toolResponse: { isAsync: true, status: "async_launched" } } },
  });
  send({
    sessionUpdate: "tool_call",
    toolCallId: "grep-1",
    kind: "search",
    title: 'grep "wechat"',
    rawInput: { pattern: "wechat" },
    status: "pending",
    _meta: { claudeCode: { toolName: "Grep", parentToolUseId: "agent-1" } },
  });
  send({
    sessionUpdate: "tool_call_update",
    toolCallId: "grep-1",
    _meta: { claudeCode: { toolResponse: { filenames: ["a.ts"] } } },
  });

  expect([...events].reverse().find((event) => event.toolCallId === "agent-1")).toMatchObject({
    toolCallId: "agent-1",
    isSubagent: true,
    status: "running",
  });
  expect(events.at(-1)).toMatchObject({
    toolCallId: "grep-1",
    parentToolCallId: "agent-1",
    status: "success",
  });
});

test("Qoder Agent metadata produces a subagent event across a sparse terminal update", () => {
  const events: ToolUseEvent[] = [];
  const state = createStreamingPromptState(false, {
    driver: "qoder",
    onToolEvent: (event) => events.push(event),
  });
  const send = (update: Record<string, unknown>) =>
    parseStreamingChunks(state, JSON.stringify({ method: "session/update", params: { update } }));

  send({
    sessionUpdate: "tool_call",
    toolCallId: "qoder-agent-1",
    status: "pending",
    kind: "think",
    title: "Agent",
    rawInput: {
      description: "Pick a random number 1-100",
      prompt: "Reply with one integer between 1 and 100.",
      subagent_type: "general-purpose",
    },
    _meta: { qoder: { toolName: "Agent" } },
  });
  send({
    sessionUpdate: "tool_call_update",
    toolCallId: "qoder-agent-1",
    status: "completed",
    rawOutput: "47",
    _meta: { qoder: {} },
  });

  expect(events.at(-1)).toEqual({
    toolCallId: "qoder-agent-1",
    isSubagent: true,
    toolName: "Agent",
    kind: "think",
    summary: "general-purpose: Pick a random number 1-100",
    rawInput: {
      description: "Pick a random number 1-100",
      prompt: "Reply with one integer between 1 and 100.",
      subagent_type: "general-purpose",
    },
    rawOutput: "47",
    status: "success",
  });
});

test("a qoder async Agent launch stays running until its background continuation ends", () => {
  const events: ToolUseEvent[] = [];
  const state = createStreamingPromptState(false, {
    driver: "qoder",
    onToolEvent: (event) => events.push(event),
  });
  const send = (update: Record<string, unknown>) =>
    parseStreamingChunks(state, JSON.stringify({ method: "session/update", params: { update } }));

  send({
    sessionUpdate: "tool_call",
    toolCallId: "qoder-agent-1",
    status: "pending",
    kind: "think",
    title: "Agent",
    rawInput: { description: "research", prompt: "dig in", subagent_type: "general-purpose", run_in_background: true },
    _meta: { qoder: { toolName: "Agent" } },
  });
  send({
    sessionUpdate: "tool_call_update",
    toolCallId: "qoder-agent-1",
    status: "completed",
    rawOutput: { status: "async_launched", agentId: "ageneral-purpose-abc", description: "research", prompt: "dig in" },
    _meta: { qoder: { toolName: "Agent" } },
  });

  expect(events.at(-1)).toMatchObject({
    toolCallId: "qoder-agent-1",
    isSubagent: true,
    status: "running",
  });

  send({
    sessionUpdate: "tool_call",
    toolCallId: "qoder-agent-2",
    status: "pending",
    kind: "think",
    title: "Agent",
    rawInput: { description: "audit", prompt: "review", subagent_type: "general-purpose", run_in_background: true },
    _meta: { qoder: { toolName: "Agent" } },
  });
  send({
    sessionUpdate: "tool_call_update",
    toolCallId: "qoder-agent-2",
    status: "completed",
    rawOutput: '{"status":"async_launched","agentId":"aExplore-def","description":"audit"}',
    // Real qoder terminal frames are sparse; toolName must survive via meta merge.
    _meta: { qoder: {} },
  });

  expect(events.at(-1)).toMatchObject({
    toolCallId: "qoder-agent-2",
    isSubagent: true,
    status: "running",
  });
});

test("Kimi recognizes delegated work only after its incremental Agent input is complete", () => {
  const events: ToolUseEvent[] = [];
  const state = createStreamingPromptState(false, {
    driver: "kimi",
    onToolEvent: (event) => events.push(event),
  });
  const send = (update: Record<string, unknown>) =>
    parseStreamingChunks(state, JSON.stringify({ method: "session/update", params: { update } }));

  send({
    sessionUpdate: "tool_call",
    toolCallId: "kimi-agent-1",
    status: "pending",
    kind: "other",
    title: "Agent",
  });
  expect(events.at(-1)?.isSubagent).toBeUndefined();

  send({
    sessionUpdate: "tool_call_update",
    toolCallId: "kimi-agent-1",
    status: "in_progress",
    title: "Launching coder agent: Random number 1-100",
    rawInput: {
      prompt: "请随机说出 1 到 100 之间的一个整数。",
      description: "Random number 1-100",
      subagent_type: "coder",
    },
  });
  send({
    sessionUpdate: "tool_call_update",
    toolCallId: "kimi-agent-1",
    status: "completed",
    rawOutput: "73",
  });

  expect(events.at(-1)).toMatchObject({
    toolCallId: "kimi-agent-1",
    isSubagent: true,
    toolName: "Launching coder agent: Random number 1-100",
    summary: "coder: Random number 1-100",
    rawOutput: "73",
    status: "success",
  });
});

test("Codex subagent metadata survives a sparse terminal namespace update", () => {
  const events: ToolUseEvent[] = [];
  const state = createStreamingPromptState(false, {
    driver: "codex",
    onToolEvent: (event) => events.push(event),
  });

  parseStreamingChunks(state, JSON.stringify({
    method: "session/update",
    params: {
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "codex-agent-1",
        status: "in_progress",
        kind: "other",
        title: "Start subagent random_number",
        rawInput: {
          agentThreadId: "thread-child-1",
          agentPath: "/root/random_number",
          activityKind: "started",
        },
        _meta: {
          codex: {
            subagent: {
              threadId: "thread-child-1",
              path: "/root/random_number",
              activity: "started",
            },
          },
        },
      },
    },
  }));

  parseStreamingChunks(state, JSON.stringify({
    method: "session/update",
    params: {
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "codex-agent-1",
        status: "completed",
        _meta: { codex: { subagent: { activity: "started" } } },
      },
    },
  }));

  expect(events.at(-1)).toEqual({
    toolCallId: "codex-agent-1",
    isSubagent: true,
    toolName: "Start subagent random_number",
    kind: "other",
    rawInput: {
      agentThreadId: "thread-child-1",
      agentPath: "/root/random_number",
      activityKind: "started",
    },
    status: "success",
  });
});

test("provider subagent signals are driver-gated and malformed metadata fails open", () => {
  const parse = (driver: string, update: Record<string, unknown>): ToolUseEvent | undefined => {
    const events: ToolUseEvent[] = [];
    const state = createStreamingPromptState(false, {
      driver,
      onToolEvent: (event) => events.push(event),
    });
    parseStreamingChunks(state, JSON.stringify({ method: "session/update", params: { update } }));
    return events.at(-1);
  };
  const base = {
    sessionUpdate: "tool_call",
    toolCallId: "agent-1",
    status: "completed",
    kind: "other",
    title: "Agent",
  };

  expect(parse("custom", { ...base, _meta: { claudeCode: { toolName: "Agent" } } })?.isSubagent).toBeUndefined();
  expect(parse("custom", { ...base, _meta: { qoder: { toolName: "Agent" } } })?.isSubagent).toBeUndefined();
  expect(parse("custom", {
    ...base,
    rawInput: { prompt: "delegate", subagent_type: "coder" },
  })?.isSubagent).toBeUndefined();
  expect(parse("custom", {
    ...base,
    _meta: { codex: { subagent: { threadId: "thread-1", activity: "started" } } },
  })?.isSubagent).toBeUndefined();
  expect(parse("qoder", { ...base, _meta: { qoder: { toolName: "" } } })?.isSubagent).toBeUndefined();
  expect(parse("kimi", { ...base, rawInput: { prompt: "delegate" } })?.isSubagent).toBeUndefined();
  expect(parse("codex", {
    ...base,
    _meta: { codex: { subagent: { activity: "started" } } },
  })?.isSubagent).toBeUndefined();
});

test("wrong-driver Claude metadata does not alter an ordinary tool event", () => {
  const events: ToolUseEvent[] = [];
  const state = createStreamingPromptState(false, {
    driver: "custom",
    onToolEvent: (event) => events.push(event),
  });

  parseStreamingChunks(state, JSON.stringify({
    method: "session/update",
    params: {
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "ordinary-1",
        status: "completed",
        kind: "other",
        title: "Agent",
        _meta: {
          claudeCode: {
            toolName: "Agent",
            parentToolUseId: "unrelated-parent",
            toolResponse: { status: "async_launched", agentId: "unexpected" },
          },
        },
      },
    },
  }));

  expect(events).toEqual([{
    toolCallId: "ordinary-1",
    toolName: "Agent",
    kind: "other",
    status: "success",
  }]);
});
