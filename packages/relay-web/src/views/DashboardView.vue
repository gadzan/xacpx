<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch, type Component } from "vue";
import { useI18n } from "vue-i18n";
import { connectEvents, sendSubscribe, TerminalRequestError, isRetryableTerminalError } from "../api/events";
import { useInstancesStore, supportsRmuxTerminal, supportsDesktop } from "../stores/instances";
import { useChatStore, loadPersistedSelection } from "../stores/chat";
import { useDirectBotsStore, loadPersistedBotSelection } from "../stores/direct-bots";
import { useTasksStore } from "../stores/tasks";
import { useGroupsStore, loadPersistedGroupSelection } from "../stores/groups";
import { useNoticesStore } from "../stores/notices";
import { useConnectionStore } from "../stores/connection";
import { useCenterTabsStore, sessionKey } from "../stores/center-tabs";
import { useTerminalStore, terminalLocalKey } from "../stores/terminal";
import { useDesktopStore } from "../stores/desktop";
import { useFilesStore } from "../stores/files";
import { iconForFile } from "../lib/file-icons";
import { detachSessionTerminal } from "../lib/session-terminal";
import { pushToast } from "../lib/use-toasts";
import { migrateAwayFromLegacyTerminalIds } from "../lib/terminal-sessions";
import InstanceTree from "../components/InstanceTree.vue";
import AgentIcon from "../components/AgentIcon.vue";
import MobileSheet from "../components/MobileSheet.vue";
import MobileConnStrip from "../components/MobileConnStrip.vue";
import ChatPane from "../components/ChatPane.vue";
import EmptySessionState, { type RecentSessionItem } from "../components/EmptySessionState.vue";
import DirectBotPane from "../components/DirectBotPane.vue";
import GroupPane from "../components/GroupPane.vue";
import FileViewer from "../components/FileViewer.vue";
import TaskPanel from "../components/TaskPanel.vue";
import FilesPanel from "../components/FilesPanel.vue";
import TerminalTab from "../components/TerminalTab.vue";
import DesktopTab from "../components/DesktopTab.vue";
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
import { setNotificationClickHandler, initTabFocusTracker } from "../lib/local-notification";
import { Search, Moon, Sun, Settings, X, ArrowLeft, FileText, List, Monitor, PanelLeftClose, PanelLeftOpen, PanelRightOpen, SquareTerminal, MoreHorizontal, Plus, MessageSquare, LayoutList } from "lucide-vue-next";

const theme = useThemeStore();
const instances = useInstancesStore();
const chat = useChatStore();
const tasks = useTasksStore();
const directBotsStore = useDirectBotsStore();
const groupsStore = useGroupsStore();
const terminals = useTerminalStore();
const desktops = useDesktopStore();
const files = useFilesStore();
const notices = useNoticesStore();
const conn = useConnectionStore();
const centerTabs = useCenterTabsStore();
const { t } = useI18n();
let disconnect: (() => void) | null = null;
let focusTracker: ReturnType<typeof initTabFocusTracker> | null = null;
function onSwMessage(event: MessageEvent): void {
  if (event.data?.type === "SELECT_SESSION" && typeof event.data.instanceId === "string" && typeof event.data.sessionAlias === "string") {
    onSelect(event.data.instanceId, event.data.sessionAlias);
  }
}

// Mobile-only drawer state (the right files/tasks panel). On desktop (lg:) it is a
// static column and the flag is visually irrelevant because the lg: classes override
// the transform. There is no left drawer on mobile: the instance list is the home
// screen and the top bar's ← goes back to it (goHome below).
const rightOpen = ref(false);
const rightTab = ref<"tasks" | "files">("files");
/** Instance-level Desktop tab (not a per-session center tab): one viewer per instance. */
const desktopTabOpen = ref(false);
function closeDrawers() {
  rightOpen.value = false;
}
function openRight(tab: "tasks" | "files") {
  rightTab.value = tab;
  rightOpen.value = true;
}
function closeRightColumn(): void {
  if (isDesktop.value) rightCollapsed.value = true;
  else rightOpen.value = false;
}
function onShowFiles(): void {
  rightTab.value = "files";
  rightCollapsed.value = false;
}

