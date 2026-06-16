import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import FileViewer from "../components/FileViewer.vue";
import { useFilesStore } from "../stores/files";

let pinia: ReturnType<typeof createPinia>;
beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
});

describe("FileViewer", () => {
  it("renders a numbered gutter with one row per line", async () => {
    const w = mount(FileViewer, { global: { plugins: [pinia] } });
    const files = useFilesStore();
    files.file = { workspace: "ws", path: "src/a.ts", content: "one\ntwo\nthree", size: 13, truncated: false, binary: false };
    await w.vm.$nextTick();
    const lines = w.findAll('[data-test="fv-line"]');
    expect(lines.length).toBe(3);
    expect(lines[0].text()).toContain("1");
    expect(lines[0].text()).toContain("one");
    expect(lines[2].text()).toContain("three");
  });

  it("offers a copy button that copies the file content", async () => {
    const w = mount(FileViewer, { global: { plugins: [pinia] } });
    const files = useFilesStore();
    files.file = { workspace: "ws", path: "src/a.ts", content: "hello", size: 5, truncated: false, binary: false };
    await w.vm.$nextTick();
    await w.find('[data-test="copy-button"]').trigger("click");
    await Promise.resolve();
    expect((navigator.clipboard.writeText as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith("hello");
  });

  it("hides the gutter and copy button for a binary file", async () => {
    const w = mount(FileViewer, { global: { plugins: [pinia] } });
    const files = useFilesStore();
    files.file = { workspace: "ws", path: "bin.dat", content: "", size: 4, truncated: false, binary: true };
    await w.vm.$nextTick();
    expect(w.find('[data-test="fv-file-body"]').exists()).toBe(false);
    expect(w.find('[data-test="copy-button"]').exists()).toBe(false);
    expect(w.text()).toContain("Binary file not shown");
  });

  it("emits back when the Back affordance is clicked", async () => {
    const w = mount(FileViewer, { global: { plugins: [pinia] } });
    const files = useFilesStore();
    files.file = { workspace: "ws", path: "src/a.ts", content: "x", size: 1, truncated: false, binary: false };
    await w.vm.$nextTick();
    await w.find('[data-test="fv-back"]').trigger("click");
    expect(w.emitted("back")).toBeTruthy();
  });

  it("renders a single-file diff when a diff path is selected", async () => {
    const w = mount(FileViewer, { global: { plugins: [pinia] } });
    const files = useFilesStore();
    files.diffPath = "src/a.ts";
    files.diff = { workspace: "ws", files: [{ path: "src/a.ts", status: " M" }], diff: "@@ -1 +1 @@\n-old\n+new", truncated: false };
    await w.vm.$nextTick();
    const body = w.find('[data-test="fv-diff-body"]');
    expect(body.exists()).toBe(true);
    expect(body.text()).toContain("new");
  });
});
