<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { ArchiveRestore, ChevronDown, ChevronRight, Folder, Link2, Loader2, Moon, MoreHorizontal, Pencil, Plus, Settings2, SquareTerminal, Trash2, Unplug } from "lucide-vue-next";
import { useInstancesStore, groupArchivedKey, parseGroupArchivedKey } from "../stores/instances";
import { useChatStore } from "../stores/chat";
import { useCenterTabsStore, sessionKey } from "../stores/center-tabs";
import { useTerminalStore } from "../stores/terminal";
import { detachSessionTerminal } from "../lib/session-terminal";
import { confirm } from "../lib/use-confirm";
import { showActionToast } from "../lib/use-action-toast";
import { pushToast } from "../lib/use-toasts";
import { useSwipeActions } from "../lib/use-swipe-actions";
import { groupSessions, dedupedSessionName, sessionPresentationName, archivedLast } from "../lib/sidebar-group-mode";
import NewSessionDialog from "./NewSessionDialog.vue";
import ManageInstanceDialog from "./ManageInstanceDialog.vue";
import AgentIcon from "./AgentIcon.vue";
import type { GroupArchivedMode, GroupArchivedState, InstanceView } from "../stores/instances";

// Local directive: focus + select an element on mount (the rename input).
const vFocus = {
  mounted(el: HTMLInputElement) { el.focus(); el.select(); },
};

const store = useInstancesStore();
const chat = useChatStore();
const centerTabs = useCenterTabsStore();
const terminals = useTerminalStore();
const { t } = useI18n();

// A session row carries the agent NAME; the brand glyph keys on its driver. Prefer the
// driver carried on the row itself (server-resolved; sleeping rows live outside the
// active list, so the agents map below is only a fallback for old instances).
function driverFor(inst: InstanceView, s: Pick<InstanceView["sessions"][number], "agent" | "driver">): string | undefined {
  return s.driver ?? inst.agents.find((a) => a.name === s.agent)?.driver;
}
// Agent-mode group headers key on the agent NAME (no row) — agents map only.
function driverForAgentName(inst: InstanceView, agentName: string): string | undefined {
  return inst.agents.find((a) => a.name === agentName)?.driver;
}
const emit = defineEmits<{ select: [instanceId: string, alias: string] }>();
const dialogFor = ref<{ id: string; name: string; presetAgent?: string; presetWorkspace?: string } | null>(null);
const manageFor = ref<{ id: string; name: string } | null>(null);

// 1Hz clock so working-session elapsed badges tick.
const nowMs = ref(Date.now());
const timer = setInterval(() => { nowMs.value = Date.now(); }, 1000);
onUnmounted(() => clearInterval(timer));

