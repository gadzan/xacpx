<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { ArchiveRestore, Ban, Bot, Check, ChevronRight, Folder, Link2, Loader2, MessageSquare, Monitor, Moon, MoreHorizontal, Pencil, Plus, Settings2, SquareTerminal, Trash2, Unplug, Users, Filter } from "lucide-vue-next";
import { useInstancesStore, groupArchivedKey, parseGroupArchivedKey, supportsBotDedicatedWorkspaceCleanup, supportsDesktop } from "../stores/instances";
import { useChatStore } from "../stores/chat";
import { useCenterTabsStore, sessionKey } from "../stores/center-tabs";
import { useTerminalStore } from "../stores/terminal";
import { useDirectBotsStore } from "../stores/direct-bots";
import { useGroupsStore } from "../stores/groups";
import { detachSessionTerminal } from "../lib/session-terminal";
import { confirm } from "../lib/use-confirm";
import { showActionToast } from "../lib/use-action-toast";
import { pushToast } from "../lib/use-toasts";
import { useSwipeActions } from "../lib/use-swipe-actions";
import { useDropdown } from "../lib/use-dropdown";
import type { DropdownGroup } from "../lib/use-dropdown";
import { groupSessions, dedupedSessionName, sessionPresentationName, archivedLast } from "../lib/sidebar-group-mode";
import NewSessionDialog from "./NewSessionDialog.vue";
import ManageInstanceDialog from "./ManageInstanceDialog.vue";
import AgentIcon from "./AgentIcon.vue";
import BotAvatar from "./BotAvatar.vue";
import BotDialog from "./BotDialog.vue";
import GroupDialog from "./GroupDialog.vue";
import BotRemovalDialog from "./BotRemovalDialog.vue";
import DropdownPanel from "./DropdownPanel.vue";
import Tooltip from "./Tooltip.vue";
import type { GroupArchivedMode, GroupArchivedState, InstanceView } from "../stores/instances";
import type { BotDetailDto, BotSummaryDto, GroupSummaryDto } from "@ganglion/xacpx-relay-protocol";

// Local directive: focus + select an element on mount (the rename input).
const vFocus = {
  mounted(el: HTMLInputElement) { el.focus(); el.select(); },
};

const store = useInstancesStore();
const chat = useChatStore();
const centerTabs = useCenterTabsStore();
const terminals = useTerminalStore();
const directBotsStore = useDirectBotsStore();
const groupsStore = useGroupsStore();
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
const emit = defineEmits<{
  select: [instanceId: string, alias: string];
  selectBot: [instanceId: string, botId: string];
  selectGroup: [instanceId: string, groupId: string];
  /** Instance-level Desktop open: independent of any chat/session selection. */
  openDesktop: [instanceId: string];
}>();
const dialogFor = ref<{ id: string; name: string; presetAgent?: string; presetWorkspace?: string } | null>(null);
const manageFor = ref<{ id: string; name: string } | null>(null);
const botDialogFor = ref<{
  instanceId: string;
  instanceName: string;
  bot?: BotDetailDto | BotSummaryDto;
  resumeGroupCreate?: boolean;
} | null>(null);
const groupDialogFor = ref<{ instanceId: string; instanceName: string; group?: GroupSummaryDto } | null>(null);

const instanceNavMode = ref<Record<string, "sessions" | "bots" | "groups">>({});
function modeFor(instanceId: string): "sessions" | "bots" | "groups" {
  return instanceNavMode.value[instanceId] ?? "sessions";
}
function setMode(instanceId: string, mode: "sessions" | "bots" | "groups"): void {
  instanceNavMode.value = { ...instanceNavMode.value, [instanceId]: mode };
  if (mode === "bots" && !directBotsStore.botsLoaded[instanceId]) {
    void directBotsStore.loadBots(instanceId).catch(() => {});
  }
  if (mode === "groups" && !groupsStore.groupsLoaded[instanceId]) {
    void groupsStore.loadGroups(instanceId).catch(() => {});
  }
}
function onBotTap(instanceId: string, botId: string): void {
  emit("selectBot", instanceId, botId);
}
function onGroupTap(instanceId: string, groupId: string): void {
  emit("selectGroup", instanceId, groupId);
}
/** Reload the Groups list after a failed fetch. groupsLoaded stays false on
 *  failure, so this is also what the next Groups-mode entry does — the
 *  affordance just lets the user trigger it without leaving the mode. */
function retryGroupsLoad(instanceId: string): void {
  void groupsStore.loadGroups(instanceId).catch(() => {});
}
function onBotSaved(bot: BotDetailDto): void {
  const opened = botDialogFor.value;
  if (opened && !opened.resumeGroupCreate) emit("selectBot", opened.instanceId, bot.id);
}
// BotDialog emits close after saved, so the Group form reopens here on both paths.
function onBotDialogClose(): void {
  const opened = botDialogFor.value;
  botDialogFor.value = null;
  if (opened?.resumeGroupCreate) groupDialogFor.value = { instanceId: opened.instanceId, instanceName: opened.instanceName };
}
function onGroupSaved(group: GroupSummaryDto): void {
  const opened = groupDialogFor.value;
  if (opened && !opened.group) emit("selectGroup", opened.instanceId, group.id);
}
function onGroupCreateBot(): void {
  const opened = groupDialogFor.value;
  groupDialogFor.value = null;
  if (opened) botDialogFor.value = { instanceId: opened.instanceId, instanceName: opened.instanceName, resumeGroupCreate: true };
}
const removalFor = ref<{ instanceId: string; bot: BotSummaryDto } | null>(null);

