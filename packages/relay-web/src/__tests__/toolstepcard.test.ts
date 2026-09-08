import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import ToolStepCard from "../components/ToolStepCard.vue";
import type { ToolStepDto } from "@ganglion/xacpx-relay-protocol";

function card(step: Partial<ToolStepDto>) {
  return mount(ToolStepCard, {
    props: { step: { toolCallId: "t1", kind: "execute", title: "git commit", status: "error", ...step } as ToolStepDto },
  });
}

async function expand(w: ReturnType<typeof card>) {
  await w.find('[data-test="tool-step-header"]').trigger("click");
}

const FATAL = "fatal: Unable to create '.git/index.lock': Operation not permitted";

describe("ToolStepCard error banner de-duplication", () => {
  it("starts with tool details collapsed and expands from the header", async () => {
    const w = card({
      status: "success",
      error: undefined,
      detail: { type: "command", command: "npm test", output: "passed", exitCode: 0 },
    });

    expect(w.find('[data-test="tool-step-header"]').attributes("aria-expanded")).toBe("false");
    expect(w.find('[data-test="tool-step-detail"]').exists()).toBe(false);

    await expand(w);

    expect(w.find('[data-test="tool-step-header"]').attributes("aria-expanded")).toBe("true");
    expect(w.find('[data-test="cmd-output"]').text()).toContain("passed");
  });

  it("hides the banner when the command output already prints the error", async () => {
    const w = card({
      error: FATAL,
      detail: { type: "command", command: "git commit -m x", output: `${FATAL}`, exitCode: 128 },
    });
    await expand(w);
    // The failure is already visible in the command body (+ exit + red border), so the
    // banner would just repeat it.
    expect(w.find('[data-test="tool-step-error"]').exists()).toBe(false);
    expect(w.find('[data-test="cmd-output"]').text()).toContain("Operation not permitted");
  });

  it("still shows the banner when the error is NOT in the output", async () => {
    const w = card({
      error: "spawn failed: ENOENT",
      detail: { type: "command", command: "git commit -m x", output: "some unrelated stdout", exitCode: 1 },
    });
    await expand(w);
    expect(w.find('[data-test="tool-step-error"]').text()).toContain("spawn failed: ENOENT");
  });

  it("shows the banner when there is no detail body to carry the error", async () => {
    const w = card({ error: "permission denied", detail: undefined });
    await expand(w);
    expect(w.find('[data-test="tool-step-error"]').text()).toContain("permission denied");
  });

  it("matches against the pre-truncation prefix so a capped error still de-dups", async () => {
    const long = "x".repeat(2000);
    const w = card({
      // The connector caps `error` and appends a marker the output doesn't carry.
      error: `${long}\n…(truncated)`,
      detail: { type: "command", command: "run", output: `${long} ...more output...`, exitCode: 2 },
    });
    await expand(w);
    expect(w.find('[data-test="tool-step-error"]').exists()).toBe(false);
  });

  it("never shows a banner for a successful step", async () => {
    const w = card({
      status: "success",
      error: undefined,
      detail: { type: "command", command: "git status", output: "clean", exitCode: 0 },
    });
    await expand(w);
    expect(w.find('[data-test="tool-step-error"]').exists()).toBe(false);
  });

  it("hydrates compact details before showing the expanded body", async () => {
    let resolveHydrate!: () => void;
    const ensureFull = vi.fn(() => new Promise<void>((resolve) => { resolveHydrate = resolve; }));
    const w = mount(ToolStepCard, {
      props: {
        step: {
          toolCallId: "t1",
          kind: "read",
          title: "a.ts",
          status: "success",
          detail: { type: "read", path: "a.ts" },
        } as ToolStepDto,
        ensureFull,
      },
    });
    await w.find('[data-test="tool-step-header"]').trigger("click");
    await nextTick();
    expect(ensureFull).toHaveBeenCalledTimes(1);
    expect(w.find('[data-test="tool-step-hydrating"]').exists()).toBe(true);
    resolveHydrate();
    await nextTick();
    await nextTick();
    expect(w.find('[data-test="tool-step-hydrating"]').exists()).toBe(false);
    expect(w.find('[data-test="read-path"]').text()).toContain("a.ts");
  });
});

