/**
 * Real-seam anchoring gate for Agent Messaging v0.3 presentation correlation.
 *
 * Regression: in production the sent agent-message card rendered as a standalone
 * row at the TOP of the transcript because the correlation join never fired —
 * ToolUseEvent.toolName carries the ACP DISPLAY title (e.g. "Send peer message
 * to Worker B"), not the MCP machine tool name, so the agent_send branch in
 * tool-presentation never executed. The prior unit tests hand-forged
 * toolName:"agent_send" and bypassed the transport seam entirely.
 *
 * This gate chains the REAL components:
 *
 *   real xacpx MCP server (InMemoryTransport) → agent_send CallToolResult
 *   → representative ACP tool_call / tool_call_update frames per driver
 *   → createStreamingPromptState → ToolUseEvent
 *   → toolUseEventToStepDto → step.agentMessageId === receipt.messageId
 *
 * Drivers covered: Claude (machine name in _meta.claudeCode.toolName, receipt in
 * toolResponse) and Codex (no machine name; title carries the tool name; the
 * adapter dropped structuredContent and only forwarded text — recovered via the
 * versioned receipt marker).
 */
import { expect, test } from "bun:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  createStreamingPromptState,
  parseStreamingChunks,
} from "../../../../src/transport/streaming-prompt";
import type { ToolUseEvent } from "../../../../src/channels/types";
import { createXacpxMcpServer } from "../../../../src/mcp/xacpx-mcp-server";
import { createMemoryTransport } from "../../../../src/mcp/xacpx-mcp-transport";
import { toolUseEventToStepDto } from "../../../../packages/channel-relay/src/tool-presentation";

const RECEIPT = {
  messageId: "msg_seam_1",
  status: "queued" as const,
  modeUsed: "queue" as const,
  route: "local" as const,
};

/** Real MCP agent_send result through the actual server + SDK client. */
async function callRealAgentSend(): Promise<{
  structuredContent: unknown;
  text: string;
}> {
  const server = createXacpxMcpServer({
    transport: createMemoryTransport(async () => null, {
      sendAgentMessage: async () => RECEIPT,
    }),
    coordinatorSession: "backend:main",
  });
  const client = new Client({ name: "seam-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = (await client.callTool({
      name: "agent_send",
      arguments: { to: "agent:node-local:endpoint-peer", message: "ping" },
    })) as unknown as {
      structuredContent?: unknown;
      content?: Array<{ type: string; text?: string }>;
    };
    return {
      structuredContent: result.structuredContent,
      text: result.content?.find((b) => b.type === "text")?.text ?? "",
    };
  } finally {
    await client.close();
    await server.close();
  }
}

/** Drive ACP session/update frames through the real streaming-prompt state. */
function streamAcpFrames(
  driver: string | undefined,
  frames: Array<Record<string, unknown>>,
): ToolUseEvent[] {
  const events: ToolUseEvent[] = [];
  const state = createStreamingPromptState(false, {
    driver,
    onToolEvent: (e) => {
      events.push(e);
    },
  });
  for (const update of frames) {
    parseStreamingChunks(
      state,
      JSON.stringify({ method: "session/update", params: { update } }),
    );
  }
  return events;
}

test("real MCP agent_send result carries structuredContent AND the versioned text marker", async () => {
  const result = await callRealAgentSend();
  expect(result.structuredContent).toEqual(RECEIPT);
  const marker = result.text.match(/xacpx-agent-send-receipt:v1 (\{[^\n]*\})/);
  expect(marker?.[1]).toBeDefined();
  expect(JSON.parse(marker![1]!)).toEqual({
    messageId: RECEIPT.messageId,
    status: RECEIPT.status,
  });
});

test("Claude seam: display title ≠ agent_send, machine name in _meta.claudeCode.toolName — step still anchors", async () => {
  const result = await callRealAgentSend();
  const events = streamAcpFrames(undefined, [
    {
      sessionUpdate: "tool_call",
      toolCallId: "toolu_as_1",
      kind: "other",
      // Display title is a human phrase — this is what broke production.
      title: "Send peer message to Worker B",
      rawInput: { to: "agent:node-local:endpoint-peer", message: "ping" },
      status: "pending",
      _meta: { claudeCode: { toolName: "mcp__xacpx__agent_send" } },
    },
    {
      // Sparse terminal frame: claude-agent-acp delivers the MCP result via
      // toolResponse with status omitted.
      sessionUpdate: "tool_call_update",
      toolCallId: "toolu_as_1",
      _meta: {
        claudeCode: {
          toolName: "mcp__xacpx__agent_send",
          toolResponse: result.structuredContent,
        },
      },
    },
  ]);

  const terminal = events.at(-1)!;
  expect(terminal.toolName).toBe("Send peer message to Worker B"); // display stays display
  expect(terminal.machineToolName).toBe("mcp__xacpx__agent_send");
  expect(terminal.status).toBe("success");

  const step = toolUseEventToStepDto(terminal);
  expect(step.agentMessageId).toBe(RECEIPT.messageId);
});

