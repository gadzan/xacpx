<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { connectEvents } from "../api/events";
import { useInstancesStore } from "../stores/instances";
import { useChatStore, loadPersistedSelection } from "../stores/chat";
import { useTasksStore } from "../stores/tasks";
import { useNoticesStore } from "../stores/notices";
import { useConnectionStore } from "../stores/connection";
import { useCenterTabsStore, sessionKey } from "../stores/center-tabs";
import { useTerminalStore } from "../stores/terminal";
import InstanceTree from "../components/InstanceTree.vue";
import ChatPane from "../components/ChatPane.vue";
import FileViewer from "../components/FileViewer.vue";
import TaskPanel from "../components/TaskPanel.vue";
import FilesPanel from "../components/FilesPanel.vue";
import TerminalTab from "../components/TerminalTab.vue";
import CenterTabStrip from "../components/CenterTabStrip.vue";
import NoticeToast from "../components/NoticeToast.vue";
import ActionToast from "../components/ActionToast.vue";
import ToastHost from "../components/ToastHost.vue";
import ConnectionBadge from "../components/ConnectionBadge.vue";
import CommandPalette from "../components/CommandPalette.vue";
import BrandLogo from "../components/BrandLogo.vue";
import { useThemeStore } from "../stores/theme";
import { createEdgeSwipe } from "../lib/edge-swipe";
import { clampPanelWidth, createPanelResize } from "../lib/resize-panel";
import { Search, Moon, Sun, Settings, X, Menu, FileText, List, PanelLeftClose, PanelLeftOpen, SquareTerminal } from "lucide-vue-next";