// Mobile edge-swipe for the right drawer: from the right edge swipe left to open
// tasks/files; a swipe back toward the edge closes it. Inert on lg+ (static columns).
// No left-edge gesture: there is no instances drawer any more, and a swipe-back would
// fight iOS Safari's own back gesture (deferred to a history.pushState-based approach).
const swipe = createEdgeSwipe({
  // < 1024px = the Tailwind `lg` boundary at which the drawers stop being
  // off-canvas. innerWidth ≥ the CSS viewport width (it includes a classic
  // scrollbar), so we never disable while the layout is still off-canvas.
  isEnabled: () => typeof window !== "undefined" && window.innerWidth < 1024,
  isRightOpen: () => rightOpen.value,
  openRight: () => { rightOpen.value = true; }, // keeps the last-used right tab
  closeRight: () => { rightOpen.value = false; },
});
// Desktop-only: collapse the instances sidebar to reclaim width. Persisted so the
// choice survives reloads. (Mobile has no instances column outside the home list.)
const leftCollapsed = ref(localStorage.getItem("xacpx.leftCollapsed") === "1");
watch(leftCollapsed, (v) => localStorage.setItem("xacpx.leftCollapsed", v ? "1" : "0"));
// Desktop-only: collapse the right files/tasks column, persisted like leftCollapsed.
const rightCollapsed = ref(localStorage.getItem("xacpx.rightCollapsed") === "1");
watch(rightCollapsed, (v) => localStorage.setItem("xacpx.rightCollapsed", v ? "1" : "0"));

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
// Terminal close is a global terminate of the shared RMUX resource (with multi-viewer warning).
let terminalCloseInFlight = false;
async function requestCloseTerminal(key: string): Promise<void> {
  if (terminalCloseInFlight) return;
  const instanceId = keyInstance(key);
  const alias = keyAlias(key);
  const localKey = terminalLocalKey(instanceId, alias);
  const view = terminals.get(localKey);
  if (view?.terminatePending) return;

  // Open never succeeded (or identity was cleared): just drop the local tab.
  // There is no shared RMUX resource to terminate, so do not block on RPC.
  if (!view?.terminalId || !view.generation) {
    if (view) terminals.detach(localKey);
    centerTabs.closeTab(key, "terminal");
    return;
  }

  const viewerCount = view.viewerCount ?? 1;
  const ok = window.confirm(
    viewerCount > 1 ? t("terminal.closeSharedConfirm") : t("terminal.closeConfirm"),
  );
  if (!ok) return;
  terminalCloseInFlight = true;
  try {
    const result = await terminals.terminate(localKey);
    centerTabs.closeTab(key, "terminal");
    if (result.status === "cleanup-pending") {
      pushToast("info", "terminal.cleanupPendingToast");
    }
  } catch (err) {
    const code = err instanceof TerminalRequestError ? err.code : "terminal-protocol-error";
    if (code === "terminal-session-not-found" || code === "terminal-attachment-not-found") {
      if (view) terminals.detach(localKey);
      centerTabs.closeTab(key, "terminal");
      return;
    }
    if (isRetryableTerminalError(code)) {
      pushToast("error", "terminal.closeRetryToast");
      return;
    }
    pushToast("error", "terminal.closeError");
  } finally {
    terminalCloseInFlight = false;
  }
}

function requestCloseTab(key: string, id: string) {
  const tab = centerTabs.tabsFor(key).find((t) => t.id === id);
  if (tab?.kind === "terminal") {
    void requestCloseTerminal(key);
    return;
  }
  centerTabs.closeTabGuarded(key, id, () => window.confirm(t("files.unsavedConfirm")));
}

// Prune center-tabs whose session has disappeared OUT-OF-BAND (deleted from the CLI /
// WeChat / another browser tab). `InstanceTree` prunes on local archive/delete, but a
// server-driven removal only reloads `instances` (via applyEvent → loadSessions) — nothing
// else tells centerTabs, so that session's FileViewer/TerminalTab panes above would stay
// mounted forever. Only consider an instance's session list authoritative once it has loaded
// completely (`sessionsLoaded && !sessionsHasMore`): while a fetch is still paginated, a key
// that isn't in `sessions` yet hasn't necessarily been removed — pruning then would race the
// load and drop a still-valid tab. Browser does not terminate RMUX resources here.
const validSessionKeys = computed(() => {
  const keys = new Set<string>();
  for (const inst of instances.instances) {
    if (!inst.sessionsLoaded || inst.sessionsHasMore) continue;
    for (const s of inst.sessions) keys.add(sessionKey(inst.id, s.alias));
    for (const state of Object.values(inst.groupArchived ?? {})) {
      for (const s of state.sessions) keys.add(sessionKey(inst.id, s.alias));
    }
  }
  return keys;
});
function reconcileCenterTabs() {
  const valid = validSessionKeys.value;
  const openKeys = new Set(centerTabs.allOpenTabs().map((t) => t.key));
  for (const key of openKeys) {
    const inst = instances.byId(keyInstance(key));
    if (inst?.sessionsLoaded && !inst.sessionsHasMore && !valid.has(key)) {
      // Unmount detaches; channel-relay owns resource retirement for deleted sessions.
      const alias = keyAlias(key);
      detachSessionTerminal(key, keyInstance(key), alias, terminals);
      centerTabs.clearSession(key);
    }
  }
}
watch(() => instances.instances, reconcileCenterTabs, { deep: true });

const terminalCapable = computed(() => {
  const id = chat.instanceId;
  if (!id) return false;
  const inst = instances.byId(id);
  return !!inst && supportsRmuxTerminal(inst);
});

/**
 * Instance-scoped Desktop target: independent of the chat/session selection so
 * an instance with zero sessions — or one viewed in Direct Bot mode — can still
 * open its Desktop. The toolbar button bumps this whenever a session is
 * selected; the per-instance tree entry sets it directly.
 */
const desktopInstanceId = ref<string | null>(null);

/**
 * Toolbar entry visibility: keyed off the chat-selected instance so the control
 * appears as soon as a desktop-capable instance is selected. The OPEN viewer
 * (`desktopInstanceId`) is tracked separately so an instance with no session
 * selection can still hold the viewer after being opened from the instance tree.
 */
const desktopCapableForSelection = computed(() => {
  const id = chat.instanceId;
  if (!id) return false;
  const inst = instances.byId(id);
  return !!inst && supportsDesktop(inst);
});

/** The instance the toolbar button would open: the current viewer, else the selection. */
const desktopToolbarTarget = computed(() => desktopInstanceId.value ?? chat.instanceId);

