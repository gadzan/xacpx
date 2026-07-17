<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { ChevronRight, Download, File, FileText, Folder, FolderGit2, GitBranch, List, Loader2, MoreHorizontal, Plus, RefreshCw, Upload, X } from "lucide-vue-next";
import { useFilesStore } from "../stores/files";
import { useGitStore } from "../stores/git";
import { useInstancesStore } from "../stores/instances";
import { useChatStore } from "../stores/chat";
import { useCenterTabsStore, sessionKey } from "../stores/center-tabs";
import { groupChanges, splitPath } from "../lib/change-groups";
import { openMenuKey, ROOT_MENU_KEY } from "../lib/tree-menu";
import { confirm } from "../lib/use-confirm";
import { slugify, uniqueName } from "../lib/session-form";
import { useWorktreeSession } from "../lib/use-worktree-session";
import FileTreeNode from "./FileTreeNode.vue";
import ContextMenu from "./ContextMenu.vue";

// Navigation-only file rail: a file tree (Files) and a changed-files list (Changes).
// Opening a file or a single-file diff shows it full-width in the center column (see
// FileViewer); the rail stays narrow and is just for getting around.
// Local directive: focus + select an element on mount (the rename input).
const vFocus = {
  mounted(el: HTMLInputElement) { el.focus(); el.select(); },
};

const props = defineProps<{ instanceId: string | null }>();
const { t } = useI18n();
const files = useFilesStore();
const git = useGitStore();
const instances = useInstancesStore();
const chat = useChatStore();
const centerTabs = useCenterTabsStore();
const worktreeSession = useWorktreeSession();

// The session whose center tabs a click here should open a tab on — null when no
// session is selected, in which case opening a file/diff from the rail is a no-op.
const currentKey = computed(() =>
  chat.instanceId && chat.sessionAlias ? sessionKey(chat.instanceId, chat.sessionAlias) : null,
);

// dotfile / gitignore toggles for the Files-tab tree, persisted across sessions.
const showDotfiles = ref(localStorage.getItem("xacpx.files.showDotfiles") === "1");
const showGitignored = ref(localStorage.getItem("xacpx.files.showGitignored") === "1");
watch(showDotfiles, (v) => localStorage.setItem("xacpx.files.showDotfiles", v ? "1" : "0"));
watch(showGitignored, (v) => localStorage.setItem("xacpx.files.showGitignored", v ? "1" : "0"));
// Root-layer children, filtered by the same predicate FileTreeNode applies to its own children.
const rootChildren = computed(() => (files.tree[""] ?? []).filter((e) =>
  (!e.ignored || showGitignored.value) && (!e.name.startsWith(".") || showDotfiles.value)));
// Purely local view state for the Changes-tab row highlight — distinct from
// `files.diffPath`, which is the SCOPE of the currently loaded `files.diff` (whole-tree
// vs one file) and must only ever be written by `files.loadDiff()`. Conflating the two
// used to cause `refresh()` to rescope the loaded diff to whatever row was last clicked.
const selectedDiff = ref<string | null>(null);

function openTreeFile(rel: string) {
  selectedDiff.value = null; // clear any Changes-tab row highlight in favor of the freshly opened file
  if (currentKey.value) centerTabs.openFile(currentKey.value, rel);
}

// Root-level "new file / new folder" — the workspace root has no parent tree row to
// right-click, so the workspace-header ⋯ button opens a menu that drops an inline input.
const rootInline = ref<null | "file" | "dir">(null);
const rootName = ref("");
async function submitRoot() {
  const kind = rootInline.value;
  const name = rootName.value.trim();
  rootInline.value = null;
  rootName.value = "";
  if (kind && name) await files.createEntry("", name, kind);
}
const rootMenu = ref<{ x: number; y: number } | null>(null);
function openRootMenu(e: MouseEvent | KeyboardEvent) {
  const r = (e.currentTarget as HTMLElement | null)?.getBoundingClientRect();
  // Anchor under the button; ContextMenu clamps into the viewport if it would overflow.
  rootMenu.value = r ? { x: r.left, y: r.bottom } : { x: 0, y: 0 };
  openMenuKey.value = ROOT_MENU_KEY;
}
function onRootMenuSelect(key: string) {
  if (key === "newFile") rootInline.value = "file";
  else if (key === "newFolder") rootInline.value = "dir";
  rootMenu.value = null;
  if (openMenuKey.value === ROOT_MENU_KEY) openMenuKey.value = null;
}

