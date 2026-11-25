import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import { i18n } from "../i18n";
import TraceLiveStack from "../components/TraceLiveStack.vue";

function tool(title: string, status = "running") {
  return {
    key: "tool:1",
    type: "tool",
    isLatest: true,
    step: {
      toolCallId: "t1", toolName: "Bash", kind: "execute", status,
      title, detail: { type: "command", command: title, output: "" },
    },
  } as never;
}

const mountInline = (nodes: never[]) => mount(TraceLiveStack, {
  props: { nodes, variant: "inline", maxItems: 1, streaming: true },
  global: { plugins: [i18n] },
});

const section = (w: ReturnType<typeof mountInline>) =>
  w.find('[data-test="trace-live-stack"]');

describe("inline live stack keeps a constant box", () => {
  it("is a fixed height and full width whatever the content is", async () => {
    const short = mountInline([tool("ls")]);
    const long = mountInline([tool("a title ".repeat(40))]);
    await flushPromises();
    // A box sized by its text resized on every new tool and pushed the reply
    // around while the reader was watching it.
    for (const w of [short, long]) {
      const cls = section(w).attributes("class") ?? "";
      expect(cls).toContain("h-9");
      expect(cls).toContain("w-full");
      // Overflow is clipped rather than allowed to widen the box.
      expect(cls).toContain("overflow-hidden");
    }
    expect(section(short).attributes("class")).toBe(section(long).attributes("class"));
  });

  it("keeps the row present before the first part arrives", async () => {
    const empty = mountInline([]);
    await flushPromises();
    // Rendering nothing until the first tool lands meant the box appeared mid-turn
    // and moved everything below it.
    expect(section(empty).exists()).toBe(true);
    expect(empty.find('[data-test="trace-live-placeholder"]').exists()).toBe(true);
  });

  it("gives status and duration fixed slots so nothing shifts sideways", async () => {
    const running = mountInline([tool("npm test", "running")]);
    const done = mountInline([tool("npm test", "success")]);
    const bare = mountInline([tool("npm test")]);
    await flushPromises();
    for (const w of [running, done, bare]) {
      // A dot that appears, or a duration that grows from nothing to "1.2s", used to
      // push the title around on every status change.
      expect(w.find('[data-test="trace-live-status"]').exists()).toBe(true);
      expect(w.find('[data-test="trace-live-duration"]').attributes("class")).toContain("w-9");
      expect(w.find('[data-test="trace-live-title"]').attributes("class")).toContain("truncate");
    }
  });

  it("shows one row, not a stack", async () => {
    const w = mountInline([tool("a"), tool("b"), tool("c")]);
    await flushPromises();
    expect(w.findAll('[data-test="trace-live-row"]').length).toBe(1);
  });
});
