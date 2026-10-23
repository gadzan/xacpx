<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
  AlertCircle,
  CircleStop,
  HelpCircle,
  Loader2,
} from "lucide-vue-next";
import type {
  BotDetailDto,
  BotSummaryDto,
  ConversationMessageDto,
  ConversationRunDto,
  MemberTurnSummaryDto,
  PlanEntryDto,
  TurnPartDto,
  InteractionValueDto,
} from "@ganglion/xacpx-relay-protocol";
import type { DirectBotLiveTurn, PendingInteractionState } from "../stores/direct-bots";
import { useInstancesStore } from "../stores/instances";
import StreamMarkdown from "./StreamMarkdown.vue";
import TurnParts from "./TurnParts.vue";
import TranscriptRow from "./TranscriptRow.vue";
import TranscriptJumpLatest from "./TranscriptJumpLatest.vue";
import CopyButton from "./CopyButton.vue";
import BotAvatar from "./BotAvatar.vue";
import { avatarHasOpenInteraction, botAvatarState, type BotAvatarState } from "../lib/bot-avatar-state";
import PlanPanel from "./PlanPanel.vue";
import ConversationInteractionForm from "./ConversationInteractionForm.vue";
import { fmtTime, fmtDateTime } from "../lib/format";

import RunStatusChip from "./RunStatusChip.vue";
const props = defineProps<{
  messages: ConversationMessageDto[];
  liveTurn: DirectBotLiveTurn | null;
  activeRun: ConversationRunDto | null;
  activeMemberTurn: MemberTurnSummaryDto | null;
  runParts: Record<string, TurnPartDto[]>;
  planEntries?: PlanEntryDto[];
  hasMoreOlder?: boolean;
  loadingOlder?: boolean;
  loadingHistory?: boolean;
  bot?: BotDetailDto | BotSummaryDto;
  /** Intro hint under the empty-state Bot card; the pane derives it from the
   *  same state as the composer so the two never disagree. `null` hides it. */
  emptyHint?: string | null;
  instanceId?: string | null;
  avatarState?: BotAvatarState;
  avatarActivityKey?: string;
  observedAvatarCompletion?: boolean;
  loadOlder?: () => Promise<void>;
  /** Open interaction awaiting an answer, if any. Passed in rather than read
   *  from the store: this component is a pure renderer and its parent already
   *  subscribes to the store for the rest of the turn. */
  pendingInteraction?: PendingInteractionState | null;
}>();
const emit = defineEmits<{
  loadOlder: [];
  cancelRun: [];
  answer: [key: string, value: import("@ganglion/xacpx-relay-protocol").InteractionValueDto];
  submitInteraction: [];
  declineInteraction: [];
  cancelInteraction: [];
  dismissInteraction: [];
}>();

const { t } = useI18n();
const instancesStore = useInstancesStore();

const scroller = ref<HTMLElement | null>(null);
const atBottom = ref(true);
const pendingAnchor = ref<number | null>(null);
const THRESHOLD = 64;

// Elapsed timer ticker for live turn
const nowMs = ref(Date.now());
let timer: ReturnType<typeof setInterval> | null = null;
onMounted(() => {
  timer = setInterval(() => { nowMs.value = Date.now(); }, 1000);
});
onUnmounted(() => {
  if (timer) clearInterval(timer);
});

