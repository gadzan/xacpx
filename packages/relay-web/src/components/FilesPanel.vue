<script setup lang="ts">
import { computed, watch } from "vue";
import { useFilesStore } from "../stores/files";
import { useInstancesStore } from "../stores/instances";

const props = defineProps<{ instanceId: string | null }>();
const files = useFilesStore();
const instances = useInstancesStore();

const workspaces = computed(() => (props.instanceId ? instances.byId(props.instanceId)?.workspaces ?? [] : []));
const crumbs = computed(() => (files.path ? files.path.split("/") : []));

// Format a byte size compactly.
function fmtSize(n?: number): string {
  if (n === undefined) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
function diffLineClass(line: string): string {
  if (line.startsWith("+") && !line.startsWith("+++")) return "text-green-600";
  if (line.startsWith("-") && !line.startsWith("---")) return "text-red-600";
  if (line.startsWith("@@")) return "text-sky-600";
  if (line.startsWith("diff ") || line.startsWith("index ")) return "text-slate-400";
  return "text-slate-600";
}

// When the selected instance changes, reset and load its workspaces, auto-selecting
// the first so the panel is immediately useful.
watch(
  () => props.instanceId,
  async (id) => {
    files.reset();
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
  if (props.instanceId) void files.selectWorkspace(props.instanceId, name);
}
</script>

<template>
  <div class="flex h-full flex-col text-sm">
    <div v-if="!instanceId" class="flex flex-1 items-center justify-center p-4 text-center text-xs text-slate-400">
      Select a session to browse its workspace
    </div>
    <template v-else>
      <div class="flex items-center gap-2 border-b p-2">
        <select data-test="ws-select" class="min-w-0 flex-1 rounded border px-2 py-1 text-xs" :value="files.workspace ?? ''" @change="onWorkspaceChange">
          <option v-if="!workspaces.length" value="">no workspaces</option>
          <option v-for="w in workspaces" :key="w.name" :value="w.name">{{ w.name }}</option>
        </select>
        <div class="flex shrink-0 overflow-hidden rounded border text-xs">
          <button data-test="tab-files" class="px-2 py-1" :class="files.tab === 'files' ? 'bg-sky-500 text-white' : 'text-slate-500'" @click="files.tab = 'files'">Files</button>
          <button data-test="tab-changes" class="px-2 py-1" :class="files.tab === 'changes' ? 'bg-sky-500 text-white' : 'text-slate-500'" @click="files.tab = 'changes'">Changes</button>
        </div>
      </div>

      <div v-if="files.error" data-test="files-error" class="bg-red-50 px-2 py-1 text-xs text-red-700">{{ files.error }}</div>

      <!-- Files tab -->
      <div v-if="files.tab === 'files'" class="min-h-0 flex-1 overflow-y-auto">
        <!-- breadcrumb -->
        <div class="flex flex-wrap items-center gap-1 border-b px-2 py-1 text-xs text-slate-500">
          <button class="hover:underline" @click="files.up(-1)">{{ files.workspace ?? "root" }}</button>
          <template v-for="(c, i) in crumbs" :key="i">
            <span>/</span><button class="hover:underline" @click="files.up(i)">{{ c }}</button>
          </template>
        </div>

        <!-- file viewer -->
        <div v-if="files.file" data-test="file-viewer">
          <div class="flex items-center gap-2 border-b bg-slate-50 px-2 py-1 text-xs">
            <span class="truncate font-mono text-slate-700">{{ files.file.path }}</span>
            <span class="text-slate-400">{{ fmtSize(files.file.size) }}</span>
            <span v-if="files.file.truncated" class="rounded bg-amber-100 px-1 text-amber-700">truncated</span>
            <span v-if="files.file.binary" class="rounded bg-slate-200 px-1 text-slate-600">binary</span>
            <button class="ml-auto text-slate-400 hover:text-slate-700" @click="files.file = null">✕</button>
          </div>
          <pre v-if="!files.file.binary" class="overflow-x-auto p-2 font-mono text-xs leading-snug text-slate-700 whitespace-pre">{{ files.file.content }}</pre>
          <div v-else class="p-3 text-xs text-slate-400">Binary file not shown.</div>
        </div>

        <!-- directory listing -->
        <ul v-else>
          <li v-for="e in files.entries" :key="e.name">
            <button data-test="fs-entry" class="flex w-full items-center gap-2 px-3 py-1 text-left hover:bg-slate-50" @click="files.open(e)">
              <span>{{ e.type === "dir" ? "📁" : "📄" }}</span>
              <span class="truncate" :class="e.type === 'dir' ? 'text-slate-700' : 'text-slate-600'">{{ e.name }}</span>
              <span v-if="e.type === 'file'" class="ml-auto text-xs text-slate-400">{{ fmtSize(e.size) }}</span>
            </button>
          </li>
          <li v-if="!files.entries.length && !files.loading" class="px-3 py-2 text-xs text-slate-400">empty directory</li>
        </ul>
      </div>

      <!-- Changes (git diff) tab -->
      <div v-else class="min-h-0 flex-1 overflow-y-auto">
        <div v-if="files.diff">
          <ul class="border-b text-xs">
            <li v-for="f in files.diff.files" :key="f.path" data-test="diff-file" class="flex items-center gap-2 px-3 py-1">
              <span class="w-6 font-mono text-slate-400">{{ f.status.trim() || "··" }}</span>
              <span class="truncate font-mono text-slate-700">{{ f.path }}</span>
            </li>
            <li v-if="!files.diff.files.length" class="px-3 py-2 text-slate-400">no changes</li>
          </ul>
          <pre v-if="files.diff.diff" data-test="diff-body" class="overflow-x-auto p-2 font-mono text-xs leading-snug whitespace-pre"><span v-for="(l, i) in files.diff.diff.split('\n')" :key="i" class="block" :class="diffLineClass(l)">{{ l }}</span></pre>
          <div v-if="files.diff.truncated" class="px-3 py-1 text-xs text-amber-600">diff truncated</div>
        </div>
        <div v-else-if="!files.loading" class="p-3 text-xs text-slate-400">no diff loaded</div>
      </div>

      <div v-if="files.loading" class="border-t px-3 py-1 text-xs text-slate-400">loading…</div>
    </template>
  </div>
</template>
