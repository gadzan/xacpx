import { defineStore } from "pinia";
import { ref } from "vue";
import {
  isErrorPayload,
  type FsDiffResult,
  type FsEntryDto,
  type FsListResult,
  type FsReadResult,
  type FsSearchResult,
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
  const tab = ref<"files" | "changes">("files");
  const query = ref("");
  const results = ref<string[]>([]);
  const searchTruncated = ref(false);
  const searching = ref(false);
  const loading = ref(false);
  const error = ref("");

  function reset(): void {
    workspace.value = null;
    path.value = "";
    entries.value = [];
    file.value = null;
    diff.value = null;
    diffPath.value = null;
    query.value = "";
    results.value = [];
    error.value = "";
  }

  async function selectWorkspace(id: string, ws: string): Promise<void> {
    instanceId.value = id;
    workspace.value = ws;
    file.value = null;
    diff.value = null;
    diffPath.value = null;
    query.value = "";
    results.value = [];
    await list("");
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

  /** Navigate to an ancestor by breadcrumb index (-1 = root). */
  function up(toIndex: number): void {
    const segs = path.value ? path.value.split("/") : [];
    void list(segs.slice(0, toIndex + 1).join("/"));
  }

  async function search(q: string): Promise<void> {
    query.value = q;
    if (!instanceId.value || !workspace.value || !q.trim()) {
      results.value = [];
      searchTruncated.value = false;
      return;
    }
    searching.value = true;
    error.value = "";
    try {
      const r = unwrap(await api.rpc<FsSearchResult>(instanceId.value, "control.fs.search", { workspace: workspace.value, query: q }));
      results.value = r.matches;
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
    } catch (e) {
      error.value = e instanceof Error ? e.message : "diff-failed";
      diff.value = null;
    } finally {
      loading.value = false;
    }
  }

  return { instanceId, workspace, path, entries, file, diff, diffPath, tab, query, results, searchTruncated, searching, loading, error, reset, selectWorkspace, list, open, openFile, up, search, loadDiff };
});
