import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import type { ToolStepStatus } from "@ganglion/xacpx-relay-protocol";
import TraceLiveStack from "../components/TraceLiveStack.vue";
import type { TurnPresentationItem } from "../lib/turn-presentation";
import { TRACE_LIVE_THROTTLE_MS, traceLiveBurstActive, traceLiveTypeLabelKey } from "../lib/trace-live";

function toolNode(id: string, title = `Step ${id}`, status: ToolStepStatus = "success"): TurnPresentationItem {
  return {
    key: `tool:${id}`,
    type: "tool",
    isLatest: false,
    step: { toolCallId: id, toolName: "read_file", kind: "read", status, title },
  };
}

function markdownNode(length: number, text: string): TurnPresentationItem {
  return {
    key: `markdown:0:${length}`,
    type: "markdown",
    sourceRange: [0, length],
    source: text,
    html: `<p>${text}</p>`,
    copyText: text,
    isLatest: true,
  };
}

function subagentNode(id: string, durationMs?: number): TurnPresentationItem {
  return {
    key: `subagent:${id}`,
    type: "subagent",
    isLatest: false,
    step: {
      toolCallId: id, toolName: "task", kind: "other", status: "success",
      title: `Subagent ${id}`, isSubagent: true, ...(durationMs !== undefined ? { durationMs } : {}),
    },
    children: [],
  };
}

function rows(wrapper: ReturnType<typeof mount>): string[] {
  return wrapper.findAll('[data-test="trace-live-item"]').map((row) => row.text());
}

