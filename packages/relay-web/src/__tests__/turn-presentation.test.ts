import { describe, expect, it } from "vitest";
import type { PeerMessageHistoryEntry, ToolStepDto, TurnPartDto } from "@ganglion/xacpx-relay-protocol";
import { deriveTurnPresentation, extractCollapsedTraceSummary, type TurnPresentationOptions } from "../lib/turn-presentation";
import { createTurnLayoutGeometryCache } from "../lib/turn-layout";

const tool = (id: string): ToolStepDto => ({
  toolCallId: id,
  toolName: "Read",
  kind: "read",
  status: "success",
  title: `${id}.ts`,
});

const visibleShape = (parts: TurnPartDto[], opts?: TurnPresentationOptions) =>
  deriveTurnPresentation(parts, opts).nodes.map((item) => {
    if (item.type === "markdown") return { type: "text", text: item.source };
    if (item.type === "reasoning") return { type: item.type, text: item.text };
    if (item.type === "agent-message") return { type: item.type, id: item.message.messageId, anchor: item.anchorToolCallId };
    return { type: item.type, id: item.step.toolCallId };
  });

describe("deriveTurnPresentation", () => {
  it("reuses layout geometry when only a tool payload changes", () => {
    const layoutCache = createTurnLayoutGeometryCache();
    const running = tool("read-1");
    running.status = "running";
    const success = { ...running, status: "success" as const };
    const parts = (step: ToolStepDto): TurnPartDto[] => [
      { type: "text", text: "before " },
      { type: "tool", step },
      { type: "text", text: "after" },
    ];

    const first = deriveTurnPresentation(parts(running), { layoutCache });
    const second = deriveTurnPresentation(parts(success), { layoutCache });

    expect(second.layout).toBe(first.layout);
    const firstTool = first.nodes.find((node) => node.type === "tool");
    const secondTool = second.nodes.find((node) => node.type === "tool");
    expect(firstTool?.type === "tool" && firstTool.step.status).toBe("running");
    expect(secondTool?.type === "tool" && secondTool.step.status).toBe("success");
  });

  it("uses a single Markdown node for the zero-activity fast path", () => {
    const presentation = deriveTurnPresentation([
      { type: "text", text: "first " },
      { type: "text", text: "**second**" },
    ]);

    expect(presentation.layout.activityPlacements.size).toBe(0);
    expect(presentation.nodes).toHaveLength(1);
    expect(presentation.nodes[0]?.type).toBe("markdown");
    expect(presentation.nodes[0]?.type === "markdown" && presentation.nodes[0].html)
      .toContain("<strong>second</strong>");
  });

  it("keeps repeated plain-text progress updates interleaved with their tools", () => {
    expect(visibleShape([
      { type: "text", text: "plan: inspect the reap target" },
      { type: "tool", step: tool("read-1") },
      { type: "text", text: "plan: inspect the reap target" },
      { type: "tool", step: tool("read-2") },
      { type: "text", text: "plan: inspect the reap target" },
      { type: "tool", step: tool("edit-1") },
      { type: "text", text: "High 修完，继续检查。" },
    ])).toEqual([
      { type: "text", text: "plan: inspect the reap target" },
      { type: "tool", id: "read-1" },
      { type: "text", text: "plan: inspect the reap target" },
      { type: "tool", id: "read-2" },
      { type: "text", text: "plan: inspect the reap target" },
      { type: "tool", id: "edit-1" },
      { type: "text", text: "High 修完，继续检查。" },
    ]);
  });

  it("keeps progress interleaved before a later Markdown result block", () => {
    expect(visibleShape([
      { type: "text", text: "plan A " },
      { type: "tool", step: tool("read-1") },
      { type: "text", text: "plan B" },
      { type: "tool", step: tool("read-2") },
      { type: "text", text: "\n\n## Result\nDone" },
    ])).toEqual([
      { type: "text", text: "plan A " },
      { type: "tool", id: "read-1" },
      { type: "text", text: "plan B" },
      { type: "tool", id: "read-2" },
      { type: "text", text: "\n\n## Result\nDone" },
    ]);
  });

  it("keeps a tool event at a safe plain-text paragraph offset", () => {
    expect(visibleShape([
      { type: "text", text: "before " },
      { type: "tool", step: tool("read-1") },
      { type: "text", text: "after" },
    ])).toEqual([
      { type: "text", text: "before " },
      { type: "tool", id: "read-1" },
      { type: "text", text: "after" },
    ]);
  });

  it("interleaves without reparsing a heading-like suffix", () => {
    const parts: TurnPartDto[] = [
      { type: "text", text: "before " },
      { type: "tool", step: tool("read-1") },
      { type: "text", text: "# not a heading" },
    ];
    expect(visibleShape(parts)).toEqual([
      { type: "text", text: "before " },
      { type: "tool", id: "read-1" },
      { type: "text", text: "# not a heading" },
    ]);
    const markdown = deriveTurnPresentation(parts).nodes
      .filter((node) => node.type === "markdown");
    expect(markdown[1]!.html).toContain("<p># not a heading</p>");
    expect(markdown[1]!.html).not.toContain("<h1>");
  });

  it("interleaves without normalizing a pipe-prose suffix into a table", () => {
    expect(visibleShape([
      { type: "text", text: "Progress: " },
      { type: "tool", step: tool("read-1") },
      { type: "text", text: "| a | b |\n| 1 | 2 |" },
    ])).toEqual([
      { type: "text", text: "Progress: " },
      { type: "tool", id: "read-1" },
      { type: "text", text: "| a | b |\n| 1 | 2 |" },
    ]);
  });

  it("keeps streaming activity exact while marker-aware remend heals the paragraph", () => {
    const incomplete: TurnPartDto[] = [
      { type: "text", text: "Working **carefully " },
      { type: "tool", step: tool("read-1") },
      { type: "text", text: "now" },
    ];
    const completed: TurnPartDto[] = [
      ...incomplete.slice(0, -1),
      { type: "text", text: "now** done" },
    ];
    const expectedIncomplete = [
      { type: "text", text: "Working **carefully " },
      { type: "tool", id: "read-1" },
      { type: "text", text: "now" },
    ];
    const expectedCompleted = [
      { type: "text", text: "Working **carefully " },
      { type: "tool", id: "read-1" },
      { type: "text", text: "now** done" },
    ];

    expect(visibleShape(incomplete, { streaming: true })).toEqual(expectedIncomplete);
    expect(visibleShape(completed, { streaming: true })).toEqual(expectedCompleted);
  });

  it("renders a reference-dependent paragraph from the shared document env", () => {
    const parts: TurnPartDto[] = [
      { type: "text", text: "See [docs][ref]" },
      { type: "tool", step: tool("read-1") },
      { type: "text", text: "\n\n[ref]: https://example.com" },
    ];
    expect(visibleShape(parts)).toEqual([
      { type: "text", text: "See [docs][ref]" },
      { type: "tool", id: "read-1" },
    ]);
    const markdown = deriveTurnPresentation(parts).nodes.find((node) => node.type === "markdown");
    expect(markdown?.type === "markdown" && markdown.html).toContain('href="https://example.com"');
  });

  it("keeps a reference link alive when table normalization forces a block reparse", () => {
    // The first paragraph needs table normalization (missing delimiter row),
    // which forces renderAtomicBlock down the standalone-reparse path; without
    // the document env the [docs][ref] link would render as literal text.
    const parts: TurnPartDto[] = [
      { type: "text", text: "See [docs][ref]\n| a | b |\n| 1 | 2 |" },
      { type: "tool", step: tool("read-1") },
      { type: "text", text: " plus tail\n\n[ref]: https://example.com\n\nfinal" },
    ];
    const markdown = deriveTurnPresentation(parts).nodes
      .filter((node) => node.type === "markdown");
    expect(markdown.length).toBeGreaterThan(0);
    expect(markdown.some((node) => node.type === "markdown" && node.html.includes('href="https://example.com"'))).toBe(true);
  });

  it("copies the displayed final reply instead of a raw broken fragment", () => {
    const presentation = deriveTurnPresentation([
      { type: "text", text: "I'll inspect **this " },
      { type: "tool", step: tool("read-1") },
      { type: "text", text: "carefully**. Fixed." },
    ]);
    const hidden = presentation.nodes.filter((node) => node.type === "markdown");
    expect(hidden.length).toBeGreaterThan(0);
    expect(presentation.finalReplyNodes.map((node) => node.source).join("")).toContain("carefully**. Fixed.");
    expect(presentation.finalReplyNodes.map((node) => node.copyText).join("")).toBe("carefully. Fixed.");
    expect(presentation.finalReplyNodes.map((node) => node.copyText).join("")).not.toContain("**");
  });

  it("copies an image-only final reply as its alt text instead of nothing", () => {
    const parts: TurnPartDto[] = [
      { type: "text", text: "Before " },
      { type: "tool", step: tool("read-1") },
      { type: "text", text: "![plot](https://example.com/p.png)" },
    ];
    const presentation = deriveTurnPresentation(parts);
    expect(presentation.finalReplyNodes.map((node) => node.source).join(""))
      .toBe("![plot](https://example.com/p.png)");
    expect(presentation.finalReplyNodes.map((node) => node.copyText).join("")).toBe("plot");
    expect(extractCollapsedTraceSummary(parts).finalReplyText).toBe("plot");
  });

  it("copies a reference link label without leaking its definition", () => {
    const parts: TurnPartDto[] = [
      { type: "text", text: "See [docs][ref]" },
      { type: "tool", step: tool("read-1") },
      { type: "text", text: " now\n\n[ref]: https://example.com" },
    ];
    const presentation = deriveTurnPresentation(parts);
    expect(presentation.finalReplyNodes.map((node) => node.copyText).join("")).toBe(" now");
    expect(extractCollapsedTraceSummary(parts).finalReplyText)
      .not.toContain("[ref]: https://example.com");
  });

  it("keeps a newline between a healed table and the following paragraph when copying", () => {
    const parts: TurnPartDto[] = [
      { type: "text", text: "Working" },
      { type: "tool", step: tool("read-1") },
      { type: "text", text: "\n\n| a | b |\n| 1 | 2 |\n\nAfter" },
    ];
    const text = extractCollapsedTraceSummary(parts).finalReplyText;
    expect(text).not.toContain("2After");
    expect(text).toMatch(/2\n+After/);
  });

  it("never reorders activities across streaming Markdown prefixes", () => {
    const closing = "** done";
    for (let length = 0; length <= closing.length; length += 1) {
      const presentation = deriveTurnPresentation([
        { type: "text", text: "Working **carefully " },
        { type: "tool", step: tool("read-1") },
        { type: "text", text: "now" },
        { type: "tool", step: tool("read-2") },
        { type: "text", text: closing.slice(0, length) },
      ], { streaming: true });
      expect(presentation.nodes
        .filter((node) => node.type === "tool")
        .map((node) => node.step.toolCallId)).toEqual(["read-1", "read-2"]);
      const placements = [...presentation.layout.activityPlacements.values()];
      expect(placements[1]!.effectiveSlot).toBeGreaterThanOrEqual(placements[0]!.effectiveSlot);
    }
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

  it("keeps a tool event at a safe soft-break offset", () => {
    expect(visibleShape([
      { type: "text", text: "line one\n" },
      { type: "tool", step: tool("read-1") },
      { type: "text", text: "line two" },
    ])).toEqual([
      { type: "text", text: "line one\n" },
      { type: "tool", id: "read-1" },
      { type: "text", text: "line two" },
    ]);
  });

  it("shows a leading tool before narrative when only whitespace preceded it", () => {
    expect(visibleShape([
      { type: "text", text: " \n" },
      { type: "tool", step: tool("read-1") },
      { type: "text", text: "after" },
    ])).toEqual([
      { type: "tool", id: "read-1" },
      { type: "text", text: "after" },
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
    ).nodes;
    expect(items.map((item) => item.type)).toEqual(["markdown", "tool", "agent-message", "markdown"]);
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