describe("ToolStepCard de-cardified activity stream", () => {
  it("renders as a borderless minimal stream item without card background or shadow", () => {
    const w = card({ status: "success", title: "npm test" });
    const root = w.find('[data-test="tool-step-card"]');
    expect(root.classes()).not.toContain("bg-surface");
    expect(root.classes()).not.toContain("shadow-e1");
    expect(root.classes()).not.toContain("border");
  });

  it("renders kind verb label and file extension badge", () => {
    const w = mount(ToolStepCard, {
      props: {
        step: {
          toolCallId: "t1",
          kind: "execute",
          title: "grep -rn foo",
          status: "success",
        } as ToolStepDto,
      },
    });
    expect(w.text()).toContain("Terminal");
    expect(w.text()).toContain("grep -rn foo");
  });

  it("renders diff stats (+add, −del) in the header for edit steps", () => {
    const w = mount(ToolStepCard, {
      props: {
        step: {
          toolCallId: "t1",
          kind: "edit",
          toolName: "Edit",
          title: "packages/relay-web/src/index.ts",
          status: "success",
          detail: {
            type: "diff",
            path: "packages/relay-web/src/index.ts",
            oldText: "line 1\nline 2",
            newText: "line 1\nline 2 modified\nline 3\nline 4\nline 5",
          },
        } as ToolStepDto,
      },
    });
    expect(w.text()).toContain("Edit");
    expect(w.text()).toContain("TS");
    const stats = w.find('[data-test="step-diff-stats"]');
    expect(stats.exists()).toBe(true);
    expect(stats.text()).toContain("+4");
    expect(stats.text()).toContain("−1");
  });

  it("identifies new-file write operations as Write instead of Edit", () => {
    const w = mount(ToolStepCard, {
      props: {
        step: {
          toolCallId: "t1",
          kind: "edit",
          toolName: "Write",
          title: "packages/relay-web/src/new-file.ts",
          status: "success",
          detail: {
            type: "diff",
            path: "packages/relay-web/src/new-file.ts",
            oldText: "",
            newText: "export const x = 1;\n",
          },
        } as ToolStepDto,
      },
    });
    expect(w.text()).toContain("Write");
    expect(w.text()).toContain("+1");
  });

  it("does not misclassify a compact Edit diff as Write", () => {
    const w = mount(ToolStepCard, {
      props: {
        step: {
          toolCallId: "t1",
          kind: "edit",
          toolName: "Edit",
          title: "packages/relay-web/src/index.ts",
          status: "success",
          detail: {
            type: "diff",
            path: "packages/relay-web/src/index.ts",
            oldText: "",
            newText: "",
          },
        } as ToolStepDto,
      },
    });
    expect(w.text()).toContain("Edit");
    expect(w.text()).not.toContain("Write");
    expect(w.find('[data-test="step-diff-stats"]').exists()).toBe(false);
  });

  it("still labels an explicit Write tool as Write in compact mode", () => {
    const w = mount(ToolStepCard, {
      props: {
        step: {
          toolCallId: "t1",
          kind: "edit",
          toolName: "Write",
          title: "packages/relay-web/src/index.ts",
          status: "success",
          detail: {
            type: "diff",
            path: "packages/relay-web/src/index.ts",
            oldText: "",
            newText: "",
          },
        } as ToolStepDto,
      },
    });
    expect(w.text()).toContain("Write");
    expect(w.text()).not.toContain("Edit");
  });

  it("renders step header as a non-interactive div without button semantics when hasDetail is false", async () => {
    const w = mount(ToolStepCard, {
      props: {
        step: {
          toolCallId: "t1",
          toolName: "Todo",
          kind: "think",
          title: "Update todos",
          status: "success",
        } as ToolStepDto,
      },
    });
    const header = w.find('[data-test="tool-step-header"]');
    expect(header.element.tagName).toBe("DIV");
    expect(header.attributes("type")).toBeUndefined();
    expect(header.attributes("aria-expanded")).toBeUndefined();
    expect(header.classes()).not.toContain("hover:bg-fg/5");
    expect(header.classes()).toContain("cursor-default");
    await header.trigger("click");
    expect(w.find('[data-test="tool-step-detail"]').exists()).toBe(false);
  });

  it("omits diff stats when naive diff fallback triggers on large inputs (501 lines)", () => {
    const lines501 = Array.from({ length: 501 }, (_, i) => `${i}`).join("\n");
    const mod501 = lines501.replace("0", "zero");
    const w = mount(ToolStepCard, {
      props: {
        step: {
          toolCallId: "t1",
          kind: "edit",
          toolName: "Edit",
          title: "big.ts",
          status: "success",
          detail: {
            type: "diff",
            path: "big.ts",
            oldText: lines501,
            newText: mod501,
          },
        } as ToolStepDto,
      },
    });
    expect(w.find('[data-test="step-diff-stats"]').exists()).toBe(false);
  });

  it("omits diff stats when diff input contains truncated marker", () => {
    const w = mount(ToolStepCard, {
      props: {
        step: {
          toolCallId: "t1",
          kind: "edit",
          toolName: "Edit",
          title: "truncated.ts",
          status: "success",
          detail: {
            type: "diff",
            path: "truncated.ts",
            oldText: "const a = 1;\n…(truncated)",
            newText: "const a = 2;\n…(truncated)",
          },
        } as ToolStepDto,
      },
    });
    expect(w.find('[data-test="step-diff-stats"]').exists()).toBe(false);
  });
});
