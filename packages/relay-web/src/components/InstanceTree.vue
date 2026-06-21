<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Archive, ChevronDown, ChevronRight, MoreHorizontal, Plus, Settings2, Trash2 } from "lucide-vue-next";
import { useInstancesStore } from "../stores/instances";
import { useChatStore } from "../stores/chat";
import { confirm } from "../lib/use-confirm";
import NewSessionDialog from "./NewSessionDialog.vue";
import ManageInstanceDialog from "./ManageInstanceDialog.vue";

const store = useInstancesStore();
const chat = useChatStore();
const { t } = useI18n();
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
  // Refresh on (re)expand in case the list drifted while collapsed.
  if (isExpanded(id)) void store.loadSessions(id).catch(() => {});
}

// Archived sessions sink to the bottom of their instance group (stable: actives keep
// server order, archived last) so the active work stays at the top of the list.
function orderedSessions<T extends { archived?: boolean }>(sessions: T[]): T[] {
  return [...sessions].sort((a, b) => Number(a.archived ?? false) - Number(b.archived ?? false));
}

// Desktop overflow (⋯) menu open-state, keyed by `${instanceId}:${alias}`.
const openMenuFor = ref<string | null>(null);
function onDocPointerDown() { openMenuFor.value = null; }
onMounted(() => document.addEventListener("mousedown", onDocPointerDown));
onUnmounted(() => document.removeEventListener("mousedown", onDocPointerDown));

async function onArchive(id: string, alias: string) {
  openMenuFor.value = null;
  await store.archiveSession(id, alias).catch(() => {});
  showUndoToast(id, alias);
}
// TEMPORARY no-op — the real undo toast lands in a later task.
function showUndoToast(_id: string, _alias: string) { /* replaced by the undo-toast task */ }

// Deleting a session is destructive and irreversible → confirm via the popup dialog.
async function askDelete(id: string, alias: string) {
  openMenuFor.value = null;
  const ok = await confirm({
    title: t("instance.deleteSessionTitle"),
    message: t("instance.deleteSessionBody", { alias }),
    confirmLabel: t("common.delete"),
    tone: "danger",
  });
  if (ok) void store.removeSession(id, alias).catch(() => {});
}
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
          v-for="s in orderedSessions(inst.sessions)"
          :key="s.alias"
          data-test="session-row"
          class="group relative flex items-center rounded-md transition-colors"
          :class="isSelected(inst.id, s.alias) ? 'bg-accent/10' : 'hover:bg-raised'"
        >
          <!-- Selected row: left accent bar. -->
          <span v-if="isSelected(inst.id, s.alias)" class="absolute bottom-1 left-0 top-1 w-[3px] rounded-full bg-accent" />
          <button
            class="flex min-w-0 flex-1 items-center gap-2 py-1 pl-2.5 pr-1.5 text-left"
            @click="emit('select', inst.id, s.alias)"
          >
            <span v-if="!s.archived && chat.sessionAttention(inst.id, s.alias) === 'working'" data-test="attention-dot" data-attention="working"
                  class="pulse-dot h-2 w-2 shrink-0 rounded-full bg-run-bright" />
            <span v-else-if="!s.archived && chat.sessionAttention(inst.id, s.alias) === 'unread'" data-test="attention-dot" data-attention="unread"
                  class="h-2 w-2 shrink-0 rounded-full bg-info" />
            <span v-else-if="!s.archived && s.running" data-test="attention-dot" data-attention="running" class="h-2 w-2 shrink-0 rounded-full bg-run" />
            <span class="truncate text-[12.5px] font-medium"
                  :class="s.archived ? 'text-fg-muted' : (isSelected(inst.id, s.alias) ? 'font-semibold text-accent' : 'text-fg')">{{ s.alias }}</span>
            <span class="shrink-0 rounded px-1 py-px font-mono text-[9.5px]"
                  :class="isSelected(inst.id, s.alias) ? 'bg-accent/15 text-accent' : 'bg-bg text-fg-muted'">{{ s.agent }}</span>
            <span v-if="s.archived" data-test="archived-badge" class="shrink-0 rounded bg-bg px-1 py-px text-[9px] text-fg-muted">{{ $t("instance.sessionArchivedBadge") }}</span>
            <span v-if="!s.archived && elapsedLabel(inst.id, s.alias)" data-test="session-elapsed"
                  class="ml-auto shrink-0 font-mono text-[10px] tabular-nums text-run">{{ elapsedLabel(inst.id, s.alias) }}</span>
          </button>
          <!-- Row actions: desktop overflow (⋯) menu → archive / delete. Hidden when the instance is offline. -->
          <div v-if="inst.online" data-test="session-actions" class="relative mr-1 shrink-0">
            <button data-test="session-menu" :aria-label="$t('common.more')"
                    class="grid h-5 w-5 place-items-center rounded text-fg-muted hover:bg-raised hover:text-fg opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100"
                    @click.stop="openMenuFor = openMenuFor === `${inst.id}:${s.alias}` ? null : `${inst.id}:${s.alias}`"><MoreHorizontal :size="13" /></button>
            <div v-if="openMenuFor === `${inst.id}:${s.alias}`" class="absolute right-0 z-20 mt-1 w-32 rounded-md border border-border bg-surface py-1 shadow-lg">
              <button v-if="!s.archived" data-test="action-archive" class="flex w-full items-center gap-2 px-2.5 py-1 text-left text-[12px] text-fg hover:bg-raised" @click.stop="onArchive(inst.id, s.alias)"><Archive :size="12" />{{ $t("instance.archiveSession") }}</button>
              <button data-test="delete-session" class="flex w-full items-center gap-2 px-2.5 py-1 text-left text-[12px] text-danger hover:bg-danger/10" @click.stop="askDelete(inst.id, s.alias)"><Trash2 :size="12" />{{ $t("common.delete") }}</button>
            </div>
          </div>
        </div>

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
                      @close="dialogFor = null" @created="dialogFor = null" />
    <ManageInstanceDialog v-if="manageFor" :instance-id="manageFor.id" :instance-name="manageFor.name"
                          @close="manageFor = null" />
  </nav>
</template>
