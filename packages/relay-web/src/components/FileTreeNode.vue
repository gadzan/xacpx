<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { ChevronRight, ChevronDown, Folder, FolderOpen, MoreHorizontal } from "lucide-vue-next";
import type { FsEntryDto } from "@ganglion/xacpx-relay-protocol";
import { useFilesStore } from "../stores/files";
import { iconForFile } from "../lib/file-icons";
import { openMenuKey } from "../lib/tree-menu";
import ContextMenu from "./ContextMenu.vue";

// Local directive: focus + select an element on mount (the rename input).
const vFocus = {
  mounted(el: HTMLInputElement) { el.focus(); el.select(); },
};

const props = defineProps<{ entry: FsEntryDto; dir: string; depth: number; showDotfiles: boolean; showGitignored: boolean }>();
const emit = defineEmits<{ openFile: [rel: string] }>();
const files = useFilesStore();
const { t } = useI18n();

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

// context menu (items are built inline in the template via i18n — see :items below).
// `openMenuKey` (shared across all rows + the root header) enforces one menu at a time:
// this row's menu renders only while it's the active key, so opening another closes ours.
const menu = ref<{ x: number; y: number } | null>(null);
function openMenu(e: MouseEvent) {
  // Right-click / mouse-click gives real coords; keyboard-activating the ⋯ button yields a
  // click with clientX/Y = 0, so fall back to the trigger's rect to place the menu.
  let x = e.clientX, y = e.clientY;
  if (!x && !y) {
    const r = (e.currentTarget as HTMLElement | null)?.getBoundingClientRect();
    if (r) { x = r.left; y = r.bottom; }
  }
  menu.value = { x, y };
  openMenuKey.value = rel.value;
}
function closeMenu() { menu.value = null; if (openMenuKey.value === rel.value) openMenuKey.value = null; }

// "Search in this folder" fills the visible include field with a glob scoping the search
// to this folder (VSCode-style) — the backend matches `include` as a glob (**, *, ?), not
// a regex, so `<folder>/**` is what actually restricts results to the subtree. No hidden scope.
function folderIncludeGlob(p: string): string {
  return `${p}/**`;
}

// inline create/rename input
const inlineMode = ref<null | { kind: "file" | "dir" | "rename" }>(null);
const inlineName = ref("");
function startCreate(kind: "file" | "dir") {
  if (!files.expanded.has(rel.value)) void files.toggleExpand(rel.value); // ensure open
  inlineMode.value = { kind };
  inlineName.value = "";
}
function startRename() {
  inlineMode.value = { kind: "rename" };
  inlineName.value = props.entry.name;
}
async function submitInline() {
  const m = inlineMode.value;
  const name = inlineName.value.trim();
  inlineMode.value = null;
  if (!m || !name) return;
  if (m.kind === "rename") await files.renameEntry(rel.value, name);
  else await files.createEntry(rel.value, name, m.kind); // create INSIDE this folder
}
function cancelInline() { inlineMode.value = null; }

async function onMenuSelect(key: string) {
  if (key === "copyPath") await navigator.clipboard?.writeText(files.absPath(rel.value)).catch(() => {});
  else if (key === "copyRelativePath") await navigator.clipboard?.writeText(rel.value).catch(() => {});
  else if (key === "searchInFolder") { files.searchOpts.include = folderIncludeGlob(rel.value); }
  else if (key === "newFile") startCreate("file");
  else if (key === "newFolder") startCreate("dir");
  else if (key === "rename") startRename();
  else if (key === "download") await files.downloadEntry(rel.value);
  else if (key === "delete") {
    if (window.confirm(t("files.menu.confirmDelete", { name: props.entry.name }))) await files.deleteEntry(rel.value);
  }
  closeMenu();
}
</script>

