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
import ActionToast from "../components/ActionToast.vue";
import ConnectionBadge from "../components/ConnectionBadge.vue";
import CommandPalette from "../components/CommandPalette.vue";
import BrandLogo from "../components/BrandLogo.vue";
import { useThemeStore } from "../stores/theme";
import { createEdgeSwipe } from "../lib/edge-swipe";
import { clampPanelWidth, createPanelResize } from "../lib/resize-panel";
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

// Mobile edge-swipe drawers: from the left edge swipe right to open instances,
// from the right edge swipe left to open tasks/files; when a drawer is open a
// swipe back toward its edge closes it. Inert on lg+ (static columns).
const swipe = createEdgeSwipe({
  // < 1024px = the Tailwind `lg` boundary at which the drawers stop being
  // off-canvas. innerWidth ≥ the CSS viewport width (it includes a classic
  // scrollbar), so we never disable while the layout is still off-canvas.
  isEnabled: () => typeof window !== "undefined" && window.innerWidth < 1024,
  isLeftOpen: () => leftOpen.value,
  isRightOpen: () => rightOpen.value,
  openLeft: () => { leftOpen.value = true; },
  openRight: () => { rightOpen.value = true; }, // keeps the last-used right tab
  closeLeft: () => { leftOpen.value = false; },
  closeRight: () => { rightOpen.value = false; },
});
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

// Desktop-only: drag the right panel's left edge to resize it. Mobile keeps the
// fixed-width off-canvas drawer, so `isDesktop` gates both the handle and the
// inline width (an inline width would otherwise override the mobile `w-72`).
const RIGHT_MIN = 240;
const RIGHT_MAX = 560;
const RIGHT_DEFAULT = 296;
const RIGHT_VIEWPORT_FRACTION = 0.5;
// `matchMedia` is absent in some test/embedded runtimes; treat its absence as
// "not desktop" so the resize handle and inline width simply don't engage.
function queryDesktop(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    && window.matchMedia("(min-width: 1024px)").matches;
}
const isDesktop = ref(queryDesktop());
const rightWidth = ref(clampPanelWidth(
  Number(localStorage.getItem("xacpx.rightWidth")) || RIGHT_DEFAULT,
  RIGHT_MIN, RIGHT_MAX,
  typeof window !== "undefined" ? window.innerWidth : undefined, RIGHT_VIEWPORT_FRACTION));
const rightDragging = ref(false);
watch(rightWidth, (v) => localStorage.setItem("xacpx.rightWidth", String(v)));

const rightResize = createPanelResize({
  side: "right",
  getWidth: () => rightWidth.value,
  setWidth: (w) => { rightWidth.value = w; },
  min: RIGHT_MIN,
  max: RIGHT_MAX,
  maxViewportFraction: RIGHT_VIEWPORT_FRACTION,
  isEnabled: () => isDesktop.value,
  // Lock the cursor + suppress text selection for the whole document while
  // dragging, so a fast drag that outruns the thin handle still feels solid.
  onDragStart: () => {
    rightDragging.value = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  },
  onDragEnd: () => {
    rightDragging.value = false;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  },
});

let desktopMql: MediaQueryList | null = null;
function onDesktopChange(e: MediaQueryListEvent | MediaQueryList) {
  isDesktop.value = e.matches;
}

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
  if (typeof window.matchMedia === "function") {
    desktopMql = window.matchMedia("(min-width: 1024px)");
    isDesktop.value = desktopMql.matches;
    desktopMql.addEventListener("change", onDesktopChange);
  }
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
  desktopMql?.removeEventListener("change", onDesktopChange);
  disconnect?.();
});
</script>

