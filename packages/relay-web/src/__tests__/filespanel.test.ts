import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn().mockResolvedValue({ workspaces: [], entries: [], path: "" });
vi.mock("../api/client", () => ({
  ApiError: class extends Error {},
  api: { rpc: (...a: unknown[]) => rpc(...a) },
}));

import FilesPanel from "../components/FilesPanel.vue";
import { useFilesStore } from "../stores/files";
import { useInstancesStore } from "../stores/instances";
import { useChatStore } from "../stores/chat";
import { useCenterTabsStore, sessionKey } from "../stores/center-tabs";

let pinia: ReturnType<typeof createPinia>;
beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  rpc.mockClear();
  localStorage.clear();
});

describe("FilesPanel navigation rail", () => {
  it("follows the active session's workspace and shows it as a static label (no picker)", async () => {
    const instances = useInstancesStore();
    instances.instances = [{
      id: "i1", name: "pc", online: true, lastSeenAt: null, sessionsLoaded: true,
      sessions: [{ alias: "s1", agent: "codex", workspace: "backend" }],
      agents: [], workspaces: [{ name: "backend", cwd: "/b" }], agentCatalog: [],
    }] as never;
    const chat = useChatStore();
    chat.instanceId = "i1";
    chat.sessionAlias = "s1";
    const w = mount(FilesPanel, { props: { instanceId: "i1" }, global: { plugins: [pinia] } });
    await flushPromises();
    // No manual workspace dropdown any more — it's a static label tied to the session.
    expect(w.find('[data-test="ws-select"]').exists()).toBe(false);
    const label = w.find('[data-test="ws-label"]');
    expect(label.exists()).toBe(true);
    expect(label.text()).toContain("backend");
  });

  it("opening a tree file clears the changed-file row highlight, not files.diffPath", async () => {
    const chat = useChatStore();
    chat.instanceId = "i1";
    chat.sessionAlias = "s1";
    const w = mount(FilesPanel, { props: { instanceId: "i1" }, global: { plugins: [pinia] } });
    const files = useFilesStore();
    // Select a changed-file row first (sets the local highlight, per this component).
    files.tab = "changes";
    files.diff = { workspace: "ws", files: [{ path: "src/a.ts", status: " M" }], diff: "+x\n-y\n", truncated: false } as never;
    await w.vm.$nextTick();
    await w.find('[data-test="diff-file"]').trigger("click");
    expect(w.find('[data-test="diff-file"]').classes().join(" ")).toContain("bg-accent/10");
    // `files.diffPath` (the loaded-diff scope) is untouched by row selection — it's still
    // whatever loadDiff() set it to (null here, since loadDiff was never actually called).
    const diffPathBefore = files.diffPath;

    files.tab = "files";
    files.tree[""] = [{ name: "a.ts", type: "file", size: 1 }] as never;
    await w.vm.$nextTick();
    await w.find('[data-test="tree-row"]').trigger("click");

    // files.diffPath (load-scope) is untouched by opening a tree file.
    expect(files.diffPath).toBe(diffPathBefore);
    // The local row highlight is cleared — back on the Changes tab, the row is no longer highlighted.
    files.tab = "changes";
    await w.vm.$nextTick();
    expect(w.find('[data-test="diff-file"]').classes().join(" ")).not.toContain("bg-accent/10");
  });

  it("renders the tree root (no breadcrumb / up button)", async () => {
    const w = mount(FilesPanel, { props: { instanceId: "i1" }, global: { plugins: [pinia] } });
    const files = useFilesStore();
    files.tree[""] = [{ name: "src", type: "dir" }] as never;
    await w.vm.$nextTick();
    expect(w.find('[data-test="fs-up"]').exists()).toBe(false);
    expect(w.find('[data-test="tree-row"]').exists()).toBe(true);
  });

  it("search toggles drive searchOpts", async () => {
    const w = mount(FilesPanel, { props: { instanceId: "i1" }, global: { plugins: [pinia] } });
    const files = useFilesStore();
    await w.vm.$nextTick();
    await w.find('[data-test="search-regex"]').trigger("click");
    expect(files.searchOpts.regex).toBe(true);
    await w.find('[data-test="search-mode-content"]').trigger("click");
    expect(files.searchOpts.mode).toBe("content");
  });

  it("search placeholder tracks the active mode (name vs content)", async () => {
    const w = mount(FilesPanel, { props: { instanceId: "i1" }, global: { plugins: [pinia] } });
    const files = useFilesStore();
    files.searchOpts.mode = "name"; // start from name mode; default is now content
    await w.vm.$nextTick();
    const namePh = w.find('[data-test="fs-search"]').attributes("placeholder");
    await w.find('[data-test="search-mode-content"]').trigger("click");
    await w.vm.$nextTick();
    const contentPh = w.find('[data-test="fs-search"]').attributes("placeholder");
    expect(contentPh).not.toBe(namePh);
    expect(contentPh?.length).toBeGreaterThan(0);
  });

  it("dotfile/gitignore toggles persist and filter", async () => {
    const w = mount(FilesPanel, { props: { instanceId: "i1" }, global: { plugins: [pinia] } });
    const files = useFilesStore();
    files.tree[""] = [{ name: "src", type: "dir" }, { name: ".env", type: "file" }] as never;
    await w.vm.$nextTick();
    // .env is a dotfile, hidden by default.
    expect(w.findAll('[data-test="tree-row"]').length).toBe(1);
    await w.find('[data-test="toggle-dotfiles"]').setValue(true);
    expect(localStorage.getItem("xacpx.files.showDotfiles")).toBe("1");
    await w.vm.$nextTick();
    expect(w.findAll('[data-test="tree-row"]').length).toBe(2);
  });

  it("has a refresh button that re-fetches the current view via the store", async () => {
    const w = mount(FilesPanel, { props: { instanceId: "i1" }, global: { plugins: [pinia] } });
    const files = useFilesStore();
    const spy = vi.spyOn(files, "refresh").mockResolvedValue();
    await w.vm.$nextTick();
    const btn = w.find('[data-test="refresh-files"]');
    expect(btn.exists()).toBe(true);
    expect(btn.attributes("aria-label")).toBeTruthy();
    expect(btn.attributes("title")).toBeTruthy();
    await btn.trigger("click");
    expect(spy).toHaveBeenCalled();
  });

  it("shows the branch, worktree path, and a linked badge in the Changes tab git context", async () => {
    const w = mount(FilesPanel, { props: { instanceId: "i1" }, global: { plugins: [pinia] } });
    const files = useFilesStore();
    files.tab = "changes";
    files.diff = {
      workspace: "ws", files: [{ path: "a.ts", status: " M" }], diff: "+x\n-y\n", truncated: false,
      branch: "feature", worktree: { root: "/Users/dev/.worktrees/feature", linked: true },
    } as never;
    await w.vm.$nextTick();
    expect(w.find('[data-test="changes-branch"]').text()).toBe("feature");
    expect(w.find('[data-test="worktree-linked"]').exists()).toBe(true);
    expect(w.find('[data-test="worktree-path"]').text()).toContain("/Users/dev/.worktrees/feature");
  });

  it("falls back to a detached label and hides the linked badge on the primary worktree", async () => {
    const w = mount(FilesPanel, { props: { instanceId: "i1" }, global: { plugins: [pinia] } });
    const files = useFilesStore();
    files.tab = "changes";
    files.diff = {
      workspace: "ws", files: [], diff: "", truncated: false,
      detached: true, worktree: { root: "/repo", linked: false },
    } as never;
    await w.vm.$nextTick();
    expect(w.find('[data-test="changes-branch"]').text()).toBeTruthy(); // a detached label, not a branch
    expect(w.find('[data-test="worktree-linked"]').exists()).toBe(false);
    expect(w.find('[data-test="worktree-path"]').exists()).toBe(true);
  });

  it("shows a calm empty state (not a dismiss-less error banner) for a non-git workspace's Changes tab", async () => {
    const w = mount(FilesPanel, { props: { instanceId: "i1" }, global: { plugins: [pinia] } });
    const files = useFilesStore();
    files.tab = "changes";
    files.notGit = true; // backend reported "not-a-git-repo"
    await w.vm.$nextTick();
    expect(w.find('[data-test="changes-not-git"]').exists()).toBe(true);
    // The sticky, undismissable error banner must NOT be used for this expected state.
    expect(w.find('[data-test="files-error"]').exists()).toBe(false);
  });

  it("groups changed files into Staged / Changes / Untracked with full-path tooltips", async () => {
    const w = mount(FilesPanel, { props: { instanceId: "i1" }, global: { plugins: [pinia] } });
    const files = useFilesStore();
    files.tab = "changes";
    files.diff = {
      workspace: "ws",
      files: [
        { path: "src/staged.ts", status: "M " },
        { path: "src/work.ts", status: " M" },
        { path: "notes/草稿.md", status: "??" },
      ],
      diff: "",
      truncated: false,
    } as never;
    await w.vm.$nextTick();
    const groups = w.findAll('[data-test="change-group"]');
    expect(groups.length).toBe(3); // staged, changes, untracked all non-empty
    const rows = w.findAll('[data-test="diff-file"]');
    // the untracked CJK path renders raw and carries a full-path tooltip
    const cjk = rows.find((r) => r.attributes("title") === "notes/草稿.md");
    expect(cjk).toBeTruthy();
    expect(cjk!.text()).toContain("草稿.md");
  });

  it("auto-loads the diff when switching sessions while the Changes tab is active", async () => {
    const instances = useInstancesStore();
    instances.instances = [{
      id: "i1", name: "pc", online: true, lastSeenAt: null, sessionsLoaded: true,
      sessions: [
        { alias: "s1", agent: "codex", workspace: "backend" },
        { alias: "s2", agent: "codex", workspace: "frontend" },
      ],
      agents: [], workspaces: [{ name: "backend", cwd: "/b" }, { name: "frontend", cwd: "/f" }], agentCatalog: [],
    }] as never;
    const chat = useChatStore();
    chat.instanceId = "i1";
    chat.sessionAlias = "s1";
    const w = mount(FilesPanel, { props: { instanceId: "i1" }, global: { plugins: [pinia] } });
    await flushPromises();

    const files = useFilesStore();
    files.tab = "changes";
    files.diff = { workspace: "backend", files: [], diff: "", truncated: false } as never;
    await flushPromises();

    // Spy installed after any initial load, so a call here can only come from the
    // session-switch path (the tab watcher keys on `files.tab`, which doesn't change).
    const loadDiff = vi.spyOn(files, "loadDiff").mockResolvedValue();
    // Switch to a session in a different workspace while the Changes tab stays active.
    chat.sessionAlias = "s2";
    await flushPromises();

    // Loaded exactly once via this path — guards against an accidental double-load.
    expect(loadDiff).toHaveBeenCalledTimes(1);
  });

  it("does not auto-load the diff on a session switch when the Files tab is active", async () => {
    const instances = useInstancesStore();
    instances.instances = [{
      id: "i1", name: "pc", online: true, lastSeenAt: null, sessionsLoaded: true,
      sessions: [
        { alias: "s1", agent: "codex", workspace: "backend" },
        { alias: "s2", agent: "codex", workspace: "frontend" },
      ],
      agents: [], workspaces: [{ name: "backend", cwd: "/b" }, { name: "frontend", cwd: "/f" }], agentCatalog: [],
    }] as never;
    const chat = useChatStore();
    chat.instanceId = "i1";
    chat.sessionAlias = "s1";
    const w = mount(FilesPanel, { props: { instanceId: "i1" }, global: { plugins: [pinia] } });
    await flushPromises();

    const files = useFilesStore();
    files.tab = "files";
    const loadDiff = vi.spyOn(files, "loadDiff").mockResolvedValue();
    chat.sessionAlias = "s2";
    await flushPromises();

    expect(loadDiff).not.toHaveBeenCalled();
  });
});

