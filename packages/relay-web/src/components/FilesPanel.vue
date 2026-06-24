<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ChevronRight, CornerLeftUp, File, FileText, Folder, FolderGit2, GitBranch, List, RefreshCw, X } from "lucide-vue-next";
import type { FsEntryDto } from "@ganglion/xacpx-relay-protocol";
import { useFilesStore } from "../stores/files";
import { useInstancesStore } from "../stores/instances";
import { useChatStore } from "../stores/chat";
import { groupChanges, splitPath } from "../lib/change-groups";

// Navigation-only file rail: a file tree (Files) and a changed-files list (Changes).
// Opening a file or a single-file diff shows it full-width in the center column (see
// FileViewer); the rail stays narrow and is just for getting around.
const props = defineProps<{ instanceId: string | null }>();
const files = useFilesStore();
const instances = useInstancesStore();
const chat = useChatStore();

const crumbs = computed(() => (files.path ? files.path.split("/") : []));
const atRoot = computed(() => crumbs.value.length === 0);
// Go up one directory level. `up(i)` keeps the first i+1 path segments, so the parent of
// the current dir is `up(crumbs.length - 2)` (and `up(-1)` lands on the workspace root).
function upOne() {
  if (!atRoot.value) files.up(crumbs.value.length - 2);
}

// The panel follows the ACTIVE session's workspace — there's no manual picker, since the
// workspace is a fixed property of the session you're chatting with.
const activeWorkspace = computed(() => {
  const inst = props.instanceId ? instances.byId(props.instanceId) : undefined;
  return inst?.sessions.find((s) => s.alias === chat.sessionAlias)?.workspace ?? null;
});

// Git context for the Changes header: branch / detached HEAD + worktree (root path,
// linked flag), straight off the loaded diff result. null until a diff is loaded.
const gitCtx = computed(() => {
  const d = files.diff;
  if (!d) return null;
  return { branch: d.branch, detached: d.detached === true, worktree: d.worktree };
});

// Changes summary: `N files · +X −Y`, derived (read-only) from the loaded diff.
const changesSummary = computed(() => {
  const d = files.diff;
  if (!d) return null;
  let add = 0;
  let del = 0;
  for (const l of d.diff ? d.diff.split("\n") : []) {
    if (l.startsWith("+") && !l.startsWith("+++")) add++;
    else if (l.startsWith("-") && !l.startsWith("---")) del++;
  }
  return { fileCount: d.files.length, add, del };
});

// Three-way grouping of the changed-files list (Staged / Changes / Untracked). Empty groups hide.
const changeSections = computed(() => {
  const g = groupChanges(files.diff?.files ?? []);
  return [
    { key: "staged", items: g.staged },
    { key: "changes", items: g.changes },
    { key: "untracked", items: g.untracked },
  ].filter((s) => s.items.length);
});

// Per-group collapse state, persisted (sibling of the xacpx.* prefs).
const COLLAPSE_KEY = "xacpx.changes.collapsed";
const collapsed = ref<Record<string, boolean>>(loadCollapsed());
function loadCollapsed(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? "{}") as Record<string, boolean>;
  } catch {
    return {};
  }
}
function toggleGroup(key: string): void {
  collapsed.value = { ...collapsed.value, [key]: !collapsed.value[key] };
  try {
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify(collapsed.value));
  } catch {
    /* private mode / quota — collapse just won't persist */
  }
}

// Debounced file-name search.
const searchInput = ref("");
let searchTimer: ReturnType<typeof setTimeout> | null = null;
function onSearchInput() {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => void files.search(searchInput.value), 250);
}
function clearSearch() {
  searchInput.value = "";
  void files.search("");
}

