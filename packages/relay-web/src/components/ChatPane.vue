<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import { useChatStore } from "../stores/chat";
import { useInstancesStore } from "../stores/instances";
import { useFilesStore } from "../stores/files";
import { useComposerStore } from "../stores/composer";
import { useVirtualKeyboardInset } from "../lib/use-virtual-keyboard";
import { isOmpModelRestoreFailure, ompRestoreFailure } from "../lib/omp-model-recovery";
import type { PromptAttachmentRef } from "@ganglion/xacpx-relay-protocol";
import MessageList from "./MessageList.vue";
import PromptInput from "./PromptInput.vue";
import PlanPanel from "./PlanPanel.vue";
import QueueStrip from "./QueueStrip.vue";
import ConversationInteractionForm from "./ConversationInteractionForm.vue";
import { useDirectBotsStore } from "../stores/direct-bots";
import type { InteractionValueDto } from "@ganglion/xacpx-relay-protocol";
import { AlertTriangle, Bot, Folder, GitBranch, Loader2, X } from "lucide-vue-next";

const emit = defineEmits<{ (e: "show-files"): void }>();

const chat = useChatStore();
const instances = useInstancesStore();
// Interaction state lives with the other account-wide control-event projections
// (`direct-bots.ts`). It is not a Direct-Bot-only concern: the ingress and the
// pending set are per account and per instance, and only the SCOPING differs —
// a session form is placed by session alias instead of by Conversation topic.
const directBots = useDirectBotsStore();
const files = useFilesStore();
const composer = useComposerStore();
const promptInput = ref<InstanceType<typeof PromptInput> | null>(null);
// While the soft keyboard is open it already covers the iOS home indicator, so the
// composer's safe-area bottom padding is just a gap — drop it then (see the template).
const keyboardInset = useVirtualKeyboardInset();

// Plan and live status share a document-flow composer stack with the input:
// status (bottom layer) → plan (middle) → input (top). Visual overlap uses
// negative margin + reserved padding so content is never clipped.
// Keep expansion state here so toggles survive stack rerenders.
const planExpanded = ref(chat.busy);
const showPlan = computed(() => (chat.sessionPlan?.length ?? 0) > 0);
// Pending-prompt queue joins the same document-flow stack as its own layer
// (between plan and input).
const showQueue = computed(() => chat.sessionQueue.length > 0);

/**
 * The form an agent opened on THIS session, if one is open (or just closed).
 *
 * Scoped by instance + alias, so a question asked in another session — or on a
 * daemon that happens to share the alias — is never rendered into this pane.
 */
const sessionInteraction = computed(() =>
  directBots.pendingSessionInteractionFor(chat.instanceId, chat.sessionAlias),
);

// Handlers take the entry explicitly: the store's default target is the Direct
// Bot pane's visible form, which a session form never is.
function onInteractionAnswer(key: string, value: InteractionValueDto) {
  const current = sessionInteraction.value;
  if (current) directBots.setInteractionAnswer(key, value, current);
}
function onInteractionSubmit() {
  const current = sessionInteraction.value;
  if (current) void directBots.submitInteraction("accept", current);
}
function onInteractionDecline() {
  const current = sessionInteraction.value;
  if (current) void directBots.declineInteraction(current);
}
function onInteractionCancel() {
  const current = sessionInteraction.value;
  if (current) void directBots.cancelInteraction(current);
}
function onInteractionDismiss() {
  const current = sessionInteraction.value;
  if (current) directBots.dismissResolvedInteraction(current);
}

function onSend(
  text: string,
  media: PromptAttachmentRef[] = [],
  agentMentions?: Array<{ range: [number, number]; handle: string }>,
) {
  void chat.send(text, media, agentMentions);
}

watch(
  () => [chat.instanceId, chat.sessionAlias] as const,
  ([id, alias]) => {
    if (id && alias) composer.bindInstance(id, JSON.stringify(["session", id, alias]));
  },
  { immediate: true, flush: "sync" },
);