// Compact elapsed label (e.g. "12s", "3m", "1h") for a working session, or "".
function elapsedLabel(instanceId: string, alias: string): string {
  const since = chat.runningSince(instanceId, alias);
  if (since === null) return "";
  const s = Math.max(0, Math.floor((nowMs.value - since) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

function isSelected(instanceId: string, alias: string): boolean {
  return chat.instanceId === instanceId && chat.sessionAlias === alias;
}

// Terminal-open marker: the center-tabs store already keeps a Terminal tab per session
// (including background sessions). Overlay it on the agent glyph so the row width and
// title space stay unchanged. Agent-grouping drops the glyph, so that path uses a
// zero-width host that overflows into the left padding instead of inserting a new icon.
function hasOpenTerminal(instanceId: string, alias: string): boolean {
  return centerTabs.hasTerminal(sessionKey(instanceId, alias));
}

// Per-instance collapse state (expanded by default). Sessions are loaded by an explicit
// sidebar action, so this just shows/hides the rows once data is available.
const collapsed = ref<Set<string>>(new Set());
function isExpanded(id: string): boolean {
  return !collapsed.value.has(id);
}
function toggle(id: string) {
  const next = new Set(collapsed.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  collapsed.value = next;
  openSwipeFor.value = null;
}

function activeSessions(inst: InstanceView): InstanceView["sessions"] {
  return inst.sessions.filter((session) => !session.archived);
}

// Long session lists get noisy fast — cap the rendered rows per instance and let the
// user opt into the rest via "show N more" (mirrors the instance collapse/expand
// pattern above, but keyed independently since either can toggle without the other).
const SESSION_CAP = 10;
const sessionsExpanded = ref<Set<string>>(new Set());
const archivedExpanded = ref<Set<string>>(new Set());
function toggleSessions(id: string) {
  const next = new Set(sessionsExpanded.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  sessionsExpanded.value = next;
}
function archivedIsExpanded(id: string): boolean {
  return archivedExpanded.value.has(id);
}
async function toggleArchived(id: string): Promise<void> {
  const next = new Set(archivedExpanded.value);
  if (next.has(id)) {
    next.delete(id);
    archivedExpanded.value = next;
    return;
  }
  const inst = store.byId(id);
  if (inst && !inst.archivedSessionsLoaded) await store.loadArchivedSessions(id).catch(() => {});
  next.add(id);
  archivedExpanded.value = next;
}
function displaySessions(inst: InstanceView): InstanceView["sessions"] {
  if (!archivedIsExpanded(inst.id)) return activeSessions(inst);
  return inst.sessions;
}
function visibleSessions(inst: InstanceView): InstanceView["sessions"] {
  const active = activeSessions(inst);
  const activeVisible = sessionsExpanded.value.has(inst.id) ? active : active.slice(0, SESSION_CAP);
  if (!archivedIsExpanded(inst.id)) return activeVisible;
  const archived = archivedLast(inst.sessions.filter((session) => session.archived));
  return [...activeVisible, ...archived];
}

// ── Second-level grouping (workspace / agent) ───────────────────────────────
// The per-instance mode lives in the store (localStorage-backed). Flat mode keeps
// the SESSION_CAP truncation; grouped modes render every session — group collapse
// is the length control there.
function groupModeOf(inst: InstanceView) {
  return store.groupModeFor(inst.id);
}

interface SidebarSection {
  /** Group name (workspace or agent), or null for the flat (ungrouped) section. */
  key: string | null;
  sessions: InstanceView["sessions"];
  /** Sleeping rows paged in for this group (grouped modes only, when expanded). */
  archivedSessions?: InstanceView["sessions"];
  archivedState?: GroupArchivedState;
}
function sectionsFor(inst: InstanceView): SidebarSection[] {
  const mode = groupModeOf(inst);
  if (mode === "instance") return [{ key: null, sessions: visibleSessions(inst) }];
  // Grouped modes page sleeping sessions PER GROUP from the server; groups come from
  // active sessions plus any group already tracked in groupArchived (so a group whose
  // last active session was just archived stays visible with its sleeping rows).
  const groups = groupSessions(activeSessions(inst), mode);
  const present = new Set(groups.map((g) => g.key));
  for (const recordKey of Object.keys(inst.groupArchived ?? {})) {
    const parsed = parseGroupArchivedKey(recordKey);
    if (!parsed || parsed.mode !== mode) continue;
    if (!present.has(parsed.groupKey)) groups.push({ key: parsed.groupKey, sessions: [] });
  }
  return groups.map((g) => {
    const state = inst.groupArchived?.[groupArchivedKey(mode, g.key)];
    const expanded = groupArchivedIsExpanded(inst, g.key);
    return {
      key: g.key,
      sessions: g.sessions,
      archivedSessions: expanded && state ? archivedLast(state.sessions) : [],
      archivedState: state,
    };
  });
}

/** A section's renderable rows: active rows, then any expanded sleeping rows. */
function sectionRows(section: SidebarSection): InstanceView["sessions"] {
  return [...section.sessions, ...(section.archivedSessions ?? [])];
}

// Per-group sleeping-session expansion (grouped modes). Keyed by mode like
// collapsedGroups so switching modes never carries stale expansion over. Hiding
// keeps the loaded page cached; re-showing only refetches when never loaded.
const groupArchivedExpanded = ref<Set<string>>(new Set());
function groupViewKey(inst: InstanceView, key: string): string {
  return `${inst.id}:${groupModeOf(inst)}:${key}`;
}
function groupArchivedIsExpanded(inst: InstanceView, key: string): boolean {
  return groupArchivedExpanded.value.has(groupViewKey(inst, key));
}
async function toggleGroupArchived(inst: InstanceView, key: string): Promise<void> {
  const k = groupViewKey(inst, key);
  const next = new Set(groupArchivedExpanded.value);
  if (next.has(k)) {
    next.delete(k);
    groupArchivedExpanded.value = next;
    return;
  }
  const mode = groupModeOf(inst) as GroupArchivedMode;
  const state = inst.groupArchived?.[groupArchivedKey(mode, key)];
  if (!state?.loaded) await store.loadGroupArchivedSessions(inst.id, mode, key).catch(() => {});
  next.add(k);
  groupArchivedExpanded.value = next;
}
function loadMoreGroupArchived(inst: InstanceView, key: string): void {
  const mode = groupModeOf(inst) as GroupArchivedMode;
  void store.loadGroupArchivedSessions(inst.id, mode, key, true).catch(() => {});
}

// Group collapse is in-session view state only (not persisted), keyed by mode so
// switching modes never carries stale collapse over. Shares groupViewKey (above).
const collapsedGroups = ref<Set<string>>(new Set());
function isGroupCollapsed(inst: InstanceView, key: string): boolean {
  return collapsedGroups.value.has(groupViewKey(inst, key));
}
function toggleGroup(inst: InstanceView, key: string): void {
  const k = groupViewKey(inst, key);
  const next = new Set(collapsedGroups.value);
  if (next.has(k)) next.delete(k);
  else next.add(k);
  collapsedGroups.value = next;
  openSwipeFor.value = null;
}

// Display-only dedup of the `<workspace>-<agent>` auto-alias inside a group; the
// row's hover title always carries the full name.
function rowName(inst: InstanceView, s: { alias: string; displayName?: string; workspace?: string; agent?: string }, sectionKey: string | null): string {
  const mode = groupModeOf(inst);
  return sessionPresentationName({
    displayName: s.displayName,
    alias: s.alias,
    workspace: s.workspace ?? (mode === "workspace" ? sectionKey ?? undefined : undefined),
    agent: s.agent ?? (mode === "agent" ? sectionKey ?? undefined : undefined),
    groupMode: mode,
  });
}

// Group-header ＋: open the create dialog with the group's own value prefilled.
function openGroupDialog(inst: InstanceView, key: string): void {
  dialogFor.value = {
    id: inst.id,
    name: inst.name,
    ...(groupModeOf(inst) === "workspace" ? { presetWorkspace: key } : { presetAgent: key }),
  };
}

// Desktop overflow (⋯) menu open-state, keyed by `${instanceId}:${alias}`.
const openMenuFor = ref<string | null>(null);

// Inline rename: the row currently being renamed, keyed `${instanceId}:${alias}`, plus its draft.
const renamingFor = ref<string | null>(null);
const renameDraft = ref("");

function startRename(id: string, s: { alias: string; displayName?: string }) {
  openMenuFor.value = null;
  renamingFor.value = `${id}:${s.alias}`;
  renameDraft.value = s.displayName ?? s.alias;
}
function commitRename(id: string, alias: string) {
  if (renamingFor.value !== `${id}:${alias}`) return; // already cancelled
  const next = renameDraft.value.trim();
  renamingFor.value = null;
  // Surface failures (e.g. the store's "needs a newer connector" upgrade hint) as an
  // error toast — the inline input is already gone, so silence would look like success.
  void store.renameSession(id, alias, next).catch((e: unknown) => {
    pushToast("error", "instance.sessionRenameFailed", { msg: e instanceof Error ? e.message : String(e) });
  });
}
function cancelRename() {
  renamingFor.value = null;
}
// Touch swipe-to-reveal: the row whose action blocks (archive/delete) are revealed.
// Single ref ⇒ opening one row auto-closes any other. Swipe right→left reveals;
// tapping a block executes; tapping the row body or anywhere outside closes.
const openSwipeFor = ref<string | null>(null);
// Live drag: the row currently being dragged + its raw horizontal delta, so the row
// follows the finger 1:1 (transition is off while dragging, on for the snap release).
const draggingKey = ref<string | null>(null);
const dragDx = ref(0);
function onDocPointerDown() { openMenuFor.value = null; openSwipeFor.value = null; }
onMounted(() => document.addEventListener("mousedown", onDocPointerDown));
onUnmounted(() => document.removeEventListener("mousedown", onDocPointerDown));

// Px the row shifts left to reveal its blocks: one 56px block per visible action
// (delete always, archive only when the session isn't already archived).
function revealPx(s: { archived?: boolean }): number {
  return s.archived ? 56 : 112;
}
// translateX for a row: follow the finger while dragging (clamped to the reveal
// range), else snap to fully open / closed.
function rowTransform(instanceId: string, s: { alias: string; archived?: boolean }): string {
  const key = `${instanceId}:${s.alias}`;
  const reveal = revealPx(s);
  if (draggingKey.value === key) {
    const base = openSwipeFor.value === key ? -reveal : 0;
    const x = Math.max(-reveal, Math.min(0, base + dragDx.value));
    return `translateX(${x}px)`;
  }
  return openSwipeFor.value === key ? `translateX(-${reveal}px)` : "translateX(0)";
}
// Tapping the row body: if its blocks are open, the tap just closes them (iOS-style);
// otherwise it selects the session.
function onRowTap(id: string, alias: string) {
  const key = `${id}:${alias}`;
  if (openSwipeFor.value === key) { openSwipeFor.value = null; return; }
  emit("select", id, alias);
}

async function onArchive(id: string, alias: string) {
  openMenuFor.value = null;
  openSwipeFor.value = null;
  // RPC FIRST: a connector business error (HTTP 200 {error:…} surfaced by the
  // store's unwrap) must leave the UI untouched — tearing down tabs/terminal or
  // showing the undo toast before the RPC settles produced a fake success on
  // failure. Teardown runs only once the archive actually landed.
  try {
    await store.archiveSession(id, alias);
  } catch (e) {
    pushToast("error", "instance.sessionArchiveFailed", { alias, msg: e instanceof Error ? e.message : String(e) });
    return;
  }
  // Drop this session's center tabs. TerminalTab unmount detaches the viewer;
  // channel-relay retires the durable resource — browser must not terminate/kill.
  const key = sessionKey(id, alias);
  detachSessionTerminal(key, id, alias, terminals);
  centerTabs.clearSession(key);
  showUndoToast(id, alias);
}
async function onUnarchive(id: string, alias: string) {
  openMenuFor.value = null;
  openSwipeFor.value = null;
  try {
    await store.unarchiveSession(id, alias);
  } catch (e) {
    pushToast("error", "instance.sessionUnarchiveFailed", { alias, msg: e instanceof Error ? e.message : String(e) });
  }
}
function showUndoToast(id: string, alias: string) {
  showActionToast({
    message: t("instance.sessionArchivedToast", { alias }),
    actionLabel: t("instance.undo"),
    // Reuse onUnarchive (NOT a raw store call): runToastAction clears this toast
    // BEFORE the action runs, so a connector business error must surface as an
    // error toast via the same handler the ⋯-menu Wake path uses — otherwise the
    // user loses the undo affordance AND gets no failure feedback while the
    // session stays archived.
    action: () => { void onUnarchive(id, alias); },
  });
}

// Deleting a session is destructive and irreversible → confirm via the popup dialog.
async function askDelete(id: string, alias: string) {
  openMenuFor.value = null;
  openSwipeFor.value = null;
  const ok = await confirm({
    title: t("instance.deleteSessionTitle"),
    message: t("instance.deleteSessionBody", { alias }),
    confirmLabel: t("common.delete"),
    tone: "danger",
  });
  if (!ok) return;
  // Deleting the session you're viewing drops the view back to the empty "no session"
  // state rather than leaving a stale, now-broken selection pointed at it.
  const wasActive = isSelected(id, alias);
  // RPC FIRST (same rationale as onArchive): a rejected removal must keep the tabs,
  // terminal viewer and selection intact. The tail-cache purge inside the store
  // already only runs on a successful delete.
  try {
    await store.removeSession(id, alias);
  } catch (e) {
    pushToast("error", "instance.sessionDeleteFailed", { alias, msg: e instanceof Error ? e.message : String(e) });
    return;
  }
  // Drop this session's center tabs so they unmount along with it. Browser detaches only;
  // channel-relay owns resource retirement for deleted sessions.
  const key = sessionKey(id, alias);
  detachSessionTerminal(key, id, alias, terminals);
  centerTabs.clearSession(key);
  if (wasActive) chat.clearSelection();
}

// A freshly created session is what the user wants to be in — switch to it immediately.
function onSessionCreated(alias: string) {
  const id = dialogFor.value?.id;
  dialogFor.value = null;
  if (id) emit("select", id, alias);
}

// Touch second path: swipe a row right→left to REVEAL its archive/delete blocks (tap a
// block to execute); swipe left→right to close. This replaces the old swipe-to-execute
// (which deleted on a single right-swipe — too easy to mis-trigger). Handlers are built
// per visible row of online instances and keyed by `${instanceId}:${alias}`, so the
// template binds a stable set. Offline instances are excluded (mirrors the action gate).
const rowSwipes = computed(() => {
  const map: Record<string, ReturnType<typeof useSwipeActions>["handlers"]> = {};
  for (const inst of store.instances) {
    if (!inst.online) continue;
    for (const section of sectionsFor(inst)) {
      for (const s of sectionRows(section)) {
        const key = `${inst.id}:${s.alias}`;
        if (map[key]) continue;
        const reveal = revealPx(s);
        map[key] = useSwipeActions({
          pointerTypes: ["touch", "pen"],
          onMove: (dx) => { openMenuFor.value = null; draggingKey.value = key; dragDx.value = dx; },
          onEnd: (dx) => {
            // Snap open if the row ended past the halfway point, else closed.
            const base = openSwipeFor.value === key ? -reveal : 0;
            const finalX = Math.max(-reveal, Math.min(0, base + dx));
            openSwipeFor.value = finalX <= -reveal / 2 ? key : null;
            draggingKey.value = null;
            dragDx.value = 0;
          },
        }).handlers;
      }
    }
  }
  return map;
});
</script>

<template>
  <nav class="thin-scroll flex h-full flex-1 flex-col space-y-1.5 overflow-y-auto px-2 pb-2 pt-1.5">
    <!-- One instance card: header row + session area (flat or grouped) + footer.
         The card background is the level-1 zone of the tinted-zone hierarchy; group
         zones inside are one step lighter (visually isomorphic across all modes). -->
    <div v-for="inst in store.instances" :key="inst.id" data-test="instance-card"
         class="rounded-lg border border-border bg-surface/60 p-[3px]"
         :class="inst.online ? '' : 'opacity-60'">
      <!-- Instance header: chevron + online/offline dot + name + session count. -->
      <button
        class="group flex h-7 w-full items-center gap-1.5 rounded-md px-1.5 transition-colors hover:bg-raised"
        @click="toggle(inst.id)"
      >
        <ChevronDown v-if="isExpanded(inst.id)" :size="12" class="shrink-0 text-fg-muted" />
        <ChevronRight v-else :size="12" class="shrink-0 text-fg-muted" />
        <span class="h-2 w-2 shrink-0 rounded-full" :class="inst.online ? 'bg-run' : 'bg-fg-muted'" data-test="online-dot" />
        <span class="flex-1 truncate text-left text-[12.5px] font-semibold" :class="inst.online ? 'text-fg' : 'text-fg-muted'"
              :title="inst.coreVersion ? $t('instance.coreVersion', { version: inst.coreVersion }) : $t('instance.coreVersionUnknown')">{{ inst.name }}</span>
        <span v-if="inst.online" class="font-mono text-[10px] tabular-nums text-fg-muted">{{ activeSessions(inst).length }}</span>
        <span v-else class="text-[10px] font-medium text-fg-muted">{{ $t("instance.offline") }}</span>
      </button>

      <!-- Session area: flat rows, or tinted group zones (workspace/agent mode).
           Instead of a border-l indent rail, hierarchy reads from background tint +
           a very small indent — grouped rows keep almost the full row width. -->
      <div v-show="isExpanded(inst.id)" class="mt-px space-y-1 px-0.5 pb-0.5">
        <button v-if="inst.online && !inst.sessionsLoaded && !inst.sessionsLoading" data-test="load-sessions"
                class="flex w-full items-center gap-1.5 rounded px-2.5 py-1 text-left text-[11px] font-medium text-accent hover:bg-accent/10"
                @click.stop="store.loadSessions(inst.id).catch(() => {})">
          <ChevronDown :size="11" class="rotate-[-90deg]" />{{ $t("instance.loadSessions") }}
        </button>
        <div v-if="inst.online && inst.sessionsLoading" data-test="sessions-loading"
             class="py-1 pl-2.5 text-[11px] text-fg-muted">{{ $t("instance.loading") }}</div>
        <div v-for="grp in sectionsFor(inst)" :key="grp.key ?? '~flat'"
             :class="grp.key !== null ? 'rounded-md bg-fg/[0.035] p-0.5' : 'space-y-px'"
             :data-test="grp.key !== null ? 'session-group' : undefined">
          <!-- Group header: chevron + kind icon + name + count; hover ＋ creates in-group. -->
          <div v-if="grp.key !== null" class="group/hdr flex items-center gap-0.5">
            <button data-test="group-header" :aria-expanded="!isGroupCollapsed(inst, grp.key)"
                    class="flex h-6 min-w-0 flex-1 items-center gap-1.5 rounded px-1.5 text-left transition-colors hover:bg-fg/5"
                    @click="toggleGroup(inst, grp.key)">
              <ChevronDown v-if="!isGroupCollapsed(inst, grp.key)" :size="11" class="shrink-0 text-fg-muted" />
              <ChevronRight v-else :size="11" class="shrink-0 text-fg-muted" />
              <Folder v-if="groupModeOf(inst) === 'workspace'" :size="12" class="shrink-0 text-fg-muted" />
              <AgentIcon v-else :driver="driverForAgentName(inst, grp.key)" :title="grp.key" :size="13" />
              <span data-test="group-name" class="min-w-0 truncate text-[11.5px] font-semibold text-fg-muted">{{ grp.key }}</span>
              <span data-test="group-count" class="shrink-0 font-mono text-[10px] tabular-nums text-fg-muted">{{ grp.sessions.length }}</span>
            </button>
            <button data-test="group-new-session" :title="$t('instance.groupNewSession', { name: grp.key })" :aria-label="$t('instance.groupNewSession', { name: grp.key })"
                    class="grid h-5 w-5 shrink-0 place-items-center rounded text-accent transition-colors hover:bg-accent/10 opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/hdr:opacity-100"
                    @click.stop="openGroupDialog(inst, grp.key)"><Plus :size="12" /></button>
          </div>
          <div v-show="grp.key === null || !isGroupCollapsed(inst, grp.key)" class="space-y-px" :class="grp.key !== null ? 'pl-2' : ''">
            <div
              v-for="s in sectionRows(grp)"
              :key="s.alias"
              data-test="session-row"
              class="group relative rounded-md"
            >
            <!-- Clip layer: bounds ONLY the swipe track so the off-screen action blocks
                 stay hidden until revealed. The row itself is NOT clipped, so the ⋯
                 dropdown (rendered below as a row child) can overflow past the row. -->
            <div class="overflow-hidden rounded-md">
            <!-- Swipe track: full-width row content followed by the off-screen action
                 blocks. Swiping right→left translates the track left to reveal them. -->
            <div
              data-test="swipe-track"
              class="flex touch-pan-y ease-out"
              :class="draggingKey === `${inst.id}:${s.alias}` ? '' : 'transition-transform duration-200'"
              :style="{ transform: rowTransform(inst.id, s) }"
              v-on="inst.online ? rowSwipes[`${inst.id}:${s.alias}`] ?? {} : {}"
            >
              <!-- Foreground row content (spans the full row width). -->
              <div class="relative flex w-full shrink-0 items-center rounded-md transition-colors"
                   :class="isSelected(inst.id, s.alias) ? 'bg-accent/10' : 'hover:bg-raised'">
                <!-- Selected row: left accent bar. -->
                <span v-if="isSelected(inst.id, s.alias)" class="absolute bottom-1 left-0 top-1 w-[3px] rounded-full bg-accent" />
                <button
                  class="flex min-w-0 flex-1 items-center gap-2 py-2 pl-2.5 pr-1.5 text-left"
                  @click="onRowTap(inst.id, s.alias)"
                >
                  <Loader2 v-if="s.creating" data-test="session-creating" :size="12" class="shrink-0 animate-spin motion-reduce:animate-none text-accent" />
                  <span v-else-if="!s.archived && chat.sessionAttention(inst.id, s.alias) === 'working'" data-test="attention-dot" data-attention="working"
                        class="pulse-dot h-2 w-2 shrink-0 rounded-full bg-run-bright" />
                  <span v-else-if="!s.archived && chat.sessionAttention(inst.id, s.alias) === 'unread'" data-test="attention-dot" data-attention="unread"
                        class="h-2 w-2 shrink-0 rounded-full bg-info" />
                  <span v-else-if="!s.archived && s.running" data-test="attention-dot" data-attention="running" class="h-2 w-2 shrink-0 rounded-full bg-run" />
                  <!-- Agent brand glyph (driver icon) BEFORE the name, in place of a text badge —
                       saves horizontal space; the agent name stays available on hover. Redundant
                       inside an agent-mode group (the group header already carries it) → dropped.
                       Terminal-open is a corner overlay on this glyph so it does not steal title
                       space; agent-mode uses a zero-width host in the same slot. -->
                  <span v-if="groupModeOf(inst) !== 'agent'" class="relative shrink-0">
                    <AgentIcon :driver="driverFor(inst, s)" :title="s.agent" :size="14"
                               :class="s.archived ? 'opacity-60' : ''" />
                    <span
                      v-if="hasOpenTerminal(inst.id, s.alias)"
                      data-test="terminal-open-marker"
                      class="absolute -bottom-px -right-px grid h-2.5 w-2.5 place-items-center rounded-sm bg-surface text-accent ring-1 ring-accent/50"
                      :title="$t('instance.sessionTerminalOpenTitle')"
                      :aria-label="$t('instance.sessionTerminalOpenTitle')"
                    ><SquareTerminal :size="8" :stroke-width="2.5" /></span>
                  </span>
                  <span
                    v-else-if="hasOpenTerminal(inst.id, s.alias)"
                    class="relative w-0 shrink-0 self-end"
                  >
                    <span
                      data-test="terminal-open-marker"
                      class="absolute bottom-1 right-0 grid h-2.5 w-2.5 -translate-x-0.5 place-items-center rounded-sm bg-surface text-accent ring-1 ring-accent/50"
                      :title="$t('instance.sessionTerminalOpenTitle')"
                      :aria-label="$t('instance.sessionTerminalOpenTitle')"
                    ><SquareTerminal :size="8" :stroke-width="2.5" /></span>
                  </span>
                  <input v-if="renamingFor === `${inst.id}:${s.alias}`" data-test="rename-input"
                         v-model="renameDraft" :maxlength="60" :placeholder="$t('instance.sessionRenamePlaceholder')"
                         class="min-w-0 flex-1 rounded border border-accent bg-bg px-1 py-px text-[13px] text-fg outline-none"
                         @click.stop @keydown.enter.prevent="commitRename(inst.id, s.alias)"
                         @keydown.escape.prevent="cancelRename" @blur="commitRename(inst.id, s.alias)"
                         v-focus />
                  <span v-else data-test="session-name" class="min-w-0 truncate text-[12.5px] font-medium"
                        :title="s.displayName || s.alias"
                        :class="s.archived ? 'text-fg-muted' : (isSelected(inst.id, s.alias) ? 'font-semibold text-accent' : 'text-fg')">{{ rowName(inst, s, grp.key) }}</span>
                  <!-- Archived state is shown visually by the dimmed name (no text badge), but that
                       greying carries no signal for screen readers — keep a visually-hidden label so
                       archived status is still announced. -->
                  <span v-if="s.archived" data-test="archived-label" class="sr-only">{{ $t("instance.sessionArchivedLabel") }}</span>
                  <!-- Native (agent-side / resumed) sessions get a small link glyph instead of a text
                       badge to keep the row uncluttered. -->
                  <Link2 v-if="s.native" data-test="native-badge" :size="12"
                         :aria-label="$t('instance.sessionNativeBadgeTitle')" :title="$t('instance.sessionNativeBadgeTitle')"
                         class="shrink-0 text-info" :class="s.archived ? 'opacity-60' : ''" />
                  <!-- Cold indicator: awake session whose warm process has exited (TTL or otherwise);
                       next message cold-starts. Absent `warm` (old instance) shows nothing. -->
                  <Unplug v-if="!s.archived && s.warm === false" data-test="cold-indicator" :size="12"
                          :aria-label="$t('instance.sessionColdTitle')" :title="$t('instance.sessionColdTitle')"
                          class="shrink-0 text-fg-muted" />
                  <span v-if="!s.archived && elapsedLabel(inst.id, s.alias)" data-test="session-elapsed"
                        class="ml-auto shrink-0 font-mono text-[10px] tabular-nums text-run">{{ elapsedLabel(inst.id, s.alias) }}</span>
                </button>
                <!-- Row actions: desktop overflow (⋯) menu → archive / delete. Hidden when the instance is offline. -->
                <div v-if="inst.online" data-test="session-actions" class="relative mr-1 shrink-0">
                  <button data-test="session-menu" :aria-label="$t('common.more')"
                          class="grid h-5 w-5 place-items-center rounded text-fg-muted hover:bg-raised hover:text-fg opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100"
                          @click.stop="openSwipeFor = null; openMenuFor = openMenuFor === `${inst.id}:${s.alias}` ? null : `${inst.id}:${s.alias}`"><MoreHorizontal :size="13" /></button>
                </div>
              </div>
              <!-- Swipe-revealed action blocks (touch). Sit just past the right edge; the
                   `@click.stop` prevents the row tap from also firing. -->
              <template v-if="inst.online">
                <button v-if="!s.archived" data-test="swipe-archive" :aria-label="$t('instance.archiveSession')" :title="$t('instance.sleepTooltip')"
                        class="flex w-14 shrink-0 items-center justify-center bg-warn text-white transition-colors hover:bg-warn/90"
                        @click.stop="onArchive(inst.id, s.alias)"><Moon :size="16" /></button>
                <button data-test="swipe-delete" :aria-label="$t('common.delete')" :title="$t('common.delete')"
                        class="flex w-14 shrink-0 items-center justify-center bg-danger text-white transition-colors hover:bg-danger/90"
                        @click.stop="askDelete(inst.id, s.alias)"><Trash2 :size="16" /></button>
              </template>
            </div>
            </div>
            <!-- ⋯ dropdown: a child of the ROW (not the clip layer), so it overflows the
                 row downward instead of being clipped to the row's height.
                 `@mousedown.stop`: the document-level mousedown listener nulls openMenuFor,
                 which would unmount this menu in the microtask BEFORE the item's click
                 fires (mousedown → Vue flush → mouseup → click on a detached node), so
                 archive/delete silently no-op. Stopping mousedown keeps the menu mounted. -->
            <div v-if="inst.online && openMenuFor === `${inst.id}:${s.alias}`" @mousedown.stop
                 class="absolute right-1 top-full z-30 mt-0.5 w-32 rounded-md border border-border bg-surface py-1 shadow-lg">
              <button data-test="action-rename" class="flex w-full items-center gap-2 px-2.5 py-1 text-left text-[12px] text-fg hover:bg-raised" @click.stop="startRename(inst.id, s)"><Pencil :size="12" />{{ $t("instance.renameSession") }}</button>
              <button v-if="!s.archived" data-test="action-archive" :title="$t('instance.sleepTooltip')" class="flex w-full items-center gap-2 px-2.5 py-1 text-left text-[12px] text-fg hover:bg-raised" @click.stop="onArchive(inst.id, s.alias)"><Moon :size="12" />{{ $t("instance.archiveSession") }}</button>
              <button v-else data-test="action-unarchive" class="flex w-full items-center gap-2 px-2.5 py-1 text-left text-[12px] text-fg hover:bg-raised" @click.stop="onUnarchive(inst.id, s.alias)"><ArchiveRestore :size="12" />{{ $t("instance.unarchiveSession") }}</button>
              <button data-test="delete-session" class="flex w-full items-center gap-2 px-2.5 py-1 text-left text-[12px] text-danger hover:bg-danger/10" @click.stop="askDelete(inst.id, s.alias)"><Trash2 :size="12" />{{ $t("common.delete") }}</button>
            </div>
            </div>
            <!-- Per-group sleeping-session controls (grouped modes): page sleeping rows
                 from the server 5 at a time instead of flat mode's one-shot snapshot. -->
            <template v-if="grp.key !== null && inst.online">
              <button data-test="group-toggle-archived"
                      class="flex w-full items-center gap-1.5 rounded px-2.5 py-1 text-left text-[11px] font-medium text-fg-muted transition-colors hover:bg-fg/5 hover:text-fg"
                      @click.stop="void toggleGroupArchived(inst, grp.key)">
                <ArchiveRestore :size="11" class="shrink-0" />
                {{ $t(groupArchivedIsExpanded(inst, grp.key) ? "instance.hideArchivedSessions" : "instance.showArchivedSessions") }}
              </button>
              <div v-if="grp.archivedState?.loading" data-test="group-archived-loading"
                   class="py-0.5 pl-2.5 text-[11px] text-fg-muted">{{ $t("instance.loading") }}</div>
              <button v-else-if="groupArchivedIsExpanded(inst, grp.key) && grp.archivedState?.hasMore" data-test="group-load-more"
                      class="w-full py-0.5 pl-2.5 text-left text-[11px] font-medium text-accent hover:text-fg"
                      @click.stop="loadMoreGroupArchived(inst, grp.key)">
                {{ $t("instance.loadMoreSessions") }}
              </button>
            </template>
          </div>
        </div>

        <!-- The row cap only applies in flat mode — grouped modes render everything
             and rely on per-group collapse to keep the list short. -->
        <button v-if="groupModeOf(inst) === 'instance' && activeSessions(inst).length > SESSION_CAP && !sessionsExpanded.has(inst.id)"
                data-test="sessions-show-more"
                class="w-full py-1 pl-2.5 text-left text-[11px] font-medium text-fg-muted hover:text-fg"
                @click.stop="toggleSessions(inst.id)">
          {{ $t("instance.showMoreSessions", { n: activeSessions(inst).length - SESSION_CAP }) }}
        </button>
        <button v-else-if="groupModeOf(inst) === 'instance' && activeSessions(inst).length > SESSION_CAP"
                data-test="sessions-collapse"
                class="w-full py-1 pl-2.5 text-left text-[11px] font-medium text-fg-muted hover:text-fg"
                @click.stop="toggleSessions(inst.id)">
          {{ $t("instance.collapseSessions") }}
        </button>

              <!-- Instance-level ACTIVE-list load-more, deliberately NOT mode-gated: grouped modes
                   still page active sessions 20 at a time, and this is their only "next page" entry. -->
              <button v-if="inst.sessionsHasMore && !inst.sessionsLoading" data-test="sessions-load-more"
                class="w-full py-1 pl-2.5 text-left text-[11px] font-medium text-accent hover:text-fg"
                @click.stop="store.loadMoreSessions(inst.id).catch(() => {})">
          {{ $t("instance.loadMoreSessions") }}
        </button>
        <div v-if="inst.sessionsLoaded && !activeSessions(inst).length && !archivedIsExpanded(inst.id)" data-test="no-sessions"
             class="py-1 pl-2.5 text-[11px] text-fg-muted">{{ $t("instance.noSessions") }}</div>

        <!-- Per-instance footer: icon-only actions (new session / manage), labelled via title+aria. -->
        <div class="flex items-center gap-0.5 pb-px pl-2 pt-0.5">
          <button v-if="inst.online && inst.sessionsLoaded && groupModeOf(inst) === 'instance'" data-test="toggle-archived-sessions"
                  :title="$t(archivedIsExpanded(inst.id) ? 'instance.hideArchivedSessions' : 'instance.showArchivedSessions')"
                  :aria-label="$t(archivedIsExpanded(inst.id) ? 'instance.hideArchivedSessions' : 'instance.showArchivedSessions')"
                  class="grid h-6 w-6 place-items-center rounded text-fg-muted transition-colors hover:bg-raised hover:text-fg"
                  @click="void toggleArchived(inst.id)"><ArchiveRestore :size="13" /></button>
          <button data-test="new-session" :title="$t('instance.newSession')" :aria-label="$t('instance.newSession')"
                  class="grid h-6 w-6 place-items-center rounded text-accent transition-colors hover:bg-accent/10"
                  @click="dialogFor = { id: inst.id, name: inst.name }"><Plus :size="14" /></button>
          <button data-test="manage-instance" :title="$t('instance.manage')" :aria-label="$t('instance.manage')"
                  class="grid h-6 w-6 place-items-center rounded text-fg-muted transition-colors hover:bg-raised hover:text-fg"
                  @click="manageFor = { id: inst.id, name: inst.name }"><Settings2 :size="13" /></button>
        </div>
      </div>
    </div>

    <NewSessionDialog v-if="dialogFor" :instance-id="dialogFor.id" :instance-name="dialogFor.name"
                      :preset-agent="dialogFor.presetAgent" :preset-workspace="dialogFor.presetWorkspace"
                      @close="dialogFor = null" @created="onSessionCreated" />
    <ManageInstanceDialog v-if="manageFor" :instance-id="manageFor.id" :instance-name="manageFor.name"
                          @close="manageFor = null" />
  </nav>
</template>
