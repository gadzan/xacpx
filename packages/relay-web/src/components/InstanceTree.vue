<script setup lang="ts">
import { onUnmounted, ref } from "vue";
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

async function toggle(id: string) {
  await store.loadSessions(id).catch(() => {});
}
function remove(id: string, alias: string) {
  void store.removeSession(id, alias).catch(() => {});
}
</script>

<template>
  <div class="flex h-full flex-col overflow-y-auto border-r bg-white">
    <div v-for="inst in store.instances" :key="inst.id" class="border-b">
      <button class="flex w-full items-center gap-2 px-3 py-2 text-left" @click="toggle(inst.id)">
        <span class="h-2 w-2 rounded-full" :class="inst.online ? 'bg-green-500' : 'bg-slate-300'" data-test="online-dot" />
        <span class="font-medium">{{ inst.name }}</span>
      </button>
      <ul>
        <li v-for="s in inst.sessions" :key="s.alias" class="flex items-center justify-between pr-2">
          <button class="flex flex-1 items-center gap-2 px-6 py-1 text-left text-sm hover:bg-slate-50"
                  @click="emit('select', inst.id, s.alias)">
            <span v-if="chat.sessionAttention(inst.id, s.alias) === 'working'" data-test="attention-dot" data-attention="working"
                  class="text-amber-500 animate-pulse">●</span>
            <span v-else-if="chat.sessionAttention(inst.id, s.alias) === 'unread'" data-test="attention-dot" data-attention="unread"
                  class="text-sky-500">●</span>
            <span v-else-if="s.running" data-test="attention-dot" data-attention="running" class="text-amber-500">●</span>
            {{ s.alias }} <span class="text-slate-400">({{ s.agent }})</span>
            <span v-if="elapsedLabel(inst.id, s.alias)" data-test="session-elapsed"
                  class="ml-auto tabular-nums text-xs text-amber-500">{{ elapsedLabel(inst.id, s.alias) }}</span>
          </button>
          <button data-test="delete-session" class="text-xs text-red-400 hover:underline" @click.stop="remove(inst.id, s.alias)">delete</button>
        </li>
        <li v-if="!inst.sessions.length" data-test="no-sessions" class="px-6 py-1 text-xs text-slate-400">no sessions yet</li>
      </ul>
      <div class="flex items-center gap-3 px-6 py-1.5">
        <button data-test="new-session" class="text-left text-xs font-medium text-slate-500 hover:text-slate-800"
                @click="dialogFor = { id: inst.id, name: inst.name }">+ new session</button>
        <button data-test="manage-instance" class="text-left text-xs font-medium text-slate-500 hover:text-slate-800"
                @click="manageFor = { id: inst.id, name: inst.name }">Manage</button>
      </div>
    </div>

    <NewSessionDialog v-if="dialogFor" :instance-id="dialogFor.id" :instance-name="dialogFor.name"
                      @close="dialogFor = null" @created="dialogFor = null" />
    <ManageInstanceDialog v-if="manageFor" :instance-id="manageFor.id" :instance-name="manageFor.name"
                          @close="manageFor = null" />
  </div>
</template>
