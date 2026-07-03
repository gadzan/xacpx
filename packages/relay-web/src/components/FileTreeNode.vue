<script setup lang="ts">
import { computed, ref } from "vue";
import { ChevronRight, ChevronDown, Folder, FolderOpen } from "lucide-vue-next";
import type { FsEntryDto } from "@ganglion/xacpx-relay-protocol";
import { useFilesStore } from "../stores/files";
import { iconForFile } from "../lib/file-icons";
import ContextMenu from "./ContextMenu.vue";

const props = defineProps<{ entry: FsEntryDto; dir: string; depth: number; showDotfiles: boolean; showGitignored: boolean }>();
const emit = defineEmits<{ openFile: [rel: string] }>();
const files = useFilesStore();

const rel = computed(() => (props.dir ? `${props.dir}/${props.entry.name}` : props.entry.name));
const isDir = computed(() => props.entry.type === "dir");
const isDot = computed(() => props.entry.name.startsWith("."));
const dim = computed(() => isDot.value || props.entry.ignored === true);
const isOpen = computed(() => files.expanded.has(rel.value));
const children = computed(() => files.tree[rel.value] ?? []);

// A child is visible when it passes both toggles.
function visible(e: FsEntryDto): boolean {
  if (e.ignored && !props.showGitignored) return false;
  if (e.name.startsWith(".") && !props.showDotfiles) return false;
  return true;
}
const visibleChildren = computed(() => children.value.filter(visible));
const selfVisible = computed(() => visible(props.entry));

// Git-status dot: a file gets its own porcelain status color; a dir gets a generic
// dot if any changed path lives under it. Mirrors the old FilesPanel `statusBadge` colors.
const gitDot = computed<string | null>(() => {
  if (props.entry.type === "file") {
    const code = files.changed[rel.value];
    return code ? dotClass(code) : null;
  }
  const prefix = rel.value + "/";
  return Object.keys(files.changed).some((p) => p.startsWith(prefix)) ? "bg-warn" : null;
});
function dotClass(code: string): string {
  const c = code.trim();
  if (c.includes("?")) return "bg-warn";
  if (c.includes("A")) return "bg-run";
  if (c.includes("D")) return "bg-danger";
  if (c.includes("R")) return "bg-accent";
  if (c.includes("M")) return "bg-warn";
  return "bg-warn";
}

function onRowClick() {
  if (isDir.value) void files.toggleExpand(rel.value);
  else emit("openFile", rel.value);
}

// context menu (items are built inline in the template via i18n — see :items below)
const menu = ref<{ x: number; y: number } | null>(null);
function openMenu(e: MouseEvent) { menu.value = { x: e.clientX, y: e.clientY }; }
async function onMenuSelect(key: string) {
  if (key === "copyPath") await navigator.clipboard?.writeText(files.absPath(rel.value)).catch(() => {});
  else if (key === "copyRelativePath") await navigator.clipboard?.writeText(rel.value).catch(() => {});
  else if (key === "searchInFolder") { files.searchOpts.path = rel.value; }
  menu.value = null;
}
</script>

<template>
  <div v-if="selfVisible">
    <button data-test="tree-row"
            class="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left hover:bg-raised"
            :style="{ paddingLeft: depth * 12 + 4 + 'px' }"
            @click="onRowClick" @contextmenu.prevent="openMenu">
      <component :is="isOpen ? ChevronDown : ChevronRight" v-if="isDir" :size="12" class="shrink-0 text-fg-muted" />
      <span v-else class="w-3 shrink-0" />
      <component :is="isDir ? (isOpen ? FolderOpen : Folder) : iconForFile(entry.name)" :size="13"
                 class="shrink-0" :class="isDir ? 'text-warn' : 'text-fg-muted'" />
      <span class="flex-1 truncate text-[12px]" :class="[dim ? 'opacity-45 italic' : '', isDir ? 'text-fg font-medium' : 'text-fg-muted']">{{ entry.name }}</span>
      <span v-if="gitDot" data-test="fs-status" class="ml-auto h-1.5 w-1.5 shrink-0 rounded-full" :class="gitDot"
            :title="entry.type === 'file' ? (files.changed[rel] || '') : $t('files.containsChanges')" />
    </button>

    <div v-if="isDir && isOpen">
      <FileTreeNode v-for="c in visibleChildren" :key="c.name" :entry="c" :dir="rel" :depth="depth + 1"
                    :show-dotfiles="showDotfiles" :show-gitignored="showGitignored" @open-file="emit('openFile', $event)" />
      <div v-if="!visibleChildren.length && files.tree[rel]" class="py-0.5 text-[11px] text-fg-muted" :style="{ paddingLeft: (depth + 1) * 12 + 16 + 'px' }">{{ $t("files.tree.emptyFolder") }}</div>
    </div>

    <ContextMenu v-if="menu" :x="menu.x" :y="menu.y"
                 :items="isDir
                   ? [{ key: 'copyPath', label: $t('files.menu.copyPath') }, { key: 'copyRelativePath', label: $t('files.menu.copyRelativePath') }, { key: 'searchInFolder', label: $t('files.menu.searchInFolder') }]
                   : [{ key: 'copyPath', label: $t('files.menu.copyPath') }, { key: 'copyRelativePath', label: $t('files.menu.copyRelativePath') }]"
                 @select="onMenuSelect" @close="menu = null" />
  </div>
</template>
