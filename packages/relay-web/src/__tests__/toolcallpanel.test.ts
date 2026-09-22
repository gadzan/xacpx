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
  it("shows a count while keeping rows collapsed by default", () => {
    const w = mount(ToolCallPanel, { props: { steps } });
    expect(w.find('[data-test="tool-count"]').text()).toContain("2");
    expect(w.findAll('[data-test="tool-row"]').length).toBe(0);
    expect(w.find("button").attributes("aria-expanded")).toBe("false");
  });

  it("expands a row to show its detail with the full command as rendered text", async () => {
    const w = mount(ToolCallPanel, { props: { steps } });
    expect(w.find('[data-test="cmd-output"]').exists()).toBe(false);
    await w.find("button").trigger("click");
    await w.findAll('[data-test="tool-row"]')[0].trigger("click");
    expect(w.find('[data-test="cmd-output"]').text()).toContain("passed");
    expect(w.find('[data-test="detail-headline"]').text()).toContain("npm test");
  });

  it("head-truncates path rows so the filename stays visible", async () => {
    const w = mount(ToolCallPanel, {
      props: {
        steps: [
          { toolCallId: "p1", toolName: "Read", kind: "read", status: "success", title: "packages/relay-web/src/components/ToolStepCard.vue", titleIsPath: true, detail: { type: "read", path: "packages/relay-web/src/components/ToolStepCard.vue", preview: "body" } },
          { toolCallId: "c1", toolName: "Bash", kind: "execute", status: "success", title: "bun run build", detail: { type: "command", command: "bun run build", output: "ok" } },
        ],
      },
    });
    await w.find("button").trigger("click");
    const rows = w.findAll('[data-test="tool-row"]');
    expect(rows[0].find("span.min-w-0").attributes("dir")).toBe("rtl");
    expect(rows[1].find("span.min-w-0").attributes("dir")).toBeUndefined();
  });

  it("shows the full title for a title-only row with no detail", async () => {
    // Header-only steps carry no detail; expanding must still surface the
    // full title as rendered text — previously it unwrapped the header.
    const long = "packages/relay-web/src/very/deeply/nested/title-only-file-that-overflows.ts";
    const w = mount(ToolCallPanel, {
      props: {
        steps: [
          { toolCallId: "h1", toolName: "Read", kind: "read", status: "success", title: long },
        ],
      },
    });
    await w.find("button").trigger("click");
    await w.findAll('[data-test="tool-row"]')[0].trigger("click");
    expect(w.find('[data-test="detail-headline"]').text()).toBe(long);
    expect(w.find('[data-test="copy-button"]').exists()).toBe(true);
  });

  it("marks a running step distinctly from a successful one", async () => {
    const w = mount(ToolCallPanel, { props: { steps } });
    await w.find("button").trigger("click");
    const rows = w.findAll('[data-test="tool-row"]');
    // Success → Check icon; running → spinning Loader2 icon (Lucide replaces the old emoji glyphs).
    expect(rows[0].find('[data-test="step-status-success"]').exists()).toBe(true);
    expect(rows[1].find('[data-test="step-status-running"]').exists()).toBe(true);
  });

  it("shows diff +N/−N stats on legacy edit rows", async () => {
    const w = mount(ToolCallPanel, {
      props: {
        steps: [
          {
            toolCallId: "e1", toolName: "Edit", kind: "edit", status: "success",
            title: "src/index.ts",
            detail: { type: "diff", path: "src/index.ts", oldText: "line 1\nline 2", newText: "line 1\nline 2 modified\nline 3\nline 4\nline 5" },
          } as ToolStepDto,
        ],
      },
    });
    await w.find("button").trigger("click");
    const stats = w.find('[data-test="tool-row-diff-stats"]');
    expect(stats.exists()).toBe(true);
    expect(stats.text()).toContain("+4");
    expect(stats.text()).toContain("−1");
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

  it("keeps a short panel collapsed and shows the count (no FUE dot)", () => {
    const w = mount(ToolCallPanel, { props: { steps } });
    expect(w.findAll('[data-test="tool-row"]').length).toBe(0);
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
