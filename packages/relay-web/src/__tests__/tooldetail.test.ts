import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import ToolDetail from "../components/ToolDetail.vue";
import type { ToolDetailDto } from "@ganglion/xacpx-relay-protocol";

function render(detail: ToolDetailDto) {
  return mount(ToolDetail, { props: { detail } });
}

describe("ToolDetail", () => {
  it("renders a diff with added and removed lines", () => {
    const w = render({ type: "diff", path: "src/x.ts", oldText: "const a = 1", newText: "const a = 2" });
    expect(w.find('[data-test="diff-del"]').text()).toContain("const a = 1");
    expect(w.find('[data-test="diff-add"]').text()).toContain("const a = 2");
  });

  it("renders a diff body without a header-echo path row", () => {
    const w = render({ type: "diff", path: "src/x.ts", oldText: "a\nb", newText: "a\nb\nc\nd" });
    expect(w.find('[data-test="diff-add"]').text()).toContain("c");
    expect(w.text()).not.toContain("src/x.ts");
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

  it("renders a command output block and exit code without echoing the command", () => {
    const w = render({ type: "command", command: "npm test", output: "12 passed", exitCode: 0 });
    expect(w.find('[data-test="cmd-output"]').text()).toContain("12 passed");
    expect(w.text()).toContain("exit 0");
    expect(w.text()).not.toContain("npm test");
  });

  it("renders a read with the line range only when present", () => {
    const w = render({ type: "read", path: "src/a.ts", lines: "1–20" });
    expect(w.find('[data-test="read-lines"]').text()).toContain("1–20");
    expect(w.text()).not.toContain("src/a.ts");
  });

  it("renders search matches without echoing the query", () => {
    const w = render({ type: "search", query: "rg foo", output: "a.ts:1\na.ts:2" });
    expect(w.find('[data-test="search-output"]').text()).toContain("a.ts:1");
    expect(w.find('[data-test="search-count"]').text()).toContain("2 lines");
    expect(w.text()).not.toContain("rg foo");
  });

  it("skips the line count when the output already states its own total", () => {
    const w = render({ type: "search", query: "grep", output: "4 matches" });
    expect(w.find('[data-test="search-count"]').exists()).toBe(false);
    expect(w.find('[data-test="search-output"]').text()).toContain("4 matches");
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