function openDesktop(instanceId?: string): void {
  const target = instanceId ?? chat.instanceId;
  if (!target) return;
  const inst = instances.byId(target);
  if (!inst || !supportsDesktop(inst)) return;
  // Switching instances closes the previous viewer: v1 is single-viewer per
  // instance and the hub rejects a second, so leaving it open would strand the
  // old stream (its socket is gone from the UI) until the TTL sweep reaped it.
  if (desktopInstanceId.value && desktopInstanceId.value !== target) {
    desktops.close(desktopInstanceId.value);
  }
  desktopInstanceId.value = target;
  desktops.viewFor(target);
  desktopTabOpen.value = true;
  rightOpen.value = false;
}

function closeDesktop(): void {
  if (desktopInstanceId.value) desktops.close(desktopInstanceId.value);
  desktopInstanceId.value = null;
  desktopTabOpen.value = false;
}

// ── Mobile (<lg) chrome ───────────────────────────────────────────────────────────
// Below lg the old three-layer stack (global header + second bar + ChatPane chip row)
// collapses into ONE 52px bar: [←] [avatar] [title + subtitle] [⋯]. Desktop keeps the
// global header and the chip row exactly as before, so everything below is only ever
// reachable from the mobile markup.
// One bottom sheet at a time: opening any sheet replaces the current one (the open-tabs
// sheet does not stack on the ⋯ sheet, and closing it does not return there).
type MobileSheetId = "more" | "tabs" | "fabInstance";
const activeSheet = ref<MobileSheetId | null>(null);
function openSheet(id: MobileSheetId): void { activeSheet.value = id; }
function closeSheet(): void { activeSheet.value = null; }
/** The single InstanceTree instance: the drawer's tree on desktop (and with a selection),
 *  the main-area list on the mobile home. The FAB drives its create-session dialog
 *  through the exposed `openNewSession`. */
const instanceTree = ref<InstanceType<typeof InstanceTree> | null>(null);

const isBotSelected = computed(() => directBotsStore.isBotSelected);
const isGroupSelected = computed(() => groupsStore.isGroupSelected);
/** Nothing selected: no session, bot, group, or instance desktop viewer. On <lg the
 *  instance tree becomes the main content (with the FAB); on lg the center column shows
 *  the empty state instead. */
const nothingSelected = computed(() => !currentKey.value && !isBotSelected.value && !isGroupSelected.value
  && !(desktopTabOpen.value && desktopInstanceId.value));
// The right column is an off-canvas drawer on mobile (`rightOpen`) and a static column on
// desktop; desktop hides it with no session selected and while the user collapsed it.
const showRightColumn = computed(() => !isBotSelected.value && !isGroupSelected.value
  && (!isDesktop.value || (!rightCollapsed.value && !!currentKey.value)));
// Desktop empty state: recent sessions across online instances. SessionDto carries no
// activity timestamp, so the order is the store's list order with the persisted
// last-opened session bumped to the front.
const RECENT_SESSION_LIMIT = 5;
const recentSessions = computed<RecentSessionItem[]>(() => {
  const last = loadPersistedSelection();
  const rows: RecentSessionItem[] = [];
  for (const inst of instances.instances) {
    if (!inst.online) continue;
    for (const s of inst.sessions) {
      rows.push({ instanceId: inst.id, instanceName: inst.name, alias: s.alias, displayName: s.displayName, agent: s.agent, driver: s.driver });
    }
  }
  if (last) {
    const idx = rows.findIndex((r) => r.instanceId === last.instanceId && r.alias === last.alias);
    if (idx > 0) rows.unshift(...rows.splice(idx, 1));
  }
  return rows.slice(0, RECENT_SESSION_LIMIT);
});

/** Mobile ←: back to the home list. Clears the chat, bot AND group selections — which
 *  also drops their persisted copies, so a refresh lands on home. `xacpx.lastInstance`
 *  is deliberately kept (the FAB's recent-first order reads it). */
function goHome(): void {
  closeSheet();
  rightOpen.value = false;
  closeDesktop();
  chat.clearSelection();
  directBotsStore.clearSelection();
  groupsStore.clearSelection();
}
/** Session view on <lg: the single session bar (+ connection strip). Bot / group views
 *  render their own chrome, so the bar steps aside even if a stale session key lingers. */
const mobileSessionBar = computed(() => !!currentKey.value && !isBotSelected.value && !isGroupSelected.value);
/** Session or bot view: the global header steps aside for the single mobile bar. */
const mobileSingleBar = computed(() => !!currentKey.value || isBotSelected.value);

const sessionRow = computed(() =>
  chat.instanceId && chat.sessionAlias ? instances.findSessionRow(chat.instanceId, chat.sessionAlias) : undefined,
);
// The session's acpx driver for the bar's agent glyph — same resolution as ChatPane's
// header (row-carried driver first, agents map as the fallback for older instances).
const sessionDriver = computed(() =>
  sessionRow.value?.driver
  ?? (chat.instanceId ? instances.byId(chat.instanceId)?.agents.find((a) => a.name === sessionRow.value?.agent)?.driver : undefined),
);
/** "instance · agent · branch". Missing parts are skipped, so the separator never leads
 *  and never doubles; branch comes from the session's git summary once it has loaded. */
const sessionSubtitle = computed(() => {
  const parts: string[] = [];
  const inst = chat.instanceId ? instances.byId(chat.instanceId) : undefined;
  if (inst?.name) parts.push(inst.name);
  if (sessionRow.value?.agent) parts.push(sessionRow.value.agent);
  if (files.gitSummary?.branch) parts.push(files.gitSummary.branch);
  return parts.join(" · ");
});

