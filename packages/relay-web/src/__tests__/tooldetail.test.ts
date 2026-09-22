import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import ToolDetail from "../components/ToolDetail.vue";
import type { ToolDetailDto } from "@ganglion/xacpx-relay-protocol";

function render(detail: ToolDetailDto, headline?: string) {
  return mount(ToolDetail, { props: { detail, ...(headline !== undefined ? { headline } : {}) } });
}

describe("ToolDetail", () => {
  it("renders a diff with added and removed lines", () => {
    const w = render({ type: "diff", path: "src/x.ts", oldText: "const a = 1", newText: "const a = 2" });
    expect(w.find('[data-test="diff-del"]').text()).toContain("const a = 1");
    expect(w.find('[data-test="diff-add"]').text()).toContain("const a = 2");
  });

  it("renders a diff with the step title as a copyable headline above the body", () => {
    const w = render({ type: "diff", path: "src/x.ts", oldText: "a\nb", newText: "a\nb\nc\nd" }, "src/x.ts");
    expect(w.find('[data-test="diff-add"]').text()).toContain("c");
    expect(w.find('[data-test="detail-headline"]').text()).toContain("src/x.ts");
  });

  it("renders the edit instruction at the top of a diff card", () => {
    const w = render({ type: "diff", path: "src/x.ts", oldText: "a", newText: "b", instruction: "rename the thing" });
    expect(w.find('[data-test="diff-instruction"]').text()).toContain("rename the thing");
  });

  it("keeps unchanged lines as context, not duplicated add/del", () => {
    const w = render({ type: "diff", path: "src/x.ts", oldText: "keep\nold", newText: "keep\nnew" });
    expect(w.findAll('[data-test="diff-context"]').length).toBe(1); // "keep"
    expect(w.find('[data-test="diff-del"]').text()).toContain("old");
    expect(w.find('[data-test="diff-add"]').text()).toContain("new");
  });

  it("renders the step title as a copyable headline above output and exit code", () => {
    const w = render({ type: "command", command: "npm test", output: "12 passed", exitCode: 0 }, "npm test");
    expect(w.find('[data-test="cmd-output"]').text()).toContain("12 passed");
    expect(w.text()).toContain("exit 0");
    expect(w.find('[data-test="detail-headline"]').text()).toContain("npm test");
    expect(w.find('[data-test="copy-button"]').exists()).toBe(true);
  });

  it("renders a read with the step title headline plus the line range", () => {
    const w = render({ type: "read", path: "src/a.ts", lines: "1–20" }, "src/a.ts");
    expect(w.find('[data-test="read-lines"]').text()).toContain("1–20");
    expect(w.find('[data-test="detail-headline"]').text()).toContain("src/a.ts");
  });

  it("renders search matches with the step title as a copyable headline", () => {
    const w = render({ type: "search", query: "rg foo", output: "a.ts:1\na.ts:2" }, "rg foo");
    expect(w.find('[data-test="search-output"]').text()).toContain("a.ts:1");
    expect(w.find('[data-test="search-count"]').text()).toContain("2 lines");
    expect(w.find('[data-test="detail-headline"]').text()).toContain("rg foo");
  });

  it("skips the line count when the output already states its own total", () => {
    const w = render({ type: "search", query: "grep", output: "4 matches" });
    expect(w.find('[data-test="search-count"]').exists()).toBe(false);
    expect(w.find('[data-test="search-output"]').text()).toContain("4 matches");
  });

  it("omits the headline row when no title is passed", () => {
    const w = render({ type: "command", command: "npm test", output: "ok" });
    expect(w.find('[data-test="detail-headline"]').exists()).toBe(false);
    expect(w.find('[data-test="cmd-output"]').text()).toContain("ok");
  });
  it("renders fields as a labeled list, not JSON", () => {
    const w = render({ type: "fields", fields: [{ label: "name", value: "thing" }], output: "ok" });
    expect(w.find('[data-test="field-name"]').text()).toContain("thing");
    expect(w.html()).not.toContain("{");
  });

  it("renders text prose", () => {
    const w = render({ type: "text", text: "exploring the code" });
    expect(w.find('[data-test="tool-text"]').text()).toContain("exploring the code");
  });
});

describe("ToolDetail structured output metadata", () => {
  it("shows the driver's machine count and truncation flag on command output", () => {
    const w = render({ type: "command", command: "npm test", output: "x", truncated: true });
    expect(w.find('[data-test="output-meta"]').text()).toContain("truncated");
  });

  it("prefers the driver's machine count over the rendered-line count", () => {
    const w = render({ type: "search", query: "rg foo", output: "a.ts:1\nb.ts:2", count: 19 });
    expect(w.find('[data-test="output-meta"]').text()).toContain("19");
    expect(w.find('[data-test="search-count"]').text()).toContain("19");
  });

  it("falls back to counting rendered lines when no machine count exists", () => {
    const w = render({ type: "search", query: "rg foo", output: "a.ts:1\nb.ts:2" });
    expect(w.find('[data-test="search-count"]').text()).toContain("2");
  });

  it("omits the badge when the driver reported no count and nothing was truncated", () => {
    const w = render({ type: "search", query: "rg foo", output: "a.ts:1" });
    expect(w.find('[data-test="output-meta"]').exists()).toBe(false);
  });
});
