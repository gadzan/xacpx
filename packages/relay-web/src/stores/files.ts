import { defineStore } from "pinia";
import { ref } from "vue";
import {
  isErrorPayload,
  type FsDiffResult,
  type FsEntryDto,
  type FsListResult,
  type FsReadResult,
  type FsSearchResult,
  type FsSearchHitDto,
} from "@ganglion/xacpx-relay-protocol";
import { api } from "../api/client";

function unwrap<T>(result: T | { error: { code: string; message: string } }): T {
  if (isErrorPayload(result)) throw new Error(result.error.message || result.error.code);
  return result;
}

export const useFilesStore = defineStore("files", () => {
  const instanceId = ref<string | null>(null);
  const workspace = ref<string | null>(null);
  const path = ref(""); // current directory, relative to the workspace root
  const entries = ref<FsEntryDto[]>([]);
  const file = ref<FsReadResult | null>(null);
  const diff = ref<FsDiffResult | null>(null);
  const diffPath = ref<string | null>(null); // null = whole-tree diff
  const notGit = ref(false); // workspace isn't a git repo — a normal Changes-tab empty state, not an error
  const tab = ref<"files" | "changes">("files");
  const changed = ref<Record<string, string>>({}); // relPath -> git porcelain status, for Files-tab badges
  // Standalone read-only summary for the header chip — independent of the browsed
  // workspace above, so showing it never disturbs file-browser navigation state.
  const gitSummary = ref<{ workspace: string; changedCount: number; branch?: string; detached?: boolean } | null>(null);
  const query = ref("");
  const results = ref<string[]>([]);
  const searchTruncated = ref(false);
  const searching = ref(false);
  const loading = ref(false);
  const error = ref("");
  // Lazy tree state for the file-tree browser — parallel to the flat path/entries
  // above, which the Changes tab and openFile() still rely on.
  const root = ref("");
  const sepChar = ref<"/" | "\\">("/");
  const tree = ref<Record<string, FsEntryDto[]>>({});
  const expanded = ref<Set<string>>(new Set());
  const loadingDirs = ref<Set<string>>(new Set());
  const hits = ref<FsSearchHitDto[]>([]);
  const searchOpts = ref<{ mode: "name" | "content"; matchCase: boolean; wholeWord: boolean; regex: boolean; include: string; exclude: string; path: string }>({
    mode: "name", matchCase: false, wholeWord: false, regex: false, include: "", exclude: "", path: "",
  });

  function reset(): void {
    workspace.value = null;
    path.value = "";
    entries.value = [];
    file.value = null;
    diff.value = null;
    diffPath.value = null;
    notGit.value = false;
    changed.value = {};
    query.value = "";
    results.value = [];
    error.value = "";
    tree.value = {};
    expanded.value = new Set();
    hits.value = [];
    root.value = "";
    // The folder scope is workspace-bound (a relPath in the outgoing workspace) — the
    // other searchOpts (mode/matchCase/wholeWord/regex/include/exclude) are user
    // preferences and survive a workspace switch on purpose.
    searchOpts.value.path = "";
  }

  async function selectWorkspace(id: string, ws: string): Promise<void> {
    instanceId.value = id;
    workspace.value = ws;
    file.value = null;
    diff.value = null;
    diffPath.value = null;
    notGit.value = false;
    changed.value = {};
    query.value = "";
    results.value = [];
    tree.value = {}; hits.value = [];
    try { expanded.value = new Set(JSON.parse(localStorage.getItem(expandedKey()) ?? "[]") as string[]); } catch { expanded.value = new Set(); }
    await listTree("");
    // Mirror the root layer into the flat path/entries state — the Changes tab and
    // any surviving flat-view consumers read those, not `tree`, after selectWorkspace.
    path.value = "";
    entries.value = tree.value[""] ?? [];
    // Re-hydrate previously expanded layers (best-effort).
    for (const dir of [...expanded.value]) { if (dir && !tree.value[dir]) await listTree(dir).catch(() => {}); }
    void loadStatus();
  }

  /** Quietly fetch git status for badge annotation. Failures (e.g. a non-git
   *  workspace) clear the badges without surfacing an error, so plain browsing
   *  stays clean — the Changes tab's loadDiff() is what surfaces git errors. */
  async function loadStatus(): Promise<void> {
    if (!instanceId.value || !workspace.value) return;
    try {
      const r = await api.rpc<FsDiffResult>(instanceId.value, "control.fs.diff", { workspace: workspace.value });
      if (isErrorPayload(r)) {
        changed.value = {};
        return;
      }
      const map: Record<string, string> = {};
      for (const f of r.files) map[f.path] = f.status;
      changed.value = map;
    } catch {
      changed.value = {};
    }
  }

  /** Read-only git summary for a session's workspace (header chip). Quiet: a
   *  non-git workspace just clears the summary. `branch`/`detached` come from the
   *  diff result's git context (worktree detail is read off the full diff in the
   *  Changes tab, not mirrored here). */
  async function loadGitSummary(id: string, ws: string): Promise<void> {
    if (!id || !ws) {
      gitSummary.value = null;
      return;
    }
    try {
      const r = await api.rpc<FsDiffResult>(id, "control.fs.diff", { workspace: ws });
      if (isErrorPayload(r)) {
        gitSummary.value = null;
        return;
      }
      const branch = typeof r.branch === "string" ? r.branch : undefined;
      const detached = r.detached === true;
      gitSummary.value = {
        workspace: ws,
        changedCount: r.files.length,
        ...(branch ? { branch } : {}),
        ...(detached ? { detached: true } : {}),
      };
    } catch {
      gitSummary.value = null;
    }
  }

  async function list(dir: string): Promise<void> {
    if (!instanceId.value || !workspace.value) return;
    loading.value = true;
    error.value = "";
    file.value = null;
    try {
      const r = unwrap(await api.rpc<FsListResult>(instanceId.value, "control.fs.list", { workspace: workspace.value, path: dir }));
      path.value = r.path;
      entries.value = r.entries;
    } catch (e) {
      error.value = e instanceof Error ? e.message : "list-failed";
    } finally {
      loading.value = false;
    }
  }

  function expandedKey(): string { return `xacpx.fileTree.expanded.${workspace.value ?? ""}`; }

  /** Fetch one directory layer into the tree cache, recording root/sep along the way. */
  async function listTree(dir: string): Promise<void> {
    if (!instanceId.value || !workspace.value) return;
    loadingDirs.value = new Set(loadingDirs.value).add(dir);
    try {
      const r = unwrap(await api.rpc<FsListResult>(instanceId.value, "control.fs.list", { workspace: workspace.value, path: dir }));
      root.value = r.root; sepChar.value = r.sep;
      tree.value = { ...tree.value, [dir]: r.entries };
    } catch (e) {
      error.value = e instanceof Error ? e.message : "list-failed";
    } finally {
      const next = new Set(loadingDirs.value); next.delete(dir); loadingDirs.value = next;
    }
  }

  /** Expand/collapse a tree node, lazily fetching its children on first expand. */
  async function toggleExpand(dir: string): Promise<void> {
    const next = new Set(expanded.value);
    if (next.has(dir)) {
      next.delete(dir);
    } else {
      next.add(dir);
      if (!tree.value[dir]) await listTree(dir);
    }
    expanded.value = next;
    try { localStorage.setItem(expandedKey(), JSON.stringify([...next])); } catch { /* ignore */ }
  }

  /** Resolve a workspace-relative path to an absolute path using the workspace root/sep. */
  function absPath(rel: string): string {
    const s = sepChar.value;
    return root.value + s + rel.split("/").join(s);
  }

  /** Descend into a child dir or open a file, relative to the current path. */
  async function open(entry: FsEntryDto): Promise<void> {
    const child = path.value ? `${path.value}/${entry.name}` : entry.name;
    if (entry.type === "dir") return list(child);
    if (!instanceId.value || !workspace.value) return;
    loading.value = true;
    error.value = "";
    try {
      file.value = unwrap(await api.rpc<FsReadResult>(instanceId.value, "control.fs.read", { workspace: workspace.value, path: child }));
    } catch (e) {
      error.value = e instanceof Error ? e.message : "read-failed";
    } finally {
      loading.value = false;
    }
  }

  /** Open a file by its full path relative to the workspace root (search results). */
  async function openFile(relPath: string): Promise<void> {
    if (!instanceId.value || !workspace.value) return;
    loading.value = true;
    error.value = "";
    try {
      file.value = unwrap(await api.rpc<FsReadResult>(instanceId.value, "control.fs.read", { workspace: workspace.value, path: relPath }));
    } catch (e) {
      error.value = e instanceof Error ? e.message : "read-failed";
    } finally {
      loading.value = false;
    }
  }

  /** Re-fetch the current view without resetting navigation — used by the manual refresh
   *  button after the agent writes files. Tab-aware: Files re-lists the current dir and
   *  refreshes git badges; Changes reloads the diff. */
  async function refresh(): Promise<void> {
    if (!instanceId.value || !workspace.value) return;
    if (tab.value === "changes") {
      await loadDiff(diffPath.value ?? undefined);
      return;
    }
    await list(path.value);
    // Also drop the stale tree cache and re-pull the root plus any expanded layers,
    // so the tree browser reflects the same post-write state as the flat view above.
    tree.value = {};
    await listTree("");
    for (const dir of [...expanded.value]) { if (dir) await listTree(dir).catch(() => {}); }
    await loadStatus();
    await loadGitSummary(instanceId.value, workspace.value);
  }

  /** Navigate to an ancestor by breadcrumb index (-1 = root). */
  function up(toIndex: number): void {
    const segs = path.value ? path.value.split("/") : [];
    void list(segs.slice(0, toIndex + 1).join("/"));
  }

  async function search(q: string): Promise<void> {
    query.value = q;
    if (!instanceId.value || !workspace.value || !q.trim()) {
      results.value = [];
      hits.value = [];
      searchTruncated.value = false;
      return;
    }
    searching.value = true;
    error.value = "";
    try {
      const o = searchOpts.value;
      const r = unwrap(await api.rpc<FsSearchResult>(instanceId.value, "control.fs.search", {
        workspace: workspace.value, query: q,
        mode: o.mode, matchCase: o.matchCase, wholeWord: o.wholeWord, regex: o.regex,
        include: o.include, exclude: o.exclude, path: o.path,
      }));
      results.value = r.matches;
      hits.value = r.hits ?? [];
      searchTruncated.value = r.truncated;
    } catch (e) {
      error.value = e instanceof Error ? e.message : "search-failed";
    } finally {
      searching.value = false;
    }
  }

  /** Load the git diff for the whole tree (path omitted) or one file. */
  async function loadDiff(filePath?: string): Promise<void> {
    if (!instanceId.value || !workspace.value) return;
    loading.value = true;
    error.value = "";
    diffPath.value = filePath ?? null;
    try {
      diff.value = unwrap(await api.rpc<FsDiffResult>(instanceId.value, "control.fs.diff", { workspace: workspace.value, ...(filePath ? { path: filePath } : {}) }));
      notGit.value = false;
    } catch (e) {
      const msg = e instanceof Error ? e.message : "diff-failed";
      diff.value = null;
      // A non-git workspace is an expected state for the Changes tab — surface it as a
      // calm inline empty state, not a sticky error banner the user can't dismiss.
      if (msg === "not-a-git-repo") {
        notGit.value = true;
      } else {
        error.value = msg;
      }
    } finally {
      loading.value = false;
    }
  }

  return {
    instanceId, workspace, path, entries, file, diff, diffPath, notGit, changed, gitSummary, tab, query, results, searchTruncated, searching, loading, error,
    root, sep: sepChar, tree, expanded, loadingDirs, hits, searchOpts,
    reset, selectWorkspace, list, open, openFile, up, search, loadDiff, loadStatus, loadGitSummary, refresh,
    listTree, toggleExpand, absPath,
  };
});
