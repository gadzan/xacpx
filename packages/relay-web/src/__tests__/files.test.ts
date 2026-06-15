import { setActivePinia, createPinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
vi.mock("../api/client", () => ({
  ApiError: class extends Error { constructor(public code: string, public status: number) { super(code); } },
  api: { rpc: (id: string, type: string, payload?: unknown) => rpc(id, type, payload) },
}));

import { useFilesStore } from "../stores/files";

beforeEach(() => {
  setActivePinia(createPinia());
  rpc.mockReset();
});

describe("files store", () => {
  it("selects a workspace and lists the root", async () => {
    rpc.mockResolvedValueOnce({ workspace: "ws", path: "", entries: [
      { name: "src", type: "dir" },
      { name: "README.md", type: "file", size: 10 },
    ] });
    const s = useFilesStore();
    await s.selectWorkspace("i1", "ws");
    expect(rpc).toHaveBeenCalledWith("i1", "control.fs.list", { workspace: "ws", path: "" });
    expect(s.entries.map((e) => e.name)).toEqual(["src", "README.md"]);
  });

  it("descends into a directory and opens a file", async () => {
    rpc.mockResolvedValueOnce({ workspace: "ws", path: "", entries: [] });
    const s = useFilesStore();
    await s.selectWorkspace("i1", "ws");
    rpc.mockResolvedValueOnce({ workspace: "ws", path: "src", entries: [{ name: "a.ts", type: "file", size: 5 }] });
    await s.open({ name: "src", type: "dir" });
    expect(rpc).toHaveBeenLastCalledWith("i1", "control.fs.list", { workspace: "ws", path: "src" });
    expect(s.path).toBe("src");
    rpc.mockResolvedValueOnce({ workspace: "ws", path: "src/a.ts", content: "export const a = 1;", size: 19, truncated: false, binary: false });
    await s.open({ name: "a.ts", type: "file", size: 5 });
    expect(rpc).toHaveBeenLastCalledWith("i1", "control.fs.read", { workspace: "ws", path: "src/a.ts" });
    expect(s.file?.content).toContain("export const a");
  });

  it("loads a git diff into the changes view", async () => {
    rpc.mockResolvedValueOnce({ workspace: "ws", path: "", entries: [] });
    const s = useFilesStore();
    await s.selectWorkspace("i1", "ws");
    rpc.mockResolvedValueOnce({ workspace: "ws", files: [{ path: "f.txt", status: " M" }], diff: "@@ -1 +1,2 @@\n one\n+two", truncated: false });
    await s.loadDiff();
    expect(rpc).toHaveBeenLastCalledWith("i1", "control.fs.diff", { workspace: "ws" });
    expect(s.diff?.files[0].path).toBe("f.txt");
    expect(s.diff?.diff).toContain("+two");
  });

  it("surfaces an instance-side error payload as an error string", async () => {
    rpc.mockResolvedValueOnce({ error: { code: "internal", message: "path-escapes-workspace" } });
    const s = useFilesStore();
    await s.selectWorkspace("i1", "ws");
    expect(s.error).toBe("path-escapes-workspace");
  });
});
