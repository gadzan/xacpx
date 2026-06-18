import { expect, mock, test } from "bun:test";

import type { ResolvedSession } from "../../../../src/transport/types";
import { AcpxBridgeTransport } from "../../../../src/transport/acpx-bridge/acpx-bridge-transport";

const session: ResolvedSession = {
  alias: "api-fix",
  agent: "codex",
  agentCommand: "./node_modules/.bin/codex-acp",
  workspace: "backend",
  transportSession: "backend:api-fix",
  cwd: "/tmp/backend",
};

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const mcpSession: ResolvedSession = {
  ...session,
  mcpCoordinatorSession: "backend:main",
  mcpSourceHandle: "backend:claude:backend:main",
};

test("proxies ensureSession through the bridge client", async () => {
  const request = mock(async () => ({}));
  const transport = new AcpxBridgeTransport({
    request,
  });

  await transport.ensureSession(session);

  expect(request).toHaveBeenCalledWith("ensureSession", {
    agent: "codex",
    agentCommand: "./node_modules/.bin/codex-acp",
    cwd: "/tmp/backend",
    name: "backend:api-fix",
    mcpCoordinatorSession: undefined,
    mcpSourceHandle: undefined,
    replyMode: "verbose",
  }, undefined);
});

test("effectiveReplyMode 'stream' wins over an undefined replyMode in ensureSession params", async () => {
  const request = mock(async () => ({}));
  const transport = new AcpxBridgeTransport({ request });

  await transport.ensureSession({ ...session, effectiveReplyMode: "stream" });

  expect(request).toHaveBeenCalledWith(
    "ensureSession",
    expect.objectContaining({ replyMode: "stream" }),
    undefined,
  );
});

test("proxies hasSession through the bridge client", async () => {
  const request = mock(async () => ({ exists: true }));
  const transport = new AcpxBridgeTransport({
    request,
  });

  await expect(transport.hasSession(session)).resolves.toBe(true);
});

test("proxies tailSessionHistory through the bridge client", async () => {
  const request = mock(async () => ({ text: "history" }));
  const transport = new AcpxBridgeTransport({ request });

  await expect(transport.tailSessionHistory(session, 12)).resolves.toEqual({ text: "history" });

  expect(request).toHaveBeenCalledWith("tailSessionHistory", expect.objectContaining({
    name: "backend:api-fix",
    lines: 12,
  }));
});

test("proxies prompt through the bridge client", async () => {
  const request = mock(async () => ({ text: "ok" }));
  const transport = new AcpxBridgeTransport({
    request,
  });

  await expect(transport.prompt(session, "hello")).resolves.toEqual({ text: "ok" });
});

test("passes prompt media through to the bridge client", async () => {
  const request = mock(async () => ({ text: "ok" }));
  const transport = new AcpxBridgeTransport({
    request,
  });
  const media = { type: "image" as const, filePath: "/tmp/image.bin", mimeType: "image/*" };

  await expect(
    transport.prompt(session, "hello", undefined, undefined, { media }),
  ).resolves.toEqual({ text: "ok" });

  expect(request.mock.calls[0]?.[1]).toMatchObject({
    text: "hello",
    media,
  });
});

test("includes orchestration MCP identity in bridge prompt params", async () => {
  const request = mock(async () => ({ text: "ok" }));
  const transport = new AcpxBridgeTransport({ request });

  await transport.prompt(mcpSession, "hello");

  expect(request.mock.calls[0]?.[1]).toMatchObject({
    mcpCoordinatorSession: "backend:main",
    mcpSourceHandle: "backend:claude:backend:main",
  });
});

test("forwards bridge prompt segments into the reply callback", async () => {
  const request = mock(async (_method, _params, onEvent?: (event: { type: string; text: string }) => void) => {
    onEvent?.({ type: "prompt.segment", text: "hello" });
    onEvent?.({ type: "prompt.segment", text: "world" });
    return { text: "done" };
  });
  const segments: string[] = [];
  const transport = new AcpxBridgeTransport({
    request,
  });

  await expect(transport.prompt(session, "hello", async (text) => {
    segments.push(text);
  })).resolves.toEqual({ text: "" });
  // Bridge transport batches mid segments through SegmentAggregator (both
  // arrive within the 5s window, flushed as one combined payload at finalize).
  // Returned text is empty because the streamed segments already covered all
  // user-visible content — a non-empty final would duplicate; only an
  // overflow_summary justifies a final-tier message.
  expect(segments).toEqual(["hello\nworld"]);
});

