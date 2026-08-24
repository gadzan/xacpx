<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import { useChatStore } from "../stores/chat";
import { useInstancesStore } from "../stores/instances";
import { useFilesStore } from "../stores/files";
import { useComposerStore } from "../stores/composer";
import { useVirtualKeyboardInset } from "../lib/use-virtual-keyboard";
import type { PromptAttachmentRef } from "@ganglion/xacpx-relay-protocol";
import MessageList from "./MessageList.vue";
import PromptInput from "./PromptInput.vue";
import PlanPanel from "./PlanPanel.vue";
import QueueStrip from "./QueueStrip.vue";
import { AlertTriangle, Bot, Folder, GitBranch, Loader2, X } from "lucide-vue-next";

const emit = defineEmits<{ (e: "show-files"): void }>();

const chat = useChatStore();
const instances = useInstancesStore();
const files = useFilesStore();
const composer = useComposerStore();
// While the soft keyboard is open it already covers the iOS home indicator, so the
// composer's safe-area bottom padding is just a gap — drop it then (see the template).
const keyboardInset = useVirtualKeyboardInset();

// Plan and live status share a document-flow composer stack with the input:
// status (bottom layer) → plan (middle) → input (top). Visual overlap uses
// negative margin + reserved padding so content is never clipped.
// Keep expansion state here so toggles survive stack rerenders.
const planExpanded = ref(chat.busy);
const showPlan = computed(() => (chat.sessionPlan?.length ?? 0) > 0);

function onSend(
  text: string,
  media: PromptAttachmentRef[] = [],
  agentMentions?: Array<{ range: [number, number]; handle: string }>,
) {
  void chat.send(text, media, agentMentions);
}

// Bind the composer to the active instance so file uploads target the right daemon.
watch(() => chat.instanceId, (id) => { if (id) composer.bindInstance(id); }, { immediate: true });

// Clear staged attachments whenever the active session OR instance changes: `pending`
// is a single global array, so leftover chips from one target would otherwise attach to
// the next. Watch both identifiers and drop the staged files on any switch.
watch(
  () => [chat.instanceId, chat.sessionAlias] as const,
  ([id, alias], prev) => {
    if (prev && (id !== prev[0] || alias !== prev[1])) composer.clearAttachments();
  },
);

// Context for the header chips: the current session's workspace/agent plus the
// instance name. Branch comes from the read-only git summary (undefined until the
// backend ever adds it to the diff result).
const instance = computed(() => (chat.instanceId ? instances.byId(chat.instanceId) : undefined));
const currentSession = computed(() =>
  instance.value?.sessions.find((s) => s.alias === chat.sessionAlias),
);
// The session's acpx driver (codex/claude/…), driving the assistant avatar glyph.
// Prefer the driver carried on the session row itself (resolved server-side) — the
// agents-map fallback fails exactly when a sleeping (archived) row is selected from
// the sidebar without its group/section being in the active list. Undefined until
// either source loads → AgentIcon shows its fallback.
const currentDriver = computed(
  () =>
    currentSession.value?.driver
    ?? instance.value?.agents.find((a) => a.name === currentSession.value?.agent)?.driver,
);

// Booting state: an optimistic session whose create RPC is still cold-starting the agent.
// The "starting… Ns" elapsed readout reuses the always-on `nowMs` ticker (declared below
// for the turn HUD) so there's no second interval.
const bootElapsed = computed(() => {
  const since = currentSession.value?.creatingSince;
  return since ? Math.max(0, Math.floor((nowMs.value - since) / 1000)) : 0;
});

// Dismiss a booting/failed optimistic session: drop the row and clear the selection
// back to the empty pane. A session that actually came up keeps its (now real) row.
function dismissBooting(): void {
  const id = chat.instanceId;
  const alias = chat.sessionAlias;
  if (id && alias) instances.cancelSessionCreation(id, alias);
  chat.clearSelection();
}

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
// "vibing messages"). Purely cosmetic; reuses the 1Hz clock, rotating every ~10s on a
// calm interval rather than re-rolling every frame. "Working" stays first for t≈0.
const VERBS = [
  "Working", "Thinking", "Pondering", "Cogitating", "Reasoning", "Computing",
  "Churning", "Crunching", "Percolating", "Noodling", "Mulling", "Brewing",
  "Processing", "Deliberating", "Ruminating", "Synthesizing", "Wrangling", "Tinkering",
];
const verb = computed(() => {
  if (!chat.liveTurn) return VERBS[0];
  const s = Math.max(0, Math.floor((nowMs.value - chat.liveTurn.startedAt) / 1000));
  return VERBS[Math.floor(s / 10) % VERBS.length];
});
</script>