describe("FilesPanel center-tab routing", () => {
  it("opening a tree file with a selected session opens a center file tab", async () => {
    const chat = useChatStore();
    chat.instanceId = "i1";
    chat.sessionAlias = "s1";
    const w = mount(FilesPanel, { props: { instanceId: "i1" }, global: { plugins: [pinia] } });
    const files = useFilesStore();
    const centerTabs = useCenterTabsStore();
    const openFile = vi.spyOn(centerTabs, "openFile");
    files.tree[""] = [{ name: "a.ts", type: "file", size: 1 }] as never;
    await w.vm.$nextTick();
    await w.find('[data-test="tree-row"]').trigger("click");
    expect(openFile).toHaveBeenCalledWith(sessionKey("i1", "s1"), "a.ts");
    // The tree still renders (listing behavior unchanged).
    expect(w.find('[data-test="tree-row"]').exists()).toBe(true);
  });

  it("opening a tree file with no selected session is a no-op for the center-tabs store", async () => {
    const w = mount(FilesPanel, { props: { instanceId: "i1" }, global: { plugins: [pinia] } });
    const files = useFilesStore();
    const centerTabs = useCenterTabsStore();
    const openFile = vi.spyOn(centerTabs, "openFile");
    files.tree[""] = [{ name: "a.ts", type: "file", size: 1 }] as never;
    await w.vm.$nextTick();
    await w.find('[data-test="tree-row"]').trigger("click");
    expect(openFile).not.toHaveBeenCalled();
  });

  it("clicking a name-mode search result opens a center file tab", async () => {
    const chat = useChatStore();
    chat.instanceId = "i1";
    chat.sessionAlias = "s1";
    const w = mount(FilesPanel, { props: { instanceId: "i1" }, global: { plugins: [pinia] } });
    const files = useFilesStore();
    const centerTabs = useCenterTabsStore();
    vi.spyOn(files, "search").mockResolvedValue();
    const openFile = vi.spyOn(centerTabs, "openFile");
    files.searchOpts.mode = "name"; // this case exercises the name-mode flat result list
    files.query = "foo";
    files.results = ["src/foo.ts"] as never;
    await w.vm.$nextTick();
    await w.find('[data-test="fs-result"]').trigger("click");
    // name-mode results carry no line → openFile's line arg is undefined
    expect(openFile).toHaveBeenCalledWith(sessionKey("i1", "s1"), "src/foo.ts", undefined);
    expect(w.find('[data-test="fs-result"]').exists()).toBe(true);
  });

  it("clicking a content-mode search hit opens a center file tab", async () => {
    const chat = useChatStore();
    chat.instanceId = "i1";
    chat.sessionAlias = "s1";
    const w = mount(FilesPanel, { props: { instanceId: "i1" }, global: { plugins: [pinia] } });
    const files = useFilesStore();
    const centerTabs = useCenterTabsStore();
    vi.spyOn(files, "search").mockResolvedValue();
    const openFile = vi.spyOn(centerTabs, "openFile");
    files.searchOpts.mode = "content";
    files.query = "foo";
    files.hits = [{ path: "src/a.ts", line: 3, text: "const foo = 1" }] as never;
    await w.vm.$nextTick();
    await w.find('[data-test="fs-hit"]').trigger("click");
    // content hits pass their line so the viewer scrolls there
    expect(openFile).toHaveBeenCalledWith(sessionKey("i1", "s1"), "src/a.ts", 3);
  });

  it("clicking a changed file opens a center diff tab, keeps the listing, and highlights the row", async () => {
    const chat = useChatStore();
    chat.instanceId = "i1";
    chat.sessionAlias = "s1";
    const w = mount(FilesPanel, { props: { instanceId: "i1" }, global: { plugins: [pinia] } });
    const files = useFilesStore();
    const centerTabs = useCenterTabsStore();
    files.tab = "changes";
    files.diff = {
      workspace: "ws",
      files: [{ path: "src/a.ts", status: " M" }],
      diff: "+x\n-y\n",
      truncated: false,
    } as never;
    await w.vm.$nextTick();
    const loadDiff = vi.spyOn(files, "loadDiff").mockResolvedValue();
    const openDiff = vi.spyOn(centerTabs, "openDiff");
    await w.find('[data-test="diff-file"]').trigger("click");
    expect(openDiff).toHaveBeenCalledWith(sessionKey("i1", "s1"), "src/a.ts");
    // The panel-data listing itself must not be reloaded by the click-to-view action.
    expect(loadDiff).not.toHaveBeenCalled();
    // The changed-files list is still there (panel data untouched).
    expect(w.findAll('[data-test="diff-file"]').length).toBe(1);
    expect(w.find('[data-test="diff-file"]').classes().join(" ")).toContain("bg-accent/10");
  });

  it("refreshing the Changes tab after selecting a changed-file row reloads the whole-tree diff, not the selected file", async () => {
    // Regression for: openDiff() used to write files.diffPath purely to drive the row
    // highlight, but files.diffPath doubles as the SCOPE of the loaded files.diff — so a
    // later refresh() would rescope the whole-tree diff down to just the clicked file.
    const chat = useChatStore();
    chat.instanceId = "i1";
    chat.sessionAlias = "s1";
    const w = mount(FilesPanel, { props: { instanceId: "i1" }, global: { plugins: [pinia] } });
    const files = useFilesStore();
    files.instanceId = "i1";
    files.workspace = "ws";
    files.tab = "changes";
    const wholeTreeDiff = {
      workspace: "ws",
      files: [
        { path: "a.ts", status: " M" },
        { path: "b.ts", status: " M" },
        { path: "c.ts", status: " M" },
      ],
      diff: "+x\n-y\n+z\n",
      truncated: false,
    };
    files.diff = wholeTreeDiff;
    await w.vm.$nextTick();

    // Note: vi.spyOn(files, "loadDiff") would NOT observe refresh()'s internal call —
    // Pinia setup-store actions call sibling actions via the closure reference, not the
    // store's public property, so the spy is only triggered by external callers (verified
    // empirically: a spy here sees 0 calls even though the real RPC call fires correctly).
    // Assert on the actual RPC call args instead, which is what the bug really breaks.
    rpc.mockClear();
    rpc.mockResolvedValue(wholeTreeDiff);

    // Click a changed-file row: opens a center diff tab + highlights it, but must not
    // touch files.diffPath (the loaded-diff scope) or trigger a reload by itself.
    await w.find('[data-test="diff-file"]').trigger("click");
    expect(files.diffPath).toBeNull();
    expect(w.find('[data-test="diff-file"]').classes().join(" ")).toContain("bg-accent/10");

    // Refresh: the reviewer's bug scenario — must reload the WHOLE tree, not rescope to
    // whichever changed-file row was last clicked.
    await w.find('[data-test="refresh-files"]').trigger("click");
    await flushPromises();

    const diffCalls = rpc.mock.calls.filter((c) => c[1] === "control.fs.diff");
    expect(diffCalls.length).toBe(1);
    // No `path` param on the diff RPC call — whole-tree, not scoped to the clicked file.
    expect(diffCalls[0][2]).toEqual({ workspace: "ws" });
    // The Changes list stays whole-tree (3 files), not narrowed down to the clicked one.
    expect(files.diff?.files.length).toBe(3);

    // The row highlight still reflects the previously clicked file (local view state
    // survives the refresh, since it's independent of the reloaded files.diff).
    expect(w.find('[data-test="diff-file"]').classes().join(" ")).toContain("bg-accent/10");
  });

  it("clicking a changed file with no selected session is a no-op for the center-tabs store", async () => {
    const w = mount(FilesPanel, { props: { instanceId: "i1" }, global: { plugins: [pinia] } });
    const files = useFilesStore();
    const centerTabs = useCenterTabsStore();
    const openDiff = vi.spyOn(centerTabs, "openDiff");
    files.tab = "changes";
    files.diff = {
      workspace: "ws",
      files: [{ path: "src/a.ts", status: " M" }],
      diff: "+x\n-y\n",
      truncated: false,
    } as never;
    await w.vm.$nextTick();
    await w.find('[data-test="diff-file"]').trigger("click");
    expect(openDiff).not.toHaveBeenCalled();
  });
});

