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
          detail: { type: "read", path: "a.ts", preview: "file body" },
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
    expect(w.find('[data-test="read-preview"]').text()).toContain("file body");
    expect(w.find('[data-test="tool-step-header"]').text()).toContain("a.ts");
  });

  it("keeps a truncated header title single-line after expanding the detail", async () => {
    const w = card({
      status: "success",
      title: "a-very-long-command --with --many --flags --that --overflows",
      detail: { type: "command", command: "a-very-long-command --with --many --flags --that --overflows", output: "ok", exitCode: 0 },
    });
    const header = w.find('[data-test="tool-step-header"]');
    expect(header.find("span.min-w-0").classes()).toContain("truncate");
    await header.trigger("click");
    expect(header.attributes("aria-expanded")).toBe("true");
    // The full command/output lives in the detail drawer; the header stays a
    // single-line preview (full text remains available via the title tooltip).
    expect(header.find("span.min-w-0").classes()).toContain("truncate");
    expect(header.find("span.min-w-0").attributes("title")).toContain("a-very-long-command");
    expect(w.find('[data-test="tool-step-detail"]').exists()).toBe(true);
  });

  it("head-truncates path titles so the filename stays visible", () => {
    // dir=rtl moves the ellipsis to the head (…tail): the filename — the part
    // users scan for — survives truncation. Full path stays in the tooltip.
    const path = card({
      kind: "read",
      status: "success",
      title: "packages/relay-web/src/components/ToolStepCard.vue",
      detail: { type: "read", path: "packages/relay-web/src/components/ToolStepCard.vue", preview: "body" },
    });
    const pathTitle = path.find('[data-test="tool-step-header"] span.min-w-0');
    expect(pathTitle.attributes("dir")).toBe("rtl");
    expect(pathTitle.attributes("title")).toContain("ToolStepCard.vue");
    // Commands keep head text (the verb/flags) with the default tail ellipsis.
    const cmd = card({
      kind: "execute",
      status: "success",
      title: "bun run build --filter relay-web",
      detail: { type: "command", command: "bun run build --filter relay-web", output: "ok", exitCode: 0 },
    });
    expect(cmd.find('[data-test="tool-step-header"] span.min-w-0').attributes("dir")).toBeUndefined();
  });

  it("wraps a header-only long title without an expandable drawer", () => {
    // Title-only steps (detail omitted upstream) are non-interactive divs:
    // open can never flip, so the title must not stay truncated.
    for (const kind of ["read", "execute", "search"] as const) {
      const w = mount(ToolStepCard, {
        props: {
          step: {
            toolCallId: `long-${kind}`,
            kind,
            title: "a-very-long-title --with --many --flags --that --overflows-the-row",
            status: "success",
          } as ToolStepDto,
        },
      });
      const header = w.find('[data-test="tool-step-header"]');
      expect(header.element.tagName).toBe("DIV");
      expect(header.find("span.min-w-0").classes()).not.toContain("truncate");
      expect(header.find("span.min-w-0").attributes("title")).toContain("a-very-long-title");
      expect(w.find('[data-test="tool-step-detail"]').exists()).toBe(false);
    }
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


  it("does not treat dotted directory names or dotfiles as file extensions", () => {
    const w1 = mount(ToolStepCard, {
      props: {
        step: {
          toolCallId: "t1",
          kind: "read",
          title: "src.v2/x",
          status: "success",
        } as ToolStepDto,
      },
    });
    expect(w1.find('[data-test="file-ext-badge"]').exists()).toBe(false);

    const w2 = mount(ToolStepCard, {
      props: {
        step: {
          toolCallId: "t2",
          kind: "read",
          title: "a.b/c",
          status: "success",
        } as ToolStepDto,
      },
    });
    expect(w2.find('[data-test="file-ext-badge"]').exists()).toBe(false);

    const w3 = mount(ToolStepCard, {
      props: {
        step: {
          toolCallId: "t3",
          kind: "read",
          title: "src.v2/component.vue",
          status: "success",
        } as ToolStepDto,
      },
    });
    expect(w3.find('[data-test="file-ext-badge"]').text()).toBe("VUE");
  });

  it("correctly extracts extension from Windows absolute paths and scheme URIs", () => {
    const w1 = mount(ToolStepCard, {
      props: {
        step: {
          toolCallId: "t1",
          kind: "read",
          title: "C:\\repo\\src\\index.ts",
          status: "success",
        } as ToolStepDto,
      },
    });
    expect(w1.find('[data-test="file-ext-badge"]').text()).toBe("TS");

    const w2 = mount(ToolStepCard, {
      props: {
        step: {
          toolCallId: "t2",
          kind: "read",
          title: "C:\\repo.v2\\README",
          status: "success",
        } as ToolStepDto,
      },
    });
    expect(w2.find('[data-test="file-ext-badge"]').exists()).toBe(false);

    const w3 = mount(ToolStepCard, {
      props: {
        step: {
          toolCallId: "t3",
          kind: "read",
          title: "file:///home/user/src/main.py?line=10",
          status: "success",
        } as ToolStepDto,
      },
    });
    expect(w3.find('[data-test="file-ext-badge"]').text()).toBe("PY");
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

describe("ToolStepCard live elapsed and terminal-only notice", () => {
  it("counts up locally for a running step with a first-seen stamp", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-20T00:00:10Z"));
    const w = mount(ToolStepCard, {
      props: {
        step: {
          toolCallId: "t-run", kind: "execute", title: "sleep 30", status: "running",
          startedAt: Date.parse("2026-09-20T00:00:00Z"),
        } as ToolStepDto,
      },
    });
    expect(w.find('[data-test="step-elapsed"]').text()).toBe("10.0s");
    vi.advanceTimersByTime(5000);
    await nextTick();
    expect(w.find('[data-test="step-elapsed"]').text()).toBe("15.0s");
    vi.useRealTimers();
  });

  it("shows the connector duration once the step is terminal", () => {
    const w = mount(ToolStepCard, {
      props: {
        step: {
          toolCallId: "t-done", kind: "execute", title: "npm test", status: "success",
          durationMs: 400,
        } as ToolStepDto,
      },
    });
    expect(w.find('[data-test="step-elapsed"]').exists()).toBe(false);
    expect(w.text()).toContain("400ms");
  });

  it("explains a terminal-routed step whose output was never reported", async () => {
    const w = mount(ToolStepCard, {
      props: {
        step: {
          toolCallId: "t-term", kind: "execute", title: "cargo build", status: "error",
          terminalId: "77f1f365",
        } as ToolStepDto,
      },
    });
    await w.find('[data-test="tool-step-header"]').trigger("click");
    expect(w.find('[data-test="tool-step-terminal-only"]').exists()).toBe(true);
    expect(w.find('[data-test="tool-step-terminal-only"]').text()).not.toBe("");
  });

  it("recognizes both truncation markers when de-duplicating the error banner", async () => {
    const FATAL = "fatal: unable to access";
    // capTail's prefix marker must not defeat the banner suppression.
    const w = card({
      error: `(truncated)…\n${FATAL}`,
      detail: { type: "command", command: "git fetch", output: `(truncated)…\n${FATAL}`, exitCode: 1 },
    });
    await expand(w);
    expect(w.find('[data-test="tool-step-error"]').exists()).toBe(false);
  });
});
