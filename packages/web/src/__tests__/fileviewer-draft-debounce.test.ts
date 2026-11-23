import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import FileViewer from "../components/FileViewer.vue";
import { useFilesStore } from "../stores/files";

const TEXT = { workspace: "ws", path: "src/a.ts", content: "DISK BODY", size: 9, mtimeMs: 1000, truncated: false, binary: false };
const STORE_KEY = "xacpx.file-drafts.v1";
const readDrafts = (): Record<string, string> => JSON.parse(sessionStorage.getItem(STORE_KEY) ?? "{}");

let pinia: ReturnType<typeof createPinia>;
beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  sessionStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
});

/** Mount + load + enter edit mode under REAL timers (CodeMirror mounting relies on them),
 *  then hand back the CM view. Callers switch to fake timers before typing. */
async function mountEditing() {
  const files = useFilesStore();
  vi.spyOn(files, "readFile").mockResolvedValue({ ...TEXT });
  const w = mount(FileViewer, {
    props: { instanceId: "i1", workspace: "ws", path: "src/a.ts", sessionKey: "i1::s1" },
    global: { plugins: [pinia] },
  });
  await flushPromises();
  await new Promise((r) => setTimeout(r, 0));
  await w.get('[data-test="fv-edit"]').trigger("click");
  const editor = w.findComponent({ name: "CodeEditor" });
  const view = (editor.vm as unknown as { view: { state: { doc: { length: number } }; dispatch: (t: unknown) => void } }).view;
  return { w, view };
}

function type(view: { state: { doc: { length: number } }; dispatch: (t: unknown) => void }, text: string): void {
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
}

describe("FileViewer edit-draft debounce", () => {
  it("does not persist per keystroke; one trailing write after 300ms holds the final buffer", async () => {
    const { view } = await mountEditing();
    vi.useFakeTimers();
    type(view, "EDIT 1");
    await flushPromises();
    type(view, "EDIT 12");
    await flushPromises();
    expect(readDrafts()["i1::s1::src/a.ts"]).toBeUndefined();
    vi.advanceTimersByTime(300);
    expect(readDrafts()["i1::s1::src/a.ts"]).toBe("EDIT 12");
  });

  it("pagehide flushes the pending edit draft synchronously", async () => {
    const { view } = await mountEditing();
    vi.useFakeTimers();
    type(view, "ALMOST LOST");
    await flushPromises();
    expect(readDrafts()["i1::s1::src/a.ts"]).toBeUndefined();
    window.dispatchEvent(new Event("pagehide"));
    expect(readDrafts()["i1::s1::src/a.ts"]).toBe("ALMOST LOST");
  });

  it("unmount flushes the pending edit draft", async () => {
    const { w, view } = await mountEditing();
    vi.useFakeTimers();
    type(view, "LEAVING NOW");
    await flushPromises();
    w.unmount();
    expect(readDrafts()["i1::s1::src/a.ts"]).toBe("LEAVING NOW");
  });

  it("cancel drops the pending write so the cleared draft cannot resurrect", async () => {
    const { w, view } = await mountEditing();
    vi.useFakeTimers();
    type(view, "THROWAWAY");
    await flushPromises();
    await w.get('[data-test="fv-cancel"]').trigger("click");
    vi.advanceTimersByTime(1000); // a late timer must not re-write the draft
    expect(readDrafts()["i1::s1::src/a.ts"]).toBeUndefined();
  });

  it("a buffer typed back to disk content removes the draft key on the trailing write", async () => {
    const { view } = await mountEditing();
    vi.useFakeTimers();
    type(view, "EDITED");
    await flushPromises();
    vi.advanceTimersByTime(300);
    expect(readDrafts()["i1::s1::src/a.ts"]).toBe("EDITED");
    type(view, "DISK BODY"); // back to what's on disk
    await flushPromises();
    vi.advanceTimersByTime(300);
    expect(readDrafts()["i1::s1::src/a.ts"]).toBeUndefined();
  });
});
