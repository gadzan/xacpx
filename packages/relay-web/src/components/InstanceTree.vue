<script setup lang="ts">
import { onUnmounted, ref } from "vue";
import { ChevronDown, ChevronRight, Plus, Settings2 } from "lucide-vue-next";
import { useInstancesStore } from "../stores/instances";
import { useChatStore } from "../stores/chat";
import NewSessionDialog from "./NewSessionDialog.vue";
import ManageInstanceDialog from "./ManageInstanceDialog.vue";

const store = useInstancesStore();
const chat = useChatStore();
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

async function toggle(id: string) {
  await store.loadSessions(id).catch(() => {});
}
function remove(id: string, alias: string) {
  void store.removeSession(id, alias).catch(() => {});
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
        <ChevronDown v-if="inst.sessionsLoaded" :size="12" class="shrink-0 text-fg-muted" />
        <ChevronRight v-else :size="12" class="shrink-0 text-fg-muted" />
        <span class="h-2 w-2 shrink-0 rounded-full" :class="inst.online ? 'bg-run' : 'bg-fg-muted'" data-test="online-dot" />
        <span class="flex-1 truncate text-left text-[12.5px] font-semibold" :class="inst.online ? 'text-fg' : 'text-fg-muted'">{{ inst.name }}</span>
        <span v-if="inst.online" class="font-mono text-[10px] tabular-nums text-fg-muted">{{ inst.sessions.length }}</span>
        <span v-else class="text-[10px] font-medium text-fg-muted">offline</span>
      </button>

      <!-- Indented session rows under an accent-able left rule. -->
      <div class="ml-2.5 mt-px space-y-px border-l border-border pl-2.5">
        <div
          v-for="s in inst.sessions"
          :key="s.alias"
          class="group relative flex items-center rounded-md transition-colors"
          :class="isSelected(inst.id, s.alias) ? 'bg-accent/10' : 'hover:bg-raised'"
        >
          <!-- Selected row: left accent bar. -->
          <span v-if="isSelected(inst.id, s.alias)" class="absolute bottom-1 left-0 top-1 w-[3px] rounded-full bg-accent" />
          <button
            class="flex min-w-0 flex-1 items-center gap-2 py-1 pl-2.5 pr-1.5 text-left"
            @click="emit('select', inst.id, s.alias)"
          >
            <span v-if="chat.sessionAttention(inst.id, s.alias) === 'working'" data-test="attention-dot" data-attention="working"
                  class="pulse-dot h-2 w-2 shrink-0 rounded-full bg-run-bright" />
            <span v-else-if="chat.sessionAttention(inst.id, s.alias) === 'unread'" data-test="attention-dot" data-attention="unread"
                  class="h-2 w-2 shrink-0 rounded-full bg-info" />
            <span v-else-if="s.running" data-test="attention-dot" data-attention="running" class="h-2 w-2 shrink-0 rounded-full bg-run" />
            <span class="truncate text-[12.5px] font-medium" :class="isSelected(inst.id, s.alias) ? 'font-semibold text-accent' : 'text-fg'">{{ s.alias }}</span>
            <span class="shrink-0 rounded px-1 py-px font-mono text-[9.5px]"
                  :class="isSelected(inst.id, s.alias) ? 'bg-accent/15 text-accent' : 'bg-bg text-fg-muted'">{{ s.agent }}</span>
            <span v-if="elapsedLabel(inst.id, s.alias)" data-test="session-elapsed"
                  class="ml-auto shrink-0 font-mono text-[10px] tabular-nums text-run">{{ elapsedLabel(inst.id, s.alias) }}</span>
          </button>
          <button data-test="delete-session"
                  class="mr-1 shrink-0 px-1 text-[10px] text-danger opacity-0 transition-opacity hover:underline group-hover:opacity-100"
                  @click.stop="remove(inst.id, s.alias)">delete</button>
        </div>

        <div v-if="inst.online && !inst.sessionsLoaded && !inst.sessions.length" data-test="sessions-loading"
             class="py-1 pl-2.5 text-[11px] text-fg-muted">loading…</div>
        <div v-else-if="inst.sessionsLoaded && !inst.sessions.length" data-test="no-sessions"
             class="py-1 pl-2.5 text-[11px] text-fg-muted">no sessions yet</div>

        <!-- Per-instance footer: + new session · Manage. -->
        <div class="flex items-center gap-1.5 pb-px pl-2.5 pt-0.5">
          <button data-test="new-session"
                  class="flex items-center gap-1 text-[11px] font-medium text-accent transition-opacity hover:opacity-80"
                  @click="dialogFor = { id: inst.id, name: inst.name }"><Plus :size="12" />new session</button>
          <span class="text-border">·</span>
          <button data-test="manage-instance"
                  class="flex items-center gap-1 text-[11px] font-medium text-fg-muted transition-colors hover:text-fg"
                  @click="manageFor = { id: inst.id, name: inst.name }"><Settings2 :size="12" />Manage</button>
        </div>
      </div>
    </div>

    <NewSessionDialog v-if="dialogFor" :instance-id="dialogFor.id" :instance-name="dialogFor.name"
                      @close="dialogFor = null" @created="dialogFor = null" />
    <ManageInstanceDialog v-if="manageFor" :instance-id="manageFor.id" :instance-name="manageFor.name"
                          @close="manageFor = null" />
  </nav>
</template>
