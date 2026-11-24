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
  sessionStorage.clear();
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

  it("Cmd-S in read mode after a save does not re-fire a stale save (CodeMirror's own Mod-s " +
    "keymap doesn't care about editable:false, so it still emits `save` straight into " +
    "FileViewer's @save binding, bypassing the document-level handler's editing.value gate)", async () => {
    const files = useFilesStore();
    vi.spyOn(files, "readFile").mockResolvedValue({ ...TEXT });
    const saveFile = vi.spyOn(files, "saveFile").mockResolvedValue({ path: "src/a.ts", mtimeMs: 2000, size: 4 });
    // attachTo: document.body so a synthetic keydown that bubbles from the editor's contentDOM
    // actually reaches `document`, where FileViewer's own shortcut handler is registered.
    const w = mount(FileViewer, { props: { instanceId: "i1", workspace: "ws", path: "src/a.ts" }, global: { plugins: [pinia] }, attachTo: document.body });
    await settle();
    // jsdom never lays out elements, so offsetParent is always null; stub it non-null the way
    // a real visible (non `display:none`) pane would report, so the document-level handler's
    // visibility gate doesn't bail out regardless of the bug under test.
    Object.defineProperty(w.element, "offsetParent", { value: document.body, configurable: true });
    await w.get('[data-test="fv-edit"]').trigger("click");
    const editor = w.findComponent({ name: "CodeEditor" });
    const view = (editor.vm as unknown as {
      view: { state: { doc: { length: number } }; dispatch: (t: unknown) => void; contentDOM: HTMLElement };
    }).view;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "new" } });
    await settle();
    await w.get('[data-test="fv-save"]').trigger("click");
    await settle();
    expect(saveFile).toHaveBeenCalledTimes(1);

    // Now back in read mode (editing flipped false after the save above), but the editor is
    // still focused. CodeMirror's own `Mod-s` keymap is wired once at mount and does NOT care
    // about editable:false — dispatch directly on contentDOM (the actual node CodeMirror's
    // internal keymap listens on; jsdom resolves "Mod" to Ctrl since navigator.platform
    // doesn't report "Mac"), bubbling up to document too.
    view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, cancelable: true }));
    await settle();

    expect(saveFile).toHaveBeenCalledTimes(1);
    expect(w.find('[data-test="fv-save-error"]').exists()).toBe(false);
    w.unmount();
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
    await w.get('[data-test="fv-find-toggle"]').trigger("click");
    await settle();
    expect(w.find(".cm-search").exists() || w.find(".cm-panel").exists()).toBe(true);
  });

  it("a stale-write reload keeps the user's edited buffer (does not clobber the draft)", async () => {
    const files = useFilesStore();
    vi.spyOn(files, "readFile").mockResolvedValue({ ...TEXT });
    vi.spyOn(files, "saveFile").mockRejectedValue(new Error("stale-write"));
    const w = mountViewer({ path: "src/a.ts" });
    await settle();
    await w.get('[data-test="fv-edit"]').trigger("click");
    const editor = w.findComponent({ name: "CodeEditor" });
    const view = (editor.vm as unknown as { view: { state: { doc: { length: number; toString(): string } }; dispatch: (t: unknown) => void } }).view;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "edited-draft" } });
    await settle();
    await w.get('[data-test="fv-save"]').trigger("click");
    await settle();
    expect(w.find('[data-test="fv-save-error"]').exists()).toBe(true);

    vi.spyOn(files, "readFile").mockResolvedValue({ ...TEXT, mtimeMs: 5000, size: 99 });
    await w.get('[data-test="fv-reload"]').trigger("click");
    await settle();

    expect(w.find('[data-test="code-editor"]').exists()).toBe(true);
    expect(view.state.doc.toString()).toBe("edited-draft");
  });

  it("restores an edit draft into edit mode on load", async () => {
    const files = useFilesStore();
    vi.spyOn(files, "readFile").mockResolvedValue({ ...TEXT, path: "src/a.ts", content: "DISK BODY" });
    sessionStorage.setItem("xacpx.file-drafts.v1", JSON.stringify({ "i1::s1::src/a.ts": "DRAFT BODY" }));
    const w = mountViewer({ path: "src/a.ts", sessionKey: "i1::s1" });
    await settle();
    // Draft differs from disk + file is editable ⇒ enter edit mode with the draft buffer.
    expect(w.find('[data-test="fv-dirty-dot"]').exists()).toBe(true);
    expect(w.find('[data-test="fv-save"]').exists()).toBe(true);
    expect(w.emitted("dirty-change")?.some((e) => e[0] === true)).toBe(true);
  });

  it("does NOT enter edit mode when the draft equals disk content", async () => {
    const files = useFilesStore();
    vi.spyOn(files, "readFile").mockResolvedValue({ ...TEXT, path: "src/a.ts", content: "DISK BODY" });
    sessionStorage.setItem("xacpx.file-drafts.v1", JSON.stringify({ "i1::s1::src/a.ts": "DISK BODY" }));
    const w = mountViewer({ path: "src/a.ts", sessionKey: "i1::s1" });
    await settle();
    expect(w.find('[data-test="fv-dirty-dot"]').exists()).toBe(false);
    expect(w.find('[data-test="fv-edit"]').exists()).toBe(true); // read mode: pencil visible
  });

  it("clears the draft on cancel", async () => {
    const files = useFilesStore();
    vi.spyOn(files, "readFile").mockResolvedValue({ ...TEXT, path: "src/a.ts", content: "DISK BODY" });
    sessionStorage.setItem("xacpx.file-drafts.v1", JSON.stringify({ "i1::s1::src/a.ts": "DRAFT BODY" }));
    const w = mountViewer({ path: "src/a.ts", sessionKey: "i1::s1" });
    await settle();
    await w.get('[data-test="fv-cancel"]').trigger("click");
    expect(JSON.parse(sessionStorage.getItem("xacpx.file-drafts.v1")!)["i1::s1::src/a.ts"]).toBeUndefined();
  });

  it("clears the draft after a successful save", async () => {
    const files = useFilesStore();
    vi.spyOn(files, "readFile").mockResolvedValue({ ...TEXT, path: "src/a.ts", content: "DISK BODY" });
    vi.spyOn(files, "saveFile").mockResolvedValue({ path: "src/a.ts", mtimeMs: 2000, size: 5 });
    sessionStorage.setItem("xacpx.file-drafts.v1", JSON.stringify({ "i1::s1::src/a.ts": "DRAFT BODY" }));
    const w = mountViewer({ path: "src/a.ts", sessionKey: "i1::s1" });
    await settle();
    await w.get('[data-test="fv-save"]').trigger("click");
    await settle();
    expect(JSON.parse(sessionStorage.getItem("xacpx.file-drafts.v1")!)["i1::s1::src/a.ts"]).toBeUndefined();
  });
});