// Search box placeholder tracks the active mode (name vs content).
const searchPlaceholder = computed(() =>
  files.searchOpts.mode === "content" ? "files.searchContentPlaceholder" : "files.searchPlaceholder");
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

const activeSession = computed(() => {
  const inst = props.instanceId ? instances.byId(props.instanceId) : undefined;
  return inst?.sessions.find((session) => session.alias === chat.sessionAlias);
});
const gitBusy = computed(() => git.operation !== null);
const stagedPaths = computed(() => [...new Set((files.diff?.files ?? [])
  .filter((file) => file.status[0] !== " " && file.status[0] !== "?")
  .map((file) => file.path))]);
const stageablePaths = computed(() => [...new Set((files.diff?.files ?? [])
  .filter((file) => file.status[1] !== " " || file.status === "??")
  .map((file) => file.path))]);
const gitMessage = computed(() => {
  if (git.error) {
    const known: Record<string, string> = {
      "dirty-worktree": t("files.git.errors.dirtyWorktree"),
      "no-upstream": t("files.git.errors.noUpstream"),
      "files-write-disabled": t("files.git.errors.writeDisabled"),
      "invalid-branch-name": t("files.git.errors.invalidBranch"),
      "invalid-start-point": t("files.git.errors.invalidStartPoint"),
      "workspace-name-exists": t("files.git.errors.workspaceExists"),
      "unknown-remote": t("files.git.errors.unknownRemote"),
      "detached-head": t("files.git.errors.detachedHead"),
      "git-operation-in-progress": t("files.git.errors.inProgress"),
    };
    return { ok: false, text: known[git.error] ?? git.error };
  }
  if (git.operation) return { ok: true, text: t(`files.git.running.${git.operation.kind}`) };
  if (git.lastResult?.ok) return { ok: true, text: t(`files.git.done.${git.lastResult.kind}`) };
  return null;
});

const commitMessage = ref("");
const showBranchCreate = ref(false);
const branchName = ref("");
const branchStart = ref("");
const showWorktrees = ref(false);
const showWorktreeCreate = ref(false);
const worktreeBranch = ref("");
const worktreeStart = ref("");
const worktreeWorkspace = ref("");
const worktreeCreateBranch = ref(true);

async function refreshGit(): Promise<void> {
  if (!props.instanceId || !files.workspace) return;
  await Promise.all([git.load(props.instanceId, files.workspace), files.loadDiff()]);
}

async function runGit(action: () => Promise<unknown>): Promise<boolean> {
  const context = { instanceId: props.instanceId, workspace: files.workspace };
  try {
    await action();
    if (props.instanceId === context.instanceId && files.workspace === context.workspace) {
      await files.loadDiff();
    }
    return true;
  } catch {
    return false;
  }
}

async function stage(paths: string[]): Promise<void> {
  if (!props.instanceId || !files.workspace || !paths.length) return;
  await runGit(() => git.stage(props.instanceId!, files.workspace!, paths));
}

async function unstage(paths: string[]): Promise<void> {
  if (!props.instanceId || !files.workspace || !paths.length) return;
  await runGit(() => git.unstage(props.instanceId!, files.workspace!, paths));
}

async function commitStaged(): Promise<void> {
  const message = commitMessage.value.trim();
  if (!props.instanceId || !files.workspace || !message || !stagedPaths.value.length) return;
  if (await runGit(() => git.commit(props.instanceId!, files.workspace!, message))) commitMessage.value = "";
}

