<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ChevronRight, File, FileText, Folder, List, X } from "lucide-vue-next";
import { useFilesStore } from "../stores/files";
import { useInstancesStore } from "../stores/instances";
import CopyButton from "./CopyButton.vue";

const props = defineProps<{ instanceId: string | null }>();
const files = useFilesStore();
const instances = useInstancesStore();

const workspaces = computed(() => (props.instanceId ? instances.byId(props.instanceId)?.workspaces ?? [] : []));
const crumbs = computed(() => (files.path ? files.path.split("/") : []));

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

// Line-numbered gutter for the file viewer. Above this many lines we fall back to a
// plain <pre> so we don't emit tens of thousands of DOM nodes for a large file.
const LINE_GUTTER_LIMIT = 5000;
const fileLines = computed(() => {
  const f = files.file;
  if (!f || f.binary) return [];
  return f.content.split("\n");
});

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
// Files show their own porcelain code; directories show a dot if they contain changes.
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
function diffLineClass(line: string): string {
  if (line.startsWith("+") && !line.startsWith("+++")) return "text-run";
  if (line.startsWith("-") && !line.startsWith("---")) return "text-danger";
  if (line.startsWith("@@")) return "text-info";
  if (line.startsWith("diff ") || line.startsWith("index ")) return "text-fg-muted";
  return "text-fg-muted";
}

// When the selected instance changes, reset and load its workspaces, auto-selecting
// the first so the panel is immediately useful.
watch(
  () => props.instanceId,
  async (id) => {
    files.reset();
    searchInput.value = "";
    if (!id) return;
    files.instanceId = id;
    await instances.loadWorkspaces(id).catch(() => {});
    const first = instances.byId(id)?.workspaces?.[0];
    if (first) void files.selectWorkspace(id, first.name);
  },
  { immediate: true },
);

watch(
  () => files.tab,
  (t) => {
    if (t === "changes" && !files.diff) void files.loadDiff();
  },
);

function onWorkspaceChange(e: Event) {
  const name = (e.target as HTMLSelectElement).value;
  searchInput.value = "";
  if (props.instanceId) void files.selectWorkspace(props.instanceId, name);
}
</script>