describe("FilesPanel content search results", () => {
  function mountWithHits(hits: { path: string; line: number; text: string }[], query = "foo") {
    const w = mount(FilesPanel, { props: { instanceId: "i1" }, global: { plugins: [pinia] } });
    const files = useFilesStore();
    // Changing searchOpts triggers the re-search watcher; stub it so it can't overwrite our fixture.
    vi.spyOn(files, "search").mockResolvedValue();
    files.searchOpts.mode = "content";
    files.query = query;
    files.hits = hits as never;
    return { w, files };
  }

  it("renders each hit on two lines (path:line, then the matched text) with the query highlighted", async () => {
    const { w } = mountWithHits([{ path: "src/a.ts", line: 12, text: "const foo = bar(foo)" }]);
    await flushPromises();
    const hit = w.find('[data-test="fs-hit"]');
    expect(hit.exists()).toBe(true);
    expect(hit.text()).toContain("src/a.ts");
    expect(hit.text()).toContain(":12");
    // Two occurrences of "foo" get wrapped in highlight marks.
    const marks = hit.findAll('[data-test="hit-mark"]');
    expect(marks.length).toBe(2);
    expect(marks.every((m) => m.text() === "foo")).toBe(true);
  });

  it("shows only the first page (10) and reveals more via the Show-more button", async () => {
    const hits = Array.from({ length: 15 }, (_, i) => ({ path: `f${i}.ts`, line: i + 1, text: `foo ${i}` }));
    const { w } = mountWithHits(hits);
    await flushPromises();
    expect(w.findAll('[data-test="fs-hit"]').length).toBe(10);
    const more = w.find('[data-test="fs-more"]');
    expect(more.exists()).toBe(true);
    await more.trigger("click");
    expect(w.findAll('[data-test="fs-hit"]').length).toBe(15);
    expect(w.find('[data-test="fs-more"]').exists()).toBe(false);
  });

  it("collapses back to the first page when a new result set arrives", async () => {
    const hits = Array.from({ length: 15 }, (_, i) => ({ path: `f${i}.ts`, line: i + 1, text: `foo ${i}` }));
    const { w, files } = mountWithHits(hits);
    await flushPromises();
    await w.find('[data-test="fs-more"]').trigger("click");
    expect(w.findAll('[data-test="fs-hit"]').length).toBe(15);
    // A fresh search (any option toggle re-runs search → new hits array) resets the window.
    files.hits = Array.from({ length: 12 }, (_, i) => ({ path: `g${i}.ts`, line: i + 1, text: `foo ${i}` })) as never;
    await flushPromises();
    expect(w.findAll('[data-test="fs-hit"]').length).toBe(10);
  });

  it("does not throw on an invalid highlight regex (renders the line unhighlighted)", async () => {
    const { w } = mountWithHits([{ path: "a.ts", line: 1, text: "a(b" }], "(");
    const files = useFilesStore();
    files.searchOpts.regex = true;
    await flushPromises();
    const hit = w.find('[data-test="fs-hit"]');
    expect(hit.text()).toContain("a(b");
    expect(hit.findAll('[data-test="hit-mark"]').length).toBe(0);
  });
});
