import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

import FileViewer from "../components/FileViewer.vue";
import { useFilesStore } from "../stores/files";

const TEXT = { workspace: "ws", path: "src/a.ts", content: "one\ntwo\nthree", size: 13, mtimeMs: 1000, truncated: false, binary: false };

let pinia: ReturnType<typeof createPinia>;
beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
});

function mountViewer(props: Record<string, unknown>) {
  return mount(FileViewer, { props: { instanceId: "i1", workspace: "ws", ...props }, global: { plugins: [pinia] } });
}
const settle = async () => { await flushPromises(); await new Promise((r) => setTimeout(r, 0)); };

describe("FileViewer", () => {
  it("loads the file and renders it in the CodeMirror editor (read-only)", async () => {
    const files = useFilesStore();
    vi.spyOn(files, "readFile").mockResolvedValue({ ...TEXT });
    const w = mountViewer({ path: "src/a.ts" });
    await settle();
    expect(files.readFile).toHaveBeenCalledWith("i1", "ws", "src/a.ts");
    expect(w.find('[data-test="code-editor"]').exists()).toBe(true);
    expect(w.get('[data-test="code-editor"]').element.textContent).toContain("one");
    expect(w.get('[data-test="code-editor"]').element.textContent).toContain("three");
  });

  it("Edit → type → Save calls saveFile with the read-time token and new content", async () => {
    const files = useFilesStore();
    vi.spyOn(files, "readFile").mockResolvedValue({ ...TEXT });
    const saveFile = vi.spyOn(files, "saveFile").mockResolvedValue({ path: "src/a.ts", mtimeMs: 2000, size: 4 });
    const w = mountViewer({ path: "src/a.ts" });
    await settle();
    await w.get('[data-test="fv-edit"]').trigger("click");
    // simulate an edit by driving the exposed CM view of the child CodeEditor
    const editor = w.findComponent({ name: "CodeEditor" });
    const view = (editor.vm as unknown as { view: { state: { doc: { length: number } }; dispatch: (t: unknown) => void } }).view;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "new" } });
    await settle();
    await w.get('[data-test="fv-save"]').trigger("click");
    await settle();
    expect(saveFile).toHaveBeenCalledWith("i1", "ws", "src/a.ts", "new", { mtimeMs: 1000, size: 13 });
  });

  it("hides the Edit button for binary and truncated files", async () => {
    const files = useFilesStore();
    vi.spyOn(files, "readFile").mockResolvedValue({ workspace: "ws", path: "b.bin", content: "", size: 9e9, mtimeMs: 1, truncated: true, binary: true });
    const w = mountViewer({ path: "b.bin" });
    await settle();
    expect(w.find('[data-test="fv-edit"]').exists()).toBe(false);
  });

  it("a stale-write error shows the reload banner and stays in edit mode", async () => {
    const files = useFilesStore();
    vi.spyOn(files, "readFile").mockResolvedValue({ ...TEXT });
    vi.spyOn(files, "saveFile").mockRejectedValue(new Error("stale-write"));
    const w = mountViewer({ path: "src/a.ts" });
    await settle();
    await w.get('[data-test="fv-edit"]').trigger("click");
    const editor = w.findComponent({ name: "CodeEditor" });
    const view = (editor.vm as unknown as { view: { state: { doc: { length: number } }; dispatch: (t: unknown) => void } }).view;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "mine" } });
    await settle();
    await w.get('[data-test="fv-save"]').trigger("click");
    await settle();
    expect(w.find('[data-test="fv-save-error"]').exists()).toBe(true);
    expect(w.find('[data-test="code-editor"]').exists()).toBe(true);
  });

  it("the magnifier opens the editor search panel", async () => {
    const files = useFilesStore();
    vi.spyOn(files, "readFile").mockResolvedValue({ ...TEXT });
    const w = mountViewer({ path: "src/a.ts" });
    await settle();
    const editor = w.findComponent({ name: "CodeEditor" });
    const openSearch = vi.fn();
    (editor.vm as unknown as { openSearch: () => void }).openSearch = openSearch;
    await w.get('[data-test="fv-find-toggle"]').trigger("click");
    expect(openSearch).toHaveBeenCalled();
  });
});