const disabledBotsOpen = ref<Set<string>>(new Set());
const enablingBots = ref<Set<string>>(new Set());
function botsWithEnabled(instanceId: string, enabled: boolean): BotSummaryDto[] {
  return (directBotsStore.botsByInstance[instanceId] ?? []).filter((b) => b.enabled === enabled);
}
function isBotSelected(instanceId: string, botId: string): boolean {
  return directBotsStore.instanceId === instanceId && directBotsStore.selectedBotId === botId;
}
// The enabled Bots render in the list; the disabled ones live under the 已禁用
// group title row below it (collapsed by default). The selected Bot keeps its
// row while the Disabled list is collapsed, so disabling the open Bot does not
// make it vanish from the sidebar.
function enabledBots(instanceId: string): BotSummaryDto[] {
  return botsWithEnabled(instanceId, true);
}
function shownDisabledBots(instanceId: string): BotSummaryDto[] {
  const disabled = botsWithEnabled(instanceId, false);
  if (disabledBotsOpen.value.has(instanceId)) return disabled;
  return disabled.filter((b) => isBotSelected(instanceId, b.id));
}
function toggleDisabledBots(instanceId: string): void {
  const next = new Set(disabledBotsOpen.value);
  if (next.has(instanceId)) next.delete(instanceId);
  else next.add(instanceId);
  disabledBotsOpen.value = next;
}
// One render list for both sections: enabled rows, then the Disabled title row
// (present whenever a disabled Bot exists, even while its rows stay hidden), then
// the disabled rows. Sharing the list is what lets the template keep a single
// Bot row instead of two near-identical copies.
type BotListEntry = { kind: "bot"; bot: BotSummaryDto } | { kind: "disabled-toggle" };
function botListEntries(instanceId: string): BotListEntry[] {
  const entries: BotListEntry[] = enabledBots(instanceId).map((bot) => ({ kind: "bot", bot }));
  if (!botsWithEnabled(instanceId, false).length) return entries;
  entries.push({ kind: "disabled-toggle" });
  return [...entries, ...shownDisabledBots(instanceId).map((bot): BotListEntry => ({ kind: "bot", bot }))];
}
// Enabling and disabling are the same persisted patch (`enabled` on the Bot);
// only the feedback copy differs. Queued work may start on re-enable, so the
// success toast says so instead of a bare "saved".
async function setBotEnabled(instanceId: string, bot: BotSummaryDto, enabled: boolean): Promise<void> {
  const key = `${instanceId}:${bot.id}`;
  if (enablingBots.value.has(key)) return;
  enablingBots.value = new Set(enablingBots.value).add(key);
  try {
    await directBotsStore.updateBot(instanceId, bot.id, { enabled });
    pushToast(
      "success",
      enabled ? "bot.lifecycle.enabled" : "bot.lifecycle.disabled",
      { name: bot.name },
    );
  } catch {
    pushToast(
      "error",
      enabled ? "bot.lifecycle.enableFailed" : "bot.lifecycle.disableFailed",
      { name: bot.name },
    );
    void directBotsStore.loadBots(instanceId).catch(() => {});
  } finally {
    const next = new Set(enablingBots.value);
    next.delete(key);
    enablingBots.value = next;
  }
}

function openBotRemoval(instanceId: string, bot: BotSummaryDto): void {
  if (bot.retired) return; // A removed Bot has nothing left to remove.
  removalFor.value = { instanceId, bot };
}