const theme = useThemeStore();
const instances = useInstancesStore();
const chat = useChatStore();
const tasks = useTasksStore();
const terminals = useTerminalStore();
const notices = useNoticesStore();
const conn = useConnectionStore();
const centerTabs = useCenterTabsStore();
const { t } = useI18n();
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
// Mobile: "Back" from the file viewer returns to the FILE LIST (reopen the Files drawer)
// so the user can pick another file. It does NOT close the underlying file/diff tab — the
// tab stays open (and active) in the per-session tab strip; the drawer just overlays it.
function backToFileList() {
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

// Per-session center tab strip: the session key the tab strip / panes below key off.
// Both instanceId and sessionAlias must be set (a fresh/deselected pane has neither).
const currentKey = computed(() => (chat.instanceId && chat.sessionAlias ? sessionKey(chat.instanceId, chat.sessionAlias) : null));

/** Split a `${instanceId}::${alias}` session key back into its parts. */
function keyInstance(key: string): string {
  const idx = key.indexOf("::");
  return idx === -1 ? key : key.slice(0, idx);
}
function keyAlias(key: string): string {
  const idx = key.indexOf("::");
  return idx === -1 ? "" : key.slice(idx + 2);
}
// Resolve a session key's workspace via the instances store — mirrors FilesPanel's
// `activeWorkspace` lookup, generalized to any (not just the current) session so hidden
// panes for other sessions can still load their own content. "" when unresolvable (e.g.
// the instance hasn't loaded its session list yet).
function keyWorkspace(key: string): string {
  const inst = instances.byId(keyInstance(key));
  return inst?.sessions.find((s) => s.alias === keyAlias(key))?.workspace ?? "";
}

// Route every tab close (file/diff/terminal) through the dirty-aware guard: a clean tab
// closes immediately, a dirty file tab asks first (native confirm — the store can't show UI).
function requestCloseTab(key: string, id: string) {
  centerTabs.closeTabGuarded(key, id, () => window.confirm(t("files.unsavedConfirm")));
}

// Prune center-tabs whose session has disappeared OUT-OF-BAND (deleted from the CLI /
// WeChat / another browser tab). `InstanceTree` prunes on local archive/delete, but a
// server-driven removal only reloads `instances` (via applyEvent → loadSessions) — nothing
// else tells centerTabs, so that session's FileViewer/TerminalTab panes above would stay
// mounted (and any PTY alive) forever. Only consider an instance's session list authoritative
// once it has actually loaded (`sessionsLoaded`): while a fetch is still in flight, a key
// that isn't in `sessions` yet hasn't necessarily been removed, it just hasn't arrived —
// pruning then would race the load and drop a still-valid tab.
const validSessionKeys = computed(() => {
  const keys = new Set<string>();
  for (const inst of instances.instances) {
    if (!inst.sessionsLoaded) continue;
    for (const s of inst.sessions) keys.add(sessionKey(inst.id, s.alias));
  }
  return keys;
});
function reconcileCenterTabs() {
  const valid = validSessionKeys.value;
  const openKeys = new Set(centerTabs.allOpenTabs().map((t) => t.key));
  for (const key of openKeys) {
    const inst = instances.byId(keyInstance(key));
    if (inst?.sessionsLoaded && !valid.has(key)) centerTabs.clearSession(key);
  }
}
watch(() => instances.instances, reconcileCenterTabs, { deep: true });

// A file/diff/terminal tab opened for the current session takes over the center column.
// On mobile, opening one also closes the right drawer so the pane is actually visible.
watch(
  () => (currentKey.value ? centerTabs.activeFor(currentKey.value) : "chat"),
  (active) => { if (active !== "chat") rightOpen.value = false; },
);

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
    terminals.applyEvent(event);
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
          data-test="toggle-terminal"
          :aria-label='$t("terminal.title")'
          :title='$t("terminal.title")'
          :disabled="!chat.sessionAlias"
          class="grid h-7 w-7 place-items-center rounded-lg border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-40"
          :class="currentKey && centerTabs.activeFor(currentKey) === 'terminal' ? 'border-accent/40 bg-accent/10 text-accent' : 'border-border text-fg-muted hover:bg-raised'"
          @click="currentKey && centerTabs.openTerminal(currentKey)"
        >
          <SquareTerminal :size="15" />
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

    <!-- Mobile top bar: hamburger opens the instance tree, Tasks opens the task panel.
         When a session is open the center tab strip lives HERE (bare, so it borrows this
         bar's border/background) in place of the session-name text — folding tabs into the
         one bar mobile already spends, instead of a second full-width row. The standalone
         strip below is desktop-only. Falls back to the app title when no session is open. -->
    <div class="flex items-center gap-2 border-b border-border bg-surface px-2 py-1.5 lg:hidden">
      <button data-test="open-instances" :aria-label='$t("nav.openInstances")'
              class="rounded p-1 leading-none text-fg-muted hover:bg-fg/5" @click="leftOpen = true"><Menu :size="20" /></button>
      <CenterTabStrip v-if="currentKey" bare :session-key="currentKey" class="min-w-0 flex-1" />
      <span v-else class="min-w-0 flex-1 truncate text-center text-sm font-medium">{{ chat.sessionAlias ?? "xacpx relay" }}</span>
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

      <!-- Center: per-session tab strip (pinned Chat + closable file/diff/terminal tabs),
           always full width of the remaining space. -->
      <!-- min-w-0: let this flex child shrink to its share instead of growing to its
           widest content (a tool card's command/diff line), which would otherwise push
           the right panel off-screen. Wide tool content scrolls/wraps within instead. -->
      <!-- ChatPane is a SINGLE always-mounted instance bound to the current session,
           toggled with `v-show` (never `v-if`) — so switching tabs only flips CSS
           display, it never destroys/recreates the component, which is what preserves
           its scroll position and message-list state across a tab switch. `inert`
           additionally disables the occluded conversation for focus/interaction while a
           tab is active. Every OPEN file/diff/terminal tab across ALL sessions gets its
           own always-mounted pane too (so a background session's terminal PTY / a file's
           scroll stay warm); `v-show` reveals only the current session's active tab. A
           pane only ever unmounts when its tab is closed (closeTab) or its session is
           cleared (clearSession). -->
      <div data-test="column" class="relative flex min-w-0 flex-1 flex-col">
        <!-- Desktop-only standalone strip (mobile renders it in the top bar above). The
             wrapper — not a class on the strip — owns the responsive show/hide so the
             strip's own `display:flex` never fights a `hidden`/`lg:flex` on the same node. -->
        <div v-if="currentKey" class="hidden shrink-0 lg:block"><CenterTabStrip :session-key="currentKey" /></div>
        <div class="relative min-h-0 flex-1">
          <ChatPane class="absolute inset-0"
                    :inert="!!currentKey && centerTabs.activeFor(currentKey) !== 'chat'"
                    v-show="!currentKey || centerTabs.activeFor(currentKey) === 'chat'"
                    @show-files="rightTab = 'files'" />
          <template v-for="{ key, tab } in centerTabs.allOpenTabs()" :key="key + '|' + tab.id">
            <FileViewer v-if="tab.kind === 'file' || tab.kind === 'diff'" class="absolute inset-0 z-10"
                        v-show="key === currentKey && centerTabs.activeFor(key) === tab.id"
                        :instance-id="keyInstance(key)" :workspace="keyWorkspace(key)"
                        :session-key="key"
                        :path="tab.kind === 'file' ? tab.path : undefined"
                        :diff-path="tab.kind === 'diff' ? tab.path : undefined"
                        :line="tab.kind === 'file' ? tab.targetLine : undefined"
                        :line-rev="tab.kind === 'file' ? tab.targetRev : undefined"
                        @dirty-change="(v) => centerTabs.setDirty(key, tab.id, v)"
                        @close="requestCloseTab(key, tab.id)" @back="backToFileList" />
            <TerminalTab v-else-if="tab.kind === 'terminal'" class="absolute inset-0 z-20"
                         v-show="key === currentKey && centerTabs.activeFor(key) === tab.id"
                         :instance-id="keyInstance(key)" :session-alias="keyAlias(key)"
                         :autostart="tab.autostart ?? false"
                         @close="requestCloseTab(key, tab.id)" />
          </template>
        </div>
      </div>

      <!-- Right: tasks. Off-canvas drawer < lg, static column ≥ lg. On desktop its
           width is the user-dragged `rightWidth` (inline style overrides lg:w-[296px],
           which stays as a no-JS fallback); on mobile no inline width is set so the
           fixed `w-72` drawer width applies. -->
      <div data-test="column" data-drawer="right"
           class="fixed inset-y-0 right-0 z-40 flex w-full shrink-0 transform flex-col overflow-hidden border-l border-border bg-surface shadow-lg transition-transform pt-[env(safe-area-inset-top)] lg:relative lg:z-auto lg:w-[296px] lg:max-w-none lg:translate-x-0 lg:transform-none lg:shadow-none lg:pt-0"
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
    <ToastHost />
    <CommandPalette v-if="paletteOpen"
                    @close="paletteOpen = false"
                    @select-session="(id, alias) => { onSelect(id, alias); paletteOpen = false; }" />
  </div>
</template>
