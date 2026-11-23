import { defineStore } from "pinia";
import { ref, watch } from "vue";
import {
  isErrorPayload,
  type FsDiffResult,
  type FsDownloadResult,
  type FsEntryDto,
  type FsListResult,
  type FsReadResult,
  type FsWriteResult,
  type FsSearchResult,
  type FsSearchHitDto,
} from "@ganglion/xacpx-relay-protocol";
import { api } from "../api/client";
import { pushToast } from "../lib/use-toasts";
import * as viewCache from "../lib/view-snapshot-cache";
import { useAuthStore } from "./auth";

function unwrap<T>(result: T | { error: { code: string; message: string } }): T {
  if (isErrorPayload(result)) throw new Error(result.error.message || result.error.code);
  return result;
}

function isNotGitError(result: unknown): boolean {
  return isErrorPayload(result)
    && (result.error.code === "not-a-git-repo" || result.error.message === "not-a-git-repo");
}

/** Basename of a workspace-relative path, for toast messages. */
function baseName(rel: string): string {
  return rel.split("/").pop() || rel;
}

type GitSummary = { workspace: string; changedCount: number; branch?: string; detached?: boolean };
type WorkspaceViewSnapshot = {
  root: string;
  sep: "/" | "\\";
  tree: Record<string, FsEntryDto[]>;
  changed: Record<string, string>;
};

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
  const gitSummary = ref<GitSummary | null>(null);
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
  let diffRequestId = 0;
  let workspaceEpoch = 0;
  let lastListTreeError = "";
  let gitSummaryRevision = 0;
  let activeGitSummaryKey = "";
  const searchOpts = ref<{ mode: "name" | "content"; matchCase: boolean; wholeWord: boolean; regex: boolean; include: string; exclude: string }>({
    mode: "content", matchCase: false, wholeWord: false, regex: false, include: "", exclude: "",
  });

  const cacheUser = (): string | null => useAuthStore().account?.username ?? null;
  function workspaceSnapshot(): WorkspaceViewSnapshot {
    return {
      root: root.value,
      sep: sepChar.value,
      tree: tree.value,
      changed: changed.value,
    };
  }
  function applyWorkspaceSnapshot(snapshot: WorkspaceViewSnapshot): void {
    root.value = typeof snapshot.root === "string" ? snapshot.root : "";
    sepChar.value = snapshot.sep === "\\" ? "\\" : "/";
    tree.value = snapshot.tree && typeof snapshot.tree === "object" ? snapshot.tree : {};
    changed.value = snapshot.changed && typeof snapshot.changed === "object" ? snapshot.changed : {};
    path.value = "";
    entries.value = tree.value[""] ?? [];
  }
  function persistWorkspaceSnapshot(): void {
    const user = cacheUser();
    if (!user || !instanceId.value || !workspace.value) return;
    void viewCache.write(user, "workspace-view", instanceId.value, workspace.value, workspaceSnapshot());
  }

  function reset(options: { persist?: boolean } = {}): void {
    if (options.persist !== false) persistWorkspaceSnapshot();
    diffRequestId++;
    workspaceEpoch++;
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
    loading.value = false;
    error.value = "";
    tree.value = {};
    expanded.value = new Set();
    hits.value = [];
    root.value = "";
    // `include` can hold a workspace-bound folder scope ("<folder>/**", set by "Search in
    // this folder"), so clear it on a workspace switch — otherwise a stale scope leaks into
    // the next workspace and silently filters out all of its results. The rest
    // (mode/matchCase/wholeWord/regex/exclude) are user preferences and survive on purpose.
    searchOpts.value.include = "";
  }

  function resetForAccountChange(): void {
    reset({ persist: false });
    instanceId.value = null;
    gitSummaryRevision += 1;
    activeGitSummaryKey = "";
    gitSummary.value = null;
  }

  async function selectWorkspace(id: string, ws: string): Promise<void> {
    persistWorkspaceSnapshot();
    diffRequestId++;
    const epoch = ++workspaceEpoch;
    instanceId.value = id;
    workspace.value = ws;
    loading.value = false;
    file.value = null;
    diff.value = null;
    diffPath.value = null;
    notGit.value = false;
    changed.value = {};
    query.value = "";
    results.value = [];
    tree.value = {}; hits.value = [];
    try { expanded.value = new Set(JSON.parse(localStorage.getItem(expandedKey()) ?? "[]") as string[]); } catch { expanded.value = new Set(); }
    const user = cacheUser();
    if (user) {
      const hot = viewCache.peek<WorkspaceViewSnapshot>(user, "workspace-view", id, ws);
      const cached = hot ?? await viewCache.read<WorkspaceViewSnapshot>(user, "workspace-view", id, ws);
      if (epoch !== workspaceEpoch || instanceId.value !== id || workspace.value !== ws || cacheUser() !== user) return;
      if (cached) applyWorkspaceSnapshot(cached);
    }
    await listTree("");
    if (epoch !== workspaceEpoch || instanceId.value !== id || workspace.value !== ws) return;
    // Mirror the root layer into the flat path/entries state — the Changes tab and
    // any surviving flat-view consumers read those, not `tree`, after selectWorkspace.
    path.value = "";
    entries.value = tree.value[""] ?? [];
    // Revalidate every expanded cached layer (best-effort). Keeping a cached
    // directory forever merely because it already exists would violate SWR.
    const staleExpanded = [...expanded.value].filter(Boolean);
    await Promise.all(
      staleExpanded.map(async (dir) => {
        try {
          await listTree(dir, { quiet: true });
        } catch {
          // A cached expanded directory may have been removed since the last visit.
          // Drop only confirmed missing paths; transient transport failures should not
          // destroy the user's navigation state.
          if (lastListTreeError === "not-found" || lastListTreeError === "unknown-workspace") {
            const next = new Set(expanded.value);
            next.delete(dir);
            expanded.value = next;
            try { localStorage.setItem(expandedKey(), JSON.stringify([...next])); } catch { /* ignore */ }
          }
        }
      }),
    );
    void loadStatus();
  }

  /** Quietly fetch git status for badge annotation. A confirmed non-git
   *  workspace clears the badges; transient failures preserve the cached state.
   *  Neither case surfaces an error while the user is browsing files. */
  async function loadStatus(): Promise<void> {
    if (!instanceId.value || !workspace.value) return;
    const id = instanceId.value;
    const ws = workspace.value;
    const epoch = workspaceEpoch;
    const isCurrent = () => epoch === workspaceEpoch
      && instanceId.value === id
      && workspace.value === ws;
    try {
      const r = await api.rpc<FsDiffResult>(id, "control.fs.diff", { workspace: ws });
      if (!isCurrent()) return;
      if (isErrorPayload(r)) {
        if (isNotGitError(r)) {
          changed.value = {};
          persistWorkspaceSnapshot();
        }
        return;
      }
      const map: Record<string, string> = {};
      for (const f of r.files) map[f.path] = f.status;
      changed.value = map;
      persistWorkspaceSnapshot();
    } catch {
      // Stale-while-revalidate: a transport failure says nothing about the
      // workspace's current git state, so keep the cached badges visible.
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
    const key = `${id}\0${ws}`;
    const revision = ++gitSummaryRevision;
    if (activeGitSummaryKey !== key) gitSummary.value = null;
    activeGitSummaryKey = key;
    const user = cacheUser();
    if (user) {
      const hot = viewCache.peek<{ summary: GitSummary | null }>(user, "git-summary", id, ws);
      const cached = hot ?? await viewCache.read<{ summary: GitSummary | null }>(user, "git-summary", id, ws);
      if (revision !== gitSummaryRevision || activeGitSummaryKey !== key || cacheUser() !== user) return;
      if (cached) gitSummary.value = cached.summary;
    }
    try {
      const r = await api.rpc<FsDiffResult>(id, "control.fs.diff", { workspace: ws });
      if (revision !== gitSummaryRevision || activeGitSummaryKey !== key) return;
      if (isErrorPayload(r)) {
        if (isNotGitError(r)) {
          gitSummary.value = null;
          if (user && cacheUser() === user) {
            void viewCache.write(user, "git-summary", id, ws, { summary: null });
          }
        }
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
      if (user && cacheUser() === user) void viewCache.write(user, "git-summary", id, ws, { summary: gitSummary.value });
    } catch {
      // A transient refresh failure keeps a cache-seeded summary visible.
      if (revision === gitSummaryRevision && activeGitSummaryKey === key && !user) gitSummary.value = null;
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
  async function listTree(dir: string, options: { quiet?: boolean } = {}): Promise<void> {
    if (!instanceId.value || !workspace.value) return;
    const id = instanceId.value;
    const ws = workspace.value;
    const epoch = workspaceEpoch;
    const isCurrent = () => epoch === workspaceEpoch
      && instanceId.value === id
      && workspace.value === ws;
    loadingDirs.value = new Set(loadingDirs.value).add(dir);
    try {
      lastListTreeError = "";
      const r = unwrap(await api.rpc<FsListResult>(id, "control.fs.list", { workspace: ws, path: dir }));
      if (!isCurrent()) return;
      root.value = r.root; sepChar.value = r.sep;
      tree.value = { ...tree.value, [dir]: r.entries };
      persistWorkspaceSnapshot();
    } catch (e) {
      if (!isCurrent()) return;
      lastListTreeError = e instanceof Error ? e.message : "list-failed";
      if (!options.quiet) error.value = e instanceof Error ? e.message : "list-failed";
      else throw e;
    } finally {
      if (isCurrent()) {
        const next = new Set(loadingDirs.value); next.delete(dir); loadingDirs.value = next;
      }
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
    persistWorkspaceSnapshot();
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
        include: o.include, exclude: o.exclude,
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

  /** Re-list one directory layer + refresh git badges after a write. */
  async function refreshDir(dir: string): Promise<void> {
    await listTree(dir);
    await loadStatus();
  }
  function parentOf(rel: string): string {
    const i = rel.lastIndexOf("/");
    return i < 0 ? "" : rel.slice(0, i);
  }

  // Write-op results surface as global toasts (auto-dismissing, closable) rather than
  // the sticky `error` banner, which stays reserved for read/list/search failures.
  function opFailed(e: unknown): void {
    pushToast("error", "files.toast.failed", { msg: e instanceof Error ? e.message : "unknown" });
  }

  async function createEntry(dir: string, name: string, kind: "file" | "dir"): Promise<void> {
    if (!instanceId.value || !workspace.value || !name.trim()) return;
    const p = dir ? `${dir}/${name}` : name;
    try {
      unwrap(await api.rpc(instanceId.value, "control.fs.create", { workspace: workspace.value, path: p, kind }));
      await refreshDir(dir);
      pushToast("success", "files.toast.created", { name });
    } catch (e) { opFailed(e); }
  }
  async function renameEntry(rel: string, newName: string): Promise<void> {
    if (!instanceId.value || !workspace.value || !newName.trim()) return;
    try {
      unwrap(await api.rpc(instanceId.value, "control.fs.rename", { workspace: workspace.value, path: rel, newName }));
      await refreshDir(parentOf(rel));
      pushToast("success", "files.toast.renamed", { name: newName });
    } catch (e) { opFailed(e); }
  }
  async function deleteEntry(rel: string): Promise<void> {
    if (!instanceId.value || !workspace.value) return;
    try {
      unwrap(await api.rpc(instanceId.value, "control.fs.delete", { workspace: workspace.value, path: rel }));
      await refreshDir(parentOf(rel));
      pushToast("success", "files.toast.deleted", { name: baseName(rel) });
    } catch (e) { opFailed(e); }
  }
  async function downloadEntry(rel: string): Promise<void> {
    if (!instanceId.value || !workspace.value) return;
    try {
      const r = unwrap(await api.rpc<FsDownloadResult>(
        instanceId.value, "control.fs.download", { workspace: workspace.value, path: rel }));
      const bytes = Uint8Array.from(atob(r.base64), (c) => c.charCodeAt(0));
      const blob = new Blob([bytes], { type: r.mimeType });
      const url = URL.createObjectURL(blob);
      try {
        const a = document.createElement("a");
        a.href = url; a.download = baseName(rel) || "download";
        document.body.appendChild(a); a.click(); a.remove();
      } finally {
        URL.revokeObjectURL(url);
      }
      pushToast("success", "files.toast.downloaded", { name: baseName(rel) });
    } catch (e) { opFailed(e); }
  }

  /** Load the git diff for the whole tree (path omitted) or one file. */
  async function loadDiff(filePath?: string): Promise<void> {
    if (!instanceId.value || !workspace.value) return;
    const id = instanceId.value;
    const ws = workspace.value;
    const requestId = ++diffRequestId;
    const isCurrent = () => requestId === diffRequestId
      && instanceId.value === id
      && workspace.value === ws;
    loading.value = true;
    error.value = "";
    diffPath.value = filePath ?? null;
    try {
      const result = unwrap(await api.rpc<FsDiffResult>(id, "control.fs.diff", { workspace: ws, ...(filePath ? { path: filePath } : {}) }));
      if (!isCurrent()) return;
      diff.value = result;
      notGit.value = false;
    } catch (e) {
      if (!isCurrent()) return;
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
      if (isCurrent()) loading.value = false;
    }
  }

  /** Read a file's content without touching the global `file` slot — for tab
   *  panes that hold their own local content independent of the file browser. */
  async function readFile(id: string, ws: string, filePath: string): Promise<FsReadResult> {
    return unwrap(await api.rpc<FsReadResult>(id, "control.fs.read", { workspace: ws, path: filePath }));
  }

  /** Read a git diff (whole-tree or one file) without touching the global `diff`/`diffPath`
   *  slots — for tab panes that hold their own local diff content. */
  async function readDiff(id: string, ws: string, filePath?: string): Promise<FsDiffResult> {
    return unwrap(await api.rpc<FsDiffResult>(id, "control.fs.diff", { workspace: ws, ...(filePath ? { path: filePath } : {}) }));
  }

  /** Overwrite a file's content, echoing the read-time stale-write token. Throws the raw
   *  error code (`stale-write` / `files-write-disabled` / `is-binary` / `file-too-large`)
   *  so the caller can map it to a message. */
  async function saveFile(
    id: string, ws: string, filePath: string, content: string, expected: { mtimeMs: number; size: number },
  ): Promise<FsWriteResult> {
    return unwrap(await api.rpc<FsWriteResult>(id, "control.fs.write", { workspace: ws, path: filePath, content, expected }));
  }

  const auth = useAuthStore();
  watch(() => auth.account?.username ?? null, () => resetForAccountChange(), { flush: "sync" });

  return {
    instanceId, workspace, path, entries, file, diff, diffPath, notGit, changed, gitSummary, tab, query, results, searchTruncated, searching, loading, error,
    root, sep: sepChar, tree, expanded, loadingDirs, hits, searchOpts,
    reset, selectWorkspace, list, open, openFile, up, search, loadDiff, loadStatus, loadGitSummary, refresh,
    listTree, toggleExpand, absPath,
    createEntry, renameEntry, deleteEntry, downloadEntry,
    readFile, readDiff, saveFile,
  };
});
