import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises } from "@vue/test-utils";

vi.mock("../lib/shiki", () => ({
  resolveLang: () => "text",
  // deterministic stand-in so jsdom never loads the real engine — one `.line` per source
  // line, mirroring real Shiki output so line anchoring (scroll/search) is exercised.
  highlightToHtml: (code: string) =>
    Promise.resolve(
      `<pre class="shiki"><code>${code.split("\n").map((l) => `<span class="line">${l}</span>`).join("")}</code></pre>`,
    ),
}));

import FileViewer from "../components/FileViewer.vue";
import CodeEditor from "../components/CodeEditor.vue";
import { useFilesStore } from "../stores/files";

let pinia: ReturnType<typeof createPinia>;
beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
});

describe("FileViewer", () => {
  it("renders the file content (loaded via readFile from the path prop) and upgrades it to highlighted HTML", async () => {
    vi.useFakeTimers();
    const files = useFilesStore();
    vi.spyOn(files, "readFile").mockResolvedValue({ workspace: "ws", path: "src/a.ts", content: "one\ntwo\nthree", size: 13, mtimeMs: 1000, truncated: false, binary: false });
    const w = mount(FileViewer, { props: { instanceId: "i1", workspace: "ws", path: "src/a.ts" }, global: { plugins: [pinia] } });
    await flushPromises();
    await w.vm.$nextTick();
    expect(files.readFile).toHaveBeenCalledWith("i1", "ws", "src/a.ts");
    // immediate plain fallback shows the content before highlighting resolves
    const body = w.find('[data-test="fv-file-body"]');
    expect(body.exists()).toBe(true);
    expect(body.text()).toContain("one");
    expect(body.text()).toContain("three");
    // after the 150ms debounce + async highlight, Shiki HTML replaces the fallback
    vi.advanceTimersByTime(200);
    await flushPromises();
    await w.vm.$nextTick();
    expect(w.find('[data-test="fv-file-body"]').html()).toContain("shiki");
    vi.useRealTimers();
  });

  it("offers a copy button that copies the file content", async () => {
    const files = useFilesStore();
    vi.spyOn(files, "readFile").mockResolvedValue({ workspace: "ws", path: "src/a.ts", content: "hello", size: 5, mtimeMs: 1000, truncated: false, binary: false });
    const w = mount(FileViewer, { props: { instanceId: "i1", workspace: "ws", path: "src/a.ts" }, global: { plugins: [pinia] } });
    await flushPromises();
    await w.vm.$nextTick();
    await w.find('[data-test="copy-button"]').trigger("click");
    await Promise.resolve();
    expect((navigator.clipboard.writeText as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith("hello");
  });

  it("hides the gutter and copy button for a binary file", async () => {
    const files = useFilesStore();
    vi.spyOn(files, "readFile").mockResolvedValue({ workspace: "ws", path: "bin.dat", content: "", size: 4, mtimeMs: 1000, truncated: false, binary: true });
    const w = mount(FileViewer, { props: { instanceId: "i1", workspace: "ws", path: "bin.dat" }, global: { plugins: [pinia] } });
    await flushPromises();
    await w.vm.$nextTick();
    expect(w.find('[data-test="fv-file-body"]').exists()).toBe(false);
    expect(w.find('[data-test="copy-button"]').exists()).toBe(false);
    expect(w.text()).toContain("Binary file not shown");
  });

  it("the mobile Files affordance emits back (return to the file list)", async () => {
    const files = useFilesStore();
    vi.spyOn(files, "readFile").mockResolvedValue({ workspace: "ws", path: "src/a.ts", content: "x", size: 1, mtimeMs: 1000, truncated: false, binary: false });
    const w = mount(FileViewer, { props: { instanceId: "i1", workspace: "ws", path: "src/a.ts" }, global: { plugins: [pinia] } });
    await flushPromises();
    await w.vm.$nextTick();
    await w.find('[data-test="fv-back-list"]').trigger("click");
    expect(w.emitted("back")).toBeTruthy();
  });

  it("the mobile Close affordance emits close (return to the conversation)", async () => {
    const files = useFilesStore();
    vi.spyOn(files, "readFile").mockResolvedValue({ workspace: "ws", path: "src/a.ts", content: "x", size: 1, mtimeMs: 1000, truncated: false, binary: false });
    const w = mount(FileViewer, { props: { instanceId: "i1", workspace: "ws", path: "src/a.ts" }, global: { plugins: [pinia] } });
    await flushPromises();
    await w.vm.$nextTick();
    await w.find('[data-test="fv-close"]').trigger("click");
    expect(w.emitted("close")).toBeTruthy();
  });

  it("the desktop Back affordance emits close (desktop has the list always visible)", async () => {
    const files = useFilesStore();
    vi.spyOn(files, "readFile").mockResolvedValue({ workspace: "ws", path: "src/a.ts", content: "x", size: 1, mtimeMs: 1000, truncated: false, binary: false });
    const w = mount(FileViewer, { props: { instanceId: "i1", workspace: "ws", path: "src/a.ts" }, global: { plugins: [pinia] } });
    await flushPromises();
    await w.vm.$nextTick();
    await w.find('[data-test="fv-back"]').trigger("click");
    expect(w.emitted("close")).toBeTruthy();
  });

  it("in-file find marks every match and reports the count (prev/next cycle, clear on close)", async () => {
    vi.useFakeTimers();
    (Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = vi.fn();
    const files = useFilesStore();
    vi.spyOn(files, "readFile").mockResolvedValue({ workspace: "ws", path: "a.ts", content: "const foo = 1\nreturn foo", size: 22, mtimeMs: 1000, truncated: false, binary: false });
    const w = mount(FileViewer, { props: { instanceId: "i1", workspace: "ws", path: "a.ts" }, global: { plugins: [pinia] } });
    await flushPromises();
    await w.vm.$nextTick();
    vi.advanceTimersByTime(200); // let the highlight resolve so `.line` rows exist
    await flushPromises();
    await w.vm.$nextTick();

    expect(w.find('[data-test="fv-find-bar"]').exists()).toBe(false);
    await w.find('[data-test="fv-find-toggle"]').trigger("click");
    await w.find('[data-test="fv-find-input"]').setValue("foo");
    await flushPromises();
    await w.vm.$nextTick();

    expect(w.findAll("mark.search-hit")).toHaveLength(2);
    expect(w.find('[data-test="fv-find-count"]').text()).toBe("1/2");
    // next wraps 1→2→1
    await w.find('[data-test="fv-find-next"]').trigger("click");
    expect(w.find('[data-test="fv-find-count"]').text()).toBe("2/2");
    // closing clears the marks
    await w.find('[data-test="fv-find-close"]').trigger("click");
    await w.vm.$nextTick();
    expect(w.findAll("mark.search-hit")).toHaveLength(0);
    vi.useRealTimers();
  });

  it("does not offer the find bar for a huge (never-highlighted) file", async () => {
    const files = useFilesStore();
    const huge = Array.from({ length: 5001 }, (_, i) => `line ${i}`).join("\n");
    vi.spyOn(files, "readFile").mockResolvedValue({ workspace: "ws", path: "big.txt", content: huge, size: huge.length, mtimeMs: 1000, truncated: false, binary: false });
    const w = mount(FileViewer, { props: { instanceId: "i1", workspace: "ws", path: "big.txt" }, global: { plugins: [pinia] } });
    await flushPromises();
    await w.vm.$nextTick();
    // > LINE_GUTTER_LIMIT ⇒ plain <pre>, no `.line` anchors ⇒ find would always say "no results".
    expect(w.find('[data-test="fv-find-toggle"]').exists()).toBe(false);
  });

  it("scrolls to and flashes the target line when opened from a content-search hit", async () => {
    vi.useFakeTimers();
    (Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = vi.fn();
    const files = useFilesStore();
    vi.spyOn(files, "readFile").mockResolvedValue({ workspace: "ws", path: "a.ts", content: "l1\nl2\nl3\nl4", size: 11, mtimeMs: 1000, truncated: false, binary: false });
    const w = mount(FileViewer, { props: { instanceId: "i1", workspace: "ws", path: "a.ts", line: 3, lineRev: 1 }, global: { plugins: [pinia] } });
    await flushPromises();
    await w.vm.$nextTick();
    vi.advanceTimersByTime(200);
    await flushPromises();
    await w.vm.$nextTick();

    const lines = Array.from(w.element.querySelectorAll(".line")) as HTMLElement[];
    expect(lines).toHaveLength(4);
    expect(lines[2].scrollIntoView).toHaveBeenCalled();
    expect(lines[2].classList.contains("line-flash")).toBe(true);
    vi.useRealTimers();
  });

  it("renders a single-file diff (loaded via readDiff from the diffPath prop) as structured rows", async () => {
    const files = useFilesStore();
    vi.spyOn(files, "readDiff").mockResolvedValue({ workspace: "ws", files: [{ path: "src/a.ts", status: " M" }], diff: "@@ -1 +1 @@\n-old\n+new", truncated: false });
    const w = mount(FileViewer, { props: { instanceId: "i1", workspace: "ws", diffPath: "src/a.ts" }, global: { plugins: [pinia] } });
    await flushPromises();
    await w.vm.$nextTick();
    expect(files.readDiff).toHaveBeenCalledWith("i1", "ws", "src/a.ts");
    const body = w.find('[data-test="fv-diff-body"]');
    expect(body.exists()).toBe(true);
    const rows = w.findAll('[data-test="fv-diff-row"]');
    // hunk header + one del + one add
    expect(rows.length).toBe(3);
    expect(body.text()).toContain("old");
    expect(body.text()).toContain("new");
  });

  it("ignores a stale readFile response when props change before it resolves (race guard)", async () => {
    const files = useFilesStore();
    let resolveFirst!: (v: { workspace: string; path: string; content: string; size: number; truncated: boolean; binary: boolean }) => void;
    const first = new Promise((resolve) => { resolveFirst = resolve; });
    const readFileSpy = vi.spyOn(files, "readFile").mockImplementationOnce(() => first as Promise<{ workspace: string; path: string; content: string; size: number; mtimeMs: number; truncated: boolean; binary: boolean }>);
    const w = mount(FileViewer, { props: { instanceId: "i1", workspace: "ws", path: "a.ts" }, global: { plugins: [pinia] } });
    await w.vm.$nextTick();
    readFileSpy.mockResolvedValueOnce({ workspace: "ws", path: "b.ts", content: "second", size: 6, mtimeMs: 1000, truncated: false, binary: false });
    // switch to a second file before the first load resolves
    await w.setProps({ path: "b.ts" });
    await flushPromises();
    await w.vm.$nextTick();
    // now let the stale first response resolve — it must NOT clobber the second file's content
    resolveFirst({ workspace: "ws", path: "a.ts", content: "first (stale)", size: 14, truncated: false, binary: false });
    await flushPromises();
    await w.vm.$nextTick();
    const body = w.find('[data-test="fv-file-body"]');
    expect(body.text()).toContain("second");
    expect(body.text()).not.toContain("stale");
  });

  it("ignores a stale readFile rejection when props change before it rejects (race guard)", async () => {
    const files = useFilesStore();
    let rejectFirst!: (e: Error) => void;
    const first = new Promise<{ workspace: string; path: string; content: string; size: number; mtimeMs: number; truncated: boolean; binary: boolean }>((_resolve, reject) => { rejectFirst = reject; });
    const readFileSpy = vi.spyOn(files, "readFile").mockImplementationOnce(() => first);
    const w = mount(FileViewer, { props: { instanceId: "i1", workspace: "ws", path: "a.ts" }, global: { plugins: [pinia] } });
    await w.vm.$nextTick();
    readFileSpy.mockResolvedValueOnce({ workspace: "ws", path: "b.ts", content: "second", size: 6, mtimeMs: 1000, truncated: false, binary: false });
    // switch to a second file before the first load rejects
    await w.setProps({ path: "b.ts" });
    await flushPromises();
    await w.vm.$nextTick();
    // second file's content is showing
    expect(w.find('[data-test="fv-file-body"]').text()).toContain("second");
    // now let the stale first load reject — it must NOT clobber the second file's content
    // nor surface an error for a selection that's no longer current
    rejectFirst(new Error("deleted"));
    await flushPromises();
    await w.vm.$nextTick();
    expect(w.find('[data-test="fv-file-body"]').text()).toContain("second");
    expect(w.find('[data-test="fv-error"]').exists()).toBe(false);
  });

  it("shows an error (and clears stale content) when a load rejects with no newer selection pending", async () => {
    const files = useFilesStore();
    vi.spyOn(files, "readFile").mockResolvedValueOnce({ workspace: "ws", path: "a.ts", content: "first", size: 5, mtimeMs: 1000, truncated: false, binary: false });
    const w = mount(FileViewer, { props: { instanceId: "i1", workspace: "ws", path: "a.ts" }, global: { plugins: [pinia] } });
    await flushPromises();
    await w.vm.$nextTick();
    expect(w.find('[data-test="fv-file-body"]').text()).toContain("first");
    // switch to a file whose load rejects (deleted file, permission error, etc.)
    vi.spyOn(files, "readFile").mockRejectedValueOnce(new Error("deleted"));
    await w.setProps({ path: "gone.ts" });
    await flushPromises();
    await w.vm.$nextTick();
    const err = w.find('[data-test="fv-error"]');
    expect(err.exists()).toBe(true);
    expect(err.text()).toContain("deleted");
    // the previous selection's content must not still be shown as if it were the new one
    expect(w.find('[data-test="fv-file-body"]').exists()).toBe(false);
    expect(w.text()).not.toContain("first");
  });

  it("Edit enters edit mode and Save calls saveFile with the read token", async () => {
    const files = useFilesStore();
    vi.spyOn(files, "readFile").mockResolvedValue({ workspace: "ws", path: "a.ts", content: "old", size: 3, mtimeMs: 100, truncated: false, binary: false });
    const saveFile = vi.fn().mockResolvedValue({ path: "a.ts", mtimeMs: 200, size: 3 });
    files.saveFile = saveFile;
    const w = mount(FileViewer, { props: { instanceId: "i1", workspace: "ws", path: "a.ts" }, global: { plugins: [pinia] } });
    await flushPromises();
    await w.vm.$nextTick();
    await w.get('[data-test="fv-edit"]').trigger("click");
    expect(w.find('[data-test="code-editor"]').exists()).toBe(true);
    // Save starts disabled until the draft actually differs from the loaded content — mirror a
    // real edit via the CodeEditor's v-model (its own doc-change wiring is covered by
    // codeeditor.test.ts) rather than clicking Save on an untouched, still-clean draft.
    await w.getComponent(CodeEditor).vm.$emit("update:modelValue", "new content");
    await w.vm.$nextTick();
    await w.get('[data-test="fv-save"]').trigger("click");
    await flushPromises();
    expect(saveFile).toHaveBeenCalledWith("i1", "ws", "a.ts", "new content", { mtimeMs: 100, size: 3 });
  });

  it("Edit button is hidden for binary/truncated files", async () => {
    const files = useFilesStore();
    vi.spyOn(files, "readFile").mockResolvedValue({ workspace: "ws", path: "big.bin", content: "", size: 9e9, mtimeMs: 1, truncated: true, binary: true });
    const w = mount(FileViewer, { props: { instanceId: "i1", workspace: "ws", path: "big.bin" }, global: { plugins: [pinia] } });
    await flushPromises();
    await w.vm.$nextTick();
    expect(w.find('[data-test="fv-edit"]').exists()).toBe(false);
  });

  it("Cmd/Ctrl-S while editing saves exactly once (CodeMirror's own Mod-s keymap and the " +
    "document-level shortcut must not both fire save() for the same keypress)", async () => {
    const files = useFilesStore();
    vi.spyOn(files, "readFile").mockResolvedValue({ workspace: "ws", path: "a.ts", content: "old", size: 3, mtimeMs: 100, truncated: false, binary: false });
    const saveFile = vi.fn().mockResolvedValue({ path: "a.ts", mtimeMs: 200, size: 3 });
    files.saveFile = saveFile;
    // attachTo: document.body so the synthetic keydown actually bubbles up to `document`,
    // where FileViewer's own shortcut handler is registered (see onKeydown/onMounted below).
    const w = mount(FileViewer, { props: { instanceId: "i1", workspace: "ws", path: "a.ts" }, global: { plugins: [pinia] }, attachTo: document.body });
    await flushPromises();
    await w.vm.$nextTick();
    // jsdom never lays out elements, so offsetParent is always null; stub it non-null the way
    // a real visible (non `display:none`) pane would report, so the document-level Cmd/Ctrl-S
    // handler's visibility gate doesn't bail out regardless of the bug under test.
    Object.defineProperty(w.element, "offsetParent", { value: document.body, configurable: true });
    await w.get('[data-test="fv-edit"]').trigger("click");
    await w.getComponent(CodeEditor).vm.$emit("update:modelValue", "new content");
    await w.vm.$nextTick();
    // Dispatch ONE real keydown on the CodeMirror content DOM (not just synthetically calling
    // save()): it both (a) runs through CodeMirror's own `Mod-s` keymap (emits `save`, handled
    // by the parent's `@save="save()"` on <CodeEditor>) and (b) bubbles up to `document`, where
    // FileViewer's own keydown listener ALSO matches and calls save() — exactly the double-fire
    // this test guards against. (jsdom resolves "Mod" to Ctrl, not Cmd, since navigator.platform
    // doesn't report "Mac" — ctrlKey is what actually drives CodeMirror's keymap here.)
    const view = (w.getComponent(CodeEditor).vm as unknown as { view: { contentDOM: HTMLElement } }).view;
    view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, cancelable: true }));
    await flushPromises();
    expect(saveFile).toHaveBeenCalledTimes(1);
    w.unmount();
  });

  it("a stale-write error shows the reload banner and keeps edit mode", async () => {
    const files = useFilesStore();
    vi.spyOn(files, "readFile").mockResolvedValue({ workspace: "ws", path: "a.ts", content: "old", size: 3, mtimeMs: 100, truncated: false, binary: false });
    files.saveFile = vi.fn().mockRejectedValue(new Error("stale-write"));
    const w = mount(FileViewer, { props: { instanceId: "i1", workspace: "ws", path: "a.ts" }, global: { plugins: [pinia] } });
    await flushPromises();
    await w.vm.$nextTick();
    await w.get('[data-test="fv-edit"]').trigger("click");
    await w.getComponent(CodeEditor).vm.$emit("update:modelValue", "new content");
    await w.vm.$nextTick();
    await w.get('[data-test="fv-save"]').trigger("click");
    await flushPromises();
    expect(w.find('[data-test="fv-save-error"]').exists()).toBe(true);
    expect(w.find('[data-test="code-editor"]').exists()).toBe(true); // still editing, draft kept
  });
});
