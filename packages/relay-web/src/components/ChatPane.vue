<script setup lang="ts">
import { computed, onUnmounted, ref } from "vue";
import { useChatStore } from "../stores/chat";
import { useInstancesStore } from "../stores/instances";
import MessageList from "./MessageList.vue";
import PromptInput from "./PromptInput.vue";

const emit = defineEmits<{ (e: "show-files"): void }>();

const chat = useChatStore();
const instances = useInstancesStore();

// Context for the header chips: the current session's workspace/agent plus the
// instance name. Branch is intentionally absent — the protocol carries no git
// branch yet (deferred to the read-only git summary batch).
const instance = computed(() => (chat.instanceId ? instances.byId(chat.instanceId) : undefined));
const currentSession = computed(() =>
  instance.value?.sessions.find((s) => s.alias === chat.sessionAlias),
);

// Live elapsed clock for the active turn HUD.
const nowMs = ref(Date.now());
const timer = setInterval(() => { nowMs.value = Date.now(); }, 1000);
onUnmounted(() => clearInterval(timer));

const elapsed = computed(() => {
  if (!chat.liveTurn) return "";
  const s = Math.max(0, Math.floor((nowMs.value - chat.liveTurn.startedAt) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
});
const runningTools = computed(() => chat.liveTurn?.toolSteps.filter((t) => t.status === "running").length ?? 0);

// Whimsical near-synonyms cycled through while a turn runs (à la Claude Code / HAPI's
// "vibing messages"). Purely cosmetic; reuses the 1Hz clock, rotating every ~4s on a
// calm interval rather than re-rolling every frame. "Working" stays first for t≈0.
const VERBS = [
  "Working", "Thinking", "Pondering", "Cogitating", "Reasoning", "Computing",
  "Churning", "Crunching", "Percolating", "Noodling", "Mulling", "Brewing",
  "Processing", "Deliberating", "Ruminating", "Synthesizing", "Wrangling", "Tinkering",
];
const verb = computed(() => {
  if (!chat.liveTurn) return VERBS[0];
  const s = Math.max(0, Math.floor((nowMs.value - chat.liveTurn.startedAt) / 1000));
  return VERBS[Math.floor(s / 4) % VERBS.length];
});
</script>

<template>
  <div class="flex h-full flex-1 flex-col">
    <div v-if="!chat.sessionAlias" class="flex flex-1 items-center justify-center text-slate-400">
      Select a session
    </div>
    <template v-else>
      <div class="border-b px-4 py-2">
        <div class="text-sm font-medium">{{ chat.sessionAlias }}</div>
        <div v-if="currentSession || instance" class="mt-1 flex flex-wrap items-center gap-1 text-xs text-slate-500">
          <button v-if="currentSession?.workspace" data-test="ctx-chip-workspace"
                  class="rounded bg-slate-100 px-1.5 py-0.5 hover:bg-slate-200" title="Browse files"
                  @click="emit('show-files')">📁 {{ currentSession.workspace }}</button>
          <span v-if="instance?.name" data-test="ctx-chip-instance" class="rounded bg-slate-100 px-1.5 py-0.5">@ {{ instance.name }}</span>
          <span v-if="currentSession?.agent" data-test="ctx-chip-agent" class="rounded bg-slate-100 px-1.5 py-0.5">🤖 {{ currentSession.agent }}</span>
        </div>
      </div>
      <div v-if="chat.error" data-test="chat-error" class="bg-red-50 px-4 py-1 text-xs text-red-700">
        {{ chat.error }}
        <button class="ml-2 underline" @click="chat.error = ''">dismiss</button>
      </div>
      <MessageList :messages="chat.messages" :streaming="chat.streaming" :live-turn="chat.liveTurn" />
      <div v-if="chat.busy" data-test="turn-hud" class="flex items-center gap-2 px-4 py-1 text-xs text-slate-500">
        <span class="animate-pulse">●</span>
        <span>{{ verb }}… {{ elapsed }}</span>
        <span v-if="runningTools > 0">· 🔧 {{ runningTools }}</span>
        <button data-test="cancel-turn" class="ml-auto text-red-500 hover:underline" @click="chat.cancel">Cancel</button>
      </div>
      <PromptInput :busy="chat.busy" :draft-key="`${chat.instanceId}\0${chat.sessionAlias}`" @send="chat.send" @cancel="chat.cancel" />
    </template>
  </div>
</template>
