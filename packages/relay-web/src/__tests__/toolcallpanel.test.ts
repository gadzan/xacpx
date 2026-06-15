import { mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it } from "vitest";
import ToolCallPanel from "../components/ToolCallPanel.vue";
import ReasoningPanel from "../components/ReasoningPanel.vue";
import type { ToolStepDto } from "@ganglion/xacpx-relay-protocol";
import { summarizeSteps } from "../lib/tool-summary";
import { resetFue } from "../lib/use-fue";

const steps: ToolStepDto[] = [
  { toolCallId: "t1", toolName: "Bash", kind: "execute", status: "success", title: "npm test", durationMs: 400, detail: { type: "command", command: "npm test", output: "passed" } },
  { toolCallId: "t2", toolName: "Read", kind: "read", status: "running", title: "a.ts" },
];

const manySteps = (n: number): ToolStepDto[] =>
  Array.from({ length: n }, (_, i) => ({ toolCallId: `t${i}`, toolName: "Read", kind: "read" as const, status: "success" as const, title: `f${i}.ts` }));

describe("ToolCallPanel", () => {
  it("shows a count and one row per step", () => {
    const w = mount(ToolCallPanel, { props: { steps } });
    expect(w.find('[data-test="tool-count"]').text()).toContain("2");
    expect(w.findAll('[data-test="tool-row"]').length).toBe(2);
  });

  it("expands a row to show its detail on click", async () => {
    const w = mount(ToolCallPanel, { props: { steps } });
    expect(w.find('[data-test="cmd-output"]').exists()).toBe(false);
    await w.findAll('[data-test="tool-row"]')[0].trigger("click");
    expect(w.find('[data-test="cmd-output"]').text()).toContain("passed");
  });

  it("marks a running step distinctly from a successful one", () => {
    const w = mount(ToolCallPanel, { props: { steps } });
    const rows = w.findAll('[data-test="tool-row"]');
    expect(rows[0].text()).toContain("✅");
    expect(rows[1].text()).toContain("⏳");
  });

  it("renders a kind/status summary in the header", () => {
    const w = mount(ToolCallPanel, { props: { steps } });
    const sum = w.find('[data-test="tool-summary"]').text();
    expect(sum).toContain("💻1"); // one execute
    expect(sum).toContain("📖1"); // one read
    expect(sum).toContain("✅1"); // one success
    expect(sum).toContain("⏳1"); // one running
  });
});

describe("ToolCallPanel auto-collapse", () => {
  beforeEach(() => resetFue("tool-group-collapse"));

  it("collapses a many-step panel by default and expands on header click", async () => {
    const w = mount(ToolCallPanel, { props: { steps: manySteps(8) } });
    expect(w.findAll('[data-test="tool-row"]').length).toBe(0); // collapsed
    expect(w.find('[data-test="fue-dot"]').exists()).toBe(true); // FUE nudge replaces the count
    await w.find("button").trigger("click");
    expect(w.findAll('[data-test="tool-row"]').length).toBe(8);
  });

  it("keeps a short panel expanded and shows the count (no FUE dot)", () => {
    const w = mount(ToolCallPanel, { props: { steps } });
    expect(w.findAll('[data-test="tool-row"]').length).toBe(2);
    expect(w.find('[data-test="fue-dot"]').exists()).toBe(false);
    expect(w.find('[data-test="tool-count"]').text()).toContain("2");
  });
});

describe("summarizeSteps", () => {
  it("counts by kind and status in stable order", () => {
    const sum = summarizeSteps(steps);
    expect(sum.kinds).toEqual([
      { icon: "📖", count: 1 },
      { icon: "💻", count: 1 },
    ]);
    expect(sum.statuses).toEqual([
      { icon: "⏳", count: 1 },
      { icon: "✅", count: 1 },
    ]);
  });

  it("aggregates repeated kinds", () => {
    expect(summarizeSteps(manySteps(4)).kinds).toEqual([{ icon: "📖", count: 4 }]);
  });
});

describe("ReasoningPanel", () => {
  it("renders reasoning text inside a collapsible", () => {
    const w = mount(ReasoningPanel, { props: { reasoning: "step by step" } });
    expect(w.text()).toContain("Reasoning");
    expect(w.find('[data-test="reasoning-body"]').text()).toContain("step by step");
  });

  it("shows a shimmer and stays open while streaming", () => {
    const w = mount(ReasoningPanel, { props: { reasoning: "thinking", streaming: true, defaultOpen: false } });
    expect(w.find('[data-test="reasoning-shimmer"]').exists()).toBe(true);
    expect(w.text()).toContain("Reasoning…");
    // Forced open despite defaultOpen=false.
    expect(w.find('[data-test="reasoning-body"]').exists()).toBe(true);
  });

  it("respects defaultOpen and the toggle when not streaming", async () => {
    const w = mount(ReasoningPanel, { props: { reasoning: "done", defaultOpen: false } });
    expect(w.find('[data-test="reasoning-shimmer"]').exists()).toBe(false);
    expect(w.find('[data-test="reasoning-body"]').exists()).toBe(false);
    await w.find("button").trigger("click");
    expect(w.find('[data-test="reasoning-body"]').exists()).toBe(true);
  });
});
