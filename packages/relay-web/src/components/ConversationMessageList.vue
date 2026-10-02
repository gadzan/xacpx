<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
  AlertCircle,
  AlertTriangle,
  Bot,
  CheckCircle2,
  CircleStop,
  Clock,
  HelpCircle,
  Loader2,
  User,
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
import CopyButton from "./CopyButton.vue";
import AgentIcon from "./AgentIcon.vue";
import PlanPanel from "./PlanPanel.vue";
import ConversationInteractionForm from "./ConversationInteractionForm.vue";
import { fmtTime, fmtDateTime } from "../lib/format";

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
  instanceId?: string | null;
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

// Resolve agent driver for bot avatar
const botDriver = computed(() => {
  if (!props.bot || !props.instanceId) return undefined;
  const inst = instancesStore.byId(props.instanceId);
  return inst?.agents.find((a) => a.name === props.bot?.agent)?.driver;
});

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
  <div ref="scroller" class="thin-scroll relative flex-1 overflow-y-auto px-3 py-4 sm:px-6" @scroll.passive="onScroll">
    <!-- Load Older Button -->
    <div v-if="hasMoreOlder" class="mb-4 flex justify-center">
      <button
        type="button"
        data-test="load-older-button"
        :disabled="loadingOlder"
        class="flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1 text-xs font-medium text-fg-muted shadow-sm transition-colors hover:bg-raised hover:text-fg disabled:opacity-50"
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
      <div class="mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-accent/10 text-accent">
        <AgentIcon v-if="botDriver" :driver="botDriver" :title="bot?.name ?? 'Bot'" :size="24" />
        <Bot v-else :size="24" />
      </div>
      <h3 class="text-base font-semibold text-fg">{{ bot?.name ?? "Direct Bot" }}</h3>
      <p v-if="bot?.role" class="mt-0.5 text-xs text-fg-muted">{{ bot.role }}</p>
      <div v-if="bot && 'instructions' in bot && bot.instructions" class="mt-3 max-w-md rounded-xl border border-border bg-surface/60 p-3 text-left text-xs text-fg-muted leading-relaxed">
        {{ bot.instructions }}
      </div>
      <p class="mt-4 text-xs text-fg-muted">{{ $t("bot.chat.emptyHint") }}</p>
    </div>

    <!-- Messages List -->
    <div class="space-y-4">
      <div
        v-for="m in messages"
        :key="m.id"
        class="group flex flex-col"
        :class="m.role === 'human' ? 'items-end' : 'items-start'"
      >
        <!-- Human Message -->
        <div v-if="m.role === 'human'" class="flex max-w-[85%] items-start gap-2.5 sm:max-w-[75%]">
          <div class="flex flex-col items-end min-w-0">
            <div class="rounded-2xl bg-accent px-3.5 py-2 text-sm text-accent-fg shadow-sm leading-relaxed whitespace-pre-wrap break-words">
              {{ m.content }}
            </div>
            <div class="mt-1 flex items-center gap-2 px-1 text-[11px] text-fg-muted">
              <span>{{ fmtTime(m.createdAt) }}</span>
              <CopyButton :text="m.content" class="opacity-0 group-hover:opacity-100 transition-opacity" />
            </div>
          </div>
          <div class="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-fg/10 text-fg-muted">
            <User :size="14" />
          </div>
        </div>

        <!-- Bot Message -->
        <div v-else-if="m.role === 'bot'" class="flex max-w-[95%] sm:max-w-[85%] items-start gap-3">
          <div class="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-surface border border-border text-accent mt-0.5">
            <AgentIcon v-if="botDriver" :driver="botDriver" :title="bot?.name ?? 'Bot'" :size="15" />
            <Bot v-else :size="15" />
          </div>
          <div class="flex flex-col items-start min-w-0 flex-1">
            <div class="flex items-center gap-2 mb-1">
              <span class="text-xs font-semibold text-fg">{{ bot?.name ?? "Bot" }}</span>
              <span v-if="bot?.role" class="text-[10px] text-fg-muted font-normal">{{ bot.role }}</span>
            </div>

            <!-- Rich TurnParts if preserved from live stream -->
            <div v-if="partsForMessage(m)" class="w-full rounded-xl border border-border bg-surface/40 p-3 shadow-sm">
              <TurnParts
                :parts="partsForMessage(m)!"
                :collapse-trace="true"
                :trace-key="`conv:${m.conversationId}:run:${m.runId}`"
              />
            </div>

            <!-- Plain StreamMarkdown fallback -->
            <div v-else class="w-full rounded-2xl border border-border bg-surface/50 px-4 py-3 text-sm text-fg shadow-sm leading-relaxed">
              <StreamMarkdown :text="m.content" />
            </div>

            <div class="mt-1 flex items-center gap-2 px-1 text-[11px] text-fg-muted">
              <span>{{ fmtTime(m.createdAt) }}</span>
              <CopyButton :text="m.content" class="opacity-0 group-hover:opacity-100 transition-opacity" />
            </div>
          </div>
        </div>

        <!-- System Message -->
        <div v-else class="w-full py-1 text-center text-xs text-fg-muted italic">
          {{ m.content }}
        </div>
      </div>

      <!-- Live Active Turn -->
      <div v-if="liveTurn || (activeRun && (activeRun.state === 'queued' || activeRun.state === 'running' || activeRun.state === 'waiting-human'))"
           data-test="live-turn-container"
           class="flex max-w-[95%] sm:max-w-[85%] items-start gap-3 pt-2">
        <div class="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-surface border border-border text-accent mt-0.5">
          <AgentIcon v-if="botDriver" :driver="botDriver" :title="bot?.name ?? 'Bot'" :size="15" />
          <Bot v-else :size="15" />
        </div>

        <div class="flex flex-col items-start min-w-0 flex-1 space-y-2">
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

          <!-- Turn Live HUD Header -->
          <div class="flex items-center gap-2 flex-wrap">
            <span class="text-xs font-semibold text-fg">{{ bot?.name ?? "Bot" }}</span>
            <div class="flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-medium"
                 :class="{
                   'bg-run/15 text-run': activeRun?.state === 'running',
                   'bg-warning/15 text-warning': activeRun?.state === 'queued' || activeRun?.state === 'waiting-human',
                 }">
              <Loader2 v-if="activeRun?.state === 'running'" :size="11" class="animate-spin" />
              <Clock v-else-if="activeRun?.state === 'queued'" :size="11" />
              <AlertCircle v-else-if="activeRun?.state === 'waiting-human'" :size="11" />
              <span>{{ activeRun?.state === 'queued' ? $t("bot.run.queued") : activeRun?.state === 'running' ? $t("bot.run.running") : activeRun?.state === 'waiting-human' ? $t("bot.run.waitingHuman") : activeRun?.state ?? $t("bot.run.running") }}</span>
              <span v-if="liveElapsedLabel" class="tabular-nums font-mono opacity-80">· {{ liveElapsedLabel }}</span>
            </div>

            <!-- Stop Button: only while the Run is non-terminal; terminal Runs
              keep their banner but must not offer another cancel RPC. -->
            <button
              v-if="activeRun && (activeRun.state === 'queued' || activeRun.state === 'running' || activeRun.state === 'waiting-human')"
              type="button"
              data-test="stop-turn-hud-button"
              class="flex items-center gap-1 rounded border border-danger/40 bg-danger/10 px-2 py-0.5 text-[10.5px] font-medium text-danger hover:bg-danger/20 transition-colors"
              @click="emit('cancelRun')"
            >
              <CircleStop :size="11" />
              <span>{{ $t("bot.prompt.stop") }}</span>
            </button>
          </div>

          <!-- Plan Panel if plan emitted -->
          <PlanPanel v-if="planEntries && planEntries.length > 0" :entries="planEntries" class="w-full" />

          <!-- Live Turn Content -->
          <div v-if="liveTurn && liveTurn.parts.length > 0" class="w-full rounded-xl border border-border bg-surface/50 p-3 shadow-sm">
            <TurnParts
              :parts="liveTurn.parts"
              :streaming="liveTurn.status === 'streaming'"
            />
          </div>
          <div v-else class="flex items-center gap-2 py-2 text-xs text-fg-muted">
            <Loader2 :size="14" class="animate-spin text-accent" />
            <span>{{ $t("bot.chat.working") }}…</span>
          </div>
        </div>
      </div>

      <!-- Run Terminated State Banners (when not completed normally) -->
      <div v-if="activeRun?.state === 'failed'" class="flex items-center gap-2 rounded-xl border border-danger/30 bg-danger/10 p-3 text-xs text-danger">
        <AlertCircle :size="16" class="shrink-0" />
        <div class="flex-1">
          <span class="font-semibold">{{ $t("bot.run.failed") }}: </span>
          <span>{{ activeRun.completionReason || $t("bot.run.unknownError") }}</span>
        </div>
      </div>

      <div v-else-if="activeRun?.state === 'cancelled'" class="flex items-center gap-2 rounded-xl border border-border bg-surface p-3 text-xs text-fg-muted">
        <CircleStop :size="15" class="shrink-0 text-danger" />
        <span>{{ $t("bot.run.cancelled") }}</span>
      </div>

      <div v-else-if="activeRun?.state === 'indeterminate'" class="flex items-center gap-2 rounded-xl border border-warning/30 bg-warning/10 p-3 text-xs text-warning">
        <HelpCircle :size="16" class="shrink-0" />
        <div class="flex-1">
          <span class="font-semibold">{{ $t("bot.run.indeterminate") }}: </span>
          <span>{{ $t("bot.run.indeterminateHint") }}</span>
        </div>
      </div>
    </div>
  </div>
</template>
