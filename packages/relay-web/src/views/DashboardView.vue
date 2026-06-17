<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { connectEvents } from "../api/events";
import { useInstancesStore } from "../stores/instances";
import { useChatStore, loadPersistedSelection } from "../stores/chat";
import { useTasksStore } from "../stores/tasks";
import { useNoticesStore } from "../stores/notices";
import { useConnectionStore } from "../stores/connection";
import { useFilesStore } from "../stores/files";
import InstanceTree from "../components/InstanceTree.vue";
import ChatPane from "../components/ChatPane.vue";
import FileViewer from "../components/FileViewer.vue";
import TaskPanel from "../components/TaskPanel.vue";
import FilesPanel from "../components/FilesPanel.vue";
import NoticeToast from "../components/NoticeToast.vue";
import ConnectionBadge from "../components/ConnectionBadge.vue";
import CommandPalette from "../components/CommandPalette.vue";
import BrandLogo from "../components/BrandLogo.vue";
import { useThemeStore } from "../stores/theme";
import { Search, Moon, Sun, Settings, X, Menu, FileText, List, PanelLeftClose, PanelLeftOpen } from "lucide-vue-next";

const theme = useThemeStore();
const instances = useInstancesStore();
const chat = useChatStore();
const files = useFilesStore();
const tasks = useTasksStore();
const notices = useNoticesStore();
const conn = useConnectionStore();
let disconnect: (() => void) | null = null;

// Mobile-only drawer state. On desktop (lg:) both panels are static columns and
// these flags are visually irrelevant because the lg: classes override the transform.
const leftOpen = ref(false);
const rightOpen = ref(false);
const rightTab = ref<"tasks" | "files">("tasks");
function closeDrawers() {
  leftOpen.value = false;
  rightOpen.value = false;
}
function openRight(tab: "tasks" | "files") {
  rightTab.value = tab;
  rightOpen.value = true;
}
// Mobile: "Back" from the file viewer returns to the FILE LIST (reopen the Files drawer),
// not the conversation. Clearing the open file reverts the center to ChatPane underneath.
function backToFileList() {
  closeFileViewer();
  openRight("files");
}

// Desktop-only: collapse the instances sidebar to reclaim width. Persisted so the
// choice survives reloads. (Mobile uses the leftOpen off-canvas drawer instead.)
const leftCollapsed = ref(localStorage.getItem("xacpx.leftCollapsed") === "1");
watch(leftCollapsed, (v) => localStorage.setItem("xacpx.leftCollapsed", v ? "1" : "0"));

// A file/diff opened from the rail takes over the center column (FileViewer); Back
// returns to the conversation. On mobile, opening one also closes the right drawer so
// the viewer is actually visible.
const viewingFile = computed(() => !!(files.file || files.diffPath));
function closeFileViewer() {
  files.file = null;
  files.diffPath = null;
}
watch(viewingFile, (v) => { if (v) rightOpen.value = false; });

// Cmd/Ctrl+K command palette.
const paletteOpen = ref(false);
function onGlobalKey(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    paletteOpen.value = !paletteOpen.value;
  }
}

function onSelect(instanceId: string, alias: string) {
  chat.select(instanceId, alias);
  void chat.loadHistory().catch(() => {});
  leftOpen.value = false; // mobile: jump straight to the conversation
}

let everOnline = false;
async function reloadSnapshot() {
  await instances.loadInstances().catch(() => {});
  await chat.loadActiveTurns().catch(() => {}); // re-seed live HUDs / working dots
  if (chat.instanceId && chat.sessionAlias) {
    await instances.loadSessions(chat.instanceId).catch(() => {});
    await chat.loadHistory().catch(() => {});
    await tasks.loadFor(chat.instanceId, chat.sessionAlias).catch(() => {});
  }
}
function onStatus(online: boolean) {
  conn.setOnline(online);
  if (online) {
    if (everOnline) void reloadSnapshot();
    everOnline = true;
  }
}

