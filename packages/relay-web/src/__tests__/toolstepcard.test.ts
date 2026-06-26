import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import ToolStepCard from "../components/ToolStepCard.vue";
import type { ToolStepDto } from "@ganglion/xacpx-relay-protocol";

function card(step: Partial<ToolStepDto>) {
  return mount(ToolStepCard, {
    props: { step: { toolCallId: "t1", kind: "execute", title: "git commit", status: "error", ...step } as ToolStepDto },
  });
}

const FATAL = "fatal: Unable to create '.git/index.lock': Operation not permitted";

describe("ToolStepCard error banner de-duplication", () => {
  it("hides the banner when the command output already prints the error", () => {
    const w = card({
      error: FATAL,
      detail: { type: "command", command: "git commit -m x", output: `${FATAL}`, exitCode: 128 },
    });
    // The failure is already visible in the command body (+ exit + red border), so the
    // banner would just repeat it.
    expect(w.find('[data-test="tool-step-error"]').exists()).toBe(false);
    expect(w.find('[data-test="cmd-output"]').text()).toContain("Operation not permitted");
  });

  it("still shows the banner when the error is NOT in the output", () => {
    const w = card({
      error: "spawn failed: ENOENT",
      detail: { type: "command", command: "git commit -m x", output: "some unrelated stdout", exitCode: 1 },
    });
    expect(w.find('[data-test="tool-step-error"]').text()).toContain("spawn failed: ENOENT");
  });

  it("shows the banner when there is no detail body to carry the error", () => {
    const w = card({ error: "permission denied", detail: undefined });
    expect(w.find('[data-test="tool-step-error"]').text()).toContain("permission denied");
  });

  it("matches against the pre-truncation prefix so a capped error still de-dups", () => {
    const long = "x".repeat(2000);
    const w = card({
      // The connector caps `error` and appends a marker the output doesn't carry.
      error: `${long}\n…(truncated)`,
      detail: { type: "command", command: "run", output: `${long} ...more output...`, exitCode: 2 },
    });
    expect(w.find('[data-test="tool-step-error"]').exists()).toBe(false);
  });

  it("never shows a banner for a successful step", () => {
    const w = card({
      status: "success",
      error: undefined,
      detail: { type: "command", command: "git status", output: "clean", exitCode: 0 },
    });
    expect(w.find('[data-test="tool-step-error"]').exists()).toBe(false);
  });
});