<template>
  <div class="flex h-dvh flex-col bg-bg text-fg"
       @touchstart.passive="swipe.onTouchStart"
       @touchend.passive="swipe.onTouchEnd"
       @touchcancel.passive="swipe.onTouchCancel">
    <!-- Global top bar: brand lockup + connection pill on the left; search, theme, settings on the right. -->
    <!-- pt-[env(safe-area-inset-top)]: in an installed iOS PWA (viewport-fit=cover)
         the content runs under the notch / status bar; extend the bar's surface up
         so its controls sit below the inset instead of behind the notch. env() is 0
         on desktop, so this is a no-op there. -->
    <header class="sticky top-0 z-30 flex h-[calc(2.75rem+env(safe-area-inset-top))] shrink-0 items-center justify-between border-b border-border bg-surface/80 px-3 pt-[env(safe-area-inset-top)] backdrop-blur-xl">
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
          :aria-label='$t("nav.search")'
          class="group flex h-7 items-center gap-2 rounded-lg border border-border bg-bg px-2.5 text-left transition-colors hover:border-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent sm:w-64"
          @click="paletteOpen = true"
        >
          <Search :size="14" class="text-fg-muted" />
          <span class="hidden flex-1 text-[12.5px] text-fg-muted sm:inline">{{ $t("nav.searchPlaceholder") }}</span>
          <kbd class="hidden rounded border border-border bg-raised px-1.5 py-0.5 font-mono text-[10px] text-fg-muted sm:inline">⌘K</kbd>
        </button>
        <button
          data-test="theme-toggle"
          :aria-label='theme.mode === "dark" ? $t("nav.toLight") : $t("nav.toDark")'
          class="grid h-7 w-7 place-items-center rounded-lg border border-border text-fg-muted transition-colors hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          @click="theme.toggle()"
        >
          <Moon v-if="theme.mode === 'dark'" :size="15" />
          <Sun v-else :size="15" />
        </button>
        <router-link
          to="/settings"
          data-test="settings-link"
          :aria-label='$t("nav.settings")'
          class="grid h-7 w-7 place-items-center rounded-lg border border-border text-fg-muted transition-colors hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <Settings :size="15" />
        </router-link>
      </div>
    </header>

    <!-- Mobile top bar: hamburger opens the instance tree, Tasks opens the task panel. -->
    <div class="flex items-center gap-2 border-b border-border bg-surface px-2 py-1.5 lg:hidden">
      <button data-test="open-instances" :aria-label='$t("nav.openInstances")'
              class="rounded p-1 leading-none text-fg-muted hover:bg-fg/5" @click="leftOpen = true"><Menu :size="20" /></button>
      <span class="min-w-0 flex-1 truncate text-center text-sm font-medium">{{ chat.sessionAlias ?? "xacpx relay" }}</span>
      <div class="flex shrink-0 items-center gap-0.5">
        <button data-test="open-files" :aria-label='$t("nav.openFiles")' :title='$t("nav.files")'
                class="grid h-8 w-8 place-items-center rounded text-fg-muted hover:bg-fg/5"
                @click="openRight('files')"><FileText :size="18" /></button>
        <button data-test="open-tasks" :aria-label='$t("nav.openTasks")' :title='$t("nav.tasks")'
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
           class="fixed inset-y-0 left-0 z-40 flex w-72 max-w-[85%] shrink-0 transform flex-col border-r border-border bg-surface shadow-lg transition-[transform,width] pt-[env(safe-area-inset-top)] lg:static lg:z-auto lg:max-w-none lg:translate-x-0 lg:transform-none lg:shadow-none lg:pt-0"
           :class="[leftOpen ? 'translate-x-0' : '-translate-x-full', leftCollapsed ? 'lg:w-0 lg:min-w-0 lg:overflow-hidden lg:border-r-0' : 'lg:w-[248px]']">
        <div class="flex h-9 shrink-0 items-center justify-between px-3 text-xs">
          <span class="font-semibold uppercase tracking-wider text-fg-muted">{{ $t("nav.instances") }}</span>
          <div class="flex items-center gap-2">
            <button data-test="toggle-left" :aria-label='$t("nav.hideSidebar")' :title='$t("nav.hideSidebar")'
                    class="hidden h-6 w-6 place-items-center rounded-md text-fg-muted transition-colors hover:bg-raised hover:text-fg lg:grid"
                    @click="leftCollapsed = true"><PanelLeftClose :size="15" /></button>
            <button data-test="close-instances" :aria-label='$t("nav.closeInstances")'
                    class="text-fg-muted hover:text-fg lg:hidden" @click="leftOpen = false"><X :size="18" /></button>
          </div>
        </div>
        <InstanceTree @select="onSelect" />
      </div>

      <!-- Slim edge handle to bring the sidebar back once collapsed (desktop only). -->
      <button v-if="leftCollapsed" data-test="expand-left" :aria-label='$t("nav.showSidebar")' :title='$t("nav.showSidebar")'
              class="hidden w-5 shrink-0 items-center justify-center border-r border-border bg-surface/60 text-fg-muted transition-colors hover:bg-raised hover:text-fg lg:flex"
              @click="leftCollapsed = false"><PanelLeftOpen :size="15" /></button>

      <!-- Center: chat, always full width of the remaining space. -->
      <!-- min-w-0: let this flex child shrink to its share instead of growing to its
           widest content (a tool card's command/diff line), which would otherwise push
           the right panel off-screen. Wide tool content scrolls/wraps within instead. -->
      <!-- ChatPane stays mounted AND laid out (never display:none) — a file viewer just
           overlays it. v-if/v-show would unmount or display:none the conversation, which
           loses its scroll position and forces a full re-layout on return (visible jank).
           Overlaying keeps the scroller warm, so Back is an instant repaint. `inert`
           disables the occluded conversation for focus/interaction. -->
      <div data-test="column" class="relative flex min-w-0 flex-1 flex-col">
        <ChatPane class="absolute inset-0" :inert="viewingFile" @show-files="rightTab = 'files'" />
        <FileViewer v-if="viewingFile" class="absolute inset-0 z-10" @back="backToFileList" @close="closeFileViewer" />
      </div>

      <!-- Right: tasks. Off-canvas drawer < lg, static column ≥ lg. On desktop its
           width is the user-dragged `rightWidth` (inline style overrides lg:w-[296px],
           which stays as a no-JS fallback); on mobile no inline width is set so the
           fixed `w-72` drawer width applies. -->
      <div data-test="column" data-drawer="right"
           class="fixed inset-y-0 right-0 z-40 flex w-72 max-w-[85%] shrink-0 transform flex-col overflow-hidden border-l border-border bg-surface shadow-lg transition-transform pt-[env(safe-area-inset-top)] lg:relative lg:z-auto lg:w-[296px] lg:max-w-none lg:translate-x-0 lg:transform-none lg:shadow-none lg:pt-0"
           :class="rightOpen ? 'translate-x-0' : 'translate-x-full'"
           :style="isDesktop ? { width: rightWidth + 'px' } : undefined">
        <!-- Resize handle: a thin grab strip on the panel's left edge (desktop only).
             touch-none keeps a touch on it from scrolling; it's hidden < lg anyway.
             Pointer-only enhancement over the no-JS lg:w-[296px] fallback, so it's
             aria-hidden (no keyboard/value semantics to honor); the title gives a
             sighted hover hint. -->
        <div data-test="right-resize" aria-hidden="true" :title='$t("nav.resizePanel")'
             class="absolute inset-y-0 left-0 z-20 hidden w-1.5 cursor-col-resize touch-none select-none transition-colors lg:block"
             :class="rightDragging ? 'bg-accent/50' : 'hover:bg-accent/30'"
             @pointerdown.prevent="rightResize.onPointerDown" />
        <div class="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2.5">
          <button data-test="right-tab-files"
                  class="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11.5px] transition-colors cursor-pointer"
                  :class="rightTab === 'files' ? 'bg-accent/10 text-accent font-semibold' : 'text-fg-muted font-medium hover:bg-raised'"
                  @click="rightTab = 'files'">
            <FileText :size="13" />{{ $t("nav.files") }}
          </button>
          <button data-test="right-tab-tasks"
                  class="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11.5px] transition-colors cursor-pointer"
                  :class="rightTab === 'tasks' ? 'bg-accent/10 text-accent font-semibold' : 'text-fg-muted font-medium hover:bg-raised'"
                  @click="rightTab = 'tasks'">
            <List :size="13" />{{ $t("nav.tasks") }}
          </button>
          <button data-test="close-tasks" :aria-label='$t("nav.closeTasks")'
                  class="ml-auto text-fg-muted hover:text-fg lg:hidden" @click="rightOpen = false"><X :size="18" /></button>
        </div>
        <div class="min-h-0 flex-1 overflow-hidden">
          <TaskPanel v-if="rightTab === 'tasks'" />
          <FilesPanel v-else :instance-id="chat.instanceId" />
        </div>
      </div>
    </div>
    <NoticeToast />
    <ActionToast />
    <CommandPalette v-if="paletteOpen"
                    @close="paletteOpen = false"
                    @select-session="(id, alias) => { onSelect(id, alias); paletteOpen = false; }" />
  </div>
</template>
