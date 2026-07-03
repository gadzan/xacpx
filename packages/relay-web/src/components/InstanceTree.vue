<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Archive, ChevronDown, ChevronRight, Link2, Loader2, MoreHorizontal, Pencil, Plus, Settings2, Trash2 } from "lucide-vue-next";
import { useInstancesStore } from "../stores/instances";
import { useChatStore } from "../stores/chat";
import { confirm } from "../lib/use-confirm";
import { showActionToast } from "../lib/use-action-toast";
import { useSwipeActions } from "../lib/use-swipe-actions";
import NewSessionDialog from "./NewSessionDialog.vue";
import ManageInstanceDialog from "./ManageInstanceDialog.vue";
import AgentIcon from "./AgentIcon.vue";
import type { InstanceView } from "../stores/instances";

// Local directive: focus + select an element on mount (the rename input).
const vFocus = {
  mounted(el: HTMLInputElement) { el.focus(); el.select(); },
};

const store = useInstancesStore();
const chat = useChatStore();
const { t } = useI18n();

// A session row carries the agent NAME; the brand glyph keys on its driver. Resolve via the
// instance's configured agents (AgentDto maps name→driver). Undefined → AgentIcon falls back.
function driverFor(inst: InstanceView, agentName: string): string | undefined {
  return inst.agents.find((a) => a.name === agentName)?.driver;
}
const emit = defineEmits<{ select: [instanceId: string, alias: string] }>();
const dialogFor = ref<{ id: string; name: string } | null>(null);
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

// Per-instance collapse state (expanded by default). The store already eager-loads
// sessions for online instances, so this just shows/hides the already-loaded rows.
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
  // Refresh on (re)expand in case the list drifted while collapsed.
  if (isExpanded(id)) void store.loadSessions(id).catch(() => {});
}

// Archived sessions sink to the bottom of their instance group (stable: actives keep
// server order, archived last) so the active work stays at the top of the list.
function orderedSessions<T extends { archived?: boolean }>(sessions: T[]): T[] {
  return [...sessions].sort((a, b) => Number(a.archived ?? false) - Number(b.archived ?? false));
}

