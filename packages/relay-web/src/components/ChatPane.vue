<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import { useChatStore } from "../stores/chat";
import { useInstancesStore } from "../stores/instances";
import { useFilesStore } from "../stores/files";
import MessageList from "./MessageList.vue";
import PromptInput from "./PromptInput.vue";
import PlanPanel from "./PlanPanel.vue";
import { Bot, Folder, GitBranch, X } from "lucide-vue-next";

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
const runningTools = computed(() => chat.liveToolSteps.filter((t) => t.status === "running").length);

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
      <!-- header -->
      <div class="shrink-0 flex min-h-11 lg:h-11 items-center gap-2.5 border-b border-border bg-surface/60 px-3 lg:px-5 py-1.5 lg:py-0 backdrop-blur-md">
        <h1 class="hidden lg:block text-[14px] font-semibold tracking-tight text-fg">{{ chat.sessionAlias }}</h1>
        <div v-if="currentSession || instance" class="flex flex-wrap items-center gap-1">
          <button v-if="currentSession?.workspace" data-test="ctx-chip-workspace"
                  class="flex items-center gap-1.5 rounded-md border border-border bg-surface py-0.5 pl-1.5 pr-2 text-[10.5px] font-medium text-fg-muted hover:bg-fg/5"
                  title="Browse files"
                  @click="emit('show-files')"><Folder :size="11" class="text-warn" />{{ currentSession.workspace }}</button>
          <span v-if="instance?.name" data-test="ctx-chip-instance"
                class="flex items-center gap-1 rounded-md border border-border bg-surface py-0.5 pl-1.5 pr-2 text-[10.5px] font-medium text-fg-muted"><span class="font-mono text-accent">@</span>{{ instance.name }}</span>
          <span v-if="currentSession?.agent" data-test="ctx-chip-agent"
                class="flex items-center gap-1.5 rounded-md border border-border bg-surface py-0.5 pl-1.5 pr-2 text-[10.5px] font-medium text-fg-muted"><Bot :size="11" class="text-accent" />{{ currentSession.agent }}</span>
          <button v-if="files.gitSummary" data-test="git-summary"
                  class="flex items-center gap-1.5 rounded-md border border-border bg-surface py-0.5 pl-1.5 pr-2 text-[10.5px] font-medium text-fg-muted hover:bg-fg/5"
                  title="View changes"
                  @click="files.tab = 'changes'; emit('show-files')">
            <GitBranch :size="11" class="text-warn" />
            <span v-if="files.gitSummary.branch">{{ files.gitSummary.branch }}</span>
            <span class="h-1 w-1 rounded-full bg-warn" aria-hidden="true" />
            <span class="text-warn">{{ files.gitSummary.changedCount }} changed</span>
          </button>
        </div>
      </div>
      <div v-if="chat.error" data-test="chat-error" class="bg-danger/10 px-4 py-1 text-xs text-danger">
        {{ chat.error }}
        <button class="ml-2 text-danger underline" @click="chat.error = ''">dismiss</button>
      </div>
      <MessageList :messages="chat.messages" :live-turn="chat.liveTurn"
                   :session-key="`${chat.instanceId}\0${chat.sessionAlias}`"
                   :scroll-to-scheduled="chat.scrollRequest"
                   :has-more-older="chat.hasMoreOlder" :loading-older="chat.loadingOlder"
                   @resend="chat.resend" @load-older="chat.loadOlder" />
      <!-- composer area -->
      <div class="shrink-0 space-y-2 bg-gradient-to-t from-bg to-transparent px-2 lg:px-5 pb-4 pt-1.5">
        <!-- TURN HUD -->
        <div v-if="chat.busy" data-test="turn-hud"
             class="flex items-center gap-2 rounded-lg border border-run/20 bg-run/8 px-3 py-1.5">
          <span class="h-2 w-2 rounded-full bg-run pulse-dot" aria-hidden="true" />
          <span class="text-[12px] font-semibold text-run">{{ verb }}…</span>
          <span class="font-mono text-[12px] font-semibold tabular-nums text-run">{{ elapsed }}</span>
          <span v-if="runningTools > 0" class="text-[11.5px] text-fg-muted">· {{ runningTools }} {{ runningTools === 1 ? "tool" : "tools" }}</span>
          <span class="flex-1" />
          <button data-test="cancel-turn"
                  class="flex items-center gap-1.5 text-[11.5px] font-medium text-danger transition-opacity hover:opacity-80"
                  @click="chat.cancel"><X :size="13" />Cancel</button>
        </div>
        <PlanPanel v-if="chat.sessionPlan?.length" :entries="chat.sessionPlan" :active="chat.busy" />
        <PromptInput :busy="chat.busy" :draft-key="`${chat.instanceId}\0${chat.sessionAlias}`"
                     :instance-id="chat.instanceId" :session-alias="chat.sessionAlias"
                     @send="chat.send" @cancel="chat.cancel" />
      </div>
    </template>
  </div>
</template>
