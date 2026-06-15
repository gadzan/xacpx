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
    // Success → Check icon; running → spinning Loader2 icon (Lucide replaces the old emoji glyphs).
    expect(rows[0].find('[data-test="step-status-success"]').exists()).toBe(true);
    expect(rows[1].find('[data-test="step-status-running"]').exists()).toBe(true);
  });

  it("renders a kind/status summary in the header", () => {
    const w = mount(ToolCallPanel, { props: { steps } });
    // Icons are now Lucide components; each entry carries a `sum-<label>` data-test
    // alongside its count (one execute, one read, one success, one running).
    expect(w.find('[data-test="sum-execute"]').text()).toContain("1");
    expect(w.find('[data-test="sum-read"]').text()).toContain("1");
    expect(w.find('[data-test="sum-success"]').text()).toContain("1");
    expect(w.find('[data-test="sum-running"]').text()).toContain("1");
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
    // icon is now a Lucide component, so assert on the stable label + count.
    expect(sum.kinds.map((k) => ({ label: k.label, count: k.count }))).toEqual([
      { label: "read", count: 1 },
      { label: "execute", count: 1 },
    ]);
    expect(sum.statuses.map((s) => ({ label: s.label, count: s.count }))).toEqual([
      { label: "running", count: 1 },
      { label: "success", count: 1 },
    ]);
  });

  it("aggregates repeated kinds", () => {
    expect(summarizeSteps(manySteps(4)).kinds.map((k) => ({ label: k.label, count: k.count }))).toEqual([
      { label: "read", count: 4 },
    ]);
  });
});

describe("ReasoningPanel", () => {
  it("collapses by default; opening reveals the reasoning text", async () => {
    const w = mount(ReasoningPanel, { props: { reasoning: "step by step" } });
    expect(w.text()).toContain("Reasoning");
    // Collapsed by default — the thought doesn't bury the answer below it.
    expect(w.find('[data-test="reasoning-body"]').exists()).toBe(false);
    await w.find("button").trigger("click");
    expect(w.find('[data-test="reasoning-body"]').text()).toContain("step by step");
  });

  it("shows a shimmer while streaming but stays collapsed until opened", async () => {
    const w = mount(ReasoningPanel, { props: { reasoning: "thinking", streaming: true } });
    expect(w.find('[data-test="reasoning-shimmer"]').exists()).toBe(true);
    expect(w.text()).toContain("Reasoning…");
    // No longer force-opened mid-stream; the user expands on demand.
    expect(w.find('[data-test="reasoning-body"]').exists()).toBe(false);
    await w.find("button").trigger("click");
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