describe("trace live stack", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    window.innerWidth = 1280;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the newest three events, newest first", () => {
    const wrapper = mount(TraceLiveStack, {
      props: { nodes: [toolNode("a"), toolNode("b"), toolNode("c"), toolNode("d")], streaming: true },
    });
    const text = rows(wrapper);
    expect(text).toHaveLength(3);
    expect(text[0]).toContain("Step d");
    expect(text[1]).toContain("Step c");
    expect(text[2]).toContain("Step b");
    expect(text.join(" ")).not.toContain("Step a");
    wrapper.unmount();
  });

  it("shows two events on mobile", () => {
    window.innerWidth = 390;
    const wrapper = mount(TraceLiveStack, {
      props: { nodes: [toolNode("a"), toolNode("b"), toolNode("c")], streaming: true },
    });
    expect(rows(wrapper)).toHaveLength(2);
    wrapper.unmount();
  });

  it("updates a same-key event in place without adding a row", async () => {
    const wrapper = mount(TraceLiveStack, {
      props: { nodes: [toolNode("a"), toolNode("b", "Step b", "running")], streaming: true },
    });
    expect(rows(wrapper)).toHaveLength(2);
    const firstRow = wrapper.findAll('[data-test="trace-live-item"]')[0]!.element;
    await wrapper.setProps({ nodes: [toolNode("a"), toolNode("b", "Step b updated", "success")] });
    await vi.waitFor(() => expect(wrapper.text()).toContain("Step b updated"));
    expect(rows(wrapper)).toHaveLength(2);
    expect(wrapper.findAll('[data-test="trace-live-item"]')[0]!.element).toBe(firstRow);
    expect(wrapper.find('[data-test="trace-live-status"]').attributes("data-status")).toBe("success");
    wrapper.unmount();
  });

  it("coalesces updates under 120ms into one trailing render without re-entering the key", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const wrapper = mount(TraceLiveStack, {
      props: { nodes: [toolNode("a"), toolNode("b", "Step b v1")], streaming: true },
    });
    expect(rows(wrapper)).toHaveLength(2);
    expect(wrapper.text()).toContain("Step b v1");
    const firstRow = wrapper.findAll('[data-test="trace-live-item"]')[0]!.element;

    await wrapper.setProps({ nodes: [toolNode("a"), toolNode("b", "Step b v2")] });
    await vi.advanceTimersByTimeAsync(40);
    await wrapper.setProps({ nodes: [toolNode("a"), toolNode("b", "Step b v3")] });
    await vi.advanceTimersByTimeAsync(40);
    await wrapper.setProps({ nodes: [toolNode("a"), toolNode("b", "Step b v4")] });

    // No intermediate frame: the 120ms window has not elapsed yet.
    expect(wrapper.text()).toContain("Step b v1");
    expect(wrapper.text()).not.toContain("Step b v2");
    expect(wrapper.text()).not.toContain("Step b v3");
    expect(wrapper.text()).not.toContain("Step b v4");

    await vi.advanceTimersByTimeAsync(40);
    expect(wrapper.text()).toContain("Step b v4");
    expect(rows(wrapper)).toHaveLength(2);
    expect(wrapper.findAll('[data-test="trace-live-item"]')[0]!.element).toBe(firstRow);
    // Same-key streaming updates are not events, so the rate gate stays open.
    expect(wrapper.find(".relative").classes()).not.toContain("trace-live--static");
    wrapper.unmount();
  });

  it("suppresses enter, move and leave animations above 10 events per second", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const wrapper = mount(TraceLiveStack, {
      props: { nodes: [toolNode("e0")], streaming: true },
    });
    expect(wrapper.find(".relative").classes()).not.toContain("trace-live--static");
    const nodes = [toolNode("e0")];
    // 11 new events inside one second: strictly above the 10/s budget.
    for (let index = 1; index <= 11; index++) {
      nodes.push(toolNode(`e${index}`));
      await wrapper.setProps({ nodes: [...nodes] });
      await vi.advanceTimersByTimeAsync(10);
    }
    expect(wrapper.find(".relative").classes()).toContain("trace-live--static");

    // The gate clears by rate, not by "next event": no update for a second.
    await vi.advanceTimersByTimeAsync(1_100);
    expect(wrapper.find(".relative").classes()).not.toContain("trace-live--static");
    wrapper.unmount();
  });

  it("keeps 10 events per second animating (threshold is strictly greater)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const nodes = [toolNode("s0")];
    const wrapper = mount(TraceLiveStack, { props: { nodes: [...nodes], streaming: true } });
    // The mount itself is the first arrival; nine more make ten in the window.
    for (let index = 1; index <= 9; index++) {
      nodes.push(toolNode(`s${index}`));
      await wrapper.setProps({ nodes: [...nodes] });
      await vi.advanceTimersByTimeAsync(10);
    }
    expect(wrapper.find(".relative").classes()).not.toContain("trace-live--static");
    wrapper.unmount();
  });

  it("keeps the previous rows when a new event enters", async () => {
    const wrapper = mount(TraceLiveStack, {
      props: { nodes: [toolNode("a"), toolNode("b")], streaming: true },
    });
    expect(rows(wrapper)).toHaveLength(2);
    await wrapper.setProps({ nodes: [toolNode("a"), toolNode("b"), toolNode("c")] });
    await vi.waitFor(() => expect(rows(wrapper)).toHaveLength(3));
    expect(rows(wrapper)[0]).toContain("Step c");
    expect(rows(wrapper)[1]).toContain("Step b");
    expect(rows(wrapper)[2]).toContain("Step a");
    wrapper.unmount();
  });

  it("treats a growing markdown key as the same event", async () => {
    const wrapper = mount(TraceLiveStack, {
      props: { nodes: [markdownNode(5, "hello")], streaming: true },
    });
    const firstRow = wrapper.findAll('[data-test="trace-live-item"]')[0]!.element;
    await wrapper.setProps({ nodes: [markdownNode(11, "hello world")] });
    await vi.waitFor(() => expect(wrapper.text()).toContain("hello world"));
    expect(rows(wrapper)).toHaveLength(1);
    expect(wrapper.findAll('[data-test="trace-live-item"]')[0]!.element).toBe(firstRow);
    wrapper.unmount();
  });

  it("collapses to a terminal summary and stops the running stack", async () => {
    const wrapper = mount(TraceLiveStack, {
      props: { nodes: [toolNode("a"), toolNode("b")], streaming: true },
    });
    expect(wrapper.find('[data-test="trace-live-label"]').exists()).toBe(true);
    await wrapper.setProps({ streaming: false, terminal: "done" });
    expect(wrapper.get('[data-test="trace-live-summary"]').text()).toContain("Run complete");
    expect(wrapper.findAll('[data-test="trace-live-item"]')).toHaveLength(0);
    expect(wrapper.find('[data-test="trace-live-label"]').exists()).toBe(false);
    await wrapper.setProps({ terminal: "failed" });
    expect(wrapper.get('[data-test="trace-live-summary"]').text()).toContain("Run failed");
    await wrapper.setProps({ terminal: "cancelled" });
    expect(wrapper.get('[data-test="trace-live-summary"]').text()).toContain("Run cancelled");
    wrapper.unmount();
  });

  it("emits the revealed node key when a live row is clicked", async () => {
    const wrapper = mount(TraceLiveStack, {
      props: { nodes: [toolNode("a"), toolNode("b")], streaming: true },
    });
    await wrapper.get('[data-test="trace-live-row"]').trigger("click");
    expect(wrapper.emitted("reveal")).toEqual([["tool:b"]]);
    wrapper.unmount();
  });

  it("shows the step type as visible text, not only the aria-hidden icon", () => {
    const structured = mount(TraceLiveStack, {
      props: { nodes: [toolNode("a", "Read file", "success"), subagentNode("s")], streaming: true },
    });
    // Newest first; the title is a command/task, so the type needs its own label.
    expect(structured.findAll('[data-test="trace-live-kind"]').map((node) => node.text()))
      .toEqual(["Subagent", "Read"]);
    structured.unmount();

    const prose = mount(TraceLiveStack, {
      props: {
        nodes: [
          markdownNode(5, "hello"),
          { key: "reasoning:r", type: "reasoning", text: "plan", isLatest: true },
        ],
        streaming: true,
      },
    });
    // Prose titles already ARE the type name; no duplicated second label.
    expect(prose.findAll('[data-test="trace-live-kind"]')).toHaveLength(0);
    const text = prose.findAll('[data-test="trace-live-item"]').map((row) => row.text());
    expect(text[0]).toContain("Reasoning");
    expect(text[1]).toContain("Reply");
    prose.unmount();
  });

  it("renders the source duration for tool and subagent rows", () => {
    const wrapper = mount(TraceLiveStack, {
      props: {
        nodes: [
          { key: "tool:t", type: "tool", isLatest: false,
            step: { toolCallId: "t", toolName: "bash", kind: "execute", status: "success", title: "pnpm test", durationMs: 1_250 } },
          subagentNode("s", 2_400),
        ],
        streaming: false,
      },
    });
    const durations = wrapper.findAll('[data-test="trace-live-duration"]').map((node) => node.text());
    expect(durations).toEqual(["2.4s", "1.3s"]);
    wrapper.unmount();
  });

  it("keeps the last output line as the preview for every kind", () => {
    const wrapper = mount(TraceLiveStack, {
      props: {
        nodes: [
          { key: "tool:t", type: "tool", isLatest: false,
            step: {
              toolCallId: "t", toolName: "bash", kind: "execute", status: "success", title: "pnpm test",
              detail: { type: "command", command: "pnpm test", output: "line one\nline two\n12 passed" },
            } },
        ],
        streaming: false,
      },
    });
    expect(wrapper.get('[data-test="trace-live-preview"]').text()).toBe("line two 12 passed");
    wrapper.unmount();
  });

  it("labels every live kind through one i18n key mapping", () => {
    expect(traceLiveTypeLabelKey({ kind: "reasoning" })).toBe("group.detail.live.reasoning");
    expect(traceLiveTypeLabelKey({ kind: "markdown" })).toBe("group.detail.live.text");
    expect(traceLiveTypeLabelKey({ kind: "agent-message" })).toBe("group.detail.live.message");
    expect(traceLiveTypeLabelKey({ kind: "subagent" })).toBe("tools.subagent");
    expect(traceLiveTypeLabelKey({ kind: "tool", toolKind: "execute" })).toBe("tools.kinds.execute");
    expect(traceLiveTypeLabelKey({ kind: "tool", toolKind: "fetch" })).toBe("tools.kinds.other");
  });

  it("counts a burst only above 10 arrivals in the trailing second", () => {
    const arrivals = Array.from({ length: 11 }, (_, index) => 1_000 + index);
    expect(traceLiveBurstActive(arrivals.slice(0, 10), 1_010)).toBe(false);
    expect(traceLiveBurstActive(arrivals, 1_010)).toBe(true);
    // Older arrivals leave the window instead of accumulating forever.
    expect(traceLiveBurstActive(arrivals, 2_500)).toBe(false);
  });

  it("keeps its only visual delay under the 150ms freshness contract", () => {
    expect(TRACE_LIVE_THROTTLE_MS).toBeLessThanOrEqual(150);
  });
});
