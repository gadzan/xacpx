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