test("Codex seam (real codex-acp shape): title mcp.server.tool, rawInput {server,tool}, receipt under rawOutput.result — anchors via structuredContent", async () => {
  const result = await callRealAgentSend();
  // Exact codex-acp createMcpToolCallUpdate frame shape (verified against
  // @agentclientprotocol/codex-acp): title `mcp.${server}.${tool}`,
  // rawInput {server, tool, arguments}, rawOutput {result, error},
  // _meta {is_mcp_tool_call: true}.
  const events = streamAcpFrames("codex", [
    {
      sessionUpdate: "tool_call",
      toolCallId: "call_as_1",
      kind: "other",
      title: "mcp.xacpx.agent_send",
      rawInput: {
        server: "xacpx",
        tool: "agent_send",
        arguments: { to: "agent:node-local:endpoint-peer", message: "ping" },
      },
      status: "pending",
      _meta: { is_mcp_tool_call: true },
    },
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "call_as_1",
      status: "completed",
      rawOutput: {
        result: {
          content: [{ type: "text", text: result.text }],
          structuredContent: result.structuredContent,
        },
        error: null,
      },
      _meta: { is_mcp_tool_call: true },
    },
  ]);

  const terminal = events.at(-1)!;
  // Display title is the dotted mcp.server.tool phrase — it must NOT match the
  // agent_send correlation on its own.
  expect(terminal.toolName).toBe("mcp.xacpx.agent_send");
  // The stable identity comes from rawInput.tool.
  expect(terminal.machineToolName).toBe("agent_send");
  expect(terminal.status).toBe("success");

  const step = toolUseEventToStepDto(terminal);
  expect(step.agentMessageId).toBe(RECEIPT.messageId);
});

test("Codex seam, structuredContent dropped: the versioned marker under rawOutput.result.content anchors", async () => {
  const result = await callRealAgentSend();
  const events = streamAcpFrames("codex", [
    {
      sessionUpdate: "tool_call",
      toolCallId: "call_as_2",
      kind: "other",
      title: "mcp.xacpx.agent_send",
      rawInput: { server: "xacpx", tool: "agent_send", arguments: { to: "agent:node-local:endpoint-peer", message: "ping" } },
      status: "pending",
      _meta: { is_mcp_tool_call: true },
    },
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "call_as_2",
      status: "completed",
      // Adapter variant that drops structuredContent: only the text content
      // survives inside result.content, carrying the versioned marker.
      rawOutput: {
        result: { content: [{ type: "text", text: result.text }] },
        error: null,
      },
      _meta: { is_mcp_tool_call: true },
    },
  ]);

  const step = toolUseEventToStepDto(events.at(-1)!);
  expect(step.agentMessageId).toBe(RECEIPT.messageId);
});

test("Codex non-MCP tools (title is the machine name) keep bare-name correlation", async () => {
  const result = await callRealAgentSend();
  const events = streamAcpFrames("codex", [
    {
      sessionUpdate: "tool_call",
      toolCallId: "call_as_3",
      kind: "other",
      // Dynamic (non-MCP) codex tools report the bare tool name as title and
      // no {server,tool} rawInput — display fallback stays valid.
      title: "agent_send",
      rawInput: { arguments: { to: "agent:node-local:endpoint-peer", message: "ping" } },
      status: "completed",
      rawOutput: { result: { content: [{ type: "text", text: result.text }] }, error: null },
    },
  ]);
  const step = toolUseEventToStepDto(events.at(-1)!);
  expect(step.agentMessageId).toBe(RECEIPT.messageId);
});

test("late-join regression: running frame (no receipt) → sparse terminal frame (receipt) gains agentMessageId on the same toolCallId", async () => {
  const result = await callRealAgentSend();
  // ONE state across both frames — the turn is running when the receipt lands.
  const collected: ToolUseEvent[] = [];
  const state = createStreamingPromptState(false, {
    driver: undefined,
    onToolEvent: (e) => {
      collected.push(e);
    },
  });
  const send = (update: Record<string, unknown>) =>
    parseStreamingChunks(
      state,
      JSON.stringify({ method: "session/update", params: { update } }),
    );

  send({
    sessionUpdate: "tool_call",
    toolCallId: "toolu_as_late",
    kind: "other",
    title: "Send peer message to Worker B",
    rawInput: { to: "agent:node-local:endpoint-peer", message: "ping" },
    status: "pending",
    _meta: { claudeCode: { toolName: "mcp__xacpx__agent_send" } },
  });
  // While the MCP call is in flight there is no receipt yet.
  const running = toolUseEventToStepDto(collected.at(-1)!);
  expect(running.status).toBe("running");
  expect(running.agentMessageId).toBeUndefined();

  // The sparse terminal update lands with the receipt — the SAME toolCallId
  // replaces the running step and must now carry agentMessageId.
  send({
    sessionUpdate: "tool_call_update",
    toolCallId: "toolu_as_late",
    _meta: {
      claudeCode: {
        toolName: "mcp__xacpx__agent_send",
        toolResponse: result.structuredContent,
      },
    },
  });
  const terminalStep = toolUseEventToStepDto(collected.at(-1)!);
  expect(terminalStep.toolCallId).toBe("toolu_as_late");
  expect(terminalStep.agentMessageId).toBe(RECEIPT.messageId);
});

test("a display title that merely MENTIONS agent_send never correlates when the machine name says otherwise", () => {
  const step = toolUseEventToStepDto({
    toolCallId: "t",
    toolName: "Call agent_send for updates",
    machineToolName: "WebSearch",
    kind: "other",
    status: "success",
    rawOutput: {
      structuredContent: { messageId: RECEIPT.messageId, status: "queued" },
    },
  });
  expect(step.agentMessageId).toBeUndefined();
});
