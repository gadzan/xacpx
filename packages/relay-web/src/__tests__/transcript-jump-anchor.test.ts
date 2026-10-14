import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "@vue/compiler-sfc";

// The jump-to-latest button and scrim are `position: absolute; bottom: …`.
// If their containing block is the scroll container itself, they are laid out
// against the scrolled content and drift up into the middle of the transcript.
// They must be siblings of the scroller inside a non-scrolling relative wrapper.
type Node = { type: number; tag?: string; props?: Array<{ name: string; value?: { content: string } }>; children?: Node[] };

function attr(node: Node, name: string): string | undefined {
  return node.props?.find((p) => p.name === name)?.value?.content;
}
function contains(node: Node, tag: string): boolean {
  return (node.children ?? []).some((c) => c.tag === tag || contains(c, tag));
}

describe.each(["GroupTranscript.vue", "ConversationMessageList.vue"])("%s jump-latest anchoring", (file) => {
  it("renders TranscriptJumpLatest outside the scroll container, inside a relative wrapper", () => {
    const src = readFileSync(resolve(__dirname, "../components", file), "utf8");
    const root = parse(src).descriptor.template!.ast!.children.find((c) => c.type === 1) as unknown as Node;
    const scroller = root.children!.find((c) => c.type === 1 && attr(c, "ref") === "scroller");
    expect(scroller, "scroller must be a direct child of the wrapper").toBeDefined();
    expect(attr(scroller!, "class")).toContain("overflow-y-auto");
    expect(contains(scroller!, "TranscriptJumpLatest")).toBe(false);
    expect(root.children!.some((c) => c.tag === "TranscriptJumpLatest")).toBe(true);
    expect(attr(root, "class")?.split(/\s+/)).toContain("relative");
    expect(attr(root, "class")).not.toContain("overflow");
  });
});
