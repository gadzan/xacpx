import { expect, test } from "bun:test";

import { TransportInvoker } from "../../../src/commands/transport-invoker";
import { createNoopAppLogger } from "../../../src/logging/app-logger";
import type { ToolUseEvent } from "../../../src/channels/types";

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
  const invoker = new TransportInvoker({
    transport,
    logger: createNoopAppLogger(),
    sessions: {},
    resolveSessionAgentCommand: async () => undefined,
    autoInstall: async () => ({ ok: false, errors: [], logPath: "" }),
    discoverPaths: async () => [],
    followClaudeBackgroundTurn: async (options) => {
      followerCalled = true;
      expect([...options.launchedToolCallIds]).toEqual(["agent-1"]);
      await options.onText?.("完整方案");
      return {
        status: "completed",
        transcriptPath: "session.jsonl",
        completedToolCallIds: ["agent-1"],
      };
    },
  } as never);

  const result = await invoker.promptTransportSession(
    {
      alias: "relay:demo",
      agent: "claude",
      driver: "claude",
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
