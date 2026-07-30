import { setActivePinia, createPinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
vi.mock("../api/client", () => ({
  ApiError: class extends Error { constructor(public code: string, public status: number) { super(code); } },
  api: { rpc: (id: string, type: string, payload?: unknown) => rpc(id, type, payload) },
}));

import { useFilesStore } from "../stores/files";
import { useAuthStore } from "../stores/auth";
import { write as writeViewSnapshot } from "../lib/view-snapshot-cache";

beforeEach(() => {
  setActivePinia(createPinia());
  rpc.mockReset();
});

describe("files store", () => {
  it("discards a stale diff response after the active workspace changes", async () => {
    let resolveOld!: (value: unknown) => void;
    const oldResponse = new Promise((resolve) => { resolveOld = resolve; });
    rpc.mockImplementationOnce(() => oldResponse);

    const s = useFilesStore();
    s.instanceId = "i1";
    s.workspace = "old";
    const oldLoad = s.loadDiff();

    s.workspace = "new";
    rpc.mockResolvedValueOnce({ workspace: "new", files: [{ path: "new.txt", status: " M" }], diff: "+new", truncated: false });
    await s.loadDiff();
    resolveOld({ workspace: "old", files: [{ path: "old.txt", status: " M" }], diff: "+old", truncated: false });
    await oldLoad;

    expect(s.diff?.workspace).toBe("new");
    expect(s.diff?.files[0]?.path).toBe("new.txt");
    expect(s.loading).toBe(false);
  });

  it("clears diff loading when a workspace reset invalidates the request", async () => {
    let resolveOld!: (value: unknown) => void;
    rpc.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
    const s = useFilesStore();
    s.instanceId = "i1";
    s.workspace = "old";

    const oldLoad = s.loadDiff();
    expect(s.loading).toBe(true);
    s.reset();
    expect(s.loading).toBe(false);
    resolveOld({ workspace: "old", files: [], diff: "", truncated: false });
    await oldLoad;
    expect(s.loading).toBe(false);
    expect(s.diff).toBeNull();
  });

  it("discards a stale tree response from a superseded workspace selection", async () => {
    let resolveOld!: (value: unknown) => void;
    rpc.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
    const s = useFilesStore();
    const oldSelection = s.selectWorkspace("i1", "old");

    rpc.mockResolvedValueOnce({ workspace: "new", path: "", root: "/new", sep: "/", entries: [{ name: "new.ts", type: "file" }] });
    await s.selectWorkspace("i1", "new");
    resolveOld({ workspace: "old", path: "", root: "/old", sep: "/", entries: [{ name: "old.ts", type: "file" }] });
    await oldSelection;

    expect(s.workspace).toBe("new");
    expect(s.root).toBe("/new");
    expect(s.tree[""]?.map((entry) => entry.name)).toEqual(["new.ts"]);
  });

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

  it("selectWorkspace paints a cached tree before the root refresh settles", async () => {
    useAuthStore().account = { username: "tree-cache-user" };
    await writeViewSnapshot("tree-cache-user", "workspace-view", "i1", "ws", {
      root: "/cached/ws",
      sep: "/",
      tree: { "": [{ name: "cached.ts", type: "file", size: 1 }] },
      changed: { "cached.ts": " M" },
    });
    let resolveRoot!: (value: unknown) => void;
    rpc
      .mockReturnValueOnce(new Promise((resolve) => { resolveRoot = resolve; }))
      .mockResolvedValueOnce({ workspace: "ws", files: [], diff: "", truncated: false });
    const s = useFilesStore();
    const pending = s.selectWorkspace("i1", "ws");

    expect(s.root).toBe("/cached/ws");
    expect(s.entries.map((entry) => entry.name)).toEqual(["cached.ts"]);
    expect(s.changed).toEqual({ "cached.ts": " M" });

    resolveRoot({
      workspace: "ws",
      root: "/fresh/ws",
      sep: "/",
      path: "",
      entries: [{ name: "fresh.ts", type: "file", size: 1 }],
    });
    await pending;
    expect(s.root).toBe("/fresh/ws");
    expect(s.entries.map((entry) => entry.name)).toEqual(["fresh.ts"]);
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
    s.searchOpts.mode = "name"; // this case exercises name-mode search explicitly
    rpc.mockResolvedValueOnce({ workspace: "ws", query: "a.ts", matches: ["src/a.ts"], truncated: false });
    await s.search("a.ts");
    expect(rpc).toHaveBeenLastCalledWith("i1", "control.fs.search", { workspace: "ws", query: "a.ts", mode: "name", matchCase: false, wholeWord: false, regex: false, include: "", exclude: "" });
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

  it("loadStatus keeps cached git badges when the refresh request fails", async () => {
    const s = useFilesStore();
    s.instanceId = "i1";
    s.workspace = "ws";
    s.changed = { "cached.ts": " M" };
    rpc.mockRejectedValueOnce(new Error("network"));

    await s.loadStatus();

    expect(s.changed).toEqual({ "cached.ts": " M" });
  });

  it("loadStatus only clears cached badges for a confirmed non-git workspace", async () => {
    const s = useFilesStore();
    s.instanceId = "i1";
    s.workspace = "ws";
    s.changed = { "cached.ts": " M" };
    rpc.mockResolvedValueOnce({ error: { code: "timeout", message: "connector timed out" } });

    await s.loadStatus();

    expect(s.changed).toEqual({ "cached.ts": " M" });
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

  it("loadGitSummary paints a workspace cache before the refresh settles", async () => {
    useAuthStore().account = { username: "alice" };
    await writeViewSnapshot("alice", "git-summary", "i1", "ws", {
      summary: { workspace: "ws", changedCount: 3, branch: "cached" },
    });
    let resolveRpc!: (value: unknown) => void;
    rpc.mockReturnValueOnce(new Promise((resolve) => { resolveRpc = resolve; }));
    const s = useFilesStore();
    const pending = s.loadGitSummary("i1", "ws");
    expect(s.gitSummary).toEqual({ workspace: "ws", changedCount: 3, branch: "cached" });
    resolveRpc({ workspace: "ws", files: [], diff: "", truncated: false, branch: "fresh" });
    await pending;
    expect(s.gitSummary).toEqual({ workspace: "ws", changedCount: 0, branch: "fresh" });
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

  it("readFile returns content without touching the global file slot", async () => {
    const s = useFilesStore();
    rpc.mockResolvedValueOnce({ workspace: "ws", path: "a.ts", content: "x", size: 1, truncated: false, binary: false });
    const r = await s.readFile("i1", "ws", "a.ts");
    expect(r.content).toBe("x");
    expect(s.file).toBeNull(); // global slot untouched
  });

  it("readDiff returns a diff without touching global diff state", async () => {
    const s = useFilesStore();
    rpc.mockResolvedValueOnce({ workspace: "ws", files: [], diff: "@@", truncated: false });
    const r = await s.readDiff("i1", "ws", "a.ts");
    expect(r.diff).toBe("@@");
    expect(s.diff).toBeNull();
    expect(rpc).toHaveBeenLastCalledWith("i1", "control.fs.diff", { workspace: "ws", path: "a.ts" });
  });

  it("saveFile sends control.fs.write with the content and expected token", async () => {
    const s = useFilesStore();
    rpc.mockResolvedValueOnce({ path: "a.ts", mtimeMs: 222, size: 3 });
    const res = await s.saveFile("inst1", "ws", "a.ts", "new", { mtimeMs: 111, size: 2 });
    expect(rpc).toHaveBeenLastCalledWith("inst1", "control.fs.write", {
      workspace: "ws", path: "a.ts", content: "new", expected: { mtimeMs: 111, size: 2 },
    });
    expect(res).toEqual({ path: "a.ts", mtimeMs: 222, size: 3 });
  });
});

describe("files store: tree + advanced search", () => {
  it("listTree caches a directory layer and records root/sep", async () => {
    rpc.mockResolvedValueOnce({ workspace: "ws", path: "", entries: [{ name: "src", type: "dir" }], root: "/abs/ws", sep: "/" });
    const s = useFilesStore();
    s.instanceId = "i1"; s.workspace = "ws";
    await s.listTree("");
    expect(rpc).toHaveBeenLastCalledWith("i1", "control.fs.list", { workspace: "ws", path: "" });
    expect(s.tree[""].map((e) => e.name)).toEqual(["src"]);
    expect(s.root).toBe("/abs/ws");
    expect(s.absPath("src/a.ts")).toBe("/abs/ws/src/a.ts");
  });

  it("toggleExpand lazy-loads then toggles without refetching", async () => {
    const s = useFilesStore();
    s.instanceId = "i1"; s.workspace = "ws";
    rpc.mockResolvedValueOnce({ workspace: "ws", path: "src", entries: [{ name: "a.ts", type: "file", size: 3 }], root: "/abs/ws", sep: "/" });
    await s.toggleExpand("src");
    expect(s.expanded.has("src")).toBe(true);
    expect(s.tree["src"].length).toBe(1);
    rpc.mockClear();
    await s.toggleExpand("src"); // collapse — no fetch
    expect(s.expanded.has("src")).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("content search sends advanced options and fills hits", async () => {
    const s = useFilesStore();
    s.instanceId = "i1"; s.workspace = "ws";
    s.searchOpts.mode = "content"; s.searchOpts.regex = true; s.searchOpts.include = "**/*.ts"; // manual include glob
    rpc.mockResolvedValueOnce({ workspace: "ws", query: "foo", matches: [], hits: [{ path: "a.ts", line: 2, text: "foo" }], truncated: false });
    await s.search("foo");
    expect(rpc).toHaveBeenLastCalledWith("i1", "control.fs.search", { workspace: "ws", query: "foo", mode: "content", matchCase: false, wholeWord: false, regex: true, include: "**/*.ts", exclude: "" });
    expect(s.hits[0].line).toBe(2);
  });

  it("reset() clears the directory search scope (searchOpts.include) to avoid cross-workspace leak", () => {
    const s = useFilesStore();
    s.searchOpts.include = "src/**"; // folder scope set by "Search in this folder"
    s.reset();
    expect(s.searchOpts.include).toBe("");
  });
});