async function switchBranch(event: Event): Promise<void> {
  const select = event.target as HTMLSelectElement;
  const branch = select.value;
  if (!props.instanceId || !files.workspace || !branch || branch === git.status?.branch) return;
  if (!await runGit(() => git.checkout(props.instanceId!, files.workspace!, { branch }))) {
    select.value = git.status?.branch ?? "";
  }
}

async function createBranch(): Promise<void> {
  const branch = branchName.value.trim();
  if (!props.instanceId || !files.workspace || !branch) return;
  const ok = await runGit(() => git.checkout(props.instanceId!, files.workspace!, {
    branch,
    create: true,
    ...(branchStart.value.trim() ? { startPoint: branchStart.value.trim() } : {}),
  }));
  if (ok) {
    branchName.value = "";
    branchStart.value = "";
    showBranchCreate.value = false;
  }
}

async function fetchRemote(): Promise<void> {
  if (props.instanceId && files.workspace) await runGit(() => git.fetch(props.instanceId!, files.workspace!));
}

async function pullRemote(): Promise<void> {
  if (props.instanceId && files.workspace) await runGit(() => git.pull(props.instanceId!, files.workspace!));
}

async function pushRemote(): Promise<void> {
  if (!props.instanceId || !files.workspace) return;
  let setUpstream = false;
  if (!git.status?.upstream) {
    setUpstream = await confirm({
      title: t("files.git.pushFirstTitle"),
      message: t("files.git.pushFirstBody", { branch: git.status?.branch ?? "HEAD" }),
      confirmLabel: t("files.git.pushAndTrack"),
      cancelLabel: t("files.cancel"),
    });
    if (!setUpstream) return;
  }
  await runGit(() => git.push(props.instanceId!, files.workspace!, setUpstream ? { setUpstream: true, remote: "origin" } : {}));
}

function beginWorktreeCreate(): void {
  const branch = git.status?.branch ?? "main";
  worktreeBranch.value = "";
  worktreeStart.value = branch;
  const base = slugify(`${files.workspace ?? "workspace"}-worktree`) || "worktree";
  const existing = instances.byId(props.instanceId ?? "")?.workspaces.map((item) => item.name) ?? [];
  worktreeWorkspace.value = uniqueName(base, existing);
  worktreeCreateBranch.value = true;
  showWorktreeCreate.value = true;
}

async function createWorktree(): Promise<void> {
  const id = props.instanceId;
  const workspace = files.workspace;
  const branch = worktreeBranch.value.trim();
  const workspaceName = worktreeWorkspace.value.trim();
  const agent = activeSession.value?.agent;
  if (!id || !workspace || !branch || !workspaceName || !agent) return;
  try {
    const created = await git.createWorktree(id, workspace, {
      workspaceName,
      branch,
      createBranch: worktreeCreateBranch.value,
      ...(worktreeCreateBranch.value && worktreeStart.value.trim() ? { startPoint: worktreeStart.value.trim() } : {}),
    });
    await worktreeSession.open(id, agent, created.workspace.name);
    showWorktreeCreate.value = false;
  } catch {
    // The Git store owns the actionable inline error and operation lifecycle.
  }
}

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

// Client-side windowing: show a first page of results, reveal more on demand — keeps the
// panel snappy instead of dumping every hit (backend still caps + flags `searchTruncated`).
const PAGE = 10;
const visibleCount = ref(PAGE);
// Collapse back to the first page whenever a new result set arrives — covers a new query,
// a mode switch, and any search-option toggle (each re-runs search(), reassigning the arrays).
watch(() => [files.results, files.hits], () => { visibleCount.value = PAGE; });
const visibleHits = computed(() => files.hits.slice(0, visibleCount.value));
const visibleResults = computed(() => files.results.slice(0, visibleCount.value));
const moreHits = computed(() => Math.max(0, files.hits.length - visibleCount.value));
const moreResults = computed(() => Math.max(0, files.results.length - visibleCount.value));
function showMore() { visibleCount.value += PAGE; }

