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

  it("searches files by name and opens a result", async () => {
    rpc.mockResolvedValueOnce({ workspace: "ws", path: "", entries: [] });
    const s = useFilesStore();
    await s.selectWorkspace("i1", "ws");
    rpc.mockResolvedValueOnce({ workspace: "ws", query: "a.ts", matches: ["src/a.ts"], truncated: false });
    await s.search("a.ts");
    expect(rpc).toHaveBeenLastCalledWith("i1", "control.fs.search", { workspace: "ws", query: "a.ts" });
    expect(s.results).toEqual(["src/a.ts"]);
    rpc.mockResolvedValueOnce({ workspace: "ws", path: "src/a.ts", content: "x", size: 1, truncated: false, binary: false });
    await s.openFile("src/a.ts");
    expect(rpc).toHaveBeenLastCalledWith("i1", "control.fs.read", { workspace: "ws", path: "src/a.ts" });
    expect(s.file?.path).toBe("src/a.ts");
  });

  it("loads a per-file diff and tracks the selected path", async () => {
    rpc.mockResolvedValueOnce({ workspace: "ws", path: "", entries: [] });
    const s = useFilesStore();
    await s.selectWorkspace("i1", "ws");
    rpc.mockResolvedValueOnce({ workspace: "ws", files: [{ path: "f.txt", status: " M" }], diff: "@@\n+x", truncated: false });
    await s.loadDiff("f.txt");
    expect(rpc).toHaveBeenLastCalledWith("i1", "control.fs.diff", { workspace: "ws", path: "f.txt" });
    expect(s.diffPath).toBe("f.txt");
    rpc.mockResolvedValueOnce({ workspace: "ws", files: [], diff: "", truncated: false });
    await s.loadDiff();
    expect(rpc).toHaveBeenLastCalledWith("i1", "control.fs.diff", { workspace: "ws" });
    expect(s.diffPath).toBe(null);
  });

  it("flags a non-git workspace on loadDiff without raising the sticky error banner", async () => {
    rpc.mockResolvedValueOnce({ workspace: "ws", path: "", entries: [] });
    const s = useFilesStore();
    await s.selectWorkspace("i1", "ws");
    rpc.mockResolvedValueOnce({ error: { code: "internal", message: "not-a-git-repo" } });
    await s.loadDiff();
    expect(s.notGit).toBe(true);
    expect(s.diff).toBeNull();
    expect(s.error).toBe(""); // expected state → no dismiss-less error banner
  });

  it("clears the non-git flag once a real diff loads", async () => {
    rpc.mockResolvedValueOnce({ workspace: "ws", path: "", entries: [] });
    const s = useFilesStore();
    await s.selectWorkspace("i1", "ws");
    s.notGit = true;
    rpc.mockResolvedValueOnce({ workspace: "ws", files: [{ path: "f.txt", status: " M" }], diff: "@@\n+x", truncated: false });
    await s.loadDiff();
    expect(s.notGit).toBe(false);
  });

  it("an empty search query clears results without an rpc", async () => {
    rpc.mockResolvedValueOnce({ workspace: "ws", path: "", entries: [] });
    const s = useFilesStore();
    await s.selectWorkspace("i1", "ws");
    rpc.mockReset();
    await s.search("   ");
    expect(rpc).not.toHaveBeenCalled();
    expect(s.results).toEqual([]);
  });

  it("loadStatus populates the changed map from a whole-tree diff", async () => {
    const s = useFilesStore();
    s.instanceId = "i1";
    s.workspace = "ws";
    rpc.mockResolvedValueOnce({ workspace: "ws", files: [{ path: "src/a.ts", status: " M" }, { path: "new.ts", status: "??" }], diff: "", truncated: false });
    await s.loadStatus();
    expect(rpc).toHaveBeenLastCalledWith("i1", "control.fs.diff", { workspace: "ws" });
    expect(s.changed).toEqual({ "src/a.ts": " M", "new.ts": "??" });
  });

  it("loadStatus clears the changed map quietly for a non-git workspace (no error)", async () => {
    const s = useFilesStore();
    s.instanceId = "i1";
    s.workspace = "ws";
    s.changed = { stale: "M" };
    rpc.mockResolvedValueOnce({ error: { code: "internal", message: "not-a-git-repo" } });
    await s.loadStatus();
    expect(s.changed).toEqual({});
    expect(s.error).toBe(""); // browsing stays clean — no error surfaced
  });

  it("loadGitSummary stores a changed-file count for a workspace", async () => {
    const s = useFilesStore();
    rpc.mockResolvedValueOnce({ workspace: "ws", files: [{ path: "a.ts", status: " M" }, { path: "b.ts", status: "??" }], diff: "", truncated: false });
    await s.loadGitSummary("i1", "ws");
    expect(rpc).toHaveBeenLastCalledWith("i1", "control.fs.diff", { workspace: "ws" });
    expect(s.gitSummary).toEqual({ workspace: "ws", changedCount: 2 });
  });

  it("loadGitSummary picks up a branch when the backend provides one", async () => {
    const s = useFilesStore();
    rpc.mockResolvedValueOnce({ workspace: "ws", branch: "main", files: [], diff: "", truncated: false });
    await s.loadGitSummary("i1", "ws");
    expect(s.gitSummary).toEqual({ workspace: "ws", changedCount: 0, branch: "main" });
  });

  it("loadGitSummary clears the summary for a non-git workspace (error payload)", async () => {
    const s = useFilesStore();
    rpc.mockResolvedValueOnce({ error: { code: "internal", message: "not-a-git-repo" } });
    await s.loadGitSummary("i1", "ws");
    expect(s.gitSummary).toBeNull();
  });

  it("refresh() re-lists the current dir and refreshes git badges on the Files tab", async () => {
    rpc.mockResolvedValueOnce({ workspace: "ws", path: "", entries: [] });
    const s = useFilesStore();
    await s.selectWorkspace("i1", "ws");
    // Navigate into a child dir so refresh has a non-root current path to re-fetch.
    rpc.mockResolvedValueOnce({ workspace: "ws", path: "src", entries: [] });
    await s.open({ name: "src", type: "dir" });
    expect(s.path).toBe("src");
    expect(s.tab).toBe("files");
    rpc.mockReset();
    rpc.mockResolvedValue({ workspace: "ws", path: "src", entries: [{ name: "a.ts", type: "file", size: 1 }], files: [], diff: "", truncated: false });
    await s.refresh();
    // Re-lists the CURRENT path (not a navigation reset).
    expect(rpc).toHaveBeenCalledWith("i1", "control.fs.list", { workspace: "ws", path: "src" });
    expect(s.entries.map((e) => e.name)).toEqual(["a.ts"]);
  });

  it("refresh() reloads the diff on the Changes tab", async () => {
    rpc.mockResolvedValueOnce({ workspace: "ws", path: "", entries: [] });
    const s = useFilesStore();
    await s.selectWorkspace("i1", "ws");
    s.tab = "changes";
    s.diffPath = "f.txt";
    rpc.mockReset();
    rpc.mockResolvedValue({ workspace: "ws", files: [{ path: "f.txt", status: " M" }], diff: "@@\n+x", truncated: false });
    await s.refresh();
    expect(rpc).toHaveBeenCalledWith("i1", "control.fs.diff", { workspace: "ws", path: "f.txt" });
    // No list re-fetch on the Changes tab.
    expect(rpc.mock.calls.some((c) => c[1] === "control.fs.list")).toBe(false);
  });

  it("refresh() is a no-op without an instance/workspace", async () => {
    const s = useFilesStore();
    await s.refresh();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("surfaces an instance-side error payload as an error string", async () => {
    rpc.mockResolvedValueOnce({ error: { code: "internal", message: "path-escapes-workspace" } });
    const s = useFilesStore();
    await s.selectWorkspace("i1", "ws");
    expect(s.error).toBe("path-escapes-workspace");
  });
});
