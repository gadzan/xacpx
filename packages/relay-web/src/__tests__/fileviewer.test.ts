import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises } from "@vue/test-utils";

vi.mock("../lib/shiki", () => ({
  resolveLang: () => "text",
  // deterministic stand-in so jsdom never loads the real engine
  highlightToHtml: (code: string) => Promise.resolve(`<pre class="shiki"><code><span class="line">${code}</span></code></pre>`),
}));

import FileViewer from "../components/FileViewer.vue";
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
    vi.spyOn(files, "readFile").mockResolvedValue({ workspace: "ws", path: "src/a.ts", content: "one\ntwo\nthree", size: 13, truncated: false, binary: false });
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
    vi.spyOn(files, "readFile").mockResolvedValue({ workspace: "ws", path: "src/a.ts", content: "hello", size: 5, truncated: false, binary: false });
    const w = mount(FileViewer, { props: { instanceId: "i1", workspace: "ws", path: "src/a.ts" }, global: { plugins: [pinia] } });
    await flushPromises();
    await w.vm.$nextTick();
    await w.find('[data-test="copy-button"]').trigger("click");
    await Promise.resolve();
    expect((navigator.clipboard.writeText as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith("hello");
  });

  it("hides the gutter and copy button for a binary file", async () => {
    const files = useFilesStore();
    vi.spyOn(files, "readFile").mockResolvedValue({ workspace: "ws", path: "bin.dat", content: "", size: 4, truncated: false, binary: true });
    const w = mount(FileViewer, { props: { instanceId: "i1", workspace: "ws", path: "bin.dat" }, global: { plugins: [pinia] } });
    await flushPromises();
    await w.vm.$nextTick();
    expect(w.find('[data-test="fv-file-body"]').exists()).toBe(false);
    expect(w.find('[data-test="copy-button"]').exists()).toBe(false);
    expect(w.text()).toContain("Binary file not shown");
  });

  it("the mobile Files affordance emits back (return to the file list)", async () => {
    const files = useFilesStore();
    vi.spyOn(files, "readFile").mockResolvedValue({ workspace: "ws", path: "src/a.ts", content: "x", size: 1, truncated: false, binary: false });
    const w = mount(FileViewer, { props: { instanceId: "i1", workspace: "ws", path: "src/a.ts" }, global: { plugins: [pinia] } });
    await flushPromises();
    await w.vm.$nextTick();
    await w.find('[data-test="fv-back-list"]').trigger("click");
    expect(w.emitted("back")).toBeTruthy();
  });

  it("the mobile Close affordance emits close (return to the conversation)", async () => {
    const files = useFilesStore();
    vi.spyOn(files, "readFile").mockResolvedValue({ workspace: "ws", path: "src/a.ts", content: "x", size: 1, truncated: false, binary: false });
    const w = mount(FileViewer, { props: { instanceId: "i1", workspace: "ws", path: "src/a.ts" }, global: { plugins: [pinia] } });
    await flushPromises();
    await w.vm.$nextTick();
    await w.find('[data-test="fv-close"]').trigger("click");
    expect(w.emitted("close")).toBeTruthy();
  });

  it("the desktop Back affordance emits close (desktop has the list always visible)", async () => {
    const files = useFilesStore();
    vi.spyOn(files, "readFile").mockResolvedValue({ workspace: "ws", path: "src/a.ts", content: "x", size: 1, truncated: false, binary: false });
    const w = mount(FileViewer, { props: { instanceId: "i1", workspace: "ws", path: "src/a.ts" }, global: { plugins: [pinia] } });
    await flushPromises();
    await w.vm.$nextTick();
    await w.find('[data-test="fv-back"]').trigger("click");
    expect(w.emitted("close")).toBeTruthy();
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
    const readFileSpy = vi.spyOn(files, "readFile").mockImplementationOnce(() => first as Promise<{ workspace: string; path: string; content: string; size: number; truncated: boolean; binary: boolean }>);
    const w = mount(FileViewer, { props: { instanceId: "i1", workspace: "ws", path: "a.ts" }, global: { plugins: [pinia] } });
    await w.vm.$nextTick();
    readFileSpy.mockResolvedValueOnce({ workspace: "ws", path: "b.ts", content: "second", size: 6, truncated: false, binary: false });
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
});
