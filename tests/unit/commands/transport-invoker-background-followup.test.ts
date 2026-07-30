import { expect, test } from "bun:test";

import { TransportInvoker } from "../../../src/commands/transport-invoker";
import { createNoopAppLogger } from "../../../src/logging/app-logger";
import type { ToolUseEvent } from "../../../src/channels/types";
import { createBackgroundFollowupTransport } from "../../../src/transport/background-followup-transport";

test("Claude async Agent continuation stays in the same turn and forwards the recovered final", async () => {
  const replies: string[] = [];
  const toolEvents: ToolUseEvent[] = [];
  let followerCalled = false;

  const transport = {
    prompt: async (_session: unknown, _text: string, _reply: unknown, _context: unknown, options: any) => {
      await options.onToolEvent({
        toolCallId: "agent-1",
        toolName: "Research",
        kind: "think",
        isSubagent: true,
        rawOutput: [{ type: "text", text: "Async agent launched successfully. agentId: abc" }],
        status: "running",
      });
      await options.onToolEvent({
        toolCallId: "child-grep",
        toolName: "grep wechat",
        kind: "search",
        status: "running",
      });
      return { text: "" };
    },
    getAgentSessionId: async () => "claude-session",
  };
  const logger = createNoopAppLogger();
  const wrappedTransport = createBackgroundFollowupTransport(transport as never, {
    logger,
    followBackgroundTurn: async (options) => {
      followerCalled = true;
      expect([...options.launchedToolCallIds]).toEqual(["agent-1"]);
      expect([...options.subagentIdsByToolCallId ?? []]).toEqual([["agent-1", "abc"]]);
      await options.onText?.("完整方案");
      return {
        status: "completed",
        transcriptPath: "session.jsonl",
        completedToolCallIds: ["agent-1"],
        failedToolCallIds: [],
      };
    },
  });
  const invoker = new TransportInvoker({
    transport: wrappedTransport,
    logger,
    sessions: {},
    resolveSessionAgentCommand: async () => undefined,
    autoInstall: async () => ({ ok: false, errors: [], logPath: "" }),
    discoverPaths: async () => [],
  } as never);

  const result = await invoker.promptTransportSession(
    {
      alias: "relay:demo",
      agent: "claude",
      workspace: "demo",
      cwd: "E:\\projects\\demo",
      transportSession: "demo:relay:demo",
    },
    "plan it",
    async (text) => { replies.push(text); },
    undefined,
    undefined,
    undefined,
    (event) => { toolEvents.push(event); },
  );

  expect(result).toEqual({ text: "" });
  expect(followerCalled).toBe(true);
  expect(replies).toEqual(["完整方案"]);
  expect(toolEvents.find((event) => event.toolCallId === "agent-1" && event.status === "success")).toBeTruthy();
  expect(toolEvents.find((event) => event.toolCallId === "child-grep" && event.status === "success")).toBeTruthy();
});

test("a failed Claude Agent closes its still-running child tools as errors", async () => {
  const toolEvents: ToolUseEvent[] = [];
  const logger = createNoopAppLogger();
  const transport = createBackgroundFollowupTransport({
    prompt: async (_session: unknown, _text: string, _reply: unknown, _context: unknown, options: any) => {
      await options.onToolEvent({
        toolCallId: "agent-1",
        toolName: "Research",
        kind: "think",
        isSubagent: true,
        rawOutput: { status: "async_launched", agentId: "abc" },
        status: "running",
      });
      await options.onToolEvent({
        toolCallId: "child-grep",
        parentToolCallId: "agent-1",
        toolName: "grep wechat",
        kind: "search",
        status: "running",
      });
      return { text: "" };
    },
    getAgentSessionId: async () => "claude-session",
  } as never, {
    logger,
    followBackgroundTurn: async () => ({
      status: "completed",
      transcriptPath: "session.jsonl",
      completedToolCallIds: ["agent-1"],
      failedToolCallIds: ["agent-1"],
    }),
  });
  const invoker = new TransportInvoker({
    transport,
    logger,
    sessions: {},
    resolveSessionAgentCommand: async () => undefined,
    autoInstall: async () => ({ ok: false, errors: [], logPath: "" }),
    discoverPaths: async () => [],
  } as never);

  await invoker.promptTransportSession(
    { alias: "relay:demo", agent: "claude", workspace: "demo", cwd: "E:\\projects\\demo", transportSession: "demo:relay:demo" },
    "plan it",
    async () => {},
    undefined,
    undefined,
    undefined,
    (event) => { toolEvents.push(event); },
  );

  expect([...toolEvents].reverse().find((event) => event.toolCallId === "agent-1")?.status).toBe("error");
  expect([...toolEvents].reverse().find((event) => event.toolCallId === "child-grep")?.status).toBe("error");
});

