import { describe, expect, it } from "vitest";
import type { ToolStepDto, TurnPartDto } from "@ganglion/xacpx-relay-protocol";
import { deriveTurnPresentation } from "../lib/turn-presentation";

const tool = (id: string): ToolStepDto => ({
  toolCallId: id,
  toolName: "Read",
  kind: "read",
  status: "success",
  title: `${id}.ts`,
});

const visibleShape = (parts: TurnPartDto[]) =>
  deriveTurnPresentation(parts).map((item) => {
    if (item.type === "text") return { type: item.type, text: item.text };
    if (item.type === "reasoning") return { type: item.type, text: item.text };
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

  it("places a tool at an explicit paragraph boundary", () => {
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
});