// Context for the header chips: the current session's workspace/agent plus the
// instance name. Branch comes from the read-only git summary (undefined until the
// backend ever adds it to the diff result).
const instance = computed(() => (chat.instanceId ? instances.byId(chat.instanceId) : undefined));
// Resolve the selected row across every list the dashboard keeps it in — NOT just
// inst.sessions. Sleeping rows deliberately live outside that list (grouped sidebar
// pages them into groupArchived; flat-mode archive can drop the selected row until a
// full snapshot loads), and the chat pane must keep its header/driver while one is open.
const currentSession = computed(() =>
  chat.instanceId && chat.sessionAlias
    ? instances.findSessionRow(chat.instanceId, chat.sessionAlias)
    : undefined,
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
const modelRecovery = computed(() => isOmpModelRestoreFailure(currentDriver.value, chat.error));
const modelRestore = computed(() => ompRestoreFailure(currentDriver.value, chat.error));

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

// Always-on 1 Hz clock. Feeds the booting "starting… Ns" readout above; the active
// turn's rotating quip + elapsed now ride the sticky agent-icon (see MessageList /
// useWorkingQuip), so the composer no longer carries a status HUD.
const nowMs = ref(Date.now());
const timer = setInterval(() => { nowMs.value = Date.now(); }, 1000);
onUnmounted(() => clearInterval(timer));
</script>

<template>
  <div class="flex h-full flex-1 flex-col">
    <!-- header (desktop only: <lg the single mobile top bar in DashboardView /
         DirectBotPane carries the title + subtitle instead of this chip row) -->
    <div class="hidden lg:flex shrink-0 min-h-11 lg:h-11 items-center gap-2.5 bg-surface/60 px-3 lg:px-5 py-1.5 lg:py-0 backdrop-blur-md">
      <h1 class="hidden lg:block text-sm font-semibold tracking-tight text-fg">{{ currentSession?.displayName || chat.sessionAlias }}</h1>
      <!-- Chip strip scrolls horizontally (swipe on touch) so long workspace/branch names
           stay fully readable instead of truncating — title tooltips don't work on touch.
           Each chip is shrink-0 (natural width); the strip overflows and scrolls. -->
      <div v-if="currentSession || instance" class="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto no-scrollbar">
        <!-- Session name as the leading chip. Mobile only: on lg+ the <h1> above already
             shows it at the front of this row, so showing it here too would duplicate. -->
        <span data-test="ctx-chip-session"
              class="flex shrink-0 items-center whitespace-nowrap rounded-sm bg-surface-2 px-2 py-0.5 text-xs font-semibold text-fg lg:hidden">{{ currentSession?.displayName || chat.sessionAlias }}</span>
        <button v-if="currentSession?.workspace" data-test="ctx-chip-workspace"
                class="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-sm bg-surface-2 py-0.5 pl-1.5 pr-2 text-xs font-medium text-fg-muted hover:bg-fg/5"
                :title='$t("chat.browseFiles")'
                @click="emit('show-files')"><Folder :size="11" class="shrink-0 text-warn" /><span>{{ currentSession.workspace }}</span></button>
        <span v-if="instance?.name" data-test="ctx-chip-instance"
              class="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-sm bg-surface-2 py-0.5 pl-1.5 pr-2 text-xs font-medium text-fg-muted"><span class="font-mono text-accent">@</span><span>{{ instance.name }}</span></span>
        <span v-if="currentSession?.agent" data-test="ctx-chip-agent"
              class="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-sm bg-surface-2 py-0.5 pl-1.5 pr-2 text-xs font-medium text-fg-muted"><Bot :size="11" class="shrink-0 text-accent" /><span>{{ currentSession.agent }}</span></span>
        <button v-if="files.gitSummary" data-test="git-summary"
                class="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-sm bg-surface-2 py-0.5 pl-1.5 pr-2 text-xs font-medium text-fg-muted hover:bg-fg/5"
                :title="files.gitSummary.branch || $t('chat.viewChanges')"
                @click="files.tab = 'changes'; emit('show-files')">
          <GitBranch :size="11" class="shrink-0" :class="files.gitSummary.changedCount > 0 ? 'text-warn' : 'text-fg-muted'" />
          <span v-if="files.gitSummary.branch" class="font-mono">{{ files.gitSummary.branch }}</span>
          <span v-else-if="files.gitSummary.detached" class="italic">{{ $t("files.detached") }}</span>
          <span class="h-1 w-1 shrink-0 rounded-full" :class="files.gitSummary.changedCount > 0 ? 'bg-warn' : 'bg-fg-muted'" aria-hidden="true" />
          <span :class="files.gitSummary.changedCount > 0 ? 'text-warn' : 'text-fg-muted'">{{ files.gitSummary.changedCount }} {{ $t("chat.changed") }}</span>
        </button>
      </div>
    </div>
    <div v-if="chat.error" data-test="chat-error"
         class="mx-3 mt-2 flex items-start gap-2 rounded-lg bg-danger/10 px-3 py-2 text-danger">
      <AlertTriangle :size="14" class="mt-0.5 shrink-0" aria-hidden="true" />
      <div class="min-w-0 flex-1">
        <p class="max-h-24 overflow-y-auto whitespace-pre-wrap break-words text-ui leading-relaxed">{{ modelRestore ? $t('chat.modelRestoreFailed', { model: modelRestore.modelId ?? '' }) : chat.error }}</p>
        <button v-if="modelRecovery" type="button" data-test="model-recovery-refresh"
                class="mt-1 rounded-sm px-1 py-0.5 text-xs font-medium underline hover:bg-danger/10"
                @click="promptInput?.refreshModels()">{{ $t('chat.modelRecoveryChoose') }}</button>
      </div>
      <button type="button" class="-mr-0.5 -mt-0.5 shrink-0 rounded-sm p-1 text-danger/70 transition-colors hover:bg-danger/10 hover:text-danger"
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
        <button data-test="booting-dismiss" class="rounded-lg px-3 py-1.5 text-xs font-medium text-fg hover:bg-fg/5"
                @click="dismissBooting">{{ $t("common.dismiss") }}</button>
      </template>
      <template v-else>
        <Loader2 :size="22" class="animate-spin motion-reduce:animate-none text-accent" aria-hidden="true" />
        <p class="text-sm font-medium text-fg">{{ $t("session.starting", { agent: currentSession?.agent }) }}
          <span class="ml-1 font-mono tabular-nums text-fg-muted">{{ bootElapsed }}s</span></p>
        <p class="max-w-sm text-xs text-fg-muted">{{ $t("session.startingHint") }}</p>
        <button data-test="booting-cancel" class="rounded-lg px-3 py-1.5 text-xs font-medium text-fg-muted hover:bg-fg/5"
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
      <!-- Same centered 48rem column as the transcript rows (MessageList mx-auto
           max-w-3xl), so status/plan/composer never outgrow the conversation on
           wide panes. Narrow screens ignore the cap (w-full). -->
      <div class="mx-auto w-full max-w-3xl">
      <!-- Document-flow stack: status (bottom) → plan (middle) → input (top).
           Overlap is visual only — lower layers reserve padding-bottom equal to the
           pull-up so content stays fully visible.
           Redesign PR2: no elevation on plan/queue strips; composer uses bg-surface
           without shadow (float shadow is reserved for overlays). -->
      <TransitionGroup
        tag="div"
        name="composer-layer"
        class="composer-stack flex flex-col"
        data-test="composer-stack"
      >
        <PlanPanel v-if="showPlan" key="plan-layer" v-model:expanded="planExpanded" :entries="chat.sessionPlan!" :active="chat.busy" variant="stack"
                   class="stack-layer stack-layer--plan relative z-20 mx-2 pb-[var(--stack-overlap)] sm:mx-3" />
        <QueueStrip v-if="showQueue" key="queue-layer"
                    class="stack-layer stack-layer--queue relative z-[25] mx-2 pb-[var(--stack-overlap)] sm:mx-3"
                    :class="{ 'stack-layer--pull': showPlan }" />
        <!-- Agent question, as its own layer directly above the composer: the
             transcript has no interaction slot, and a form the user cannot see is
             worse than no form. Topmost layer so a blocking question wins over
             plan/queue chrome. Height-bounded and internally scrollable like the
             plan panel: this layer sits in a `shrink-0` footer, so an unbounded
             list of fields would grow the footer until the composer left a phone
             screen entirely. -->
        <ConversationInteractionForm v-if="sessionInteraction" key="interaction-layer"
                                     class="stack-layer stack-layer--interaction thin-scroll relative z-40 mx-2 max-h-[min(45vh,22rem)] overflow-y-auto pb-[var(--stack-overlap)] sm:mx-3"
                                     :request="sessionInteraction.request"
                                     :answers="sessionInteraction.answers"
                                     :submitting="sessionInteraction.submitting"
                                     :error-code="sessionInteraction.errorCode"
                                     :outcome="sessionInteraction.outcome"
                                     @answer="onInteractionAnswer" @submit="onInteractionSubmit"
                                     @decline="onInteractionDecline" @cancel="onInteractionCancel"
                                     @dismiss="onInteractionDismiss" />
        <div key="composer-layer" class="stack-layer stack-layer--composer relative z-30"
             :class="{ 'stack-layer--pull': showPlan || showQueue }">
          <PromptInput ref="promptInput" :busy="chat.busy" :draft-key="`${chat.instanceId}\0${chat.sessionAlias}`"
                       :instance-id="chat.instanceId" :session-alias="chat.sessionAlias"
                       @send="onSend" @cancel="chat.cancel" />
        </div>
      </TransitionGroup>
      </div>
      </div>
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
/* Deliberately NO `.composer-layer-move` rule. TransitionGroup's move transition is a
   FLIP: Vue records each child's rect before the update and writes the delta as an inline
   `translate(dx,dy)`. This stack lives inside a `v-show` pane, so while the pane is hidden
   every child measures 0,0 — the first update after the pane is revealed then animates the
   input from (-paneLeft, -paneTop), i.e. it flies in from the upper left. Dropping the
   move class makes Vue skip FLIP entirely (hasCSSTransform is false); plan/queue layers
   keep their enter/leave fade, and reflow repositioning becomes instant. */
</style>