const liveElapsedLabel = computed(() => {
  if (!props.liveTurn) return "";
  const s = Math.max(0, Math.floor((nowMs.value - props.liveTurn.startedAt) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h`;
});

// Map the Run lifecycle onto the shared chip's three visual states. `waiting-human` is the
// one state where stillness is the message: the run is blocked on the user, so the dot
// stops breathing and turns warn instead of pretending to still be working.
const runChipState = computed<"running" | "queued" | "waiting">(() => {
  if (props.activeRun?.state === "waiting-human") return "waiting";
  if (props.activeRun?.state === "queued") return "queued";
  return "running";
});
const runChipLabel = computed(() => {
  if (props.activeRun?.state === "waiting-human") return t("bot.run.waitingHuman");
  if (props.activeRun?.state === "queued") return t("bot.run.queued");
  return t("bot.run.running");
});

// Resolve agent driver for bot avatar
const botDriver = computed(() => {
  if (!props.bot || !props.instanceId) return undefined;
  const inst = instancesStore.byId(props.instanceId);
  return inst?.agents.find((a) => a.name === props.bot?.agent)?.driver;
});

const currentAvatarState = computed(() => props.avatarState ?? botAvatarState({
  retired: props.bot?.retired,
  online: props.instanceId ? instancesStore.byId(props.instanceId)?.online : undefined,
  runState: props.activeRun?.state,
  liveStatus: props.liveTurn?.status,
  waiting: avatarHasOpenInteraction(props.pendingInteraction, {
    instanceId: props.instanceId,
    botId: props.bot?.id,
    run: props.activeRun,
    memberTurnId: props.activeMemberTurn?.id,
  }),
}));

function onScroll(): void {
  const el = scroller.value;
  if (!el) return;
  atBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight <= THRESHOLD;
}

function scrollToBottom(smooth = false): void {
  const el = scroller.value;
  if (!el) return;
  el.scrollTo({
    top: el.scrollHeight,
    behavior: smooth ? "smooth" : "auto",
  });
}

// Keep scroll at bottom on incoming streaming output or new messages,
// or restore exact scroll anchor when older messages are prepended.
watch(
  () => props.messages.length,
  (now, prev) => {
    if (pendingAnchor.value !== null && now > prev) {
      const anchor = pendingAnchor.value;
      pendingAnchor.value = null;
      void nextTick(() => {
        const el = scroller.value;
        if (el) {
          el.scrollTop = el.scrollHeight - anchor;
        }
      });
      return;
    }
    if (atBottom.value) {
      void nextTick(() => scrollToBottom(false));
    }
  },
);

// Monotonic stream revision from the store: every in-place mutation
// (text/reasoning append, tool upsert) bumps liveTurn.revision, while
// parts.length misses those (appendText does last.text += chunk; upsertTool
// replaces one row). The atBottom guard still protects manual scroll-up.
watch(
  () => props.liveTurn?.revision ?? 0,
  () => {
    if (atBottom.value) {
      void nextTick(() => scrollToBottom(false));
    }
  },
);

async function handleLoadOlder(): Promise<void> {
  const el = scroller.value;
  if (!el || props.loadingOlder) return;
  const anchor = el.scrollHeight - el.scrollTop;
  pendingAnchor.value = anchor;

  if (props.loadOlder) {
    try {
      await props.loadOlder();
    } finally {
      await nextTick();
      if (el && pendingAnchor.value !== null) {
        el.scrollTop = el.scrollHeight - pendingAnchor.value;
        pendingAnchor.value = null;
      }
    }
  } else {
    emit("loadOlder");
  }
}

// Parts helper for finished bot message
function partsForMessage(m: ConversationMessageDto): TurnPartDto[] | undefined {
  if (m.runId && props.runParts[m.runId]?.length) {
    return props.runParts[m.runId];
  }
  return undefined;
}
</script>

<template>
  <div class="relative flex min-h-0 flex-1 flex-col">
  <!-- px-4 on mobile (16px): a horizontally scrollable code block inside a message must
       not start within 24px of the left screen edge, or it competes with the iOS Safari
       back swipe. 16 + the block's own padding clears that. -->
  <div ref="scroller" data-test="conversation-scroller" class="thin-scroll min-h-0 flex-1 overflow-y-auto py-4 px-4 lg:py-5 lg:pl-5 lg:pr-5" @scroll.passive="onScroll">
    <!-- Load Older Button -->
    <div v-if="hasMoreOlder" class="mb-4 flex justify-center">
      <button
        type="button"
        data-test="load-older-button"
        :disabled="loadingOlder"
        class="flex items-center gap-1.5 rounded-full bg-surface px-3 py-1 text-xs font-medium text-fg-muted transition-colors hover:bg-raised hover:text-fg disabled:opacity-50"
        @click="handleLoadOlder"
      >
        <Loader2 v-if="loadingOlder" :size="12" class="animate-spin" />
        <span>{{ loadingOlder ? $t("common.loading") : $t("chat.loadOlder") }}</span>
      </button>
    </div>

    <!-- Empty State / Bot Intro: only when no messages, no live turn, and no
      terminal Run banner to show. A terminal Run without messages is a real
      outcome state (e.g. cancelled before the first assistant row), not an
      empty conversation. -->
    <div v-if="!loadingHistory && messages.length === 0 && !liveTurn && !(activeRun && (activeRun.state === 'failed' || activeRun.state === 'cancelled' || activeRun.state === 'indeterminate'))" class="my-auto flex flex-col items-center justify-center py-12 text-center">
      <BotAvatar class="mb-3" :avatar="bot?.avatar" :driver="botDriver" :name="bot?.name" :size="72"
                 :state="currentAvatarState" :activity-key="avatarActivityKey" :observed-completion="observedAvatarCompletion"
                 :disabled="bot ? !bot.enabled : false" :retired="bot?.retired" />
      <h3 class="text-base font-semibold text-fg">{{ bot?.name ?? "Direct Bot" }}</h3>
      <p v-if="bot?.role" class="mt-0.5 text-xs text-fg-muted">{{ bot.role }}</p>
      <div v-if="bot && 'instructions' in bot && bot.instructions" class="mt-3 max-w-md rounded-2xl bg-surface/60 p-3 text-left text-xs text-fg-muted leading-relaxed">
        {{ bot.instructions }}
      </div>
      <p v-if="emptyHint !== null" data-test="bot-empty-hint" class="mt-4 text-xs text-fg-muted">{{ emptyHint ?? $t("bot.chat.emptyHint") }}</p>
    </div>

    <div class="mx-auto max-w-3xl space-y-5">
      <div
        v-for="m in messages"
        :key="m.id"
        class="group flex flex-col"
        :class="m.role === 'human' ? 'items-end' : 'items-start'"
      >
        <!-- Human Message -->
        <TranscriptRow v-if="m.role === 'human'" own :row-id="m.id">
          <div class="min-w-0 max-w-full rounded-2xl rounded-tr-sm bg-accent-soft px-3.5 py-2 text-sm leading-relaxed text-fg">
            <StreamMarkdown :text="m.content" />
          </div>
          <div class="mt-0.5 flex items-center gap-1.5 text-fg-muted">
            <CopyButton :text="m.content" />
            <span class="font-mono text-xs tabular-nums">{{ fmtTime(m.createdAt) }}</span>
          </div>
        </TranscriptRow>

        <!-- Bot Message -->
        <TranscriptRow v-else-if="m.role === 'bot'" :driver="botDriver" :row-id="m.id"
                       :speaker="bot?.name ?? 'Bot'" :speaker-role="bot?.role">
          <template #avatar>
            <BotAvatar :avatar="bot?.avatar" :driver="botDriver" :name="bot?.name" :size="32" static :retired="bot?.retired" />
          </template>
          <!-- Rich TurnParts if preserved from live stream -->
          <div v-if="partsForMessage(m)" class="w-full">
            <TurnParts
              :parts="partsForMessage(m)!"
              :collapse-trace="true"
              :trace-key="`conv:${m.conversationId}:run:${m.runId}`"
            />
          </div>

          <!-- Plain StreamMarkdown fallback -->
          <div v-else class="w-full text-sm leading-relaxed text-fg">
            <StreamMarkdown :text="m.content" />
          </div>

          <div class="flex items-center gap-1.5 pt-0.5 text-fg-muted">
            <CopyButton :text="m.content" />
            <span class="font-mono text-xs tabular-nums">{{ fmtTime(m.createdAt) }}</span>
          </div>
        </TranscriptRow>

        <!-- System Message -->
        <div v-else class="w-full py-1 text-center text-xs text-fg-muted italic">
          {{ m.content }}
        </div>
      </div>

      <!-- Live Active Turn -->
      <TranscriptRow v-if="liveTurn || (activeRun && (activeRun.state === 'queued' || activeRun.state === 'running' || activeRun.state === 'waiting-human'))"
           data-test="live-turn-container"
           :driver="botDriver"
           :speaker="bot?.name ?? 'Bot'" :speaker-role="bot?.role">
        <template #avatar>
          <BotAvatar :key="avatarActivityKey" :avatar="bot?.avatar" :driver="botDriver" :name="bot?.name" :size="32"
                     :state="currentAvatarState" :activity-key="avatarActivityKey" :observed-completion="observedAvatarCompletion"
                     :disabled="bot ? !bot.enabled : false" :retired="bot?.retired" />
        </template>
        <div class="flex flex-col items-start min-w-0 w-full space-y-2">
          <!-- Open interaction: rendered inside the turn's own banner so the form
            belongs to the turn that asked. A form belongs to one exact turn, and
            showing it anywhere else invites answering a turn that has moved on. -->
          <ConversationInteractionForm
            v-if="pendingInteraction"
            :request="pendingInteraction.request"
            :answers="pendingInteraction.answers"
            :submitting="pendingInteraction.submitting"
            :error-code="pendingInteraction.errorCode"
            :outcome="pendingInteraction.outcome"
            @answer="(key: string, value: InteractionValueDto) => emit('answer', key, value)"
            @submit="emit('submitInteraction')"
            @decline="emit('declineInteraction')"
            @cancel="emit('cancelInteraction')"
            @dismiss="emit('dismissInteraction')"
          />

          <!-- Run status: the same chip the session transcript floats on its live avatar,
               so a Bot run and a session turn read as one system. The chip's dot is the
               only liveness signal; the body below never adds a spinner of its own. -->
          <div class="flex items-center gap-2 flex-wrap">
            <span class="text-xs font-semibold text-fg">{{ bot?.name ?? "Bot" }}</span>
            <RunStatusChip :state="runChipState" :label="runChipLabel" :elapsed="liveElapsedLabel || undefined" />

            <!-- Stop Button: only while the Run is non-terminal; terminal Runs
              keep their banner but must not offer another cancel RPC. -->
            <button
              v-if="activeRun && (activeRun.state === 'queued' || activeRun.state === 'running' || activeRun.state === 'waiting-human')"
              type="button"
              data-test="stop-turn-hud-button"
              class="flex items-center gap-1 rounded-sm bg-danger/10 px-2 py-0.5 text-xs font-medium text-danger transition-colors hover:bg-danger hover:text-on-danger"
              @click="emit('cancelRun')"
            >
              <CircleStop :size="11" />
              <span>{{ $t("bot.prompt.stop") }}</span>
            </button>
          </div>

          <!-- Plan Panel if plan emitted -->
          <PlanPanel v-if="planEntries && planEntries.length > 0" :entries="planEntries" class="w-full" />

          <!-- Live Turn Content. An empty run reserves its slot height only: the status
               chip above already says "in flight", and a spinner here would be a second,
               unrelated indicator that disappears the moment text arrives. -->
          <div v-if="liveTurn && liveTurn.parts.length > 0" class="w-full rounded-2xl bg-surface/50 p-3">
            <TurnParts
              :parts="liveTurn.parts"
              :streaming="liveTurn.status === 'streaming'"
            />
          </div>
          <div v-else class="h-[22px]" data-test="run-empty-slot" />
        </div>
      </TranscriptRow>

      <!-- Run Terminated State Banners (when not completed normally) -->
      <div v-if="activeRun?.state === 'failed'" class="flex items-center gap-2 rounded-2xl bg-danger/10 p-3 text-xs text-danger">
        <AlertCircle :size="16" class="shrink-0" />
        <div class="flex-1">
          <span class="font-semibold">{{ $t("bot.run.failed") }}: </span>
          <span>{{ activeRun.completionReason || $t("bot.run.unknownError") }}</span>
        </div>
      </div>

      <div v-else-if="activeRun?.state === 'cancelled'" class="flex items-center gap-2 rounded-2xl bg-surface p-3 text-xs text-fg-muted">
        <CircleStop :size="15" class="shrink-0 text-danger" />
        <span>{{ $t("bot.run.cancelled") }}</span>
      </div>

      <div v-else-if="activeRun?.state === 'indeterminate'" class="flex items-center gap-2 rounded-2xl bg-warn/10 p-3 text-xs text-warn">
        <HelpCircle :size="16" class="shrink-0" />
        <div class="flex-1">
          <span class="font-semibold">{{ $t("bot.run.indeterminate") }}: </span>
          <span>{{ $t("bot.run.indeterminateHint") }}</span>
        </div>
      </div>
    </div>

  </div>

    <TranscriptJumpLatest :visible="!atBottom" @jump="scrollToBottom()" />
</div>
</template>