/** Non-chat center tabs of the current session — the count the ⋯ sheet leads with. */
const openTabCount = computed(() => (currentKey.value ? centerTabs.tabsFor(currentKey.value).length : 0));
function tabBasename(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? path : path.slice(idx + 1);
}
/** Chat + every open tab of the current session, in strip order, for the open-tabs sheet. */
const tabSheetItems = computed(() => {
  const key = currentKey.value;
  if (!key) return [];
  const active = centerTabs.activeFor(key);
  const items: { id: string; label: string; icon: Component; active: boolean }[] = [
    { id: "chat", label: t("center.chat"), icon: MessageSquare, active: active === "chat" },
  ];
  for (const tab of centerTabs.tabsFor(key)) {
    items.push({
      id: tab.id,
      label: tab.kind === "terminal" ? t("center.terminal") : tabBasename(tab.path),
      icon: tab.kind === "terminal" ? SquareTerminal : iconForFile(tab.path),
      active: active === tab.id,
    });
  }
  return items;
});
function switchTabFromSheet(id: string): void {
  if (currentKey.value) centerTabs.setActive(currentKey.value, id);
  closeSheet();
}
function closeTabFromSheet(id: string): void {
  if (currentKey.value) requestCloseTab(currentKey.value, id);
}

function openSheetRight(tab: "tasks" | "files"): void {
  openRight(tab);
  closeSheet();
}
function openSheetTerminal(): void {
  if (currentKey.value && terminalCapable.value) centerTabs.openTerminal(currentKey.value);
  closeSheet();
}
function openSheetDesktop(): void {
  if (desktopTabOpen.value) closeDesktop();
  else openDesktop();
  closeSheet();
}

// FAB (mobile home): a single online instance creates straight away; several open a
// picker with the last-used instance first (last used = the persisted chat selection).
const onlineInstances = computed(() => instances.instances.filter((i) => i.online));
// The persisted chat selection is cleared on deselect (that is how the home is reached),
// so the last-used instance is remembered under its own key whenever a session opens.
const LAST_INSTANCE_KEY = "xacpx.lastInstance";
function loadLastInstance(): string | null {
  try { return localStorage.getItem(LAST_INSTANCE_KEY) ?? loadPersistedSelection()?.instanceId ?? null; } catch { return null; }
}
watch(() => chat.instanceId, (id) => {
  if (id) try { localStorage.setItem(LAST_INSTANCE_KEY, id); } catch { /* storage may be blocked */ }
}, { immediate: true });
const fabInstances = computed(() => {
  const lastUsed = loadLastInstance();
  return [...onlineInstances.value].sort((a, b) => Number(b.id === lastUsed) - Number(a.id === lastUsed));
});
function onFabClick(): void {
  const online = onlineInstances.value;
  if (online.length === 1) instanceTree.value?.openNewSession(online[0].id);
  else if (online.length > 1) openSheet("fabInstance");
}
function createSessionIn(instanceId: string): void {
  closeSheet();
  instanceTree.value?.openNewSession(instanceId);
}

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
  // The desktop viewer is instance-scoped: switching instances closes it, but
  // selecting another session on the SAME instance keeps it open — that is the
  // point of an instance-level resource.
  if (desktopInstanceId.value && desktopInstanceId.value !== instanceId) {
    closeDesktop();
  }
  directBotsStore.clearSelection();
  groupsStore.clearSelection();
  chat.select(instanceId, alias);
  void chat.loadHistory().catch(() => {});
}

function onSelectBot(instanceId: string, botId: string) {
  // Leave the desktop tab explicitly: the DesktopTab unmounts when
  // chat.instanceId becomes null, but leaving `desktopTabOpen` true means a
  // later ordinary-session select re-mounts it (the v-if below) and silently
  // re-prepares a desktop stream the user never asked for again.
  closeDesktop();
  chat.clearSelection();
  groupsStore.clearSelection();
  void directBotsStore.selectBot(instanceId, botId);
}

function onSelectGroup(instanceId: string, groupId: string) {
  // Same lifecycle rule as onSelectBot: the desktop viewer is instance-
  // scoped, so close it explicitly. Clearing chat.instanceId alone unmounts
  // DesktopTab (its v-if), but leaving desktopTabOpen true means a later
  // ordinary-session select silently re-prepares a desktop stream.
  closeDesktop();
  chat.clearSelection();
  directBotsStore.clearSelection();
  void groupsStore.selectGroup(instanceId, groupId);
}

let everOnline = false;
const subscribedInstanceIds = (): string[] => instances.instances.map((instance) => instance.id);
async function reloadSnapshot() {
  await instances.loadInstances().catch(() => {});
  instances.loadSessionsForOnlineInstances();
  if (chat.instanceId && chat.sessionAlias) {
    await instances.loadSessions(chat.instanceId).catch(() => {});
    await chat.loadHistory().catch(() => {});
    await tasks.loadFor(chat.instanceId, chat.sessionAlias).catch(() => {});
  }
}
function onStatus(online: boolean) {
  conn.setOnline(online);
  if (online) {
    // Subscribe to every owned instance so background turns keep their working/unread
    // state accurate even while the user is viewing a different instance.
    sendSubscribe(subscribedInstanceIds());
    if (everOnline) {
      void reloadSnapshot();
      // The owned-instance negative first, and independently of the pane reconcile.
      //
      // It is an ACCOUNT-wide fact — which instances this account still owns — so it
      // must run whether or not a Bot is selected, and must not be cancelled by the
      // pane reconcile's early return. Running it here, before the pane work starts,
      // keeps it out of `reconcileOnReconnect`'s critical section entirely.
      void directBotsStore.reconcileOwnedInstanceNegative();
      void directBotsStore.reconcileOnReconnect();
      void groupsStore.reconcileOnReconnect();
    }
    everOnline = true;
  }
}