test("stream-mode session forwards fine-grained segments verbatim (no \\n-join)", async () => {
  // Regression: with effectiveReplyMode 'stream' (relay/control path), each
  // bridge prompt.segment must reach reply() VERBATIM and in order — the WeChat
  // SegmentAggregator (which \n-joins token drains, shredding multi-line
  // markdown like table headers) must be bypassed.
  const request = mock(async (_method, _params, onEvent?: (event: { type: string; text: string }) => void) => {
    onEvent?.({ type: "prompt.segment", text: "| # | 功能" });
    onEvent?.({ type: "prompt.segment", text: " | 说明 |" });
    return { text: "done" };
  });
  const segments: string[] = [];
  const transport = new AcpxBridgeTransport({ request });

  await expect(
    transport.prompt(
      { ...session, effectiveReplyMode: "stream" },
      "hello",
      async (text) => {
        segments.push(text);
      },
    ),
  ).resolves.toEqual({ text: "" });
  // Two segments arrive as two unmodified reply calls, NO "\n" inserted.
  expect(segments).toEqual(["| # | 功能", " | 说明 |"]);
  expect(segments.join("")).toBe("| # | 功能 | 说明 |");
});


test("runs prompt segment observers serially in bridge event order", async () => {
  const request = mock(async (_method, _params, onEvent?: (event: { type: string; text: string }) => void) => {
    onEvent?.({ type: "prompt.segment", text: "first" });
    onEvent?.({ type: "prompt.segment", text: "second" });
    return { text: "done" };
  });
  const observed: string[] = [];
  const releaseFirst = createDeferred<void>();
  const transport = new AcpxBridgeTransport({ request });

  const prompt = transport.prompt(session, "hello", undefined, undefined, {
    onSegment: async (text) => {
      if (text === "first") {
        await releaseFirst.promise;
      }
      observed.push(text);
    },
  });

  await Bun.sleep(0);
  expect(observed).toEqual([]);
  releaseFirst.resolve();
  await expect(prompt).resolves.toEqual({ text: "done" });
  expect(observed).toEqual(["first", "second"]);
});

