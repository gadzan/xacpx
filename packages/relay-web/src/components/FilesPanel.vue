<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ChevronRight, File, FileText, Folder, FolderGit2, GitBranch, List, RefreshCw, X } from "lucide-vue-next";
import { useFilesStore } from "../stores/files";
import { useInstancesStore } from "../stores/instances";
import { useChatStore } from "../stores/chat";
import { groupChanges, splitPath } from "../lib/change-groups";
import FileTreeNode from "./FileTreeNode.vue";

// Navigation-only file rail: a file tree (Files) and a changed-files list (Changes).
// Opening a file or a single-file diff shows it full-width in the center column (see
// FileViewer); the rail stays narrow and is just for getting around.
const props = defineProps<{ instanceId: string | null }>();
const files = useFilesStore();
const instances = useInstancesStore();
const chat = useChatStore();

// dotfile / gitignore toggles for the Files-tab tree, persisted across sessions.
const showDotfiles = ref(localStorage.getItem("xacpx.files.showDotfiles") === "1");
const showGitignored = ref(localStorage.getItem("xacpx.files.showGitignored") === "1");
watch(showDotfiles, (v) => localStorage.setItem("xacpx.files.showDotfiles", v ? "1" : "0"));
watch(showGitignored, (v) => localStorage.setItem("xacpx.files.showGitignored", v ? "1" : "0"));
// Root-layer children, filtered by the same predicate FileTreeNode applies to its own children.
const rootChildren = computed(() => (files.tree[""] ?? []).filter((e) =>
  (!e.ignored || showGitignored.value) && (!e.name.startsWith(".") || showDotfiles.value)));
function openTreeFile(rel: string) {
  files.diffPath = null;
  void files.openFile(rel);
}

// Root-level "new file / new folder" — there's no parent tree row to right-click at the
// workspace root, so this inline entry point lives in the tree header instead.
const rootInline = ref<null | "file" | "dir">(null);
const rootName = ref("");
async function submitRoot() {
  const kind = rootInline.value;
  const name = rootName.value.trim();
  rootInline.value = null;
  rootName.value = "";
  if (kind && name) await files.createEntry("", name, kind);
}
// Re-run the active search when its options change (toggles, include/exclude, mode).
watch(() => ({ ...files.searchOpts }), () => { if (files.query.trim()) void files.search(files.query); }, { deep: true });

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