// Format a byte size compactly.
function fmtSize(n?: number): string {
  if (n === undefined) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
// Git-status badge for a directory entry, derived from the quietly-loaded status map.
function entryRel(name: string): string {
  return files.path ? `${files.path}/${name}` : name;
}
function statusBadge(code: string): { label: string; cls: string; dot: string } {
  const c = code.trim();
  if (c.includes("?")) return { label: "U", cls: "text-warn", dot: "bg-warn" }; // untracked
  if (c.includes("A")) return { label: "A", cls: "text-run", dot: "bg-run" };
  if (c.includes("D")) return { label: "D", cls: "text-danger", dot: "bg-danger" };
  if (c.includes("R")) return { label: "R", cls: "text-accent", dot: "bg-accent" };
  if (c.includes("M")) return { label: "M", cls: "text-info", dot: "bg-warn" };
  return { label: c[0] ?? "•", cls: "text-fg-muted", dot: "bg-warn" };
}
function entryStatus(e: { name: string; type: string }): { label: string; cls: string; dot: string } | null {
  const rel = entryRel(e.name);
  if (e.type === "file") {
    const code = files.changed[rel];
    return code ? statusBadge(code) : null;
  }
  const prefix = `${rel}/`;
  return Object.keys(files.changed).some((p) => p.startsWith(prefix)) ? { label: "•", cls: "text-warn", dot: "bg-warn" } : null;
}

// `true` when this entry is the file currently shown in the center viewer.
function isOpen(name: string): boolean {
  return !!files.file && files.file.path === entryRel(name);
}

// Open helpers: clear the counterpart so the center viewer shows exactly one thing —
// a file or a single-file diff, never a stale mix.
function openEntry(e: FsEntryDto) {
  if (e.type === "file") files.diffPath = null;
  void files.open(e);
}
function openSearchResult(m: string) {
  files.diffPath = null;
  void files.openFile(m);
}
function openDiff(path: string) {
  files.file = null;
  void files.loadDiff(path);
}

// Follow the instance + active session's workspace. Re-selects (and resets navigation)
// whenever you switch to a session in a different workspace.
watch(
  () => [props.instanceId, activeWorkspace.value] as const,
  async ([id, ws]) => {
    files.reset();
    searchInput.value = "";
    if (!id) return;
    files.instanceId = id;
    await instances.loadWorkspaces(id).catch(() => {});
    // Default to the active session's workspace; fall back to the first configured one.
    const target = ws ?? instances.byId(id)?.workspaces?.[0]?.name;
    if (target) void files.selectWorkspace(id, target);
  },
  { immediate: true },
);

watch(
  () => files.tab,
  (t) => {
    if (t === "changes" && !files.diff) void files.loadDiff();
  },
);
</script>

<template>
  <div class="flex h-full flex-col bg-surface text-sm text-fg-muted">
    <div v-if="!instanceId" class="flex flex-1 items-center justify-center p-4 text-center text-xs text-fg-muted">
      {{ $t("files.selectToBrowse") }}
    </div>
    <template v-else>
      <!-- Active session's workspace (static — no picker) + Files / Changes tabs. -->
      <div class="flex shrink-0 items-center gap-2 border-b border-border p-2">
        <div data-test="ws-label" class="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-fg" :title="files.workspace ?? ''">
          <Folder :size="13" class="shrink-0 text-warn" />
          <span class="truncate font-medium">{{ files.workspace ?? "—" }}</span>
        </div>
        <div class="flex shrink-0 items-center gap-1">
          <button
            data-test="refresh-files"
            :title="$t('files.refresh')"
            :aria-label="$t('files.refresh')"
            class="grid h-6 w-6 place-items-center rounded text-fg-muted transition-colors hover:bg-raised hover:text-fg disabled:opacity-50"
            :disabled="files.loading"
            @click="files.refresh()"
          >
            <RefreshCw :size="13" :class="files.loading ? 'animate-spin motion-reduce:animate-none' : ''" />
          </button>
          <button data-test="tab-files"
                  class="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11.5px] transition-colors cursor-pointer"
                  :class="files.tab === 'files' ? 'bg-accent/10 text-accent font-semibold' : 'text-fg-muted font-medium hover:bg-raised'"
                  @click="files.tab = 'files'">
            <FileText :size="13" />{{ $t("files.title") }}
          </button>
          <button data-test="tab-changes"
                  class="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11.5px] transition-colors cursor-pointer"
                  :class="files.tab === 'changes' ? 'bg-accent/10 text-accent font-semibold' : 'text-fg-muted font-medium hover:bg-raised'"
                  @click="files.tab = 'changes'">
            <List :size="13" />{{ $t("files.changes") }}
          </button>
        </div>
      </div>

      <div v-if="files.error" data-test="files-error" class="shrink-0 bg-danger/10 px-2 py-1 text-xs text-danger">{{ files.error }}</div>

      <!-- Files tab: pinned search (+ breadcrumb when browsing); only the listing scrolls. -->
      <div v-if="files.tab === 'files'" class="flex min-h-0 flex-1 flex-col">
        <!-- search (pinned) -->
        <div class="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1">
          <input v-model="searchInput" data-test="fs-search" :placeholder="$t('files.searchPlaceholder')"
                 class="min-w-0 flex-1 rounded border border-border bg-bg px-2 py-1 text-xs text-fg placeholder:text-fg-muted" @input="onSearchInput" />
          <button v-if="searchInput" :aria-label="$t('files.clearSearch')" class="text-fg-muted hover:text-fg" @click="clearSearch"><X :size="14" /></button>
        </div>

        <!-- search results (the list scrolls) -->
        <div v-if="files.query.trim()" data-test="fs-results" class="min-h-0 flex-1 overflow-y-auto thin-scroll">
          <ul class="p-2.5 text-[11px] font-mono leading-5 space-y-px">
            <li v-for="m in files.results" :key="m">
              <button data-test="fs-result"
                      class="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left hover:bg-raised cursor-pointer" @click="openSearchResult(m)">
                <File :size="13" class="shrink-0 text-fg-muted" />
                <span class="truncate font-sans text-[12px] text-fg-muted">{{ m }}</span>
              </button>
            </li>
            <li v-if="!files.results.length && !files.searching" class="px-1.5 py-1 text-xs text-fg-muted">{{ $t("palette.noMatches") }}</li>
          </ul>
          <div v-if="files.searchTruncated" class="px-2.5 pb-1 text-xs text-warn">{{ $t("files.showingFirstMatches") }}</div>
        </div>

        <!-- browsing: pinned breadcrumb, then the directory listing scrolls -->
        <template v-else>
        <div class="flex shrink-0 flex-wrap items-center gap-1 border-b border-border px-2.5 py-1.5 font-mono text-[11px] text-fg-muted">
          <button data-test="fs-up" :title="$t('files.upOneLevel')" :aria-label="$t('files.upOneLevel')"
                  class="grid h-5 w-5 shrink-0 place-items-center rounded text-fg-muted hover:bg-raised hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-fg-muted"
                  :disabled="atRoot || files.loading" @click="upOne">
            <CornerLeftUp :size="13" />
          </button>
          <button class="hover:text-fg" @click="files.up(-1)">{{ files.workspace ?? $t("files.root") }}</button>
          <template v-for="(c, i) in crumbs" :key="i">
            <span>/</span><button class="hover:text-fg" @click="files.up(i)">{{ c }}</button>
          </template>
        </div>

        <!-- directory listing: tree-styled rows (chevron + folder/file icon) -->
        <ul class="min-h-0 flex-1 overflow-y-auto thin-scroll p-2.5 text-[11px] font-mono leading-5 space-y-px">
          <li v-for="e in files.entries" :key="e.name">
            <button data-test="fs-entry"
                    class="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left cursor-pointer"
                    :class="isOpen(e.name) ? 'bg-accent/15' : (entryStatus(e) ? 'bg-accent/10' : 'hover:bg-raised')" @click="openEntry(e)">
              <ChevronRight v-if="e.type === 'dir'" :size="11" class="shrink-0 text-fg-muted" />
              <span v-else class="w-[11px] shrink-0" />
              <Folder v-if="e.type === 'dir'" :size="13" class="shrink-0" :class="entryStatus(e) ? 'text-accent' : 'text-fg-muted'" />
              <File v-else :size="13" class="shrink-0" :class="isOpen(e.name) || entryStatus(e) ? 'text-accent' : 'text-fg-muted'" />
              <span class="flex-1 truncate font-sans text-[12px]"
                    :class="isOpen(e.name) || entryStatus(e) ? 'text-accent font-medium' : (e.type === 'dir' ? 'text-fg font-medium' : 'text-fg-muted')">{{ e.name }}</span>
              <span v-if="entryStatus(e)" data-test="fs-status" class="w-1.5 h-1.5 shrink-0 rounded-full"
                    :class="entryStatus(e)!.dot"
                    :title="`${entryStatus(e)!.label} — ${files.changed[entryRel(e.name)] || $t('files.containsChanges')}`" />
              <span v-if="e.type === 'file' && !entryStatus(e)" class="shrink-0 font-mono text-[10.5px] text-fg-muted tabular-nums">{{ fmtSize(e.size) }}</span>
            </button>
          </li>
          <li v-if="!files.entries.length && !files.loading" class="px-1.5 py-1 text-xs text-fg-muted">{{ $t("files.emptyDirectory") }}</li>
        </ul>
        </template>
      </div>

      <!-- Changes (git status) tab: pinned summary; only the changed-files list scrolls. -->
      <div v-else class="flex min-h-0 flex-1 flex-col">
        <template v-if="files.diff">
          <!-- pinned git context: branch / detached + worktree, then the change counts -->
          <div class="shrink-0 border-b border-border">
            <div data-test="changes-summary" class="flex items-center gap-1.5 px-2.5 pt-2" :class="gitCtx?.worktree ? 'pb-1' : 'pb-2'">
              <GitBranch :size="12" class="shrink-0 text-accent" />
              <span v-if="gitCtx?.branch" data-test="changes-branch" class="truncate font-mono text-[11.5px] font-medium text-fg">{{ gitCtx.branch }}</span>
              <span v-else-if="gitCtx?.detached" data-test="changes-branch" class="truncate font-mono text-[11.5px] italic text-fg-muted">{{ $t("files.detached") }}</span>
              <span v-else class="text-[10.5px] font-semibold uppercase tracking-wider text-fg-muted">{{ $t("files.changes") }}</span>
              <span v-if="gitCtx?.worktree?.linked" data-test="worktree-linked"
                    class="shrink-0 rounded-full border border-accent/30 bg-accent/10 px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide text-accent">{{ $t("files.linked") }}</span>
              <span class="flex-1" />
              <div v-if="changesSummary" class="flex shrink-0 items-center gap-1.5 font-mono text-[10.5px] tabular-nums">
                <span class="text-fg-muted">{{ changesSummary.fileCount }} {{ $t("files.filesCount") }}</span>
                <span class="text-run">+{{ changesSummary.add }}</span>
                <span class="text-danger">−{{ changesSummary.del }}</span>
              </div>
            </div>
            <div v-if="gitCtx?.worktree" data-test="worktree-path" class="flex items-center gap-1.5 px-2.5 pb-2 text-[10px] text-fg-muted" :title="`${$t('files.worktree')}: ${gitCtx.worktree.root}`">
              <FolderGit2 :size="11" class="shrink-0 opacity-70" />
              <span class="truncate font-mono" dir="rtl">{{ gitCtx.worktree.root }}</span>
            </div>
          </div>
          <div class="min-h-0 flex-1 overflow-y-auto thin-scroll p-2.5 space-y-2">
            <div v-for="s in changeSections" :key="s.key" data-test="change-group">
              <button class="flex w-full items-center gap-1.5 px-1 py-0.5 text-[10.5px] font-semibold uppercase tracking-wider text-fg-muted transition-colors hover:text-fg"
                      @click="toggleGroup(s.key)">
                <ChevronRight :size="11" class="shrink-0 transition-transform" :class="collapsed[s.key] ? '' : 'rotate-90'" />
                <span>{{ $t(`files.${s.key}`) }}</span>
                <span class="text-fg-muted/60">{{ s.items.length }}</span>
              </button>
              <ul v-show="!collapsed[s.key]" class="space-y-px pt-0.5">
                <li v-for="f in s.items" :key="f.path">
                  <button data-test="diff-file" :title="f.path"
                          class="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left cursor-pointer"
                          :class="files.diffPath === f.path ? 'bg-accent/10' : 'hover:bg-raised'" @click="openDiff(f.path)">
                    <span class="w-3 shrink-0 text-center font-mono text-[10.5px] uppercase" :class="statusBadge(f.status).cls">{{ statusBadge(f.status).label }}</span>
                    <span class="flex min-w-0 flex-1 items-baseline truncate font-mono text-[11px]">
                      <span v-if="splitPath(f.path).dir" class="truncate text-fg-muted/70">{{ splitPath(f.path).dir }}</span>
                      <span class="shrink-0" :class="files.diffPath === f.path ? 'text-accent' : 'text-fg'">{{ splitPath(f.path).name }}</span>
                    </span>
                  </button>
                </li>
              </ul>
            </div>
            <div v-if="!changeSections.length" class="px-1.5 py-1 text-xs text-fg-muted">{{ $t("files.noChanges") }}</div>
          </div>
        </template>
        <!-- A non-git workspace is normal here — a calm note, not an error banner. -->
        <div v-else-if="files.notGit" data-test="changes-not-git" class="flex min-h-0 flex-1 flex-col items-center justify-center gap-1.5 p-6 text-center text-xs text-fg-muted">
          <GitBranch :size="20" class="text-fg-muted/60" />
          <span>{{ $t("files.notGitRepo") }}</span>
          <span class="text-[11px] text-fg-muted/70">{{ $t("files.notGitRepoBody") }}</span>
        </div>
        <div v-else-if="!files.loading" class="p-3 text-xs text-fg-muted">{{ $t("files.noDiffLoaded") }}</div>
      </div>

      <div v-if="files.loading" class="shrink-0 border-t border-border px-3 py-1 text-xs text-fg-muted">{{ $t("files.loading") }}</div>
    </template>
  </div>
</template>
