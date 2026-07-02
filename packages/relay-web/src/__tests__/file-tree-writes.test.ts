import { describe, it, expect, vi, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { flushPromises, mount } from "@vue/test-utils";
import { useFilesStore } from "../../src/stores/files";
import { api } from "../../src/api/client";
import FileTreeNode from "../../src/components/FileTreeNode.vue";
import FilesPanel from "../../src/components/FilesPanel.vue";

beforeEach(() => { setActivePinia(createPinia()); });

const g = { global: { mocks: { $t: (k: string) => k } } };

describe("file-tree write actions", () => {
  it("createEntry posts control.fs.create with the joined path and refreshes", async () => {
    const store = useFilesStore();
    store.instanceId = "i1"; store.workspace = "ws";
    const rpc = vi.spyOn(api, "rpc").mockImplementation(async (_i, type: string) => {
      if (type === "control.fs.create") return { path: "sub/x.txt" } as any;
      if (type === "control.fs.list") return { workspace: "ws", path: "sub", entries: [], root: "/r", sep: "/" } as any;
      if (type === "control.fs.diff") return { workspace: "ws", files: [] } as any;
      return {} as any;
    });
    await store.createEntry("sub", "x.txt", "file");
    expect(rpc).toHaveBeenCalledWith("i1", "control.fs.create", { workspace: "ws", path: "sub/x.txt", kind: "file" });
  });

  it("deleteEntry posts control.fs.delete", async () => {
    const store = useFilesStore();
    store.instanceId = "i1"; store.workspace = "ws";
    const rpc = vi.spyOn(api, "rpc").mockResolvedValue({ path: "a.txt" } as any);
    await store.deleteEntry("a.txt");
    expect(rpc).toHaveBeenCalledWith("i1", "control.fs.delete", { workspace: "ws", path: "a.txt" });
  });

  it("createEntry surfaces a disabled error into store.error", async () => {
    const store = useFilesStore();
    store.instanceId = "i1"; store.workspace = "ws";
    vi.spyOn(api, "rpc").mockResolvedValue({ error: { code: "internal", message: "files-write-disabled" } } as any);
    await store.createEntry("", "x.txt", "file");
    expect(store.error).toContain("files-write-disabled");
  });
});

describe("FileTreeNode write menu", () => {
  it("file menu includes duplicate/rename/delete/download but not newFile", async () => {
    const store = useFilesStore();
    store.instanceId = "i1"; store.workspace = "ws"; store.root = "/abs"; store.sep = "/";
    const w = mount(FileTreeNode, { props: { entry: { name: "a.ts", type: "file" }, dir: "", depth: 0, showDotfiles: true, showGitignored: true }, ...g });
    await w.find('[data-test="tree-row"]').trigger("contextmenu");
    expect(w.find('[data-test="menu-duplicate"]').exists()).toBe(true);
    expect(w.find('[data-test="menu-rename"]').exists()).toBe(true);
    expect(w.find('[data-test="menu-delete"]').exists()).toBe(true);
    expect(w.find('[data-test="menu-download"]').exists()).toBe(true);
    expect(w.find('[data-test="menu-newFile"]').exists()).toBe(false);
  });

  it("delete calls window.confirm then store.deleteEntry when confirmed", async () => {
    const store = useFilesStore();
    store.instanceId = "i1"; store.workspace = "ws"; store.root = "/abs"; store.sep = "/";
    const deleteEntry = vi.spyOn(store, "deleteEntry").mockResolvedValue();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const w = mount(FileTreeNode, { props: { entry: { name: "a.ts", type: "file" }, dir: "src", depth: 1, showDotfiles: true, showGitignored: true }, ...g });
    await w.find('[data-test="tree-row"]').trigger("contextmenu");
    await w.find('[data-test="menu-delete"]').trigger("click");
    expect(confirmSpy).toHaveBeenCalled();
    expect(deleteEntry).toHaveBeenCalledWith("src/a.ts");
  });

  it("newFile enters an inline input and submits via createEntry on Enter", async () => {
    const store = useFilesStore();
    store.instanceId = "i1"; store.workspace = "ws"; store.root = "/abs"; store.sep = "/";
    store.tree["src"] = [];
    const createEntry = vi.spyOn(store, "createEntry").mockResolvedValue();
    const w = mount(FileTreeNode, { props: { entry: { name: "src", type: "dir" }, dir: "", depth: 0, showDotfiles: true, showGitignored: true }, ...g });
    await w.find('[data-test="tree-row"]').trigger("contextmenu");
    await w.find('[data-test="menu-newFile"]').trigger("click");
    await new Promise((r) => setTimeout(r, 0));

    const input = w.find('[data-test="inline-name"]');
    expect(input.exists()).toBe(true);
    await input.setValue("new.txt");
    await input.trigger("keyup.enter");

    expect(createEntry).toHaveBeenCalledWith("src", "new.txt", "file");
  });
});

describe("FilesPanel root-level create", () => {
  it("root new-file button creates at workspace root", async () => {
    vi.spyOn(api, "rpc").mockResolvedValue({} as any);
    const store = useFilesStore();
    const createEntry = vi.spyOn(store, "createEntry").mockResolvedValue();
    const w = mount(FilesPanel, { props: { instanceId: "i1" } });
    await flushPromises();

    expect(w.find('[data-test="root-new-file"]').exists()).toBe(true);
    expect(w.find('[data-test="root-new-folder"]').exists()).toBe(true);
    expect(w.find('[data-test="root-inline-name"]').exists()).toBe(false);

    await w.find('[data-test="root-new-file"]').trigger("click");
    const input = w.find('[data-test="root-inline-name"]');
    expect(input.exists()).toBe(true);
    await input.setValue("top.txt");
    await input.trigger("keyup.enter");

    expect(createEntry).toHaveBeenCalledWith("", "top.txt", "file");
    expect(w.find('[data-test="root-inline-name"]').exists()).toBe(false);
  });

  it("Esc cancels the root inline input without creating", async () => {
    vi.spyOn(api, "rpc").mockResolvedValue({} as any);
    const store = useFilesStore();
    const createEntry = vi.spyOn(store, "createEntry").mockResolvedValue();
    const w = mount(FilesPanel, { props: { instanceId: "i1" } });
    await flushPromises();

    await w.find('[data-test="root-new-folder"]').trigger("click");
    const input = w.find('[data-test="root-inline-name"]');
    expect(input.exists()).toBe(true);
    await input.setValue("nope");
    await input.trigger("keyup.esc");

    expect(createEntry).not.toHaveBeenCalled();
    expect(w.find('[data-test="root-inline-name"]').exists()).toBe(false);
  });
});