// Git-status badge for a Changes-tab row, derived from the porcelain status code.
function statusBadge(code: string): { label: string; cls: string; dot: string } {
  const c = code.trim();
  if (c.includes("?")) return { label: "U", cls: "text-warn", dot: "bg-warn" }; // untracked
  if (c.includes("A")) return { label: "A", cls: "text-run", dot: "bg-run" };
  if (c.includes("D")) return { label: "D", cls: "text-danger", dot: "bg-danger" };
  if (c.includes("R")) return { label: "R", cls: "text-accent", dot: "bg-accent" };
  if (c.includes("M")) return { label: "M", cls: "text-info", dot: "bg-warn" };
  return { label: c[0] ?? "•", cls: "text-fg-muted", dot: "bg-warn" };
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
    if (!target) return;
    await files.selectWorkspace(id, target);
    // selectWorkspace cleared the diff, but the files.tab watcher below won't refire on a
    // session switch (the tab value is unchanged), so the Changes tab would sit on the
    // "no diff loaded" placeholder until a manual refresh. Load it here when it's the
    // active view so switching sessions auto-shows the new workspace's changes.
    if (files.tab === "changes") void files.loadDiff();
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
        <!-- search (pinned): query + match-case/whole-word/regex + include/exclude + name/content mode -->
        <div class="shrink-0 border-b border-border px-2 py-1 space-y-1">
          <div class="flex items-center gap-1">
            <input v-model="searchInput" data-test="fs-search" :placeholder="$t('files.searchPlaceholder')"
                   class="min-w-0 flex-1 rounded border border-border bg-bg px-2 py-1 text-xs text-fg placeholder:text-fg-muted" @input="onSearchInput" />
            <button data-test="search-matchcase" :title="$t('files.search.matchCase')" @click="files.searchOpts.matchCase = !files.searchOpts.matchCase"
                    class="grid h-6 w-6 place-items-center rounded text-[11px]" :class="files.searchOpts.matchCase ? 'bg-accent/15 text-accent' : 'text-fg-muted hover:bg-raised'">Aa</button>
            <button data-test="search-wholeword" :title="$t('files.search.wholeWord')" @click="files.searchOpts.wholeWord = !files.searchOpts.wholeWord"
                    class="grid h-6 w-6 place-items-center rounded text-[11px]" :class="files.searchOpts.wholeWord ? 'bg-accent/15 text-accent' : 'text-fg-muted hover:bg-raised'">W</button>
            <button data-test="search-regex" :title="$t('files.search.regex')" @click="files.searchOpts.regex = !files.searchOpts.regex"
                    class="grid h-6 w-6 place-items-center rounded font-mono text-[11px]" :class="files.searchOpts.regex ? 'bg-accent/15 text-accent' : 'text-fg-muted hover:bg-raised'">.*</button>
            <button v-if="searchInput" :aria-label="$t('files.clearSearch')" class="text-fg-muted hover:text-fg" @click="clearSearch"><X :size="14" /></button>
          </div>
          <div class="flex items-center gap-1">
            <input v-model="files.searchOpts.include" data-test="search-include" :placeholder="$t('files.search.include')" class="min-w-0 flex-1 rounded border border-border bg-bg px-2 py-0.5 text-[11px] text-fg placeholder:text-fg-muted" />
            <input v-model="files.searchOpts.exclude" data-test="search-exclude" :placeholder="$t('files.search.exclude')" class="min-w-0 flex-1 rounded border border-border bg-bg px-2 py-0.5 text-[11px] text-fg placeholder:text-fg-muted" />
          </div>
          <div class="flex items-center gap-1 text-[11px]">
            <button data-test="search-mode-name" @click="files.searchOpts.mode = 'name'" class="rounded px-2 py-0.5" :class="files.searchOpts.mode === 'name' ? 'bg-accent/15 text-accent' : 'text-fg-muted hover:bg-raised'">{{ $t("files.search.byName") }}</button>
            <button data-test="search-mode-content" @click="files.searchOpts.mode = 'content'" class="rounded px-2 py-0.5" :class="files.searchOpts.mode === 'content' ? 'bg-accent/15 text-accent' : 'text-fg-muted hover:bg-raised'">{{ $t("files.search.byContent") }}</button>
          </div>
        </div>

        <!-- search results (the list scrolls): content mode groups hits by file, name mode keeps the flat list -->
        <div v-if="files.query.trim()" data-test="fs-results" class="min-h-0 flex-1 overflow-y-auto thin-scroll">
          <template v-if="files.searchOpts.mode === 'content'">
            <div v-if="!files.hits.length && !files.searching" class="px-3 py-1 text-xs text-fg-muted">{{ $t("files.search.noContentMatches") }}</div>
            <ul class="p-2 text-[11px] font-mono leading-5">
              <li v-for="(h, i) in files.hits" :key="i">
                <button data-test="fs-hit" class="flex w-full items-baseline gap-2 rounded px-1.5 py-0.5 text-left hover:bg-raised" @click="openSearchResult(h.path)">
                  <span class="shrink-0 text-fg-muted/70">{{ h.path }}:{{ h.line }}</span>
                  <span class="truncate text-fg-muted">{{ h.text }}</span>
                </button>
              </li>
            </ul>
            <div v-if="files.searchTruncated" class="px-2.5 pb-1 text-xs text-warn">{{ $t("files.showingFirstMatches") }}</div>
          </template>
          <template v-else>
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
          </template>
        </div>

        <!-- browsing: dotfile/gitignore toggles, then the tree scrolls -->
        <template v-else>
        <div class="flex shrink-0 items-center gap-3 border-b border-border px-2.5 py-1 text-[11px] text-fg-muted">
          <label class="flex items-center gap-1 cursor-pointer"><input type="checkbox" data-test="toggle-dotfiles" v-model="showDotfiles" class="accent-accent" />{{ $t("files.toggle.showDotfiles") }}</label>
          <label class="flex items-center gap-1 cursor-pointer"><input type="checkbox" data-test="toggle-gitignored" v-model="showGitignored" class="accent-accent" />{{ $t("files.toggle.showGitignored") }}</label>
        </div>

        <!-- root-level new file/folder: the workspace root has no parent row to right-click. -->
        <div class="mb-1 flex items-center gap-1">
          <button data-test="root-new-file" class="rounded px-1.5 py-0.5 text-[11px] text-fg-muted hover:bg-raised"
                  @click="rootInline = 'file'" :title="$t('files.menu.newFile')">＋{{ $t('files.menu.newFile') }}</button>
          <button data-test="root-new-folder" class="rounded px-1.5 py-0.5 text-[11px] text-fg-muted hover:bg-raised"
                  @click="rootInline = 'dir'" :title="$t('files.menu.newFolder')">＋{{ $t('files.menu.newFolder') }}</button>
        </div>
        <input v-if="rootInline" data-test="root-inline-name" v-model="rootName"
               @keyup.enter="submitRoot" @keyup.esc="rootInline = null" @blur="rootInline = null"
               class="mb-1 w-full rounded border border-border bg-raised px-1 text-[12px]" />

        <!-- directory tree: recursive rows (chevron + folder/file icon), lazy-expanded -->
        <div class="min-h-0 flex-1 overflow-y-auto thin-scroll py-1 font-mono">
          <FileTreeNode v-for="e in rootChildren" :key="e.name" :entry="e" dir="" :depth="0"
                        :show-dotfiles="showDotfiles" :show-gitignored="showGitignored" @open-file="openTreeFile" />
          <div v-if="!rootChildren.length && !files.loading" class="px-3 py-1 text-xs text-fg-muted">{{ $t("files.emptyDirectory") }}</div>
        </div>
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
