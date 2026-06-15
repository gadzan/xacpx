import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn().mockResolvedValue({ workspaces: [], entries: [], path: "" });
vi.mock("../api/client", () => ({
  ApiError: class extends Error {},
  api: { rpc: (...a: unknown[]) => rpc(...a) },
}));

import FilesPanel from "../components/FilesPanel.vue";
import { useFilesStore } from "../stores/files";

let pinia: ReturnType<typeof createPinia>;
beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  rpc.mockClear();
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
});

describe("FilesPanel file viewer", () => {
  it("renders a numbered gutter with one row per line", async () => {
    const w = mount(FilesPanel, { props: { instanceId: "i1" }, global: { plugins: [pinia] } });
    const files = useFilesStore();
    files.file = { workspace: "ws", path: "src/a.ts", content: "one\ntwo\nthree", size: 13, truncated: false, binary: false };
    await w.vm.$nextTick();
    const lines = w.findAll('[data-test="file-line"]');
    expect(lines.length).toBe(3);
    expect(lines[0].text()).toContain("1");
    expect(lines[0].text()).toContain("one");
    expect(lines[2].text()).toContain("3");
    expect(lines[2].text()).toContain("three");
  });

  it("offers a copy button that copies the file content", async () => {
    const w = mount(FilesPanel, { props: { instanceId: "i1" }, global: { plugins: [pinia] } });
    const files = useFilesStore();
    files.file = { workspace: "ws", path: "src/a.ts", content: "hello", size: 5, truncated: false, binary: false };
    await w.vm.$nextTick();
    await w.find('[data-test="copy-button"]').trigger("click");
    await Promise.resolve();
    expect((navigator.clipboard.writeText as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith("hello");
  });

  it("badges directory entries with git status", async () => {
    const w = mount(FilesPanel, { props: { instanceId: "i1" }, global: { plugins: [pinia] } });
    const files = useFilesStore();
    files.path = "";
    files.entries = [
      { name: "src", type: "dir" },
      { name: "clean.ts", type: "file", size: 1 },
      { name: "new.ts", type: "file", size: 1 },
    ];
    files.changed = { "src/a.ts": " M", "new.ts": "??" };
    await w.vm.$nextTick();
    const badges = w.findAll('[data-test="fs-status"]');
    // src (dir, nested change) + new.ts (untracked) badge; clean.ts has none.
    expect(badges.length).toBe(2);
    const texts = badges.map((b) => b.text());
    expect(texts).toContain("•"); // src directory contains a change
    expect(texts).toContain("U"); // new.ts is untracked
  });

  it("hides the gutter and copy button for a binary file", async () => {
    const w = mount(FilesPanel, { props: { instanceId: "i1" }, global: { plugins: [pinia] } });
    const files = useFilesStore();
    files.file = { workspace: "ws", path: "bin.dat", content: "", size: 4, truncated: false, binary: true };
    await w.vm.$nextTick();
    expect(w.find('[data-test="file-body"]').exists()).toBe(false);
    expect(w.find('[data-test="copy-button"]').exists()).toBe(false);
    expect(w.text()).toContain("Binary file not shown");
  });
});