<template>
  <div v-if="selfVisible">
    <!-- Row = clickable label button + a sibling ⋯ button + status dot. The ⋯ is a real
         button (not nested in the row button) so it's keyboard-activatable and valid ARIA. -->
    <div class="flex w-full items-center rounded pr-1 hover:bg-raised">
      <button data-test="tree-row"
              class="flex min-w-0 flex-1 items-center gap-1 py-0.5 pl-1 text-left"
              :style="{ paddingLeft: depth * 12 + 4 + 'px' }"
              @click="onRowClick" @contextmenu.prevent="openMenu">
        <component :is="isOpen ? ChevronDown : ChevronRight" v-if="isDir" :size="12" class="shrink-0 text-fg-muted" />
        <span v-else class="w-3 shrink-0" />
        <component :is="isDir ? (isOpen ? FolderOpen : Folder) : iconForFile(entry.name)" :size="13"
                   class="shrink-0" :class="isDir ? 'text-warn' : 'text-fg-muted'" />
        <span v-if="inlineMode?.kind !== 'rename'" class="flex-1 truncate text-[12px]" :class="[dim ? 'opacity-45 italic' : '', isDir ? 'text-fg font-medium' : 'text-fg-muted']">{{ entry.name }}</span>
        <!-- rename: replace the label with an input in-place -->
        <input v-else v-focus data-test="inline-name" v-model="inlineName" @click.stop
               @keyup.enter="submitInline" @keyup.esc="cancelInline" @blur="cancelInline"
               class="flex-1 rounded border border-border bg-raised px-1 text-[12px]" />
      </button>
      <span v-if="gitDot" data-test="fs-status" class="ml-1 h-1.5 w-1.5 shrink-0 rounded-full" :class="gitDot"
            :title="entry.type === 'file' ? (files.changed[rel] || '') : $t('files.containsChanges')" />
      <!-- Always-visible ⋯ trigger, pinned at the far right: opens the same context menu, so
           touch devices (no right-click) can reach every action. -->
      <button data-test="row-menu" type="button" :aria-label="$t('files.menu.more')"
              class="ml-1 grid h-5 w-5 shrink-0 place-items-center rounded text-fg-muted opacity-60 hover:bg-surface hover:text-fg hover:opacity-100"
              @click.stop="openMenu($event)">
        <MoreHorizontal :size="13" />
      </button>
    </div>

    <div v-if="isDir && isOpen">
      <!-- create: new-name input at top of the expanded children -->
      <input v-if="inlineMode && inlineMode.kind !== 'rename'" v-focus data-test="inline-name" v-model="inlineName" @click.stop
             @keyup.enter="submitInline" @keyup.esc="cancelInline" @blur="cancelInline"
             :style="{ marginLeft: (depth + 1) * 12 + 16 + 'px' }"
             class="my-0.5 rounded border border-border bg-raised px-1 text-[12px]" />
      <FileTreeNode v-for="c in visibleChildren" :key="c.name" :entry="c" :dir="rel" :depth="depth + 1"
                    :show-dotfiles="showDotfiles" :show-gitignored="showGitignored" @open-file="emit('openFile', $event)" />
      <div v-if="!visibleChildren.length && files.tree[rel]" class="py-0.5 text-[11px] text-fg-muted" :style="{ paddingLeft: (depth + 1) * 12 + 16 + 'px' }">{{ $t("files.tree.emptyFolder") }}</div>
    </div>

    <ContextMenu v-if="menu && openMenuKey === rel" :x="menu.x" :y="menu.y"
                 :items="isDir
                   ? [{ key: 'newFile', label: $t('files.menu.newFile') }, { key: 'newFolder', label: $t('files.menu.newFolder') },
                      { key: 'rename', label: $t('files.menu.rename') },
                      { key: 'delete', label: $t('files.menu.delete') },
                      { key: 'copyPath', label: $t('files.menu.copyPath') }, { key: 'copyRelativePath', label: $t('files.menu.copyRelativePath') },
                      { key: 'searchInFolder', label: $t('files.menu.searchInFolder') }]
                   : [{ key: 'rename', label: $t('files.menu.rename') },
                      { key: 'delete', label: $t('files.menu.delete') }, { key: 'download', label: $t('files.menu.download') },
                      { key: 'copyPath', label: $t('files.menu.copyPath') }, { key: 'copyRelativePath', label: $t('files.menu.copyRelativePath') }]"
                 @select="onMenuSelect" @close="closeMenu" />
  </div>
</template>
