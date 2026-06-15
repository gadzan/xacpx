<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import { useChatStore } from "../stores/chat";
import { useInstancesStore } from "../stores/instances";
import { useFilesStore } from "../stores/files";
import MessageList from "./MessageList.vue";
import PromptInput from "./PromptInput.vue";
import { AtSign, Bot, Folder, GitBranch, Wrench } from "lucide-vue-next";

const emit = defineEmits<{ (e: "show-files"): void }>();

const chat = useChatStore();
const instances = useInstancesStore();
const files = useFilesStore();

// Context for the header chips: the current session's workspace/agent plus the
// instance name. Branch comes from the read-only git summary (undefined until the
// backend ever adds it to the diff result).
const instance = computed(() => (chat.instanceId ? instances.byId(chat.instanceId) : undefined));
const currentSession = computed(() =>
  instance.value?.sessions.find((s) => s.alias === chat.sessionAlias),
);

// Keep a read-only git summary loaded for the current session's workspace so the
// header chip reflects changes without the user opening the Files panel first.
watch(
  () => [chat.instanceId, currentSession.value?.workspace] as const,
  ([id, ws]) => {
    if (id && ws) void files.loadGitSummary(id, ws);
    else files.gitSummary = null;
  },
  { immediate: true },
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
    <div v-if="!chat.sessionAlias" class="flex flex-1 items-center justify-center text-fg-muted">
      Select a session
    </div>
    <template v-else>
      <div class="border-b border-border px-4 py-2">
        <div class="text-sm font-medium text-fg">{{ chat.sessionAlias }}</div>
        <div v-if="currentSession || instance" class="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-fg-muted">
          <button v-if="currentSession?.workspace" data-test="ctx-chip-workspace"
                  class="inline-flex items-center gap-1 rounded-md border border-border bg-bg px-1.5 py-0.5 text-fg-muted hover:bg-fg/5"
                  title="Browse files"
                  @click="emit('show-files')"><Folder :size="14" />{{ currentSession.workspace }}</button>
          <span v-if="instance?.name" data-test="ctx-chip-instance"
                class="inline-flex items-center gap-1 rounded-md border border-border bg-bg px-1.5 py-0.5 text-fg-muted"><AtSign :size="14" />{{ instance.name }}</span>
          <span v-if="currentSession?.agent" data-test="ctx-chip-agent"
                class="inline-flex items-center gap-1 rounded-md border border-border bg-bg px-1.5 py-0.5 text-fg-muted"><Bot :size="14" />{{ currentSession.agent }}</span>
          <button v-if="files.gitSummary" data-test="git-summary"
                  class="inline-flex items-center gap-1 rounded-md border border-border bg-bg px-1.5 py-0.5 text-fg-muted hover:bg-fg/5"
                  title="View changes"
                  @click="files.tab = 'changes'; emit('show-files')">
            <GitBranch :size="14" />
            <span class="h-1.5 w-1.5 rounded-full bg-info" aria-hidden="true" />
            <span v-if="files.gitSummary.branch">{{ files.gitSummary.branch }} ·</span>
            {{ files.gitSummary.changedCount }} changed
          </button>
        </div>
      </div>
      <div v-if="chat.error" data-test="chat-error" class="bg-danger/10 px-4 py-1 text-xs text-danger">
        {{ chat.error }}
        <button class="ml-2 text-danger underline" @click="chat.error = ''">dismiss</button>
      </div>
      <MessageList :messages="chat.messages" :streaming="chat.streaming" :live-turn="chat.liveTurn" />
      <div v-if="chat.busy" data-test="turn-hud" class="flex items-center gap-2 px-4 py-1 text-xs text-fg-muted">
        <span class="h-1.5 w-1.5 rounded-full bg-run-bright animate-pulse motion-reduce:animate-none" aria-hidden="true" />
        <span><span class="font-mono tabular-nums">{{ verb }}… {{ elapsed }}</span></span>
        <span v-if="runningTools > 0" class="inline-flex items-center gap-1">· <Wrench :size="12" /> {{ runningTools }}</span>
        <button data-test="cancel-turn" class="ml-auto text-danger hover:underline" @click="chat.cancel">Cancel</button>
      </div>
      <PromptInput :busy="chat.busy" :draft-key="`${chat.instanceId}\0${chat.sessionAlias}`"
                   :instance-id="chat.instanceId" :session-alias="chat.sessionAlias"
                   @send="chat.send" @cancel="chat.cancel" />
    </template>
  </div>
</template>