// Instance additions/removals change the account-wide subscription. Each accepted id gets
// an ordered authoritative snapshot before subsequent deltas on the same socket.
watch(
  () => instances.instances.map((instance) => instance.id).join("\0"),
  () => { if (conn.online) sendSubscribe(subscribedInstanceIds()); },
);

onMounted(async () => {
  migrateAwayFromLegacyTerminalIds();
  window.addEventListener("keydown", onGlobalKey);
  if (typeof window.matchMedia === "function") {
    desktopMql = window.matchMedia("(min-width: 1024px)");
    isDesktop.value = desktopMql.matches;
    desktopMql.addEventListener("change", onDesktopChange);
  }
  await instances.loadInstances();
  instances.loadSessionsForOnlineInstances();
  disconnect = connectEvents((event) => {
    instances.applyEvent(event);
    chat.applyEvent(event);
    directBotsStore.applyEvent(event);
    groupsStore.applyEvent(event);
    // If the selected turn completed while the browser was offline, the authoritative
    // snapshot clears its stale live card. Reload persisted history immediately so the
    // completed answer replaces it without requiring a manual page refresh.
    if (
      event.kind === "state-snapshot"
      && event.instanceId === chat.instanceId
      && chat.sessionAlias
      && !event.turns.some((turn) => turn.sessionAlias === chat.sessionAlias)
    ) {
      void chat.loadHistory().catch(() => {});
    }
    tasks.applyEvent(event);
    notices.applyEvent(event);
    terminals.applyEvent(event);
    desktops.applyEvent(event);
    // An offline instance can no longer serve its desktop: close the viewer so
    // the button drops out and the (now unopenable) target is released.
    if (event.kind === "instance-status" && event.online === false && event.instanceId === desktopInstanceId.value) {
      closeDesktop();
    }
  }, onStatus);
  setNotificationClickHandler((instId, alias) => onSelect(instId, alias));
  if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", onSwMessage);
  }
  focusTracker = initTabFocusTracker();
  watch([() => chat.instanceId, () => chat.sessionAlias], ([inst, alias]) => {
    focusTracker?.updateFocus(inst, alias);
  }, { immediate: true });

  // Return to query param session if opened from notification, else prior session
  const searchParams = typeof window !== "undefined" && window.location ? new URLSearchParams(window.location.search) : null;
  const qInst = searchParams?.get("instanceId");
  const qAlias = searchParams?.get("sessionAlias");
  if (qInst && qAlias) {
    onSelect(qInst, qAlias);
    try {
      if (typeof window !== "undefined" && window.history && typeof window.history.replaceState === "function") {
        window.history.replaceState({}, "", window.location.pathname);
      }
    } catch { /* ignore */ }
  } else {
    const persistedGroup = loadPersistedGroupSelection();
    if (persistedGroup && instances.byId(persistedGroup.instanceId)) {
      onSelectGroup(persistedGroup.instanceId, persistedGroup.groupId);
    } else {
      const persistedBot = loadPersistedBotSelection();
      if (persistedBot && instances.byId(persistedBot.instanceId)) {
        onSelectBot(persistedBot.instanceId, persistedBot.botId);
      } else {
        const prior = loadPersistedSelection();
        if (prior && instances.byId(prior.instanceId)) {
          onSelect(prior.instanceId, prior.alias);
        }
      }
    }
  }
});