<template>
  <div class="flex h-full flex-1 flex-col">
    <div v-if="!chat.sessionAlias" class="flex flex-1 items-center justify-center text-fg-muted">
      {{ $t("chat.selectSession") }}
    </div>
    <template v-else>
      <!-- header -->
      <div class="shrink-0 flex min-h-11 lg:h-11 items-center gap-2.5 border-b border-border bg-surface/60 px-3 lg:px-5 py-1.5 lg:py-0 backdrop-blur-md">
        <h1 class="hidden lg:block text-[14px] font-semibold tracking-tight text-fg">{{ currentSession?.displayName || chat.sessionAlias }}</h1>
        <!-- Chip strip scrolls horizontally (swipe on touch) so long workspace/branch names
             stay fully readable instead of truncating — title tooltips don't work on touch.
             Each chip is shrink-0 (natural width); the strip overflows and scrolls. -->
        <div v-if="currentSession || instance" class="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto no-scrollbar">
          <!-- Session name as the leading chip. Mobile only: on lg+ the <h1> above already
               shows it at the front of this row, so showing it here too would duplicate. -->
          <span data-test="ctx-chip-session"
                class="flex shrink-0 items-center whitespace-nowrap rounded-md border border-border bg-surface px-2 py-0.5 text-[10.5px] font-semibold text-fg lg:hidden">{{ currentSession?.displayName || chat.sessionAlias }}</span>
          <button v-if="currentSession?.workspace" data-test="ctx-chip-workspace"
                  class="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-border bg-surface py-0.5 pl-1.5 pr-2 text-[10.5px] font-medium text-fg-muted hover:bg-fg/5"
                  :title='$t("chat.browseFiles")'
                  @click="emit('show-files')"><Folder :size="11" class="shrink-0 text-warn" /><span>{{ currentSession.workspace }}</span></button>
          <span v-if="instance?.name" data-test="ctx-chip-instance"
                class="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border border-border bg-surface py-0.5 pl-1.5 pr-2 text-[10.5px] font-medium text-fg-muted"><span class="font-mono text-accent">@</span><span>{{ instance.name }}</span></span>
          <span v-if="currentSession?.agent" data-test="ctx-chip-agent"
                class="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-border bg-surface py-0.5 pl-1.5 pr-2 text-[10.5px] font-medium text-fg-muted"><Bot :size="11" class="shrink-0 text-accent" /><span>{{ currentSession.agent }}</span></span>
          <button v-if="files.gitSummary" data-test="git-summary"
                  class="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-border bg-surface py-0.5 pl-1.5 pr-2 text-[10.5px] font-medium text-fg-muted hover:bg-fg/5"
                  :title="files.gitSummary.branch || $t('chat.viewChanges')"
                  @click="files.tab = 'changes'; emit('show-files')">
            <GitBranch :size="11" class="shrink-0 text-warn" />
            <span v-if="files.gitSummary.branch" class="font-mono">{{ files.gitSummary.branch }}</span>
            <span v-else-if="files.gitSummary.detached" class="italic">{{ $t("files.detached") }}</span>
            <span class="h-1 w-1 shrink-0 rounded-full bg-warn" aria-hidden="true" />
            <span class="text-warn">{{ files.gitSummary.changedCount }} {{ $t("chat.changed") }}</span>
          </button>
        </div>
      </div>
      <div v-if="chat.error" data-test="chat-error"
           class="mx-3 mt-2 flex items-start gap-2 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-danger">
        <AlertTriangle :size="14" class="mt-0.5 shrink-0" aria-hidden="true" />
        <p class="min-w-0 flex-1 max-h-24 overflow-y-auto whitespace-pre-wrap break-words text-[12px] leading-relaxed">{{ chat.error }}</p>
        <button type="button" class="-mr-0.5 -mt-0.5 shrink-0 rounded-md p-1 text-danger/70 transition-colors hover:bg-danger/15 hover:text-danger"
                :title="$t('common.dismissNotice')" @click="chat.error = ''"><X :size="14" /></button>
      </div>
      <!-- Cold-starting session: an optimistic row whose create RPC is still spinning up
           the agent. Show progress (and a way out) instead of an empty transcript. -->
      <div v-if="currentSession?.creating || currentSession?.createError" data-test="session-booting"
           class="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
        <template v-if="currentSession?.createError">
          <AlertTriangle :size="22" class="text-danger" aria-hidden="true" />
          <p class="text-sm font-medium text-danger">{{ $t("session.startFailed") }}</p>
          <p class="max-w-sm break-words text-xs text-fg-muted">{{ currentSession.createError }}</p>
          <button data-test="booting-dismiss" class="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-fg hover:bg-fg/5"
                  @click="dismissBooting">{{ $t("common.dismiss") }}</button>
        </template>
        <template v-else>
          <Loader2 :size="22" class="animate-spin motion-reduce:animate-none text-accent" aria-hidden="true" />
          <p class="text-sm font-medium text-fg">{{ $t("session.starting", { agent: currentSession?.agent }) }}
            <span class="ml-1 font-mono tabular-nums text-fg-muted">{{ bootElapsed }}s</span></p>
          <p class="max-w-sm text-xs text-fg-muted">{{ $t("session.startingHint") }}</p>
          <button data-test="booting-cancel" class="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-fg-muted hover:bg-fg/5"
                  @click="dismissBooting">{{ $t("common.cancel") }}</button>
        </template>
      </div>
      <template v-else>
      <!-- min-h-0 keeps the column height chain intact (flex min-height:auto would let a
           long transcript blow past the pane). -->
      <div class="flex min-h-0 flex-1" data-test="chat-body">
        <MessageList class="min-w-0" :messages="chat.messages" :live-turn="chat.liveTurn" :driver="currentDriver"
                     :session-key="`${chat.instanceId}\0${chat.sessionAlias}`"
                     :scroll-to-scheduled="chat.scrollRequest"
                     :has-more-older="chat.hasMoreOlder" :loading-older="chat.loadingOlder"
                     :loading-history="chat.loadingHistory"
                     :ensure-full="chat.ensureFullMessage"
                     @resend="chat.resend" @load-older="chat.loadOlder" />
      </div>
      <!-- composer area. pb uses max(1rem, safe-area-inset-bottom) so the iOS home-indicator
           inset is applied ONCE here (the bottommost element) and never stacks on top of the
           composer's own padding — env() is 0 off-PWA, so desktop stays at 1rem. -->
      <div class="shrink-0 bg-gradient-to-t from-bg to-transparent px-2 lg:px-5 pb-[max(1rem,env(safe-area-inset-bottom))] pt-1.5"
           :style="keyboardInset ? { paddingBottom: '0.5rem' } : undefined"
           data-test="composer-area">
        <!-- Document-flow stack: status (bottom) → plan (middle) → input (top).
             Overlap is visual only — lower layers reserve padding-bottom equal to the
             pull-up so content stays fully visible. -->
        <TransitionGroup
          tag="div"
          name="composer-layer"
          class="composer-stack flex flex-col"
          data-test="composer-stack"
        >
          <div v-if="chat.busy" key="status-layer" data-test="turn-hud"
               class="stack-layer stack-layer--status relative z-10 mx-4 flex items-center gap-2 rounded-xl border border-run/20 bg-surface/95 px-3 pt-1.5 pb-[calc(0.375rem+var(--stack-overlap))] shadow-e2 backdrop-blur-md sm:mx-6">
            <span class="h-2 w-2 rounded-full bg-run pulse-dot" aria-hidden="true" />
            <span class="text-[12px] font-semibold text-run">{{ verb }}…</span>
            <span class="font-mono text-[12px] font-semibold tabular-nums text-run">{{ elapsed }}</span>
            <span v-if="runningTools > 0" class="text-[11.5px] text-fg-muted">· {{ runningTools }} {{ runningTools === 1 ? $t("chat.tool") : $t("chat.tools") }}</span>
            <span class="flex-1" />
            <button data-test="cancel-turn"
                    class="flex items-center gap-1.5 text-[11.5px] font-medium text-danger transition-opacity hover:opacity-80"
                    @click="chat.cancel"><X :size="13" />{{ $t("common.cancel") }}</button>
          </div>
          <PlanPanel v-if="showPlan" key="plan-layer" v-model:expanded="planExpanded" :entries="chat.sessionPlan!" :active="chat.busy" variant="stack"
                     class="stack-layer stack-layer--plan relative z-20 mx-2 pb-[var(--stack-overlap)] shadow-e3 sm:mx-3"
                     :class="{ 'stack-layer--pull': chat.busy }" />
          <div key="composer-layer" class="stack-layer stack-layer--composer relative z-30"
               :class="{ 'stack-layer--pull': chat.busy || showPlan }">
            <div class="space-y-2">
              <QueueStrip />
              <PromptInput :busy="chat.busy" :draft-key="`${chat.instanceId}\0${chat.sessionAlias}`"
                           :instance-id="chat.instanceId" :session-alias="chat.sessionAlias"
                           @send="onSend" @cancel="chat.cancel" />
            </div>
          </div>
        </TransitionGroup>
      </div>
      </template>
    </template>
  </div>
</template>

<style scoped>
.composer-stack {
  --stack-overlap: 16px;
}
@media (max-width: 640px) {
  .composer-stack {
    --stack-overlap: 12px;
  }
}
/* Pull the next layer up by the reserved overlap; padding is set via Tailwind. */
.stack-layer--pull {
  margin-top: calc(-1 * var(--stack-overlap));
}
.composer-layer-enter-active,
.composer-layer-leave-active {
  transition: opacity 180ms ease, transform 220ms cubic-bezier(0.22, 1, 0.36, 1);
}
.composer-layer-enter-from,
.composer-layer-leave-to {
  opacity: 0;
  transform: translateY(8px) scale(0.98);
}
.composer-layer-move {
  transition: transform 180ms ease;
}
</style>