// Highlight the matched query inside a content line. Mirrors the backend matcher
// (regex / matchCase / wholeWord) so highlights line up with what actually matched;
// an invalid regex just yields no highlight (the line still renders).
function buildHighlightRe(): RegExp | null {
  const q = files.query.trim();
  if (!q) return null;
  const o = files.searchOpts;
  let pat = o.regex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (o.wholeWord) pat = `\\b${pat}\\b`;
  try { return new RegExp(pat, "g" + (o.matchCase ? "" : "i")); } catch { return null; }
}
function segments(text: string): { text: string; hit: boolean }[] {
  const re = buildHighlightRe();
  if (!re) return [{ text, hit: false }];
  const out: { text: string; hit: boolean }[] = [];
  let last = 0, guard = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) && guard++ < 2000) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), hit: false });
    const matched = m[0] || "";
    if (matched) out.push({ text: matched, hit: true });
    last = m.index + matched.length;
    if (m.index === re.lastIndex) re.lastIndex++; // guard against a zero-width match looping
  }
  if (last < text.length) out.push({ text: text.slice(last), hit: false });
  return out.length ? out : [{ text, hit: false }];
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

function openSearchResult(m: string, line?: number) {
  selectedDiff.value = null; // clear any Changes-tab row highlight in favor of the freshly opened file
  if (currentKey.value) centerTabs.openFile(currentKey.value, m, line); // line = scroll target for content hits
}
function openDiff(path: string) {
  // Keep the Changes-tab row highlighted without re-fetching (that would rescope the
  // panel's loaded `diff` to this one file and skew the +/- summary counts above the
  // list) — the diff VIEW itself now loads its own content in a center diff tab. The
  // highlight is purely local view state (`selectedDiff`); `files.diffPath` stays
  // untouched here so it keeps meaning "scope of the loaded diff", not "last-clicked row".
  selectedDiff.value = path;
  if (currentKey.value) centerTabs.openDiff(currentKey.value, path);
}

// Follow the instance + active session's workspace. Re-selects (and resets navigation)
// whenever you switch to a session in a different workspace.
watch(
  () => [props.instanceId, activeWorkspace.value] as const,
  async ([id, ws]) => {
    files.reset();
    git.reset();
    searchInput.value = "";
    selectedDiff.value = null;
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
    if (files.tab === "changes") void Promise.all([files.loadDiff(), git.load(id, target)]);
  },
  { immediate: true },
);