test("a failed top-level Claude Agent closes nested descendants as errors", async () => {
  const toolEvents: ToolUseEvent[] = [];
  const logger = createNoopAppLogger();
  const transport = createBackgroundFollowupTransport({
    prompt: async (_session: unknown, _text: string, _reply: unknown, _context: unknown, options: any) => {
      for (const event of [
        { toolCallId: "agent-1", toolName: "Agent", kind: "think", isSubagent: true, rawOutput: { status: "async_launched", agentId: "abc" }, status: "running" },
        { toolCallId: "agent-2", parentToolCallId: "agent-1", toolName: "Agent", kind: "think", isSubagent: true, status: "running" },
        { toolCallId: "nested-read", parentToolCallId: "agent-2", toolName: "Read", kind: "read", status: "running" },
      ] as ToolUseEvent[]) await options.onToolEvent(event);
      return { text: "" };
    },
    getAgentSessionId: async () => "claude-session",
  } as never, {
    logger,
    followBackgroundTurn: async () => ({
      status: "completed",
      transcriptPath: "session.jsonl",
      completedToolCallIds: ["agent-1"],
      failedToolCallIds: ["agent-1"],
    }),
  });
  const invoker = new TransportInvoker({
    transport,
    logger,
    sessions: {},
    resolveSessionAgentCommand: async () => undefined,
    autoInstall: async () => ({ ok: false, errors: [], logPath: "" }),
    discoverPaths: async () => [],
  } as never);

  await invoker.promptTransportSession(
    { alias: "relay:demo", agent: "claude", workspace: "demo", cwd: "E:\\projects\\demo", transportSession: "demo:relay:demo" },
    "plan it",
    async () => {},
    undefined,
    undefined,
    undefined,
    (event) => { toolEvents.push(event); },
  );

  expect([...toolEvents].reverse().find((event) => event.toolCallId === "agent-2")?.status).toBe("error");
  expect([...toolEvents].reverse().find((event) => event.toolCallId === "nested-read")?.status).toBe("error");
});

test("the background follow-up decorator preserves optional transport capabilities and binding", async () => {
  let disposed = false;
  const delegate = {
    marker: "delegate",
    prompt: async () => ({ text: "ok" }),
    async dispose(this: { marker: string }) {
      expect(this.marker).toBe("delegate");
      disposed = true;
    },
  };
  const transport = createBackgroundFollowupTransport(delegate as never, {
    logger: createNoopAppLogger(),
  });

  expect(transport.dispose).toBeDefined();
  await transport.dispose?.();
  expect(disposed).toBe(true);
});

test("a qoder session follows its background continuation with the qoder driver", async () => {
  const replies: string[] = [];
  let followedDriver: string | undefined;
  const transport = createBackgroundFollowupTransport({
    prompt: async (_session: unknown, _text: string, _reply: unknown, _context: unknown, options: any) => {
      await options.onToolEvent({
        toolCallId: "agent-1",
        toolName: "Agent",
        kind: "think",
        isSubagent: true,
        rawOutput: { status: "async_launched", agentId: "ageneral-purpose-abc" },
        status: "running",
      });
      return { text: "" };
    },
    getAgentSessionId: async () => "qoder-session",
  } as never, {
    logger: createNoopAppLogger(),
    resolveDriver: () => " Qoder ",
    followBackgroundTurn: async (options) => {
      followedDriver = options.driver;
      await options.onText?.("后台任务完成后的最终答复");
      return {
        status: "completed",
        transcriptPath: "session.jsonl",
        completedToolCallIds: ["agent-1"],
        failedToolCallIds: [],
      };
    },
  });

  await transport.prompt(
    { alias: "relay:demo", agent: "qoder", workspace: "demo", cwd: "/tmp/demo", transportSession: "demo:relay:demo" } as never,
    "plan it",
    async (text: string) => { replies.push(text); },
    undefined,
    { onToolEvent: async () => {} } as never,
  );

  expect(followedDriver).toBe("qoder");
  expect(replies).toEqual(["后台任务完成后的最终答复"]);
});

test("an unsupported driver never starts the background follow-up", async () => {
  let followerCalled = false;
  const transport = createBackgroundFollowupTransport({
    prompt: async (_session: unknown, _text: string, _reply: unknown, _context: unknown, options: any) => {
      await options.onToolEvent({
        toolCallId: "agent-1",
        toolName: "Agent",
        kind: "think",
        isSubagent: true,
        rawOutput: { status: "async_launched", agentId: "abc" },
        status: "running",
      });
      return { text: "" };
    },
    getAgentSessionId: async () => "codex-session",
  } as never, {
    logger: createNoopAppLogger(),
    resolveDriver: () => "codex",
    followBackgroundTurn: async () => {
      followerCalled = true;
      return { status: "completed", completedToolCallIds: [], failedToolCallIds: [] };
    },
  });

  await transport.prompt(
    { alias: "relay:demo", agent: "codex", workspace: "demo", cwd: "/tmp/demo", transportSession: "demo:relay:demo" } as never,
    "plan it",
    async () => {},
    undefined,
    { onToolEvent: async () => {} } as never,
  );

  expect(followerCalled).toBe(false);
});

test("a non-subagent tool whose output quotes the launch payload never starts the follow-up", async () => {
  let followerCalled = false;
  const transport = createBackgroundFollowupTransport({
    prompt: async (_session: unknown, _text: string, _reply: unknown, _context: unknown, options: any) => {
      await options.onToolEvent({
        toolCallId: "read-1",
        toolName: "Read",
        kind: "read",
        rawOutput: { status: "async_launched", agentId: "abc" },
        status: "success",
      });
      return { text: "" };
    },
    getAgentSessionId: async () => "claude-session",
  } as never, {
    logger: createNoopAppLogger(),
    resolveDriver: () => "claude",
    followBackgroundTurn: async () => {
      followerCalled = true;
      return { status: "completed", completedToolCallIds: [], failedToolCallIds: [] };
    },
  });

  await transport.prompt(
    { alias: "relay:demo", agent: "claude", workspace: "demo", cwd: "/tmp/demo", transportSession: "demo:relay:demo" } as never,
    "plan it",
    async () => {},
    undefined,
    { onToolEvent: async () => {} } as never,
  );

  expect(followerCalled).toBe(false);
});
