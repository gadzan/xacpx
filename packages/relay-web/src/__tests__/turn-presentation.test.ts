import { describe, expect, it } from "vitest";
import type { PeerMessageHistoryEntry, ToolStepDto, TurnPartDto } from "@ganglion/xacpx-relay-protocol";
import { deriveTurnPresentation, type TurnPresentationOptions } from "../lib/turn-presentation";

const tool = (id: string): ToolStepDto => ({
  toolCallId: id,
  toolName: "Read",
  kind: "read",
  status: "success",
  title: `${id}.ts`,
});

const visibleShape = (parts: TurnPartDto[], opts?: TurnPresentationOptions) =>
  deriveTurnPresentation(parts, opts).map((item) => {
    if (item.type === "text") return { type: item.type, text: item.text };
    if (item.type === "reasoning") return { type: item.type, text: item.text };
    if (item.type === "agent-message") return { type: item.type, id: item.message.messageId, anchor: item.anchorToolCallId };
    return { type: item.type, id: item.step.toolCallId };
  });

describe("deriveTurnPresentation", () => {
  it("does not let a tool event split one narrative paragraph", () => {
    expect(visibleShape([
      { type: "text", text: "before " },
      { type: "tool", step: tool("read-1") },
      { type: "text", text: "after" },
    ])).toEqual([
      { type: "text", text: "before after" },
      { type: "tool", id: "read-1" },
    ]);
  });

  it("places a tool at the semantic paragraph boundary inserted by the transport", () => {
    expect(visibleShape([
      { type: "text", text: "before\n\n" },
      { type: "tool", step: tool("read-1") },
      { type: "text", text: "after" },
    ])).toEqual([
      { type: "text", text: "before\n\n" },
      { type: "tool", id: "read-1" },
      { type: "text", text: "after" },
    ]);
  });

  it("does not split a Markdown list at a blank line between its items", () => {
    expect(visibleShape([
      { type: "text", text: "- one\n" },
      { type: "tool", step: tool("read-1") },
      { type: "text", text: "\n- two" },
    ])).toEqual([
      { type: "text", text: "- one\n\n- two" },
      { type: "tool", id: "read-1" },
    ]);
  });

  it("does not split a fenced code block at an internal blank line", () => {
    expect(visibleShape([
      { type: "text", text: "```ts\nconst a = 1;\n" },
      { type: "tool", step: tool("read-1") },
      { type: "text", text: "\nconst b = 2;\n```\n\nafter" },
    ])).toEqual([
      { type: "text", text: "```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n" },
      { type: "tool", id: "read-1" },
      { type: "text", text: "after" },
    ]);
  });

  it("does not split a Markdown table while rows are still arriving", () => {
    expect(visibleShape([
      { type: "text", text: "| a | b |\n| - | - |\n" },
      { type: "tool", step: tool("read-1") },
      { type: "text", text: "| 1 | 2 |\n\nafter" },
    ])).toEqual([
      { type: "text", text: "| a | b |\n| - | - |\n| 1 | 2 |\n\n" },
      { type: "tool", id: "read-1" },
      { type: "text", text: "after" },
    ]);
  });

  it("treats a single line break as part of the same Markdown paragraph", () => {
    expect(visibleShape([
      { type: "text", text: "line one\n" },
      { type: "tool", step: tool("read-1") },
      { type: "text", text: "line two" },
    ])).toEqual([
      { type: "text", text: "line one\nline two" },
      { type: "tool", id: "read-1" },
    ]);
  });

  it("shows a leading tool before narrative when only whitespace preceded it", () => {
    expect(visibleShape([
      { type: "text", text: " \n" },
      { type: "tool", step: tool("read-1") },
      { type: "text", text: "after" },
    ])).toEqual([
      { type: "tool", id: "read-1" },
      { type: "text", text: " \nafter" },
    ]);
  });

  it("folds child tools into their parent subagent activity", () => {
    const parent: ToolStepDto = {
      ...tool("agent-1"),
      toolName: "Task",
      kind: "think",
      isSubagent: true,
    };
    const child: ToolStepDto = {
      ...tool("read-child"),
      parentToolCallId: parent.toolCallId,
    };

    expect(visibleShape([
      { type: "tool", step: parent },
      { type: "tool", step: child },
    ])).toEqual([
      { type: "subagent", id: "agent-1" },
    ]);
  });

  const sentEntry = (messageId: string): PeerMessageHistoryEntry => ({
    kind: "agent_message",
    direction: "sent",
    messageId,
    conversationId: `conv_${messageId}`,
    peer: { handle: "agent:node_2:endpoint_b", displayName: "Worker B", agent: "codex" },
    content: `hello from ${messageId}`,
    createdAt: 1771234567890,
    status: "sent",
  });
  const sendStep = (id: string, messageId?: string): ToolStepDto => ({
    toolCallId: id,
    toolName: "agent_send",
    kind: "other",
    status: "success",
    title: "agent_send",
    ...(messageId ? { agentMessageId: messageId } : {}),
  });

  it("anchors a sent peer-message card immediately after its agent_send tool step", () => {
    const entry = sentEntry("m1");
    const items = deriveTurnPresentation(
      [
        { type: "text", text: "before\n\n" },
        { type: "tool", step: sendStep("send-1", "m1") },
        { type: "text", text: "after" },
      ],
      { sentAgentMessageById: new Map([["m1", entry]]) },
    );
    expect(items.map((item) => item.type)).toEqual(["text", "tool", "agent-message", "text"]);
    const card = items[2]!;
    expect(card.type).toBe("agent-message");
    if (card.type === "agent-message") {
      expect(card.message).toBe(entry);
      expect(card.anchorToolCallId).toBe("send-1");
      expect(card.key).toBe("agent-message:m1");
      expect(card.isLatest).toBe(false);
    }
  });

  it("emits no agent-message item without a composition map", () => {
    expect(visibleShape([
      { type: "text", text: "before\n\n" },
      { type: "tool", step: sendStep("send-1", "m1") },
      { type: "text", text: "after" },
    ])).toEqual([
      { type: "text", text: "before\n\n" },
      { type: "tool", id: "send-1" },
      { type: "text", text: "after" },
    ]);
  });

  it("emits no agent-message item when the map has no entry for the step's message id", () => {
    expect(visibleShape(
      [{ type: "tool", step: sendStep("send-1", "m1") }],
      { sentAgentMessageById: new Map([["other", sentEntry("other")]]) },
    )).toEqual([{ type: "tool", id: "send-1" }]);
  });

  it("anchors two sends in tool order (no swap)", () => {
    expect(visibleShape(
      [
        { type: "tool", step: sendStep("send-1", "m1") },
        { type: "tool", step: sendStep("send-2", "m2") },
      ],
      {
        sentAgentMessageById: new Map([
          ["m1", sentEntry("m1")],
          ["m2", sentEntry("m2")],
        ]),
      },
    )).toEqual([
      { type: "tool", id: "send-1" },
      { type: "agent-message", id: "m1", anchor: "send-1" },
      { type: "tool", id: "send-2" },
      { type: "agent-message", id: "m2", anchor: "send-2" },
    ]);
  });

  it("never anchors a received-direction entry (receiver cards stay standalone)", () => {
    const received: PeerMessageHistoryEntry = { ...sentEntry("m1"), direction: "received", status: "delivered" };
    expect(visibleShape(
      [{ type: "tool", step: sendStep("send-1", "m1") }],
      { sentAgentMessageById: new Map([["m1", received]]) },
    )).toEqual([{ type: "tool", id: "send-1" }]);
  });

  it("anchors a subagent-carried send after the subagent activity", () => {
    const parent: ToolStepDto = { ...tool("agent-1"), toolName: "Task", kind: "think", isSubagent: true };
    const child = { ...sendStep("send-child", "m1"), parentToolCallId: parent.toolCallId };
    expect(visibleShape(
      [
        { type: "tool", step: parent },
        { type: "tool", step: child },
      ],
      { sentAgentMessageById: new Map([["m1", sentEntry("m1")]]) },
    )).toEqual([
      { type: "subagent", id: "agent-1" },
      { type: "agent-message", id: "m1", anchor: "send-child" },
    ]);
  });

  it("anchors a repeated message id only once", () => {
    expect(visibleShape(
      [
        { type: "tool", step: sendStep("send-1", "m1") },
        { type: "tool", step: sendStep("send-2", "m1") },
      ],
      { sentAgentMessageById: new Map([["m1", sentEntry("m1")]]) },
    )).toEqual([
      { type: "tool", id: "send-1" },
      { type: "agent-message", id: "m1", anchor: "send-1" },
      { type: "tool", id: "send-2" },
    ]);
  });
});