<template>
  <div class="flex h-full flex-col bg-surface text-sm text-fg-muted">
    <div v-if="!instanceId" class="flex flex-1 items-center justify-center p-4 text-center text-xs text-fg-muted">
      Select a session to browse its workspace
    </div>
    <template v-else>
      <div class="flex items-center gap-2 border-b border-border p-2">
        <select data-test="ws-select" class="min-w-0 flex-1 rounded border border-border bg-bg px-2 py-1 text-xs text-fg" :value="files.workspace ?? ''" @change="onWorkspaceChange">
          <option v-if="!workspaces.length" value="">no workspaces</option>
          <option v-for="w in workspaces" :key="w.name" :value="w.name">{{ w.name }}</option>
        </select>
        <div class="flex shrink-0 items-center gap-1">
          <button data-test="tab-files"
                  class="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11.5px] transition-colors cursor-pointer"
                  :class="files.tab === 'files' ? 'bg-accent/10 text-accent font-semibold' : 'text-fg-muted font-medium hover:bg-raised'"
                  @click="files.tab = 'files'">
            <FileText :size="13" />Files
          </button>
          <button data-test="tab-changes"
                  class="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11.5px] transition-colors cursor-pointer"
                  :class="files.tab === 'changes' ? 'bg-accent/10 text-accent font-semibold' : 'text-fg-muted font-medium hover:bg-raised'"
                  @click="files.tab = 'changes'">
            <List :size="13" />Changes
          </button>
        </div>
      </div>

      <div v-if="files.error" data-test="files-error" class="bg-danger/10 px-2 py-1 text-xs text-danger">{{ files.error }}</div>

      <!-- Files tab -->
      <div v-if="files.tab === 'files'" class="min-h-0 flex-1 overflow-y-auto thin-scroll">
        <!-- search -->
        <div class="flex items-center gap-1 border-b border-border px-2 py-1">
          <input v-model="searchInput" data-test="fs-search" placeholder="Search files by name…"
                 class="min-w-0 flex-1 rounded border border-border bg-bg px-2 py-1 text-xs text-fg placeholder:text-fg-muted" @input="onSearchInput" />
          <button v-if="searchInput" aria-label="Clear search" class="text-fg-muted hover:text-fg" @click="clearSearch"><X :size="14" /></button>
        </div>

        <!-- search results -->
        <div v-if="files.query.trim()" data-test="fs-results">
          <ul class="p-2.5 text-[11px] font-mono leading-5 space-y-px">
            <li v-for="m in files.results" :key="m">
              <button data-test="fs-result"
                      class="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left hover:bg-raised cursor-pointer" @click="files.openFile(m)">
                <File :size="13" class="shrink-0 text-fg-muted" />
                <span class="truncate font-sans text-[12px] text-fg-muted">{{ m }}</span>
              </button>
            </li>
            <li v-if="!files.results.length && !files.searching" class="px-1.5 py-1 text-xs text-fg-muted">no matches</li>
          </ul>
          <div v-if="files.searchTruncated" class="px-2.5 pb-1 text-xs text-warn">showing first 200 matches</div>
          <div v-if="files.file" class="border-t border-border" />
        </div>

        <!-- breadcrumb (hidden while searching) -->
        <div v-if="!files.query.trim()" class="flex flex-wrap items-center gap-1 border-b border-border px-2.5 py-1.5 font-mono text-[11px] text-fg-muted">
          <button class="hover:text-fg" @click="files.up(-1)">{{ files.workspace ?? "root" }}</button>
          <template v-for="(c, i) in crumbs" :key="i">
            <span>/</span><button class="hover:text-fg" @click="files.up(i)">{{ c }}</button>
          </template>
        </div>

        <!-- file viewer -->
        <div v-if="files.file" data-test="file-viewer">
          <div class="flex items-center gap-2 border-b border-border bg-bg px-2.5 py-1.5 text-xs">
            <FileText :size="13" class="shrink-0 text-fg-muted" />
            <span class="truncate font-mono text-fg">{{ files.file.path }}</span>
            <span class="text-fg-muted">{{ fmtSize(files.file.size) }}</span>
            <span v-if="files.file.truncated" class="rounded bg-warn/10 px-1 text-warn">truncated</span>
            <span v-if="files.file.binary" class="rounded bg-fg/5 px-1 text-fg-muted">binary</span>
            <CopyButton v-if="!files.file.binary" :text="files.file.content" class="ml-auto" />
            <button aria-label="Close file" class="text-fg-muted hover:text-fg" @click="files.file = null"><X :size="14" /></button>
          </div>
          <!-- numbered gutter for reasonable files; plain <pre> as a fallback for huge ones -->
          <div v-if="!files.file.binary && fileLines.length <= LINE_GUTTER_LIMIT" data-test="file-body" class="overflow-x-auto font-mono text-xs leading-snug">
            <div v-for="(l, i) in fileLines" :key="i" data-test="file-line" class="flex">
              <span class="sticky left-0 w-12 shrink-0 select-none border-r border-border bg-bg px-2 text-right text-fg-muted tabular-nums">{{ i + 1 }}</span>
              <span class="whitespace-pre px-3 text-fg">{{ l || " " }}</span>
            </div>
          </div>
          <pre v-else-if="!files.file.binary" class="overflow-x-auto p-2 font-mono text-xs leading-snug text-fg whitespace-pre">{{ files.file.content }}</pre>
          <div v-else class="p-3 text-xs text-fg-muted">Binary file not shown.</div>
        </div>

        <!-- directory listing: tree-styled rows (chevron + folder/file icon, accent highlight on changed) -->
        <ul v-else-if="!files.query.trim()" class="p-2.5 text-[11px] font-mono leading-5 space-y-px">
          <li v-for="e in files.entries" :key="e.name">
            <button data-test="fs-entry"
                    class="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left cursor-pointer"
                    :class="entryStatus(e) ? 'bg-accent/10' : 'hover:bg-raised'" @click="files.open(e)">
              <ChevronRight v-if="e.type === 'dir'" :size="11" class="shrink-0 text-fg-muted" />
              <span v-else class="w-[11px] shrink-0" />
              <Folder v-if="e.type === 'dir'" :size="13" class="shrink-0" :class="entryStatus(e) ? 'text-accent' : 'text-fg-muted'" />
              <File v-else :size="13" class="shrink-0" :class="entryStatus(e) ? 'text-accent' : 'text-fg-muted'" />
              <span class="flex-1 truncate font-sans text-[12px]"
                    :class="entryStatus(e) ? 'text-accent font-medium' : (e.type === 'dir' ? 'text-fg font-medium' : 'text-fg-muted')">{{ e.name }}</span>
              <span v-if="entryStatus(e)" data-test="fs-status" class="w-1.5 h-1.5 shrink-0 rounded-full"
                    :class="entryStatus(e)!.dot"
                    :title="`${entryStatus(e)!.label} — ${files.changed[entryRel(e.name)] || 'contains changes'}`" />
              <span v-if="e.type === 'file' && !entryStatus(e)" class="shrink-0 font-mono text-[10.5px] text-fg-muted tabular-nums">{{ fmtSize(e.size) }}</span>
            </button>
          </li>
          <li v-if="!files.entries.length && !files.loading" class="px-1.5 py-1 text-xs text-fg-muted">empty directory</li>
        </ul>
      </div>

      <!-- Changes (git diff) tab -->
      <div v-else class="min-h-0 flex-1 overflow-y-auto thin-scroll">
        <div v-if="files.diff">
          <!-- Changes summary header: N files · +X −Y -->
          <div v-if="changesSummary && !files.diffPath" data-test="changes-summary" class="flex items-center justify-between border-b border-border px-2.5 py-2">
            <span class="text-[10.5px] font-semibold uppercase tracking-wider text-fg-muted">Changes</span>
            <div class="flex items-center gap-1.5 font-mono text-[10.5px] tabular-nums">
              <span class="text-fg-muted">{{ changesSummary.fileCount }} files</span>
              <span class="text-run">+{{ changesSummary.add }}</span>
              <span class="text-danger">−{{ changesSummary.del }}</span>
            </div>
          </div>
          <div v-if="files.diffPath" class="flex items-center gap-2 border-b border-border bg-accent/10 px-2.5 py-1.5 text-xs">
            <FileText :size="13" class="shrink-0 text-accent" />
            <span class="truncate font-mono text-fg">{{ files.diffPath }}</span>
            <button data-test="diff-all" class="ml-auto text-accent hover:underline" @click="files.loadDiff()">← all files</button>
          </div>
          <ul class="border-b border-border p-2.5 space-y-px">
            <li v-for="f in files.diff.files" :key="f.path">
              <button data-test="diff-file" class="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left cursor-pointer"
                      :class="files.diffPath === f.path ? 'bg-accent/10' : 'hover:bg-raised'" @click="files.loadDiff(f.path)">
                <FileText :size="12" class="shrink-0" :class="files.diffPath === f.path ? 'text-accent' : 'text-fg-muted'" />
                <span class="flex-1 truncate font-mono text-[11px]" :class="files.diffPath === f.path ? 'text-accent' : 'text-fg'">{{ f.path }}</span>
                <span class="shrink-0 font-mono text-[10.5px] uppercase tabular-nums" :class="statusBadge(f.status).cls">{{ f.status.trim() || "··" }}</span>
              </button>
            </li>
            <li v-if="!files.diff.files.length" class="px-1.5 py-1 text-xs text-fg-muted">no changes</li>
          </ul>
          <pre v-if="files.diff.diff" data-test="diff-body" class="overflow-x-auto p-2 font-mono text-xs leading-snug whitespace-pre"><span v-for="(l, i) in files.diff.diff.split('\n')" :key="i" class="block" :class="diffLineClass(l)">{{ l }}</span></pre>
          <div v-if="files.diff.truncated" class="px-2.5 py-1 text-xs text-warn">diff truncated</div>
        </div>
        <div v-else-if="!files.loading" class="p-3 text-xs text-fg-muted">no diff loaded</div>
      </div>

      <div v-if="files.loading" class="border-t border-border px-3 py-1 text-xs text-fg-muted">loading…</div>
    </template>
  </div>
</template>
