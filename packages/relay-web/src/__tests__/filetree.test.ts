import { describe, it, expect, vi, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { mount } from "@vue/test-utils";

const rpc = vi.fn();
vi.mock("../api/client", () => ({ api: { rpc: (id: string, t: string, p?: unknown) => rpc(id, t, p) } }));

import FileTreeNode from "../components/FileTreeNode.vue";
import { useFilesStore } from "../stores/files";

const g = { global: { mocks: { $t: (k: string) => k } } };

beforeEach(() => { setActivePinia(createPinia()); rpc.mockReset(); Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } }); });

describe("FileTreeNode", () => {
  it("renders a dir row with a chevron and lazy-expands on click", async () => {
    const s = useFilesStore(); s.instanceId = "i1"; s.workspace = "ws"; s.root = "/abs"; s.sep = "/";
    rpc.mockResolvedValueOnce({ workspace: "ws", path: "src", entries: [{ name: "a.ts", type: "file", size: 3 }], root: "/abs", sep: "/" });
    const w = mount(FileTreeNode, { props: { entry: { name: "src", type: "dir" }, dir: "", depth: 0, showDotfiles: false, showGitignored: false }, ...g });
    await w.find('[data-test="tree-row"]').trigger("click");
    await new Promise((r) => setTimeout(r, 0));
    expect(rpc).toHaveBeenCalledWith("i1", "control.fs.list", { workspace: "ws", path: "src" });
    expect(s.expanded.has("src")).toBe(true);
  });

  it("hides dotfiles and gitignored children unless toggled on", async () => {
    const s = useFilesStore(); s.instanceId = "i1"; s.workspace = "ws"; s.root = "/abs"; s.sep = "/";
    s.tree[""] = [
      { name: "keep.ts", type: "file" },
      { name: ".env", type: "file" },
      { name: "dist", type: "dir", ignored: true },
    ] as never;
    // depth 0 rendered by a parent; here mount each child via a wrapper list is simpler:
    const rows = (showDot: boolean, showIgn: boolean) => mount({
      components: { FileTreeNode },
      template: `<div><FileTreeNode v-for="e in entries" :key="e.name" :entry="e" dir="" :depth="0" :show-dotfiles="sd" :show-gitignored="si" /></div>`,
      data: () => ({ entries: s.tree[""], sd: showDot, si: showIgn }),
    }, g);
    expect(rows(false, false).findAll('[data-test="tree-row"]').length).toBe(1); // only keep.ts
    expect(rows(true, true).findAll('[data-test="tree-row"]').length).toBe(3);
  });

  it("context menu copy path writes the absolute host path", async () => {
    const s = useFilesStore(); s.instanceId = "i1"; s.workspace = "ws"; s.root = "/abs/ws"; s.sep = "/";
    const w = mount(FileTreeNode, { props: { entry: { name: "a.ts", type: "file" }, dir: "src", depth: 1, showDotfiles: true, showGitignored: true }, ...g });
    await w.find('[data-test="tree-row"]').trigger("contextmenu");
    await w.find('[data-test="menu-copyPath"]').trigger("click");
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("/abs/ws/src/a.ts");
  });

  it("renders a git-status dot for a changed file and a dir containing changes, not for clean files", async () => {
    const s = useFilesStore(); s.instanceId = "i1"; s.workspace = "ws"; s.root = "/abs"; s.sep = "/";
    s.changed = { "src/a.ts": " M" };
    const changedFile = mount(FileTreeNode, { props: { entry: { name: "a.ts", type: "file" }, dir: "src", depth: 1, showDotfiles: true, showGitignored: true }, ...g });
    expect(changedFile.find('[data-test="fs-status"]').exists()).toBe(true);
    const dirWithChange = mount(FileTreeNode, { props: { entry: { name: "src", type: "dir" }, dir: "", depth: 0, showDotfiles: true, showGitignored: true }, ...g });
    expect(dirWithChange.find('[data-test="fs-status"]').exists()).toBe(true);
    const cleanFile = mount(FileTreeNode, { props: { entry: { name: "clean.ts", type: "file" }, dir: "", depth: 0, showDotfiles: true, showGitignored: true }, ...g });
    expect(cleanFile.find('[data-test="fs-status"]').exists()).toBe(false);
  });
});