// ── Per-Bot ⋯ menu ─────────────────────────────────────────────────────────
// Its own controller (not the session one): the trigger is always visible on every
// Bot row, so two menus of different kinds must never share state. Keys are
// namespaced with `bot:` because Bot ids and session aliases come from different
// id spaces and a bare `${instanceId}:${id}` key could collide.
const botMenuDd = useDropdown();
const botMenuFor = ref<string | null>(null);
function botMenuKey(instanceId: string, botId: string): string {
  return `${instanceId}:bot:${botId}`;
}
function botMenuOpen(instanceId: string, botId: string): boolean {
  return botMenuDd.open && botMenuFor.value === botMenuKey(instanceId, botId);
}
function toggleBotMenu(instanceId: string, botId: string, el: HTMLElement): void {
  const key = botMenuKey(instanceId, botId);
  botMenuDd.trigger = el;
  if (botMenuDd.open && botMenuFor.value === key) {
    botMenuDd.closeMenu();
    return;
  }
  botMenuFor.value = key;
  botMenuDd.openMenu();
}
/** Edit / enable-or-disable / remove. A removed Bot can do neither of the last two. */
function botMenuGroups(instanceId: string, bot: BotSummaryDto): DropdownGroup[] {
  const pending = enablingBots.value.has(`${instanceId}:${bot.id}`);
  return [
    {
      rows: [
        { value: "edit", label: t("bot.actions.edit"), icon: Pencil, testId: "bot-menu-edit" },
        {
          value: "toggle",
          label: t(bot.enabled ? "bot.actions.disable" : "bot.actions.enable"),
          icon: Ban,
          disabled: pending || bot.retired === true,
          testId: "bot-menu-toggle",
        },
        {
          value: "delete",
          label: bot.retired ? t("bot.removal.removed") : t("bot.removal.action"),
          icon: Trash2,
          danger: !bot.retired,
          disabled: bot.retired === true,
          separatorBefore: true,
          testId: "bot-menu-delete",
        },
      ],
    },
  ];
}
function onBotMenuSelect(instanceId: string, instanceName: string, bot: BotSummaryDto, value: string): void {
  botMenuDd.closeMenu();
  if (value === "edit") botDialogFor.value = { instanceId, instanceName, bot };
  else if (value === "toggle") void setBotEnabled(instanceId, bot, !bot.enabled);
  else if (value === "delete") openBotRemoval(instanceId, bot);
}

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
// title space stay unchanged. Agent-grouping drops the glyph, so that path pins the
// badge with position:absolute in the button's left padding — out of the flex flow,
// so it neither consumes gap-2 nor overlaps the attention-dot.
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
  if (inst) await ensureSleepingLoaded(inst);
  next.add(id);
  archivedExpanded.value = next;
}
// The one instance-level 「已睡眠会话」 filter drives both layouts: flat mode loads the
// instance snapshot, grouped modes load the first sleeping page of every visible group.
async function ensureSleepingLoaded(inst: InstanceView): Promise<void> {
  const mode = groupModeOf(inst);
  if (mode === "instance") {
    if (!inst.archivedSessionsLoaded) await store.loadArchivedSessions(inst.id).catch(() => {});
    return;
  }
  await Promise.all(groupSessions(activeSessions(inst), mode).map((g) => {
    const state = inst.groupArchived?.[groupArchivedKey(mode, g.key)];
    if (state?.loaded || state?.loading) return undefined;
    return store.loadGroupArchivedSessions(inst.id, mode, g.key).catch(() => {});
  }));
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
  // Sleeping-only groups appear only while the sleeping filter is on.
  for (const recordKey of archivedIsExpanded(inst.id) ? Object.keys(inst.groupArchived ?? {}) : []) {
    const parsed = parseGroupArchivedKey(recordKey);
    if (!parsed || parsed.mode !== mode) continue;
    if (!present.has(parsed.groupKey)) groups.push({ key: parsed.groupKey, sessions: [] });
  }
  return groups.map((g) => {
    const state = inst.groupArchived?.[groupArchivedKey(mode, g.key)];
    const expanded = archivedIsExpanded(inst.id);
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

// Group view state is keyed by mode so switching modes never carries stale state over.
function groupViewKey(inst: InstanceView, key: string): string {
  return `${inst.id}:${groupModeOf(inst)}:${key}`;
}
// While the sleeping filter is on, a mode switch or a newly appearing group loads
// whatever sleeping rows that layout still lacks (loaded/loading groups are skipped).
watch(
  () => store.instances
    .filter((inst) => inst.online && archivedIsExpanded(inst.id))
    .map((inst) => {
      const mode = groupModeOf(inst);
      const keys = mode === "instance" ? [] : groupSessions(activeSessions(inst), mode).map((g) => g.key);
      return `${inst.id}|${mode}|${keys.join("\u0000")}`;
    })
    .join("\n"),
  () => {
    for (const inst of store.instances) {
      if (inst.online && archivedIsExpanded(inst.id)) void ensureSleepingLoaded(inst);
    }
  },
);
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

// Overflow (⋯) menu and the tab-row filter menu: one shared dropdown controller
// each (only one panel of a kind is ever open) keyed by the row/instance it serves.
const menuDd = useDropdown();
const menuFor = ref<string | null>(null);
const filterDd = useDropdown();
const filterFor = ref<string | null>(null);
function toggleMenuFor(key: string, el: HTMLElement): void {
  menuDd.trigger = el;
  if (menuDd.open && menuFor.value === key) {
    menuDd.closeMenu();
    return;
  }
  menuFor.value = key;
  menuDd.openMenu();
}
function toggleFilterFor(instanceId: string, el: HTMLElement): void {
  filterDd.trigger = el;
  if (filterDd.open && filterFor.value === instanceId) {
    filterDd.closeMenu();
    return;
  }
  filterFor.value = instanceId;
  filterDd.openMenu();
}
/** The ⋯ menu rows for a session (role=menu: rename, sleep/wake, delete). */
function menuGroups(s: { alias: string; archived?: boolean }): DropdownGroup[] {
  return [
    {
      rows: [
        { value: "rename", label: t("instance.renameSession"), icon: Pencil, testId: "action-rename" },
        s.archived
          ? { value: "unarchive", label: t("instance.unarchiveSession"), icon: ArchiveRestore, testId: "action-unarchive" }
          : { value: "archive", label: t("instance.archiveSession"), icon: Moon, testId: "action-archive" },
        { value: "delete", label: t("common.delete"), icon: Trash2, danger: true, separatorBefore: true, testId: "delete-session" },
      ],
    },
  ];
}

/** ⋯ menu activation: rename / sleep / wake / delete for the row it serves. */
function onMenuSelect(id: string, s: { alias: string; archived?: boolean; displayName?: string }, value: string): void {
  if (value === "rename") startRename(id, s);
  else if (value === "archive") void onArchive(id, s.alias);
  else if (value === "unarchive") void onUnarchive(id, s.alias);
  else if (value === "delete") void askDelete(id, s.alias);
}

// Inline rename: the row currently being renamed, keyed `${instanceId}:${alias}`, plus its draft.
const renamingFor = ref<string | null>(null);
const renameDraft = ref("");

function startRename(id: string, s: { alias: string; displayName?: string }) {
  menuDd.closeMenu();
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
// Outside mousedown closes the touch swipe reveal. Clicks inside an open dropdown
// panel belong to that panel (the unified controller owns its own outside-close via
// pointerdown), so they must not tear the panel down before the item's click lands.
function onDocPointerDown(e: MouseEvent) {
  const target = e.target as Element | null;
  if (target?.closest?.("[data-dd-panel]")) return;
  // A mousedown on a panel's own trigger must not close it: the click that follows
  // would read "closed" and reopen it, so the trigger could never toggle it shut.
  if (!(target && menuDd.trigger?.contains(target))) menuDd.closeMenu();
  if (!(target && filterDd.trigger?.contains(target))) filterDd.closeMenu();
  openSwipeFor.value = null;
}
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
  menuDd.closeMenu();
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
  menuDd.closeMenu();
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
  menuDd.closeMenu();
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

/** Open the create-session dialog for a specific instance. Exposed so the mobile home's
 *  FAB (DashboardView) can reuse this component's single dialog + created-handler instead
 *  of lifting dialog state up or mounting a second copy of the tree. */
function openNewSession(instanceId: string): void {
  const inst = store.byId(instanceId);
  if (!inst) return;
  dialogFor.value = { id: inst.id, name: inst.name };
}
defineExpose({ openNewSession });

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
          // Leave the left 24px to the iOS Safari back swipe: a row that captured the
          // pointer there would swallow the system gesture.
          leftEdgeGuard: 24,
          onMove: (dx) => { menuDd.closeMenu(); draggingKey.value = key; dragDx.value = dx; },
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
  <nav class="thin-scroll flex h-full flex-1 flex-col space-y-1.5 overflow-y-auto px-2 pb-2 pt-1.5 max-lg:pb-24">
    <!-- One instance card: header row + session area (flat or grouped) + footer.
         The card background is the level-1 zone of the tinted-zone hierarchy; group
         zones inside are one step lighter (visually isomorphic across all modes). -->
    <!-- No whole-card opacity: offline text fell below AA (muted name 3.21 dark / 2.52 light);
         the dimmed state reads from the muted name/label/dot, which pass AA at full opacity. -->
    <div v-for="inst in store.instances" :key="inst.id" data-test="instance-card"
         class="rounded-lg bg-surface/60 p-[3px]">
      <!-- Instance header: a flex CONTAINER (not one <button>) so the expand
           toggle and the sibling Desktop entry stay independent interactive
           controls — a nested <button> is invalid HTML and breaks keyboard
           semantics. -->
      <div class="group flex min-h-7 items-center gap-1.5 rounded-sm px-1.5 transition-colors hover:bg-surface-2">
        <button type="button"
                class="flex min-w-0 flex-1 items-center gap-1.5 rounded-sm text-left transition-colors"
                :aria-expanded="isExpanded(inst.id)"
                data-test="instance-header-toggle"
                @click="toggle(inst.id)">
          <ChevronRight :size="12" class="shrink-0 text-fg-muted transition-transform duration-150" :class="isExpanded(inst.id) ? 'rotate-90' : ''" />
          <span class="h-2 w-2 shrink-0 rounded-full" :class="inst.online ? 'bg-run' : 'bg-fg-muted'" data-test="online-dot" />
          <span class="truncate text-ui font-semibold" :class="inst.online ? 'text-fg' : 'text-fg-muted'"
                :title="inst.coreVersion ? $t('instance.coreVersion', { version: inst.coreVersion }) : $t('instance.coreVersionUnknown')">{{ inst.name }}</span>
          <span v-if="inst.online" class="shrink-0 font-mono text-xs tabular-nums text-fg-muted">{{ activeSessions(inst).length }}</span>
          <span v-else-if="!inst.online" class="shrink-0 text-xs font-medium text-fg-muted">{{ $t("instance.offline") }}</span>
        </button>
        <!-- Instance-level Desktop entry. Deliberately NOT session-scoped: the
             design makes Desktop an instance resource, so an online desktop-capable
             instance with zero sessions (or one viewed in Direct Bot mode) must
             still reach it. Only shown for online desktop-capable instances, so an
             instance whose connector predates the capability (or keeps desktop
             disabled — the default) shows neither the button nor a bogus
             "Offline" label. -->
        <button v-if="supportsDesktop(inst)" type="button"
                data-test="instance-desktop"
                :title="$t('desktop.title')"
                :aria-label="$t('desktop.title')"
                class="grid h-10 w-10 lg:h-6 lg:w-6 shrink-0 place-items-center rounded-sm text-fg-muted transition-colors hover:bg-surface-2 hover:text-accent"
                @click="emit('openDesktop', inst.id)">
          <Monitor :size="13" />
        </button>
        <div v-if="inst.online && isExpanded(inst.id) && modeFor(inst.id) === 'sessions'" class="relative shrink-0">
          <button type="button"
                  data-test="instance-filter"
                  :aria-label='$t("instance.filter")'
                  :aria-haspopup="true"
                  :aria-expanded="filterDd.open && filterFor === inst.id"
                  class="relative grid h-10 w-10 lg:h-6 lg:w-6 place-items-center rounded-sm transition-colors"
                  :class="filterDd.open && filterFor === inst.id ? 'bg-surface-2 text-fg' : 'text-fg-muted hover:bg-surface-2 hover:text-fg'"
                  @click.stop="toggleFilterFor(inst.id, $event.currentTarget as HTMLElement)">
            <Filter :size="14" />
            <span v-if="archivedIsExpanded(inst.id)" class="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-accent" />
          </button>
          <DropdownPanel v-if="filterDd.open && filterFor === inst.id" :dd="filterDd" tone="raised" width="w-52"
                         placement="bottom-end" role="menu"
                         :title='$t("instance.filter")' test-id="instance-filter-menu"
                         :nav-count="1" @navigate="void toggleArchived(inst.id)">
            <template #default="{ mobile }">
              <p class="px-2 pb-1 pt-1.5 text-xs text-fg-muted">{{ $t("instance.filterShow") }}</p>
              <button type="button" data-test="filter-sleeping-sessions"
                      class="flex w-full items-center gap-2 rounded-sm px-2 text-left text-sm font-medium text-fg"
                      :class="[mobile ? 'h-11' : 'h-8', !mobile && filterDd.highlight === 0 ? 'bg-surface-2' : '']"
                      @click="void toggleArchived(inst.id)">
                <Moon :size="14" class="shrink-0 text-fg-muted" />
                <span class="flex-1 truncate">{{ $t("instance.sleepingSessions") }}</span>
                <Check v-if="archivedIsExpanded(inst.id)" :size="14" class="shrink-0 text-accent" />
              </button>
              <p class="px-2 pb-1 text-xs text-fg-muted">{{ $t("instance.filterSleepHint") }}</p>
            </template>
          </DropdownPanel>
        </div>
      </div>

      <!-- Session area: flat rows, or tinted group zones (workspace/agent mode).
           Instead of a border-l indent rail, hierarchy reads from background tint +
           a very small indent — grouped rows keep almost the full row width. -->
      <div v-show="isExpanded(inst.id)" class="mt-px space-y-1 px-0.5 pb-0.5">
        <div v-if="inst.online" class="flex min-w-0 items-center gap-1 pb-1 mb-1 px-1">
          <button
            type="button"
            data-test="instance-nav-sessions"
            class="flex min-w-0 items-center gap-1 whitespace-nowrap rounded-sm px-1.5 py-0.5 text-xs font-medium transition-colors"
            :class="modeFor(inst.id) === 'sessions' ? 'bg-accent-soft text-accent font-semibold' : 'text-fg-muted hover:bg-surface-2 hover:text-fg'"
            @click="setMode(inst.id, 'sessions')"
          >
            <MessageSquare :size="11" class="shrink-0" />
            <span class="truncate" :title="$t('nav.sessions')">{{ $t("nav.sessions") }}</span>
          </button>
          <button
            type="button"
            data-test="instance-nav-bots"
            class="flex min-w-0 items-center gap-1 whitespace-nowrap rounded-sm px-1.5 py-0.5 text-xs font-medium transition-colors"
            :class="modeFor(inst.id) === 'bots' ? 'bg-accent-soft text-accent font-semibold' : 'text-fg-muted hover:bg-surface-2 hover:text-fg'"
            @click="setMode(inst.id, 'bots')"
          >
            <Bot :size="11" class="shrink-0" />
            <span class="truncate" :title="$t('nav.bots')">{{ $t("nav.bots") }}</span>
          </button>
          <button
            type="button"
            data-test="instance-nav-groups"
            class="flex min-w-0 items-center gap-1 whitespace-nowrap rounded-sm px-1.5 py-0.5 text-xs font-medium transition-colors"
            :class="modeFor(inst.id) === 'groups' ? 'bg-accent-soft text-accent font-semibold' : 'text-fg-muted hover:bg-surface-2 hover:text-fg'"
            @click="setMode(inst.id, 'groups')"
          >
            <Users :size="11" class="shrink-0" />
            <span class="truncate" :title="$t('nav.groups')">{{ $t("nav.groups") }}</span>
          </button>
        </div>

        <!-- BOTS MODE -->
        <div v-if="inst.online && modeFor(inst.id) === 'bots'" class="space-y-px">
          <div v-if="directBotsStore.botsByInstance[inst.id]?.length"
               data-test="bots-list-count"
               class="flex items-center gap-1.5 py-1 pl-2.5 text-xs text-fg-muted">
            <span>{{ $t("nav.bots") }}</span>
            <span class="font-mono tabular-nums">{{ directBotsStore.botsByInstance[inst.id].length }}</span>
          </div>
          <div v-if="(directBotsStore.loadingBotsByInstance[inst.id] ?? 0) > 0 && !directBotsStore.botsLoaded[inst.id]"
               data-test="bots-loading"
               class="py-1 pl-2.5 text-xs text-fg-muted">
            {{ $t("instance.loading") }}
          </div>
          <div v-else-if="!(directBotsStore.botsByInstance[inst.id] ?? []).length"
               data-test="no-bots"
               class="py-1 pl-2.5 text-xs text-fg-muted">
            {{ $t("bot.list.empty") }}
          </div>
          <div v-else-if="!botsWithEnabled(inst.id, true).length && !disabledBotsOpen.has(inst.id)"
               data-test="no-enabled-bots"
               class="py-1 pl-2.5 text-xs text-fg-muted">
            {{ $t("bot.list.allDisabled") }}
          </div>
          <template v-for="entry in botListEntries(inst.id)" :key="entry.kind === 'bot' ? entry.bot.id : 'disabled-toggle'">
            <button
              v-if="entry.kind === 'disabled-toggle'"
              type="button"
              data-test="bots-disabled-toggle"
              :aria-expanded="disabledBotsOpen.has(inst.id)"
              class="bot-disabled-toggle mt-1 flex h-7 w-full items-center gap-1 rounded-sm px-1.5 text-xs font-medium text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg"
              @click="toggleDisabledBots(inst.id)"
            >
              <ChevronRight :size="11" class="shrink-0 transition-transform duration-150" :class="disabledBotsOpen.has(inst.id) ? 'rotate-90' : ''" />
              <span>{{ $t("bot.list.disabledToggle", { count: botsWithEnabled(inst.id, false).length }) }}</span>
            </button>
            <div
              v-else
              data-test="bot-row"
              class="bot-sidebar-row relative flex h-10 items-center rounded-sm transition-colors"
              :class="isBotSelected(inst.id, entry.bot.id) ? 'bg-accent-soft' : 'hover:bg-surface-2'"
            >
              <button
                type="button"
                class="flex h-full min-w-0 flex-1 items-center gap-2 pl-2.5 pr-1.5 text-left"
                @click="onBotTap(inst.id, entry.bot.id)"
              >
                <BotAvatar :avatar="entry.bot.avatar" :driver="driverForAgentName(inst, entry.bot.agent)" :name="entry.bot.name" :size="24"
                           :disabled="!entry.bot.enabled" :retired="entry.bot.retired" :state="inst.online ? 'idle' : 'offline'"
                           :class="!entry.bot.enabled ? 'opacity-50' : ''" />
                <span class="flex min-w-0 flex-1 flex-col">
                  <span v-if="entry.bot.retired" data-test="bot-removed" class="truncate text-xs text-fg-muted">{{ $t("bot.removal.removed") }}</span>
                  <span data-test="bot-name" class="min-w-0 truncate text-ui font-medium"
                        :class="!entry.bot.enabled ? 'text-fg-muted' : (isBotSelected(inst.id, entry.bot.id) ? 'font-semibold text-accent' : 'text-fg')">
                    {{ entry.bot.name }}
                  </span>
                  <span v-if="entry.bot.role && !entry.bot.retired" class="truncate text-xs text-fg-muted">{{ entry.bot.role }}</span>
                </span>
                <span class="h-1.5 w-1.5 shrink-0 rounded-full"
                      :class="entry.bot.enabled ? 'bg-run' : 'bg-fg-muted'"
                      :title="entry.bot.enabled ? $t('bot.status.enabled') : $t('bot.status.disabled')" />
              </button>
              <button
                type="button"
                data-test="bot-menu-button"
                :aria-label="$t('common.more')"
                aria-haspopup="menu"
                :aria-expanded="botMenuOpen(inst.id, entry.bot.id)"
                class="bot-menu-trigger mr-1 grid h-10 w-10 shrink-0 place-items-center rounded-sm text-fg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent lg:h-7 lg:w-7"
                @click.stop="toggleBotMenu(inst.id, entry.bot.id, $event.currentTarget as HTMLElement)"
              >
                <span class="grid h-7 w-7 place-items-center rounded-sm transition-colors hover:bg-surface-2 hover:text-fg">
                  <MoreHorizontal :size="16" />
                </span>
              </button>
              <DropdownPanel
                v-if="botMenuOpen(inst.id, entry.bot.id)"
                :dd="botMenuDd"
                :groups="botMenuGroups(inst.id, entry.bot)"
                tone="raised"
                placement="bottom-end"
                role="menu"
                :title="entry.bot.name"
                test-id="bot-menu"
                @select="onBotMenuSelect(inst.id, inst.name, entry.bot, $event)"
              />
            </div>
          </template>

          <!-- Bots footer: new Bot + manage (the disabled toggle moved above the list). -->
          <div class="flex items-center gap-0.5 pb-px pl-2 pt-1">
            <button
              type="button"
              data-test="new-bot-button"
              class="flex items-center gap-1 rounded-sm px-2 py-1 text-xs font-medium text-accent hover:bg-accent-soft transition-colors"
              @click="botDialogFor = { instanceId: inst.id, instanceName: inst.name }"
            >
              <Plus :size="12" />
              <span>{{ $t("bot.actions.newBot") }}</span>
            </button>
            <button
              data-test="manage-instance-from-bots"
              :title="$t('instance.manage')"
              :aria-label="$t('instance.manage')"
              class="grid h-10 w-10 lg:h-6 lg:w-6 place-items-center rounded-sm text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg"
              @click="manageFor = { id: inst.id, name: inst.name }"
            >
              <Settings2 :size="13" />
            </button>
          </div>
        </div>
        <!-- GROUPS MODE -->
        <div v-if="inst.online && modeFor(inst.id) === 'groups'" class="space-y-px">
          <div v-if="groupsStore.groupsByInstance[inst.id]?.length"
               data-test="groups-list-count"
               class="flex items-center gap-1.5 py-1 pl-2.5 text-xs text-fg-muted">
            <span>{{ $t("nav.groups") }}</span>
            <span class="font-mono tabular-nums">{{ groupsStore.groupsByInstance[inst.id].length }}</span>
          </div>
          <div v-if="(groupsStore.loadingGroupsByInstance[inst.id] ?? 0) > 0 && !groupsStore.groupsLoaded[inst.id]"
               data-test="groups-loading"
               class="py-1 pl-2.5 text-xs text-fg-muted">
            {{ $t("instance.loading") }}
          </div>
          <div v-else-if="groupsStore.groupsListErrorByInstance[inst.id] !== undefined && !groupsStore.groupsLoaded[inst.id]"
               data-test="groups-load-error"
               class="py-1 pl-2.5 text-xs text-fg-muted">
            <span>{{ $t("group.list.loadFailed") }}</span>
            <button type="button"
                    data-test="groups-retry"
                    class="ml-1.5 font-medium text-accent hover:underline"
                    @click="retryGroupsLoad(inst.id)">
              {{ $t("common.retry") }}
            </button>
          </div>
          <div v-else-if="groupsStore.groupsLoaded[inst.id] && !(groupsStore.groupsByInstance[inst.id] ?? []).length"
               data-test="no-groups"
               class="py-1 pl-2.5 text-xs text-fg-muted">
            {{ $t("group.list.empty") }}
          </div>
          <div v-for="g in (groupsStore.groupsByInstance[inst.id] ?? [])"
               :key="g.id"
               data-test="group-row"
               class="group relative flex items-center rounded-sm transition-colors"
               :class="groupsStore.selectedGroupId === g.id && groupsStore.instanceId === inst.id ? 'bg-accent-soft' : 'hover:bg-surface-2'">
            <button
              class="relative flex min-w-0 flex-1 items-center gap-2 py-2 pl-2.5 pr-1.5 text-left"
              @click="onGroupTap(inst.id, g.id)"
            >
              <span class="relative shrink-0">
                <Users :size="14" class="text-accent" />
              </span>
              <div class="flex min-w-0 flex-1 flex-col">
                <span data-test="group-name" class="min-w-0 truncate text-ui font-medium"
                      :class="groupsStore.selectedGroupId === g.id && groupsStore.instanceId === inst.id ? 'font-semibold text-accent' : 'text-fg'">
                  {{ g.title }}
                </span>
                <span class="truncate text-xs text-fg-muted">{{ $t("group.header.members", g.botIds.length) }}</span>
              </div>
              <span v-if="g.lifecycle === 'deleting'"
                    data-test="group-deleting-badge"
                    class="shrink-0 rounded-sm bg-warn/15 px-1.5 py-px text-xs font-medium text-warn">
                {{ $t("group.list.deleting") }}
              </span>
            </button>
            <div class="flex items-center gap-0.5 pr-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
              <button
                type="button"
                data-test="edit-group-tree-button"
                :title="$t('group.manage.editTitle')"
                :aria-label="$t('group.manage.editTitle')"
                class="grid h-10 w-10 lg:h-5 lg:w-5 place-items-center rounded-sm text-fg-muted hover:bg-surface-2 hover:text-fg"
                @click.stop="groupDialogFor = { instanceId: inst.id, instanceName: inst.name, group: g }"
              >
                <Pencil :size="11" />
              </button>
            </div>
          </div>

          <div class="flex items-center justify-between pb-px pl-2 pt-1">
            <button
              type="button"
              data-test="new-group-button"
              class="flex items-center gap-1 rounded-sm px-2 py-1 text-xs font-medium text-accent transition-colors hover:bg-accent-soft"
              @click="groupDialogFor = { instanceId: inst.id, instanceName: inst.name }"
            >
              <Plus :size="12" />
              <span>{{ $t("group.manage.newGroup") }}</span>
            </button>
          </div>
        </div>

        <!-- SESSIONS MODE -->
        <template v-else-if="modeFor(inst.id) === 'sessions'">
        <button v-if="inst.online && !inst.sessionsLoaded && !inst.sessionsLoading" data-test="load-sessions"
                class="flex w-full items-center gap-1.5 rounded-sm px-2.5 py-1 text-left text-xs font-medium text-accent hover:bg-accent-soft"
                @click.stop="store.loadSessions(inst.id).catch(() => {})">
          <ChevronRight :size="11" />{{ $t("instance.loadSessions") }}
        </button>
        <div v-if="inst.online && inst.sessionsLoading" data-test="sessions-loading"
             class="py-1 pl-2.5 text-xs text-fg-muted">{{ $t("instance.loading") }}</div>
        <div v-for="grp in sectionsFor(inst)" :key="grp.key ?? '~flat'"
             :class="grp.key !== null ? 'rounded-sm bg-fg/[0.035] p-0.5' : 'space-y-px'"
             :data-test="grp.key !== null ? 'session-group' : undefined">
          <!-- Group header: chevron + kind icon + name + count; hover ＋ creates in-group. -->
          <div v-if="grp.key !== null" class="group/hdr flex items-center gap-0.5">
            <button data-test="group-header" :aria-expanded="!isGroupCollapsed(inst, grp.key)"
                    class="flex h-6 min-w-0 flex-1 items-center gap-1.5 rounded-sm px-1.5 text-left transition-colors hover:bg-fg/5"
                    @click="toggleGroup(inst, grp.key)">
              <ChevronRight :size="11" class="shrink-0 text-fg-muted transition-transform duration-150" :class="isGroupCollapsed(inst, grp.key) ? '' : 'rotate-90'" />
              <Folder v-if="groupModeOf(inst) === 'workspace'" :size="12" class="shrink-0 text-fg-muted" />
              <AgentIcon v-else :driver="driverForAgentName(inst, grp.key)" :title="grp.key" :size="13" />
              <span data-test="group-name" class="min-w-0 truncate text-xs font-semibold text-fg-muted">{{ grp.key }}</span>
              <span data-test="group-count" class="shrink-0 font-mono text-xs tabular-nums text-fg-muted">{{ grp.sessions.length }}</span>
            </button>
            <button data-test="group-new-session" :title="$t('instance.groupNewSession', { name: grp.key })" :aria-label="$t('instance.groupNewSession', { name: grp.key })"
                    class="grid h-10 w-10 lg:h-5 lg:w-5 shrink-0 place-items-center rounded-sm text-accent transition-colors hover:bg-accent-soft opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/hdr:opacity-100"
                    @click.stop="openGroupDialog(inst, grp.key)"><Plus :size="12" /></button>
          </div>
          <div v-show="grp.key === null || !isGroupCollapsed(inst, grp.key)" class="space-y-px" :class="grp.key !== null ? 'pl-2' : ''">
            <div
              v-for="s in sectionRows(grp)"
              :key="s.alias"
              data-test="session-row"
              class="group relative rounded-sm"
            >
            <!-- Clip layer: bounds ONLY the swipe track so the off-screen action blocks
                 stay hidden until revealed. The row itself is NOT clipped, so the ⋯
                 dropdown (rendered below as a row child) can overflow past the row. -->
            <div class="overflow-hidden rounded-sm">
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
              <div class="relative flex w-full shrink-0 items-center rounded-sm transition-colors"
                   :class="isSelected(inst.id, s.alias) ? 'bg-accent-soft' : 'hover:bg-surface-2'">
                <button
                  class="relative flex min-h-[52px] lg:min-h-0 min-w-0 flex-1 items-center gap-2 py-2 pl-2.5 pr-1.5 text-left"
                  @click="onRowTap(inst.id, s.alias)"
                >
                  <Loader2 v-if="s.creating" data-test="session-creating" :size="12" class="shrink-0 animate-spin motion-reduce:animate-none text-accent" />
                  <!-- A blocking question outranks every other signal: the turn is
                       parked until someone answers, and the form itself only renders
                       inside that session's pane, so a dot here is the only thing an
                       operator looking elsewhere gets before the window closes. -->
                  <span v-else-if="!s.archived && directBotsStore.pendingSessionInteractionFor(inst.id, s.alias)" data-test="attention-dot" data-attention="question"
                        class="pulse-dot h-2 w-2 shrink-0 rounded-full bg-warn"
                        :title="t('bot.interaction.waiting')" :aria-label="t('bot.interaction.waiting')" />
                  <span v-else-if="!s.archived && chat.sessionAttention(inst.id, s.alias) === 'working'" data-test="attention-dot" data-attention="working"
                        class="pulse-dot h-2 w-2 shrink-0 rounded-full bg-run-bright" />
                  <span v-else-if="!s.archived && chat.sessionAttention(inst.id, s.alias) === 'unread'" data-test="attention-dot" data-attention="unread"
                        class="h-2 w-2 shrink-0 rounded-full bg-info" />
                  <span v-else-if="!s.archived && s.running" data-test="attention-dot" data-attention="running" class="h-2 w-2 shrink-0 rounded-full bg-run" />
                  <!-- Agent brand glyph (driver icon) BEFORE the name, in place of a text badge —
                       saves horizontal space; the agent name stays available on hover. Redundant
                       inside an agent-mode group (the group header already carries it) → dropped.
                       Terminal-open is a corner overlay on this glyph so it does not steal title
                       space. Agent-mode pins the same badge into the button's left padding. -->
                  <span v-if="groupModeOf(inst) !== 'agent'" class="relative shrink-0">
                    <AgentIcon :driver="driverFor(inst, s)" :title="s.agent" :size="14"
                               :class="s.archived ? 'opacity-60' : ''" />
                    <span
                      v-if="hasOpenTerminal(inst.id, s.alias)"
                      data-test="terminal-open-marker"
                      class="absolute -bottom-px -right-px grid h-2.5 w-2.5 place-items-center rounded-[2px] bg-surface text-accent ring-1 ring-accent"
                      :title="$t('instance.sessionTerminalOpenTitle')"
                      :aria-label="$t('instance.sessionTerminalOpenTitle')"
                    ><SquareTerminal :size="8" :stroke-width="2.5" /></span>
                  </span>
                  <!-- Agent grouping: out-of-flow, in pl-2.5 (10px) × py-2 bottom padding.
                       left-0.5 keeps it off the 3px selected bar; bottom-0.5 keeps it below
                       the vertically-centered attention-dot so the two do not cover each other. -->
                  <span
                    v-else-if="hasOpenTerminal(inst.id, s.alias)"
                    data-test="terminal-open-marker"
                    class="absolute bottom-0.5 left-0.5 grid h-2.5 w-2.5 place-items-center rounded-[2px] bg-surface text-accent ring-1 ring-accent"
                    :title="$t('instance.sessionTerminalOpenTitle')"
                    :aria-label="$t('instance.sessionTerminalOpenTitle')"
                  ><SquareTerminal :size="8" :stroke-width="2.5" /></span>
                  <input v-if="renamingFor === `${inst.id}:${s.alias}`" data-test="rename-input"
                         v-model="renameDraft" :maxlength="60" :placeholder="$t('instance.sessionRenamePlaceholder')"
                         class="min-w-0 flex-1 rounded-sm border border-accent bg-surface-2 px-1 py-px text-ui text-fg outline-none"
                         @click.stop @keydown.enter.prevent="commitRename(inst.id, s.alias)"
                         @keydown.escape.prevent="cancelRename" @blur="commitRename(inst.id, s.alias)"
                         v-focus />
                  <!-- Single-line row. A cold session (warm process exited; next
                       message cold-starts) carries only a 12px Unplug glyph after the
                       name — the reason lives in its Tooltip. Absent `warm` (old
                       instance) shows nothing. -->
                  <div v-else class="flex min-w-0 flex-1 items-center">
                    <span data-test="session-name" class="min-w-0 truncate text-sm font-medium"
                          :title="s.displayName || s.alias"
                          :class="s.archived ? 'text-fg-muted' : (isSelected(inst.id, s.alias) ? 'font-semibold text-accent' : 'text-fg')">{{ rowName(inst, s, grp.key) }}</span>
                    <Tooltip v-if="!s.archived && s.warm === false" :text='$t("instance.sessionColdTooltip")'>
                      <Unplug data-test="cold-indicator" :size="12" tabindex="0" role="img"
                              :aria-label='$t("instance.sessionColdTooltip")'
                              class="ml-1.5 shrink-0 text-fg-muted" />
                    </Tooltip>
                  </div>
                  <!-- Archived state is shown visually by the dimmed name (no text badge), but that
                       greying carries no signal for screen readers — keep a visually-hidden label so
                       archived status is still announced. -->
                  <span v-if="s.archived" data-test="archived-label" class="sr-only">{{ $t("instance.sessionArchivedLabel") }}</span>
                  <!-- Native (agent-side / resumed) sessions get a small link glyph instead of a text
                       badge to keep the row uncluttered. -->
                  <Link2 v-if="s.native" data-test="native-badge" :size="12"
                         :aria-label="$t('instance.sessionNativeBadgeTitle')" :title="$t('instance.sessionNativeBadgeTitle')"
                         class="shrink-0 text-info" :class="s.archived ? 'opacity-60' : ''" />
                  <span v-if="!s.archived && elapsedLabel(inst.id, s.alias)" data-test="session-elapsed"
                        class="ml-auto shrink-0 font-mono text-xs tabular-nums text-run">{{ elapsedLabel(inst.id, s.alias) }}</span>
                </button>
                <!-- Row actions: desktop overflow (⋯) menu → archive / delete. Hidden when the instance is offline. -->
                <div v-if="inst.online" data-test="session-actions" class="relative mr-1 shrink-0">
                  <button data-test="session-menu" :aria-label="$t('common.more')"
                          :aria-haspopup="true" :aria-expanded="menuDd.open && menuFor === `${inst.id}:${s.alias}`"
                          class="grid h-10 w-10 lg:h-5 lg:w-5 place-items-center rounded-sm text-fg-muted hover:bg-surface-2 hover:text-fg opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100"
                          @click.stop="openSwipeFor = null; toggleMenuFor(`${inst.id}:${s.alias}`, $event.currentTarget as HTMLElement)"><MoreHorizontal :size="13" /></button>
                </div>
              </div>
              <!-- Swipe-revealed action blocks (touch). Sit just past the right edge; the
                   `@click.stop` prevents the row tap from also firing. -->
              <template v-if="inst.online">
                <button v-if="!s.archived" data-test="swipe-archive" :aria-label="$t('instance.archiveSession')" :title="$t('instance.sleepTooltip')"
                        class="flex w-14 shrink-0 items-center justify-center bg-warn text-on-warn transition-colors hover:bg-warn/90"
                        @click.stop="onArchive(inst.id, s.alias)"><Moon :size="16" /></button>
                <button data-test="swipe-delete" :aria-label="$t('common.delete')" :title="$t('common.delete')"
                        class="flex w-14 shrink-0 items-center justify-center bg-danger text-on-danger transition-colors hover:bg-danger/90"
                        @click.stop="askDelete(inst.id, s.alias)"><Trash2 :size="16" /></button>
              </template>
            </div>
            </div>
            <!-- ⋯ menu: the unified action panel (③ icon trigger), a child of the ROW
                 (not the clip layer) so it overflows the row downward instead of being
                 clipped to the row's height. Sidebar panels use bg-raised. -->
            <DropdownPanel v-if="inst.online && menuDd.open && menuFor === `${inst.id}:${s.alias}`"
                           :dd="menuDd" tone="raised" width="w-40" placement="bottom-end" role="menu"
                           :title="rowName(inst, s, grp.key)"
                           :groups="menuGroups(s)"
                           @select="onMenuSelect(inst.id, s, $event)" />
            </div>
            <!-- Grouped modes page sleeping rows per group (5 at a time) while the
                 instance-level sleeping filter is on: one load-more at the group bottom. -->
            <template v-if="grp.key !== null && inst.online && archivedIsExpanded(inst.id)">
              <div v-if="grp.archivedState?.loading" data-test="group-archived-loading"
                   class="py-0.5 pl-2.5 text-xs text-fg-muted">{{ $t("instance.loading") }}</div>
              <button v-else-if="grp.archivedState?.hasMore" data-test="group-load-more"
                      class="mt-1 flex h-8 w-full items-center justify-center rounded-lg text-ui font-medium text-accent transition-colors hover:bg-surface-2"
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
                class="w-full py-1 pl-2.5 text-left text-xs font-medium text-fg-muted hover:text-fg"
                @click.stop="toggleSessions(inst.id)">
          {{ $t("instance.showMoreSessions", { n: activeSessions(inst).length - SESSION_CAP }) }}
        </button>
        <button v-else-if="groupModeOf(inst) === 'instance' && activeSessions(inst).length > SESSION_CAP"
                data-test="sessions-collapse"
                class="w-full py-1 pl-2.5 text-left text-xs font-medium text-fg-muted hover:text-fg"
                @click.stop="toggleSessions(inst.id)">
          {{ $t("instance.collapseSessions") }}
        </button>

              <!-- Instance-level ACTIVE-list load-more, deliberately NOT mode-gated: grouped modes
                   still page active sessions 20 at a time, and this is their only "next page" entry. -->
              <button v-if="inst.sessionsHasMore && !inst.sessionsLoading" data-test="sessions-load-more"
                class="mt-1 flex h-8 w-full items-center justify-center rounded-lg text-ui font-medium text-accent transition-colors hover:bg-surface-2"
                @click.stop="store.loadMoreSessions(inst.id).catch(() => {})">
          {{ $t("instance.loadMoreSessions") }}
        </button>
        <div v-if="inst.sessionsLoaded && !activeSessions(inst).length && !archivedIsExpanded(inst.id)" data-test="no-sessions"
             class="py-1 pl-2.5 text-xs text-fg-muted">{{ $t("instance.noSessions") }}</div>

        <!-- Per-instance footer: icon-only actions (new session / manage), labelled via title+aria.
             The sleeping-sessions toggle moved to the tab row's filter menu. -->
        <div class="flex items-center gap-0.5 pb-px pl-2 pt-0.5">
          <button data-test="new-session" :title="$t('instance.newSession')" :aria-label="$t('instance.newSession')"
                  class="grid h-10 w-10 lg:h-6 lg:w-6 place-items-center rounded-sm text-accent transition-colors hover:bg-accent-soft"
                  @click="dialogFor = { id: inst.id, name: inst.name }"><Plus :size="14" /></button>
          <button data-test="manage-instance" :title="$t('instance.manage')" :aria-label="$t('instance.manage')"
                  class="grid h-10 w-10 lg:h-6 lg:w-6 place-items-center rounded-sm text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg"
                  @click="manageFor = { id: inst.id, name: inst.name }"><Settings2 :size="13" /></button>
        </div>
        </template>
      </div>
    </div>

    <NewSessionDialog v-if="dialogFor" :instance-id="dialogFor.id" :instance-name="dialogFor.name"
                      :preset-agent="dialogFor.presetAgent" :preset-workspace="dialogFor.presetWorkspace"
                      @close="dialogFor = null" @created="onSessionCreated" />
    <ManageInstanceDialog v-if="manageFor" :instance-id="manageFor.id" :instance-name="manageFor.name"
                          @close="manageFor = null" />
    <BotDialog v-if="botDialogFor" :instance-id="botDialogFor.instanceId" :instance-name="botDialogFor.instanceName"
               :bot="botDialogFor.bot" @close="onBotDialogClose" @saved="onBotSaved" />
    <GroupDialog v-if="groupDialogFor" :instance-id="groupDialogFor.instanceId" :group="groupDialogFor.group"
                 @close="groupDialogFor = null" @saved="onGroupSaved" @create-bot="onGroupCreateBot" />
    <BotRemovalDialog
      v-if="removalFor"
      :bot-name="removalFor.bot.name"
      :preview="() => directBotsStore.previewBotRemoval(removalFor!.instanceId, removalFor!.bot.id)"
      :remove="(input) => directBotsStore.removeBot(removalFor!.instanceId, { botId: removalFor!.bot.id, ...input })"
      :get-operation="(id) => directBotsStore.getLifecycleOperation(removalFor!.instanceId, id)"
      :supports-workspace-cleanup="supportsBotDedicatedWorkspaceCleanup(store.byId(removalFor!.instanceId))"
      @close="removalFor = null"
      @removed="removalFor = null"
    />
  </nav>
</template>

<style scoped>
@media (hover: none), (pointer: coarse) {
  .bot-sidebar-row { height: 44px; }
  .bot-menu-trigger { width: 44px; height: 44px; margin-right: 0; }
  .bot-disabled-toggle { min-height: 44px; }
}
</style>