watch(
  () => files.tab,
  (t) => {
    if (t === "changes" && files.instanceId && files.workspace) {
      if (!files.diff) void files.loadDiff();
      void git.load(files.instanceId, files.workspace);
    }
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
          <!-- Root-level new file/folder lives here (the workspace root has no tree row). -->
          <button
            data-test="root-menu"
            :title="$t('files.newInRoot')"
            :aria-label="$t('files.newInRoot')"
            class="grid h-6 w-6 place-items-center rounded text-fg-muted transition-colors hover:bg-raised hover:text-fg"
            @click.stop="openRootMenu($event)"
          >
            <MoreHorizontal :size="14" />
          </button>
          <button
            data-test="refresh-files"
            :title="$t('files.refresh')"
            :aria-label="$t('files.refresh')"
            class="grid h-6 w-6 place-items-center rounded text-fg-muted transition-colors hover:bg-raised hover:text-fg disabled:opacity-50"
            :disabled="files.loading"
            @click="files.tab === 'changes' ? refreshGit() : files.refresh()"
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

      <ContextMenu v-if="rootMenu && openMenuKey === ROOT_MENU_KEY" :x="rootMenu.x" :y="rootMenu.y"
                   :items="[{ key: 'newFile', label: $t('files.menu.newFile') }, { key: 'newFolder', label: $t('files.menu.newFolder') }]"
                   @select="onRootMenuSelect" @close="rootMenu = null; openMenuKey = null" />

      <!-- Files tab: pinned search (+ breadcrumb when browsing); only the listing scrolls. -->
      <div v-if="files.tab === 'files'" class="flex min-h-0 flex-1 flex-col">
        <!-- search (pinned): query + match-case/whole-word/regex + include/exclude + name/content mode -->
        <div class="shrink-0 border-b border-border px-2 py-1 space-y-1">
          <div class="flex items-center gap-1">
            <input v-model="searchInput" data-test="fs-search" :placeholder="$t(searchPlaceholder)"
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
            <!-- Each hit: file:line on its own line, then the matched source line below with
                 the query highlighted, wrapped so there's enough context to recognize it. -->
            <ul class="p-2 space-y-1">
              <li v-for="(h, i) in visibleHits" :key="i">
                <button data-test="fs-hit" class="block w-full rounded px-1.5 py-1 text-left hover:bg-raised" @click="openSearchResult(h.path, h.line)">
                  <div class="truncate font-mono text-[10.5px] text-fg-muted/70">{{ h.path }}<span class="text-accent">:{{ h.line }}</span></div>
                  <div class="mt-0.5 whitespace-pre-wrap break-words font-mono text-[11.5px] leading-5 text-fg-muted">
                    <template v-for="(seg, j) in segments(h.text)" :key="j"><span :data-test="seg.hit ? 'hit-mark' : null" :class="seg.hit ? 'rounded-sm bg-warn/30 font-semibold text-fg' : ''">{{ seg.text }}</span></template>
                  </div>
                </button>
              </li>
            </ul>
            <button v-if="moreHits" data-test="fs-more" class="mx-2 mb-1 block rounded px-2 py-1 text-[11px] text-accent hover:bg-raised" @click="showMore">
              {{ $t("files.showMore", { n: Math.min(PAGE, moreHits) }) }}
            </button>
            <div v-else-if="files.searchTruncated" class="px-2.5 pb-1 text-xs text-warn">{{ $t("files.showingFirstMatches") }}</div>
          </template>
          <template v-else>
            <ul class="p-2.5 text-[11px] font-mono leading-5 space-y-px">
              <li v-for="m in visibleResults" :key="m">
                <button data-test="fs-result"
                        class="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left hover:bg-raised cursor-pointer" @click="openSearchResult(m)">
                  <File :size="13" class="shrink-0 text-fg-muted" />
                  <span class="truncate font-sans text-[12px] text-fg-muted">{{ m }}</span>
                </button>
              </li>
              <li v-if="!files.results.length && !files.searching" class="px-1.5 py-1 text-xs text-fg-muted">{{ $t("palette.noMatches") }}</li>
            </ul>
            <button v-if="moreResults" data-test="fs-more" class="mx-2 mb-1 block rounded px-2 py-1 text-[11px] text-accent hover:bg-raised" @click="showMore">
              {{ $t("files.showMore", { n: Math.min(PAGE, moreResults) }) }}
            </button>
            <div v-else-if="files.searchTruncated" class="px-2.5 pb-1 text-xs text-warn">{{ $t("files.showingFirstMatches") }}</div>
          </template>
        </div>

        <!-- browsing: dotfile/gitignore toggles, then the tree scrolls -->
        <template v-else>
        <div class="flex shrink-0 items-center gap-3 border-b border-border px-2.5 py-1 text-[11px] text-fg-muted">
          <label class="flex items-center gap-1 cursor-pointer"><input type="checkbox" data-test="toggle-dotfiles" v-model="showDotfiles" class="accent-accent" />{{ $t("files.toggle.showDotfiles") }}</label>
          <label class="flex items-center gap-1 cursor-pointer"><input type="checkbox" data-test="toggle-gitignored" v-model="showGitignored" class="accent-accent" />{{ $t("files.toggle.showGitignored") }}</label>
        </div>

        <!-- root-level new file/folder: dropped by the workspace-header ⋯ menu (openRootMenu). -->
        <input v-if="rootInline" v-focus data-test="root-inline-name" v-model="rootName"
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
          <!-- Compact Git context and operations (A), with expandable worktree context (C). -->
          <div class="shrink-0 border-b border-border">
            <div data-test="changes-summary" class="flex items-center gap-1.5 px-2.5 pt-2 pb-1">
              <GitBranch :size="12" class="shrink-0 text-accent" />
              <select v-if="git.status?.branch" data-test="git-branch-select" :value="git.status.branch" :disabled="gitBusy"
                      class="min-w-0 max-w-[45%] truncate rounded border border-border bg-bg px-1.5 py-0.5 font-mono text-[11px] font-medium text-fg disabled:opacity-50"
                      @change="switchBranch">
                <option v-for="branch in git.status.branches" :key="branch.name" :value="branch.name"
                        :disabled="!!branch.worktreePath && !branch.current">{{ branch.name }}{{ branch.worktreePath && !branch.current ? ` · ${$t('files.git.inWorktree')}` : '' }}</option>
              </select>
              <span v-else-if="gitCtx?.branch" data-test="changes-branch" class="truncate font-mono text-[11.5px] font-medium text-fg">{{ gitCtx.branch }}</span>
              <span v-else-if="gitCtx?.detached" data-test="changes-branch" class="truncate font-mono text-[11.5px] italic text-fg-muted">{{ $t("files.detached") }}</span>
              <span v-else class="text-[10.5px] font-semibold uppercase tracking-wider text-fg-muted">{{ $t("files.changes") }}</span>
              <span v-if="gitCtx?.worktree?.linked" data-test="worktree-linked"
                    class="shrink-0 rounded-full border border-accent/30 bg-accent/10 px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide text-accent">{{ $t("files.linked") }}</span>
              <span class="flex-1" />
              <button data-test="git-new-branch" :title="$t('files.git.newBranch')" :disabled="gitBusy"
                      class="grid h-6 w-6 place-items-center rounded text-fg-muted hover:bg-raised hover:text-accent disabled:opacity-50"
                      @click="showBranchCreate = !showBranchCreate"><Plus :size="12" /></button>
              <button data-test="git-worktrees-toggle" :title="$t('files.git.worktrees')" :disabled="gitBusy"
                      class="grid h-6 w-6 place-items-center rounded text-fg-muted hover:bg-raised hover:text-accent disabled:opacity-50"
                      @click="showWorktrees = !showWorktrees"><FolderGit2 :size="12" /></button>
              <div v-if="changesSummary" class="flex shrink-0 items-center gap-1.5 font-mono text-[10.5px] tabular-nums">
                <span class="text-fg-muted">{{ changesSummary.fileCount }} {{ $t("files.filesCount") }}</span>
                <span class="text-run">+{{ changesSummary.add }}</span>
                <span class="text-danger">−{{ changesSummary.del }}</span>
              </div>
            </div>
            <div v-if="showBranchCreate" data-test="git-branch-create" class="mx-2.5 mb-1.5 space-y-1 rounded border border-border bg-bg p-1.5">
              <input v-model="branchName" data-test="git-new-branch-name" :placeholder="$t('files.git.branchName')"
                     class="w-full rounded border border-border bg-surface px-2 py-1 text-[11px] text-fg" />
              <div class="flex gap-1">
                <input v-model="branchStart" :placeholder="$t('files.git.startPoint')"
                       class="min-w-0 flex-1 rounded border border-border bg-surface px-2 py-1 text-[11px] text-fg" />
                <button data-test="git-create-branch" :disabled="gitBusy || !branchName.trim()"
                        class="rounded bg-accent px-2 py-1 text-[11px] font-medium text-white disabled:opacity-50" @click="createBranch">{{ $t("files.git.create") }}</button>
              </div>
            </div>
            <div class="flex items-center gap-1 px-2.5 pb-1 text-[10.5px]">
              <span class="min-w-0 flex-1 truncate font-mono text-fg-muted" :title="git.status?.upstream">
                {{ git.status?.upstream ?? $t("files.git.noUpstream") }}
                <template v-if="git.status?.ahead || git.status?.behind"> · ↑{{ git.status.ahead }} ↓{{ git.status.behind }}</template>
              </span>
              <button data-test="git-fetch" :disabled="gitBusy" class="rounded px-1.5 py-0.5 text-fg-muted hover:bg-raised hover:text-fg disabled:opacity-50" @click="fetchRemote">{{ $t("files.git.fetch") }}</button>
              <button data-test="git-pull" :disabled="gitBusy" class="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-fg-muted hover:bg-raised hover:text-fg disabled:opacity-50" @click="pullRemote"><Download :size="10" />{{ $t("files.git.pull") }}</button>
              <button data-test="git-push" :disabled="gitBusy" class="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-fg-muted hover:bg-raised hover:text-fg disabled:opacity-50" @click="pushRemote"><Upload :size="10" />{{ $t("files.git.push") }}</button>
            </div>
            <div v-if="showWorktrees" data-test="git-worktrees" class="border-t border-border/70 px-2.5 py-1.5 text-[10.5px]">
              <div v-for="tree in git.status?.worktrees ?? []" :key="tree.path" class="flex items-center gap-1.5 py-0.5">
                <FolderGit2 :size="10" :class="tree.current ? 'text-accent' : 'text-fg-muted'" />
                <span class="shrink-0 font-mono text-fg">{{ tree.branch ?? $t("files.detached") }}</span>
                <span class="min-w-0 flex-1 truncate font-mono text-fg-muted" :title="tree.path">{{ tree.path }}</span>
              </div>
              <button data-test="git-new-worktree" class="mt-1 inline-flex items-center gap-1 rounded px-1.5 py-1 text-accent hover:bg-accent/10" @click="beginWorktreeCreate"><Plus :size="10" />{{ $t("files.git.newWorktree") }}</button>
              <div v-if="showWorktreeCreate" data-test="git-worktree-create" class="mt-1 space-y-1 rounded border border-border bg-bg p-1.5">
                <label class="flex items-center gap-1"><input v-model="worktreeCreateBranch" type="checkbox" class="accent-accent" />{{ $t("files.git.createBranch") }}</label>
                <input v-model="worktreeBranch" data-test="git-worktree-branch" :placeholder="$t('files.git.branchName')" class="w-full rounded border border-border bg-surface px-2 py-1 text-fg" />
                <input v-model="worktreeWorkspace" data-test="git-worktree-workspace" :placeholder="$t('files.git.workspaceName')" class="w-full rounded border border-border bg-surface px-2 py-1 text-fg" />
                <input v-if="worktreeCreateBranch" v-model="worktreeStart" :placeholder="$t('files.git.startPoint')" class="w-full rounded border border-border bg-surface px-2 py-1 text-fg" />
                <button data-test="git-create-worktree" :disabled="gitBusy || !worktreeBranch.trim() || !worktreeWorkspace.trim() || !activeSession?.agent"
                        class="rounded bg-accent px-2 py-1 font-medium text-white disabled:opacity-50" @click="createWorktree">{{ $t("files.git.createAndOpen") }}</button>
              </div>
            </div>
            <div v-if="gitCtx?.worktree" data-test="worktree-path" class="flex items-center gap-1.5 px-2.5 pb-2 text-[10px] text-fg-muted" :title="`${$t('files.worktree')}: ${gitCtx.worktree.root}`">
              <FolderGit2 :size="11" class="shrink-0 opacity-70" />
              <span class="truncate font-mono" dir="rtl">{{ gitCtx.worktree.root }}</span>
            </div>
            <div v-if="gitMessage" data-test="git-operation-message" class="flex items-center gap-1 border-t border-border/70 px-2.5 py-1 text-[10.5px]" :class="gitMessage.ok ? 'text-fg-muted' : 'bg-danger/10 text-danger'">
              <Loader2 v-if="git.operation" :size="10" class="animate-spin motion-reduce:animate-none" />
              <span class="break-all">{{ gitMessage.text }}</span>
            </div>
          </div>
          <div class="min-h-0 flex-1 overflow-y-auto thin-scroll p-2.5 space-y-2">
            <div v-for="s in changeSections" :key="s.key" data-test="change-group">
              <div class="flex items-center">
                <button class="flex min-w-0 flex-1 items-center gap-1.5 px-1 py-0.5 text-[10.5px] font-semibold uppercase tracking-wider text-fg-muted transition-colors hover:text-fg"
                        @click="toggleGroup(s.key)">
                  <ChevronRight :size="11" class="shrink-0 transition-transform" :class="collapsed[s.key] ? '' : 'rotate-90'" />
                  <span>{{ $t(`files.${s.key}`) }}</span>
                  <span class="text-fg-muted/60">{{ s.items.length }}</span>
                </button>
                <button v-if="s.key !== 'staged'" data-test="git-stage-group" :disabled="gitBusy"
                        class="rounded px-1 py-0.5 text-[10px] text-accent hover:bg-accent/10 disabled:opacity-50"
                        @click="stage(s.items.map((item) => item.path))">{{ $t("files.git.stageAll") }}</button>
              </div>
              <ul v-show="!collapsed[s.key]" class="space-y-px pt-0.5">
                <li v-for="f in s.items" :key="f.path" class="group flex items-center">
                  <button data-test="diff-file" :title="f.path"
                          class="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-left cursor-pointer"
                          :class="selectedDiff === f.path ? 'bg-accent/10' : 'hover:bg-raised'" @click="openDiff(f.path)">
                    <span class="w-3 shrink-0 text-center font-mono text-[10.5px] uppercase" :class="statusBadge(f.status).cls">{{ statusBadge(f.status).label }}</span>
                    <span class="flex min-w-0 flex-1 items-baseline truncate font-mono text-[11px]">
                      <span v-if="splitPath(f.path).dir" class="truncate text-fg-muted/70">{{ splitPath(f.path).dir }}</span>
                      <span class="shrink-0" :class="selectedDiff === f.path ? 'text-accent' : 'text-fg'">{{ splitPath(f.path).name }}</span>
                    </span>
                  </button>
                  <button v-if="s.key === 'staged'" :data-test="`git-unstage-${f.path}`" :title="$t('files.git.unstage')" :disabled="gitBusy"
                          class="shrink-0 rounded px-1 py-0.5 text-[10px] text-fg-muted opacity-70 hover:bg-raised hover:text-fg group-hover:opacity-100 disabled:opacity-30"
                          @click.stop="unstage([f.path])">−</button>
                  <button v-else :data-test="`git-stage-${f.path}`" :title="$t('files.git.stage')" :disabled="gitBusy"
                          class="shrink-0 rounded px-1 py-0.5 text-[10px] text-fg-muted opacity-70 hover:bg-raised hover:text-accent group-hover:opacity-100 disabled:opacity-30"
                          @click.stop="stage([f.path])">+</button>
                </li>
              </ul>
            </div>
            <div v-if="!changeSections.length" class="px-1.5 py-1 text-xs text-fg-muted">{{ $t("files.noChanges") }}</div>
          </div>
          <div class="shrink-0 border-t border-border bg-surface p-2">
            <textarea v-model="commitMessage" data-test="git-commit-message" rows="2" :placeholder="$t('files.git.commitPlaceholder')"
                      class="w-full resize-none rounded border border-border bg-bg px-2 py-1.5 text-[11.5px] text-fg placeholder:text-fg-muted disabled:opacity-50"
                      :disabled="gitBusy" @keydown.meta.enter.prevent="commitStaged" @keydown.ctrl.enter.prevent="commitStaged" />
            <div class="mt-1 flex items-center gap-1.5">
              <span class="min-w-0 flex-1 truncate text-[10px] text-fg-muted">{{ $t("files.git.commitStaged", { n: stagedPaths.length }) }}</span>
              <button v-if="stageablePaths.length" data-test="git-stage-all" :disabled="gitBusy"
                      class="rounded px-2 py-1 text-[10.5px] text-accent hover:bg-accent/10 disabled:opacity-50" @click="stage(stageablePaths)">{{ $t("files.git.stageAll") }}</button>
              <button data-test="git-commit" :disabled="gitBusy || !commitMessage.trim() || !stagedPaths.length"
                      class="rounded bg-accent px-2.5 py-1 text-[10.5px] font-semibold text-white disabled:opacity-40" @click="commitStaged">{{ $t("files.git.commit") }}</button>
            </div>
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
