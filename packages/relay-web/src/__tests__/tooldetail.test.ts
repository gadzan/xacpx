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

  it("shows +N/−N stat badges from a real line diff", () => {
    const w = render({ type: "diff", path: "src/x.ts", oldText: "a\nb", newText: "a\nb\nc\nd" });
    const stats = w.find('[data-test="diff-stats"]').text();
    expect(stats).toContain("+2"); // 2 appended lines
    expect(stats).not.toContain("−"); // nothing removed
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

  it("renders a command with a terminal output block and exit code", () => {
    const w = render({ type: "command", command: "npm test", output: "12 passed", exitCode: 0 });
    expect(w.find('[data-test="cmd-command"]').text()).toContain("npm test");
    expect(w.find('[data-test="cmd-output"]').text()).toContain("12 passed");
    expect(w.text()).toContain("exit 0");
  });

  it("renders a read with path and line range", () => {
    const w = render({ type: "read", path: "src/a.ts", lines: "1–20" });
    expect(w.find('[data-test="read-path"]').text()).toContain("src/a.ts");
    expect(w.text()).toContain("1–20");
  });

  it("renders search query and matches", () => {
    const w = render({ type: "search", query: "rg foo", output: "a.ts:1" });
    expect(w.find('[data-test="search-query"]').text()).toContain("rg foo");
    expect(w.find('[data-test="search-output"]').text()).toContain("a.ts:1");
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