test("captures prompt segment observer failures before bridge request settles", async () => {
  const requestFinished = createDeferred<void>();
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    const request = mock(async (_method, _params, onEvent?: (event: { type: string; text: string }) => void) => {
      onEvent?.({ type: "prompt.segment", text: "first" });
      await Bun.sleep(0);
      await Bun.sleep(0);
      requestFinished.resolve();
      return { text: "done" };
    });
    const transport = new AcpxBridgeTransport({ request });

    await expect(
      transport.prompt(session, "hello", undefined, undefined, {
        onSegment: () => {
          throw new Error("observer failed");
        },
      }),
    ).rejects.toThrow("observer failed");
    await requestFinished.promise;
    await Bun.sleep(0);
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("proxies cancel through the bridge client", async () => {
  const request = mock(async () => ({ cancelled: true, message: "cancelled" }));
  const transport = new AcpxBridgeTransport({
    request,
  });

  await expect(transport.cancel(session)).resolves.toEqual({
    cancelled: true,
    message: "cancelled",
  });
});

test("proxies setMode through the bridge client", async () => {
  const request = mock(async () => ({}));
  const transport = new AcpxBridgeTransport({
    request,
  });

  await transport.setMode(session, "plan");

  expect(request).toHaveBeenCalledWith("setMode", {
    agent: "codex",
    agentCommand: "./node_modules/.bin/codex-acp",
    cwd: "/tmp/backend",
    name: "backend:api-fix",
    modeId: "plan",
    mcpCoordinatorSession: undefined,
    mcpSourceHandle: undefined,
    replyMode: "verbose",
  });
});


test("proxies permission policy updates through the bridge client", async () => {
  const request = mock(async () => ({}));
  const transport = new AcpxBridgeTransport({
    request,
  });

  await transport.updatePermissionPolicy?.({
    permissionMode: "approve-reads",
    nonInteractivePermissions: "deny",
    permissionPolicy: "C:/policies/weacpx-policy.json",
  });

  expect(request).toHaveBeenCalledWith("updatePermissionPolicy", {
    permissionMode: "approve-reads",
    nonInteractivePermissions: "deny",
    permissionPolicy: "C:/policies/weacpx-policy.json",
  });
});

test("ensureSession forwards onProgress invocations", async () => {
  let capturedOnEvent: ((e: { type: string; stage?: string }) => void) | undefined;
  const client = {
    request: async (_method: string, _params: unknown, onEvent?: (e: { type: string; stage?: string }) => void) => {
      capturedOnEvent = onEvent;
      capturedOnEvent?.({ type: "session.progress", stage: "spawn" });
      capturedOnEvent?.({ type: "session.progress", stage: "initializing" });
      return {};
    },
  };
  const transport = new AcpxBridgeTransport(client as never);
  const stages: string[] = [];
  await transport.ensureSession({
    alias: "a", agent: "x", workspace: "w", transportSession: "s", cwd: "/c",
  }, (stage) => stages.push(stage));
  expect(stages).toEqual(["spawn", "initializing"]);
});

// ── toolEventMode wire-format tests ─────────────────────────────────────────

test("bridge transport sends toolEventMode:'text' and no toolEvents when no onToolEvent and no explicit mode", async () => {
  let capturedParams: Record<string, unknown> = {};
  const request = mock(async (_method: string, params: Record<string, unknown>) => {
    capturedParams = params;
    return { text: "ok" };
  });
  const transport = new AcpxBridgeTransport({ request });

  await transport.prompt(session, "hello");

  expect(capturedParams.toolEventMode).toBe("text");
  expect(capturedParams).not.toHaveProperty("toolEvents");
});

test("bridge transport sends toolEventMode:'structured' and toolEvents:true when onToolEvent is provided", async () => {
  let capturedParams: Record<string, unknown> = {};
  const request = mock(async (_method: string, params: Record<string, unknown>) => {
    capturedParams = params;
    return { text: "ok" };
  });
  const transport = new AcpxBridgeTransport({ request });

  await transport.prompt(session, "hello", undefined, undefined, {
    onToolEvent: async () => {},
  });

  expect(capturedParams.toolEventMode).toBe("structured");
  expect(capturedParams.toolEvents).toBe(true);
});

test("bridge transport sends toolEventMode:'both' and toolEvents:true when explicit 'both'", async () => {
  let capturedParams: Record<string, unknown> = {};
  const request = mock(async (_method: string, params: Record<string, unknown>) => {
    capturedParams = params;
    return { text: "ok" };
  });
  const transport = new AcpxBridgeTransport({ request });

  await transport.prompt(session, "hello", undefined, undefined, {
    toolEventMode: "both",
    onToolEvent: async () => {},
  });

  expect(capturedParams.toolEventMode).toBe("both");
  expect(capturedParams.toolEvents).toBe(true);
});

test("bridge transport sends toolEventMode:'text' and no toolEvents when explicit 'text' even with onToolEvent", async () => {
  let capturedParams: Record<string, unknown> = {};
  const request = mock(async (_method: string, params: Record<string, unknown>) => {
    capturedParams = params;
    return { text: "ok" };
  });
  const transport = new AcpxBridgeTransport({ request });

  await transport.prompt(session, "hello", undefined, undefined, {
    toolEventMode: "text",
    onToolEvent: async () => {},
  });

  expect(capturedParams.toolEventMode).toBe("text");
  expect(capturedParams).not.toHaveProperty("toolEvents");
});

// ── onToolEvent chain semantics tests ───────────────────────────────────────

test("tool events are delivered to onToolEvent in event order", async () => {
  const releaseFirst = createDeferred<void>();
  const recorded: unknown[] = [];
  const request = mock(async (_method: string, _params: unknown, onEvent?: (event: { type: string; event?: unknown }) => void) => {
    onEvent?.({ type: "prompt.tool_event", event: { type: "tool_use", name: "first" } });
    onEvent?.({ type: "prompt.tool_event", event: { type: "tool_use", name: "second" } });
    return { text: "done" };
  });
  const transport = new AcpxBridgeTransport({ request });

  const promptPromise = transport.prompt(session, "hello", undefined, undefined, {
    onToolEvent: async (event) => {
      if ((event as { name?: string }).name === "first") {
        await releaseFirst.promise;
      }
      recorded.push(event);
    },
  });

  await Bun.sleep(0);
  // "first" is blocked; "second" must not have run yet (serialized)
  expect(recorded).toEqual([]);
  releaseFirst.resolve();
  await expect(promptPromise).resolves.toEqual({ text: "done" });
  expect(recorded).toEqual([
    { type: "tool_use", name: "first" },
    { type: "tool_use", name: "second" },
  ]);
});

test("prompt waits for onToolEvent handler chain to settle before resolving", async () => {
  const deferred = createDeferred<void>();
  const request = mock(async (_method: string, _params: unknown, onEvent?: (event: { type: string; event?: unknown }) => void) => {
    onEvent?.({ type: "prompt.tool_event", event: { type: "tool_use", name: "slow" } });
    return { text: "done" };
  });
  const transport = new AcpxBridgeTransport({ request });

  let promptResolved = false;
  const promptPromise = transport.prompt(session, "hello", undefined, undefined, {
    onToolEvent: async () => {
      await deferred.promise;
    },
  }).then((result) => {
    promptResolved = true;
    return result;
  });

  // Flush microtasks — the bridge request resolved but handler chain is still pending
  await Bun.sleep(5);
  expect(promptResolved).toBe(false);

  deferred.resolve();
  await expect(promptPromise).resolves.toEqual({ text: "done" });
  expect(promptResolved).toBe(true);
});

test("onToolEvent handler error rejects prompt", async () => {
  const request = mock(async (_method: string, _params: unknown, onEvent?: (event: { type: string; event?: unknown }) => void) => {
    onEvent?.({ type: "prompt.tool_event", event: { type: "tool_use", name: "boom" } });
    return { text: "done" };
  });
  const transport = new AcpxBridgeTransport({ request });

  await expect(
    transport.prompt(session, "hello", undefined, undefined, {
      onToolEvent: () => {
        throw new Error("handler blew up");
      },
    }),
  ).rejects.toThrow("handler blew up");
});

test("first onToolEvent handler error wins when multiple handlers throw", async () => {
  let callCount = 0;
  const request = mock(async (_method: string, _params: unknown, onEvent?: (event: { type: string; event?: unknown }) => void) => {
    onEvent?.({ type: "prompt.tool_event", event: { type: "tool_use", name: "e1" } });
    onEvent?.({ type: "prompt.tool_event", event: { type: "tool_use", name: "e2" } });
    return { text: "done" };
  });
  const transport = new AcpxBridgeTransport({ request });

  await expect(
    transport.prompt(session, "hello", undefined, undefined, {
      onToolEvent: () => {
        callCount += 1;
        throw new Error(`error-${callCount}`);
      },
    }),
  ).rejects.toThrow("error-1");
});

test("onToolEvent chain continues after a handler error", async () => {
  const recorded: unknown[] = [];
  const request = mock(async (_method: string, _params: unknown, onEvent?: (event: { type: string; event?: unknown }) => void) => {
    onEvent?.({ type: "prompt.tool_event", event: { type: "tool_use", name: "first" } });
    onEvent?.({ type: "prompt.tool_event", event: { type: "tool_use", name: "second" } });
    return { text: "done" };
  });
  const transport = new AcpxBridgeTransport({ request });

  await expect(
    transport.prompt(session, "hello", undefined, undefined, {
      onToolEvent: (event) => {
        recorded.push(event);
        if ((event as { name?: string }).name === "first") {
          throw new Error("first fails");
        }
      },
    }),
  ).rejects.toThrow("first fails");

  expect(recorded).toEqual([
    { type: "tool_use", name: "first" },
    { type: "tool_use", name: "second" },
  ]);
});

test("toolEventMode:text with onToolEvent — handler never called when bridge emits no tool events", async () => {
  const handlerCalls: unknown[] = [];
  const request = mock(async (_method: string, _params: unknown, _onEvent?: (event: { type: string; event?: unknown }) => void) => {
    // In text mode the bridge would never emit prompt.tool_event; simulate that.
    return { text: "ok" };
  });
  const transport = new AcpxBridgeTransport({ request });

  await expect(
    transport.prompt(session, "hello", undefined, undefined, {
      toolEventMode: "text",
      onToolEvent: async (event) => {
        handlerCalls.push(event);
      },
    }),
  ).resolves.toEqual({ text: "ok" });

  expect(handlerCalls).toEqual([]);
});

// ── R1: toolEventMode demotion when onToolEvent is absent ───────────────────

test("R1: bridge transport demotes toolEventMode:'structured' to 'text' when no onToolEvent is provided", async () => {
  let capturedParams: Record<string, unknown> = {};
  const request = mock(async (_method: string, params: Record<string, unknown>) => {
    capturedParams = params;
    return { text: "ok" };
  });
  const transport = new AcpxBridgeTransport({ request });

  await transport.prompt(session, "hello", undefined, undefined, {
    toolEventMode: "structured",
    // no onToolEvent
  });

  // Must be demoted: wire format shows 'text' and no toolEvents key.
  expect(capturedParams.toolEventMode).toBe("text");
  expect(capturedParams).not.toHaveProperty("toolEvents");
});

test("R1: bridge transport demotes toolEventMode:'both' to 'text' when no onToolEvent is provided", async () => {
  let capturedParams: Record<string, unknown> = {};
  const request = mock(async (_method: string, params: Record<string, unknown>) => {
    capturedParams = params;
    return { text: "ok" };
  });
  const transport = new AcpxBridgeTransport({ request });

  await transport.prompt(session, "hello", undefined, undefined, {
    toolEventMode: "both",
    // no onToolEvent
  });

  // Must be demoted: wire format shows 'text' and no toolEvents key.
  expect(capturedParams.toolEventMode).toBe("text");
  expect(capturedParams).not.toHaveProperty("toolEvents");
});

// ── onThought chain semantics tests ─────────────────────────────────────────

test("forwards prompt.thought events to options.onThought", async () => {
  const thoughts: string[] = [];
  const request = mock(async (_method: string, _params: unknown, onEvent?: (event: { type: string; text?: string }) => void) => {
    onEvent?.({ type: "prompt.thought", text: "considering edge cases" });
    return { text: "done" };
  });
  const transport = new AcpxBridgeTransport({ request });

  await transport.prompt(session, "hi", undefined, undefined, {
    onThought: (chunk) => { thoughts.push(chunk); },
  });

  expect(thoughts).toEqual(["considering edge cases"]);
});

test("onThought handler error rejects prompt", async () => {
  const request = mock(async (_method: string, _params: unknown, onEvent?: (event: { type: string; text?: string }) => void) => {
    onEvent?.({ type: "prompt.thought", text: "boom" });
    return { text: "done" };
  });
  const transport = new AcpxBridgeTransport({ request });

  await expect(
    transport.prompt(session, "hello", undefined, undefined, {
      onThought: () => {
        throw new Error("handler blew up");
      },
    }),
  ).rejects.toThrow("handler blew up");
});

test("first onThought handler error wins when multiple handlers throw", async () => {
  let callCount = 0;
  const request = mock(async (_method: string, _params: unknown, onEvent?: (event: { type: string; text?: string }) => void) => {
    onEvent?.({ type: "prompt.thought", text: "e1" });
    onEvent?.({ type: "prompt.thought", text: "e2" });
    return { text: "done" };
  });
  const transport = new AcpxBridgeTransport({ request });

  await expect(
    transport.prompt(session, "hello", undefined, undefined, {
      onThought: () => {
        callCount += 1;
        throw new Error(`error-${callCount}`);
      },
    }),
  ).rejects.toThrow("error-1");
});


test("bridge transport proxies native session methods", async () => {
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  const transport = new AcpxBridgeTransport({
    request: async (method, params) => {
      requests.push({ method, params });
      if (method === "listAgentSessions") {
        return { source: "agent", sessions: [{ sessionId: "thread-1" }] };
      }
      return {};
    },
  });

  await expect(transport.listAgentSessions?.({ agent: "codex", cwd: "/repo", filterCwd: "/repo" })).resolves.toEqual({
    source: "agent",
    sessions: [{ sessionId: "thread-1" }],
  });
  await transport.resumeAgentSession?.({
    alias: "project:codex",
    agent: "codex",
    workspace: "project",
    transportSession: "project:codex",
    cwd: "/repo",
  }, "thread-1");

  expect(requests).toEqual([
    { method: "listAgentSessions", params: { agent: "codex", cwd: "/repo", filterCwd: "/repo" } },
    { method: "resumeAgentSession", params: { agent: "codex", cwd: "/repo", name: "project:codex", agentSessionId: "thread-1" } },
  ]);
});