onUnmounted(() => {
  focusTracker?.dispose();
  focusTracker = null;
  setNotificationClickHandler(null);
  if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
    navigator.serviceWorker.removeEventListener("message", onSwMessage);
  }
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
    <header class="sticky top-0 z-30 h-[calc(2.75rem+env(safe-area-inset-top))] shrink-0 items-center justify-between bg-surface/80 px-3 pt-[env(safe-area-inset-top)] backdrop-blur-xl"
            :class="mobileSingleBar ? 'hidden lg:flex' : 'flex'">
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
          class="group flex h-10 lg:h-7 items-center gap-2 rounded-lg px-2.5 text-left transition-colors hover:bg-surface-2 active:bg-surface-2 lg:bg-bg lg:hover:bg-surface-2 lg:active:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent sm:w-64"
          @click="paletteOpen = true"
        >
          <Search :size="14" class="text-fg-muted" />
          <span class="hidden flex-1 text-ui text-fg-muted sm:inline">{{ $t("nav.searchPlaceholder") }}</span>
          <kbd class="hidden rounded-sm bg-raised px-1.5 py-0.5 font-mono text-xs text-fg-muted sm:inline">⌘K</kbd>
        </button>
        <button
          data-test="toggle-terminal"
          :aria-label='$t("terminal.title")'
          :title='terminalCapable ? $t("terminal.title") : $t("terminal.unavailable")'
          :disabled="!chat.sessionAlias || !terminalCapable"
          class="grid h-10 w-10 lg:h-7 lg:w-7 place-items-center rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-40"
          :class="currentKey && centerTabs.activeFor(currentKey) === 'terminal' ? 'bg-accent-soft text-accent' : 'text-fg-muted hover:bg-raised'"
          @click="currentKey && terminalCapable && centerTabs.openTerminal(currentKey)"
        >
          <SquareTerminal :size="15" />
        </button>
        <button
          v-if="desktopCapableForSelection"
          data-test="toggle-desktop"
          :aria-label='$t("desktop.title")'
          :title='$t("desktop.title")'
          :disabled="!desktopToolbarTarget"
          class="grid h-10 w-10 lg:h-7 lg:w-7 place-items-center rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-40"
          :class="desktopTabOpen ? 'bg-accent-soft text-accent' : 'text-fg-muted hover:bg-raised'"
          @click="desktopTabOpen ? closeDesktop() : openDesktop()"
        >
          <Monitor :size="15" />
        </button>
        <button
          data-test="theme-toggle"
          :aria-label='theme.mode === "dark" ? $t("nav.toLight") : $t("nav.toDark")'
          class="grid h-10 w-10 lg:h-7 lg:w-7 place-items-center rounded-lg text-fg-muted transition-colors hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          @click="theme.toggle()"
        >
          <Moon v-if="theme.mode === 'dark'" :size="15" />
          <Sun v-else :size="15" />
        </button>
        <router-link
          to="/settings"
          data-test="settings-link"
          :aria-label='$t("nav.settings")'
          class="grid h-10 w-10 lg:h-7 lg:w-7 place-items-center rounded-lg text-fg-muted transition-colors hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <Settings :size="15" />
        </router-link>
      </div>
    </header>

    <!-- Mobile single top bar (session view, <lg). ONE 52px row replaces the old global
         header + second bar + ChatPane chip stack: ← returns to the home list (there is
         no instances drawer on mobile), the right button opens the ⋯
         sheet that now carries files / tasks / terminal / desktop / the open
         center tabs. Desktop keeps the global header and the chip row untouched. -->
    <div v-if="mobileSessionBar" data-test="mobile-session-bar"
         class="flex h-[calc(3.25rem+env(safe-area-inset-top))] shrink-0 items-center gap-1 bg-surface px-2 pt-[env(safe-area-inset-top)] lg:hidden">
      <button type="button" data-test="mobile-back" :aria-label='$t("nav.back")' :title='$t("nav.back")'
              class="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-fg-muted transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              @click="goHome"><ArrowLeft :size="20" /></button>
      <span class="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-surface-2">
        <AgentIcon :driver="sessionDriver" :title="sessionRow?.agent" :size="18" />
      </span>
      <div class="flex min-w-0 flex-1 flex-col">
        <span class="truncate text-sm font-semibold text-fg">{{ sessionRow?.displayName || chat.sessionAlias }}</span>
        <span data-test="mobile-session-subtitle" class="truncate text-xs text-fg-muted">{{ sessionSubtitle }}</span>
      </div>
      <button type="button" data-test="mobile-more" :aria-label='$t("common.more")'
              class="grid h-10 w-10 shrink-0 place-items-center rounded-lg text-fg-muted transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              @click="openSheet('more')"><MoreHorizontal :size="20" /></button>
    </div>
    <!-- Connection strip sits directly under the mobile bar (only after the connection
         has been open at least once — see MobileConnStrip). -->
    <MobileConnStrip v-if="mobileSessionBar" />

    <!-- Groups keep the old mobile bar: GroupPane is NOT redesigned in this PR. -->
    <div v-else-if="isGroupSelected" class="flex items-center gap-2 bg-surface px-2 py-1.5 lg:hidden">
      <button type="button" data-test="mobile-back" :aria-label='$t("nav.back")' :title='$t("nav.back")'
              class="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-fg-muted transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              @click="goHome"><ArrowLeft :size="20" /></button>
      <span class="min-w-0 flex-1 truncate text-center text-sm font-medium">
        {{ groupsStore.currentGroup?.title ?? "Group" }}
        <span v-if="groupsStore.currentTopic" class="text-xs text-fg-muted font-normal"> · {{ groupsStore.currentTopic.title }}</span>
      </span>
    </div>

    <div class="flex flex-1 overflow-hidden">
      <!-- Backdrop closes any open drawer (mobile only). -->
      <div v-if="rightOpen" data-test="drawer-backdrop"
           class="fixed inset-0 z-30 bg-black/30 lg:hidden" @click="closeDrawers" />

      <!-- Left: instances. Static column ≥ lg (unchanged). Below lg it is ONLY the home
           screen: with nothing selected the tree is the full-width main content; once a
           session / bot / group is open it is hidden and ← in the top bar comes back here.
           One InstanceTree instance, no second copy with diverging local state. -->
      <div data-test="column" data-drawer="left"
           class="flex shrink-0 flex-col bg-surface transition-[width] max-lg:relative max-lg:w-full lg:static"
           :class="[
             leftCollapsed ? 'lg:w-0 lg:min-w-0 lg:overflow-hidden' : 'lg:w-[248px]',
             nothingSelected ? '' : 'max-lg:hidden',
           ]">
        <div class="flex h-9 shrink-0 items-center justify-between px-3 text-xs">
          <span class="font-semibold uppercase tracking-wider text-fg-muted">{{ $t("nav.instances") }}</span>
          <div class="flex items-center gap-2">
            <button data-test="toggle-left" :aria-label='$t("nav.hideSidebar")' :title='$t("nav.hideSidebar")'
                    class="hidden h-6 w-6 place-items-center rounded-sm text-fg-muted transition-colors hover:bg-raised hover:text-fg lg:grid"
                    @click="leftCollapsed = true"><PanelLeftClose :size="15" /></button>
          </div>
        </div>
        <InstanceTree ref="instanceTree" @select="onSelect" @select-bot="onSelectBot" @select-group="onSelectGroup" @open-desktop="openDesktop" />
      </div>

      <!-- Slim edge handle to bring the sidebar back once collapsed (desktop only). -->
      <button v-if="leftCollapsed" data-test="expand-left" :aria-label='$t("nav.showSidebar")' :title='$t("nav.showSidebar")'
              class="hidden w-5 shrink-0 items-center justify-center bg-surface/60 text-fg-muted transition-colors hover:bg-raised hover:text-fg lg:flex"
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
      <div data-test="column" class="relative flex min-w-0 flex-1 flex-col" :class="nothingSelected ? 'max-lg:hidden' : ''">
        <!-- Desktop-only standalone strip (the open tabs live in the mobile ⋯ sheet). The
             wrapper — not a class on the strip — owns the responsive show/hide so the
             strip's own `display:flex` never fights a `hidden`/`lg:flex` on the same node. -->
        <div v-if="currentKey" class="hidden shrink-0 lg:block">
          <CenterTabStrip :session-key="currentKey" @close="(id) => currentKey && requestCloseTab(currentKey, id)" />
        </div>
        <div class="relative min-h-0 flex-1">
          <DirectBotPane
            v-if="directBotsStore.isBotSelected"
            class="absolute inset-0 z-10"
            @navigate-bot="onSelectBot"
            @navigate-group="onSelectGroup"
            @back="goHome"
          />
          <GroupPane v-else-if="groupsStore.isGroupSelected" class="absolute inset-0 z-10" />
          <EmptySessionState v-else-if="nothingSelected" class="absolute inset-0"
                             :sessions="recentSessions" :instances="fabInstances"
                             @select="onSelect" @create="createSessionIn" />
          <ChatPane class="absolute inset-0"
                    :inert="directBotsStore.isBotSelected || groupsStore.isGroupSelected || (!!currentKey && centerTabs.activeFor(currentKey) !== 'chat')"
                    v-show="!!currentKey && centerTabs.activeFor(currentKey) === 'chat'"
                    @show-files="onShowFiles" />
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
                        @close="requestCloseTab(key, tab.id)" />
            <TerminalTab v-else-if="tab.kind === 'terminal'" class="absolute inset-0 z-20"
                         v-show="key === currentKey && centerTabs.activeFor(key) === tab.id"
                         :active="key === currentKey && centerTabs.activeFor(key) === tab.id"
                         :instance-id="keyInstance(key)" :session-alias="keyAlias(key)"
                         @close="requestCloseTab(key, tab.id)" />
          </template>
          <DesktopTab v-if="desktopTabOpen && desktopInstanceId" class="absolute inset-0 z-20"
                      :instance-id="desktopInstanceId"
                      :instance-name="instances.byId(desktopInstanceId)?.name ?? desktopInstanceId"
                      @close="closeDesktop()" />
        </div>
      </div>

      <!-- Slim edge handle to bring the right column back once collapsed (desktop only). -->
      <button v-if="isDesktop && currentKey && rightCollapsed" data-test="expand-right"
              :aria-label='$t("nav.showPanel")' :title='$t("nav.showPanel")'
              class="hidden w-5 shrink-0 items-center justify-center bg-surface/60 text-fg-muted transition-colors hover:bg-raised hover:text-fg lg:flex"
              @click="rightCollapsed = false"><PanelRightOpen :size="15" /></button>

      <!-- Right: tasks. Off-canvas drawer < lg, static column ≥ lg. On desktop its
           width is the user-dragged `rightWidth` (inline style overrides lg:w-[296px],
           which stays as a no-JS fallback); on mobile no inline width is set so the
           fixed `w-72` drawer width applies. -->
      <div v-if="showRightColumn"
           data-test="column" data-drawer="right"
           class="fixed inset-y-0 right-0 z-40 flex w-full shrink-0 transform flex-col overflow-hidden bg-surface shadow-float transition-transform pt-[env(safe-area-inset-top)] lg:relative lg:z-auto lg:w-[296px] lg:max-w-none lg:translate-x-0 lg:transform-none lg:shadow-none lg:pt-0"
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
        <div class="flex h-9 shrink-0 items-center gap-1 px-2.5">
          <button data-test="right-tab-files"
                  class="flex items-center gap-1.5 rounded-sm px-2.5 py-1 text-xs transition-colors cursor-pointer"
                  :class="rightTab === 'files' ? 'bg-accent-soft text-accent font-semibold' : 'text-fg-muted font-medium hover:bg-raised'"
                  @click="rightTab = 'files'">
            <FileText :size="13" />{{ $t("nav.files") }}
          </button>
          <button data-test="right-tab-tasks"
                  class="flex items-center gap-1.5 rounded-sm px-2.5 py-1 text-xs transition-colors cursor-pointer"
                  :class="rightTab === 'tasks' ? 'bg-accent-soft text-accent font-semibold' : 'text-fg-muted font-medium hover:bg-raised'"
                  @click="rightTab = 'tasks'">
            <List :size="13" />{{ $t("nav.tasks") }}
          </button>
          <button data-test="close-tasks" :aria-label='$t("nav.hidePanel")' :title='$t("nav.hidePanel")'
                  class="ml-auto grid h-10 w-10 place-items-center rounded-lg text-fg-muted transition-colors hover:bg-surface-2" @click="closeRightColumn"><X :size="18" /></button>
        </div>
        <div class="min-h-0 flex-1 overflow-hidden">
          <TaskPanel v-if="rightTab === 'tasks'" />
          <FilesPanel v-else :instance-id="chat.instanceId" />
        </div>
      </div>
    </div>

    <!-- Mobile home (<lg, nothing selected): the FAB creates a session. One online
         instance creates straight away; several open the instance picker below (last
         used first). Disabled with no online instance. -->
    <button v-if="nothingSelected" type="button" data-test="fab-new-session"
            class="fixed bottom-[calc(1.5rem+env(safe-area-inset-bottom))] right-4 z-30 flex h-12 items-center gap-2 rounded-full bg-accent px-4 text-on-accent shadow-float transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 lg:hidden"
            :disabled="onlineInstances.length === 0"
            :aria-label='$t("instance.newSession")'
            @click="onFabClick">
      <Plus :size="20" class="shrink-0" />
      <span class="text-sm font-semibold">{{ $t("instance.newSession") }}</span>
    </button>

    <!-- Session ⋯ sheet: everything the mobile bar cannot show. No model entry — the
         model stays on the composer chip. -->
    <MobileSheet v-if="activeSheet === 'more'" :title='$t("common.more")' test-id="mobile-more-sheet" @close="closeSheet">
      <button type="button" data-test="sheet-open-tabs"
              class="flex min-h-12 w-full items-center gap-3 rounded-lg px-3 text-left text-sm text-fg transition-colors hover:bg-surface-2"
              @click="openSheet('tabs')">
        <LayoutList :size="18" class="shrink-0 text-fg-muted" />
        <span>{{ $t("mobileBar.openTabs", { n: openTabCount }) }}</span>
      </button>
      <button type="button" data-test="sheet-files"
              class="flex min-h-12 w-full items-center gap-3 rounded-lg px-3 text-left text-sm text-fg transition-colors hover:bg-surface-2"
              @click="openSheetRight('files')">
        <FileText :size="18" class="shrink-0 text-fg-muted" />
        <span>{{ $t("nav.files") }}</span>
      </button>
      <button type="button" data-test="sheet-tasks"
              class="flex min-h-12 w-full items-center gap-3 rounded-lg px-3 text-left text-sm text-fg transition-colors hover:bg-surface-2"
              @click="openSheetRight('tasks')">
        <List :size="18" class="shrink-0 text-fg-muted" />
        <span>{{ $t("nav.tasks") }}</span>
      </button>
      <button type="button" data-test="sheet-terminal"
              :disabled="!terminalCapable"
              :title="terminalCapable ? $t('terminal.title') : $t('terminal.unavailable')"
              class="flex min-h-12 w-full items-center gap-3 rounded-lg px-3 text-left text-sm text-fg transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40"
              @click="openSheetTerminal">
        <SquareTerminal :size="18" class="shrink-0 text-fg-muted" />
        <span>{{ $t("terminal.title") }}</span>
      </button>
      <button v-if="desktopCapableForSelection" type="button" data-test="sheet-desktop"
              class="flex min-h-12 w-full items-center gap-3 rounded-lg px-3 text-left text-sm text-fg transition-colors hover:bg-surface-2"
              @click="openSheetDesktop">
        <Monitor :size="18" class="shrink-0 text-fg-muted" />
        <span>{{ $t("desktop.title") }}</span>
      </button>
    </MobileSheet>

    <!-- Open center tabs (the mobile replacement for the desktop tab strip): switch with
         a tap, close with the same guarded path the strip's X uses. -->
    <MobileSheet v-if="activeSheet === 'tabs'" :title='$t("mobileBar.openTabs", { n: openTabCount })' test-id="open-tabs-sheet" @close="closeSheet">
      <div v-for="item in tabSheetItems" :key="item.id" data-test="open-tab-row" :data-tab-id="item.id"
           class="flex min-h-12 items-center rounded-lg pr-1"
           :class="item.active ? 'bg-accent-soft text-accent' : 'text-fg'">
        <button type="button" class="flex min-h-12 min-w-0 flex-1 items-center gap-3 rounded-lg px-3 text-left text-sm"
                @click="switchTabFromSheet(item.id)">
          <component :is="item.icon" :size="18" class="shrink-0" />
          <span class="truncate">{{ item.label }}</span>
        </button>
        <button v-if="item.id !== 'chat'" type="button" data-test="open-tab-close"
                :aria-label='$t("center.closeTab")'
                class="grid h-10 w-10 shrink-0 place-items-center rounded-lg text-fg-muted transition-colors hover:bg-surface-2"
                @click.stop="closeTabFromSheet(item.id)"><X :size="16" /></button>
      </div>
    </MobileSheet>

    <!-- FAB instance picker (multiple online instances). -->
    <MobileSheet v-if="activeSheet === 'fabInstance'" :title='$t("mobileBar.selectInstance")' test-id="fab-instance-sheet" @close="closeSheet">
      <button v-for="inst in fabInstances" :key="inst.id" type="button" data-test="fab-instance-option"
              class="flex min-h-12 w-full items-center gap-3 rounded-lg px-3 text-left text-sm text-fg transition-colors hover:bg-surface-2"
              @click="createSessionIn(inst.id)">
        <span class="h-2 w-2 shrink-0 rounded-full bg-run" aria-hidden="true" />
        <span class="truncate">{{ inst.name }}</span>
      </button>
    </MobileSheet>

    <NoticeToast />
    <ActionToast />
    <ToastHost />
    <CommandPalette v-if="paletteOpen"
                    @close="paletteOpen = false"
                    @select-session="(id, alias) => { onSelect(id, alias); paletteOpen = false; }" />
  </div>
</template>