onMounted(async () => {
  window.addEventListener("keydown", onGlobalKey);
  await instances.loadInstances();
  disconnect = connectEvents((event) => {
    instances.applyEvent(event);
    chat.applyEvent(event);
    tasks.applyEvent(event);
    notices.applyEvent(event);
  }, onStatus);
  // Re-seed any in-flight turns (sidebar "working" dots + live view) lost on refresh.
  await chat.loadActiveTurns().catch(() => {});
  // Return to the session that was open before the refresh. Gate only on the instance
  // existing (the eager session list may still be loading); loadHistory handles a
  // since-deleted session gracefully by showing an empty pane.
  const prior = loadPersistedSelection();
  if (prior && instances.byId(prior.instanceId)) {
    onSelect(prior.instanceId, prior.alias);
  }
});

onUnmounted(() => {
  window.removeEventListener("keydown", onGlobalKey);
  disconnect?.();
});
</script>

<template>
  <div class="flex h-screen flex-col bg-bg text-fg">
    <!-- Global top bar: brand lockup + connection pill on the left; search, theme, settings on the right. -->
    <header class="sticky top-0 z-30 flex h-11 shrink-0 items-center justify-between border-b border-border bg-surface/80 px-3 backdrop-blur-xl">
      <!-- Left: brand X mark + "xacpx · relay" lockup, then the Connected pill. The
           sidebar collapse control lives in the sidebar's own header (and a slim edge
           handle below), not up here. -->
      <div class="flex items-center gap-2">
        <BrandLogo />
        <ConnectionBadge />
      </div>
      <!-- Right: search button with ⌘K chip, theme toggle, settings. -->
      <div class="flex items-center gap-1.5">
        <button
          data-test="global-search"
          aria-label="Search"
          class="group flex h-7 items-center gap-2 rounded-lg border border-border bg-bg px-2.5 text-left transition-colors hover:border-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent sm:w-64"
          @click="paletteOpen = true"
        >
          <Search :size="14" class="text-fg-muted" />
          <span class="hidden flex-1 text-[12.5px] text-fg-muted sm:inline">Search…</span>
          <kbd class="hidden rounded border border-border bg-raised px-1.5 py-0.5 font-mono text-[10px] text-fg-muted sm:inline">⌘K</kbd>
        </button>
        <button
          data-test="theme-toggle"
          :aria-label="theme.mode === 'dark' ? 'Switch to light' : 'Switch to dark'"
          class="grid h-7 w-7 place-items-center rounded-lg border border-border text-fg-muted transition-colors hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          @click="theme.toggle()"
        >
          <Moon v-if="theme.mode === 'dark'" :size="15" />
          <Sun v-else :size="15" />
        </button>
        <router-link
          to="/settings"
          data-test="settings-link"
          aria-label="Settings"
          class="grid h-7 w-7 place-items-center rounded-lg border border-border text-fg-muted transition-colors hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <Settings :size="15" />
        </router-link>
      </div>
    </header>

    <!-- Mobile top bar: hamburger opens the instance tree, Tasks opens the task panel. -->
    <div class="flex items-center gap-2 border-b border-border bg-surface px-2 py-1.5 lg:hidden">
      <button data-test="open-instances" aria-label="Open instances"
              class="rounded p-1 leading-none text-fg-muted hover:bg-fg/5" @click="leftOpen = true"><Menu :size="20" /></button>
      <span class="min-w-0 flex-1 truncate text-center text-sm font-medium">{{ chat.sessionAlias ?? "xacpx relay" }}</span>
      <div class="flex shrink-0 items-center gap-0.5">
        <button data-test="open-files" aria-label="Open files" title="Files"
                class="grid h-8 w-8 place-items-center rounded text-fg-muted hover:bg-fg/5"
                @click="openRight('files')"><FileText :size="18" /></button>
        <button data-test="open-tasks" aria-label="Open tasks" title="Tasks"
                class="grid h-8 w-8 place-items-center rounded text-fg-muted hover:bg-fg/5"
                @click="openRight('tasks')"><List :size="18" /></button>
      </div>
    </div>

    <div class="flex flex-1 overflow-hidden">
      <!-- Backdrop closes any open drawer (mobile only). -->
      <div v-if="leftOpen || rightOpen" data-test="drawer-backdrop"
           class="fixed inset-0 z-30 bg-black/30 lg:hidden" @click="closeDrawers" />

      <!-- Left: instances. Off-canvas drawer < lg, static column ≥ lg. -->
      <div data-test="column" data-drawer="left"
           class="fixed inset-y-0 left-0 z-40 flex w-72 max-w-[85%] shrink-0 transform flex-col border-r border-border bg-surface shadow-lg transition-[transform,width] lg:static lg:z-auto lg:max-w-none lg:translate-x-0 lg:transform-none lg:shadow-none"
           :class="[leftOpen ? 'translate-x-0' : '-translate-x-full', leftCollapsed ? 'lg:w-0 lg:min-w-0 lg:overflow-hidden lg:border-r-0' : 'lg:w-[248px]']">
        <div class="flex h-9 shrink-0 items-center justify-between px-3 text-xs">
          <span class="font-semibold uppercase tracking-wider text-fg-muted">Instances</span>
          <div class="flex items-center gap-2">
            <button data-test="toggle-left" aria-label="Hide sidebar" title="Hide sidebar"
                    class="hidden h-6 w-6 place-items-center rounded-md text-fg-muted transition-colors hover:bg-raised hover:text-fg lg:grid"
                    @click="leftCollapsed = true"><PanelLeftClose :size="15" /></button>
            <button data-test="close-instances" aria-label="Close instances"
                    class="text-fg-muted hover:text-fg lg:hidden" @click="leftOpen = false"><X :size="18" /></button>
          </div>
        </div>
        <InstanceTree @select="onSelect" />
      </div>

      <!-- Slim edge handle to bring the sidebar back once collapsed (desktop only). -->
      <button v-if="leftCollapsed" data-test="expand-left" aria-label="Show sidebar" title="Show sidebar"
              class="hidden w-5 shrink-0 items-center justify-center border-r border-border bg-surface/60 text-fg-muted transition-colors hover:bg-raised hover:text-fg lg:flex"
              @click="leftCollapsed = false"><PanelLeftOpen :size="15" /></button>

      <!-- Center: chat, always full width of the remaining space. -->
      <!-- min-w-0: let this flex child shrink to its share instead of growing to its
           widest content (a tool card's command/diff line), which would otherwise push
           the right panel off-screen. Wide tool content scrolls/wraps within instead. -->
      <div data-test="column" class="flex min-w-0 flex-1 flex-col">
        <FileViewer v-if="viewingFile" @back="backToFileList" @close="closeFileViewer" />
        <!-- ChatPane stays mounted (v-show, not v-if) while a file is open so the
             conversation's scroll position is preserved on return; `paused` stops its
             auto-scroll while hidden. -->
        <ChatPane v-show="!viewingFile" :paused="viewingFile" @show-files="rightTab = 'files'" />
      </div>

      <!-- Right: tasks. Off-canvas drawer < lg, static column ≥ lg. -->
      <div data-test="column" data-drawer="right"
           class="fixed inset-y-0 right-0 z-40 w-72 max-w-[85%] shrink-0 transform overflow-y-auto border-l border-border bg-surface shadow-lg transition-transform lg:static lg:z-auto lg:w-[296px] lg:max-w-none lg:translate-x-0 lg:transform-none lg:shadow-none"
           :class="rightOpen ? 'translate-x-0' : 'translate-x-full'">
        <div class="flex h-9 items-center gap-1 border-b border-border px-2.5">
          <button data-test="right-tab-files"
                  class="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11.5px] transition-colors cursor-pointer"
                  :class="rightTab === 'files' ? 'bg-accent/10 text-accent font-semibold' : 'text-fg-muted font-medium hover:bg-raised'"
                  @click="rightTab = 'files'">
            <FileText :size="13" />Files
          </button>
          <button data-test="right-tab-tasks"
                  class="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11.5px] transition-colors cursor-pointer"
                  :class="rightTab === 'tasks' ? 'bg-accent/10 text-accent font-semibold' : 'text-fg-muted font-medium hover:bg-raised'"
                  @click="rightTab = 'tasks'">
            <List :size="13" />Tasks
          </button>
          <button data-test="close-tasks" aria-label="Close tasks"
                  class="ml-auto text-fg-muted hover:text-fg lg:hidden" @click="rightOpen = false"><X :size="18" /></button>
        </div>
        <TaskPanel v-if="rightTab === 'tasks'" />
        <FilesPanel v-else :instance-id="chat.instanceId" />
      </div>
    </div>
    <NoticeToast />
    <CommandPalette v-if="paletteOpen"
                    @close="paletteOpen = false"
                    @select-session="(id, alias) => { onSelect(id, alias); paletteOpen = false; }" />
  </div>
</template>