// Long session lists get noisy fast — cap the rendered rows per instance and let the
// user opt into the rest via "show N more" (mirrors the instance collapse/expand
// pattern above, but keyed independently since either can toggle without the other).
const SESSION_CAP = 10;
const sessionsExpanded = ref<Set<string>>(new Set());
function toggleSessions(id: string) {
  const next = new Set(sessionsExpanded.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  sessionsExpanded.value = next;
}
function visibleSessions(inst: InstanceView): InstanceView["sessions"] {
  const all = orderedSessions(inst.sessions);
  return sessionsExpanded.value.has(inst.id) ? all : all.slice(0, SESSION_CAP);
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
  void store.renameSession(id, alias, next).catch(() => {});
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
  await store.archiveSession(id, alias).catch(() => {});
  showUndoToast(id, alias);
}
function showUndoToast(id: string, alias: string) {
  showActionToast({
    message: t("instance.sessionArchivedToast", { alias }),
    actionLabel: t("instance.undo"),
    action: () => { void store.unarchiveSession(id, alias).catch(() => {}); },
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
  void store.removeSession(id, alias).catch(() => {});
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
    for (const s of inst.sessions) {
      const key = `${inst.id}:${s.alias}`;
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
  return map;
});
</script>

<template>
  <nav class="thin-scroll flex h-full flex-1 flex-col space-y-1.5 overflow-y-auto px-2 pb-2 pt-1.5">
    <!-- One instance group: header row + indented session rows + per-instance footer. -->
    <div v-for="inst in store.instances" :key="inst.id" :class="inst.online ? '' : 'opacity-60'">
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
        <span v-if="inst.online" class="font-mono text-[10px] tabular-nums text-fg-muted">{{ inst.sessions.length }}</span>
        <span v-else class="text-[10px] font-medium text-fg-muted">{{ $t("instance.offline") }}</span>
      </button>

      <!-- Indented session rows under an accent-able left rule. -->
      <div v-show="isExpanded(inst.id)" class="ml-2.5 mt-px space-y-px border-l border-border pl-2.5">
        <div
          v-for="s in visibleSessions(inst)"
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
                     saves horizontal space; the agent name stays available on hover. -->
                <AgentIcon :driver="driverFor(inst, s.agent)" :title="s.agent" :size="14"
                           :class="s.archived ? 'opacity-60' : ''" />
                <input v-if="renamingFor === `${inst.id}:${s.alias}`" data-test="rename-input"
                       v-model="renameDraft" :maxlength="60" :placeholder="$t('instance.sessionRenamePlaceholder')"
                       class="min-w-0 flex-1 rounded border border-accent bg-bg px-1 py-px text-[13px] text-fg outline-none"
                       @click.stop @keydown.enter.prevent="commitRename(inst.id, s.alias)"
                       @keydown.escape.prevent="cancelRename" @blur="commitRename(inst.id, s.alias)"
                       v-focus />
                <span v-else data-test="session-name" class="min-w-0 truncate text-[12.5px] font-medium"
                      :class="s.archived ? 'text-fg-muted' : (isSelected(inst.id, s.alias) ? 'font-semibold text-accent' : 'text-fg')">{{ s.displayName || s.alias }}</span>
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
              <button v-if="!s.archived" data-test="swipe-archive" :aria-label="$t('instance.archiveSession')" :title="$t('instance.archiveSession')"
                      class="flex w-14 shrink-0 items-center justify-center bg-warn text-white transition-colors hover:bg-warn/90"
                      @click.stop="onArchive(inst.id, s.alias)"><Archive :size="16" /></button>
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
            <button v-if="!s.archived" data-test="action-archive" class="flex w-full items-center gap-2 px-2.5 py-1 text-left text-[12px] text-fg hover:bg-raised" @click.stop="onArchive(inst.id, s.alias)"><Archive :size="12" />{{ $t("instance.archiveSession") }}</button>
            <button data-test="delete-session" class="flex w-full items-center gap-2 px-2.5 py-1 text-left text-[12px] text-danger hover:bg-danger/10" @click.stop="askDelete(inst.id, s.alias)"><Trash2 :size="12" />{{ $t("common.delete") }}</button>
          </div>
        </div>

        <button v-if="orderedSessions(inst.sessions).length > SESSION_CAP && !sessionsExpanded.has(inst.id)"
                data-test="sessions-show-more"
                class="w-full py-1 pl-2.5 text-left text-[11px] font-medium text-fg-muted hover:text-fg"
                @click.stop="toggleSessions(inst.id)">
          {{ $t("instance.showMoreSessions", { n: orderedSessions(inst.sessions).length - SESSION_CAP }) }}
        </button>
        <button v-else-if="orderedSessions(inst.sessions).length > SESSION_CAP"
                data-test="sessions-collapse"
                class="w-full py-1 pl-2.5 text-left text-[11px] font-medium text-fg-muted hover:text-fg"
                @click.stop="toggleSessions(inst.id)">
          {{ $t("instance.collapseSessions") }}
        </button>

        <div v-if="inst.online && !inst.sessionsLoaded && !inst.sessions.length" data-test="sessions-loading"
             class="py-1 pl-2.5 text-[11px] text-fg-muted">{{ $t("instance.loading") }}</div>
        <div v-else-if="inst.sessionsLoaded && !inst.sessions.length" data-test="no-sessions"
             class="py-1 pl-2.5 text-[11px] text-fg-muted">{{ $t("instance.noSessions") }}</div>

        <!-- Per-instance footer: icon-only actions (new session / manage), labelled via title+aria. -->
        <div class="flex items-center gap-0.5 pb-px pl-2 pt-0.5">
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
                      @close="dialogFor = null" @created="onSessionCreated" />
    <ManageInstanceDialog v-if="manageFor" :instance-id="manageFor.id" :instance-name="manageFor.name"
                          @close="manageFor = null" />
  </nav>
</template>
