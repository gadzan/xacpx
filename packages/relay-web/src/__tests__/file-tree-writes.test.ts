import { describe, it, expect, vi, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useFilesStore } from "../../src/stores/files";
import { api } from "../../src/api/client";

beforeEach(() => { setActivePinia(createPinia()); });

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
