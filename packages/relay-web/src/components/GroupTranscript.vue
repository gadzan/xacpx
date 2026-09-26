<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import {
  AlertCircle,
  Bot,
  CheckCircle2,
  ChevronDown,
  CircleStop,
  Clock,
  HelpCircle,
  Loader2,
  Users,
  X,
} from "lucide-vue-next";
import type {
  BotSummaryDto,
  ConversationMessageDto,
  MemberTurnSummaryDto,
  TurnPartDto,
} from "@ganglion/xacpx-relay-protocol";
import { useGroupsStore, type GroupLiveTurn } from "../stores/groups";
import { useDirectBotsStore } from "../stores/direct-bots";
import { useInstancesStore } from "../stores/instances";
import StreamMarkdown from "./StreamMarkdown.vue";
import TurnParts from "./TurnParts.vue";
import CopyButton from "./CopyButton.vue";
import AgentIcon from "./AgentIcon.vue";
import PlanPanel from "./PlanPanel.vue";
import { fmtTime } from "../lib/format";

const props = defineProps<{
  bots: BotSummaryDto[];
}>();

const { t } = useI18n();
const groupsStore = useGroupsStore();
const instancesStore = useInstancesStore();

const expandedMembers = ref<Record<string, boolean>>({});

const group = computed(() => groupsStore.currentGroup);
const topic = computed(() => groupsStore.currentTopic);
const run = computed(() => groupsStore.activeRun);
const turns = computed<MemberTurnSummaryDto[]>(() => groupsStore.memberTurns);
const botById = computed<Record<string, BotSummaryDto>>(() => {
  const out: Record<string, BotSummaryDto> = {};
  for (const b of props.bots) out[b.id] = b;
  return out;
});

function driverForBot(botId: string): string | undefined {
  const instId = groupsStore.instanceId;
  if (!instId) return undefined;
  const inst = instancesStore.byId(instId);
  const agent = botById.value[botId]?.agent;
  return inst?.agents.find((a) => a.name === agent)?.driver;
}

function senderName(botId: string | undefined): string {
  if (!botId) return "Bot";
  return botById.value[botId]?.name ?? "Bot";
}

function turnStateLabel(state: MemberTurnSummaryDto["state"]): string {
  switch (state) {
    case "queued":
    case "dispatched":
      return t("bot.run.queued");
    case "running":
      return t("bot.run.running");
    case "completed":
      return t("group.run.memberCompleted");
    case "failed":
      return t("bot.run.failed");
    case "cancelled":
      return t("bot.run.cancelled");
    case "indeterminate":
      return t("bot.run.indeterminate");
  }
}

function partsForMessage(m: ConversationMessageDto): TurnPartDto[] | undefined {
  if (!m.runId) return undefined;
  // A durable bot message belongs to exactly one MemberTurn: join through
  // promptRequestId (sourceTurn.turnId) first, then senderBotId within the
  // Run. Never read the newest member's trace for every bot row, and never
  // fall back to a different Run's parts.
  const runTurns = groupsStore.memberTurns.filter((turn) => turn.runId === m.runId);
  const byPrompt = m.promptRequestId
    ? runTurns.find((turn) => turn.promptRequestId === m.promptRequestId)
    : undefined;
  const owner = byPrompt
    ?? (m.senderBotId ? runTurns.find((turn) => turn.botId === m.senderBotId) : undefined);
  const parts = owner ? partsForMember(owner) : undefined;
  return parts?.length ? parts : undefined;
}

function liveForMember(memberTurnId: string): GroupLiveTurn | null {
  return groupsStore.liveTurnForMember(memberTurnId);
}

function partsForMember(turn: MemberTurnSummaryDto): TurnPartDto[] | undefined {
  const parts = groupsStore.completeRunParts[turn.id];
  if (parts?.length) return parts;
  if (turn.promptRequestId) {
    const byPrompt = groupsStore.completeRunParts[turn.promptRequestId];
    if (byPrompt?.length) return byPrompt;
  }
  return undefined;
}

function traceKeyForMessage(m: ConversationMessageDto): string {
  return `group:${m.conversationId}:run:${m.runId ?? ""}:member:${m.promptRequestId ?? m.senderBotId ?? ""}`;
}

function toggleMember(memberTurnId: string): void {
  expandedMembers.value = { ...expandedMembers.value, [memberTurnId]: !expandedMembers.value[memberTurnId] };
}

function isExpanded(memberTurnId: string): boolean {
  return expandedMembers.value[memberTurnId] === true;
}

function handleCancel(): void {
  void groupsStore.cancelCurrentRun();
}

function handleLoadOlder(): void {
  void groupsStore.loadOlder();
}

const scroller = ref<HTMLElement | null>(null);
const atBottom = ref(true);
const THRESHOLD = 64;

function onScroll(): void {
  const el = scroller.value;
  if (!el) return;
  atBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight <= THRESHOLD;
}
</script>

<template>
  <div ref="scroller" class="thin-scroll relative flex-1 overflow-y-auto px-3 py-4 sm:px-6" @scroll.passive="onScroll">
    <div v-if="!groupsStore.loadingHistory && groupsStore.messages.length === 0 && turns.length === 0 && !(run && (run.state === 'failed' || run.state === 'cancelled' || run.state === 'indeterminate'))" class="my-auto flex flex-col items-center justify-center py-12 text-center">
      <div class="mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-accent/10 text-accent">
        <Users :size="22" />
      </div>
      <h3 class="text-base font-semibold text-fg">{{ group?.title ?? "Group" }}</h3>
      <p class="mt-4 text-xs text-fg-muted">{{ $t("group.chat.emptyHint") }}</p>
    </div>

    <div class="space-y-4">
      <div
        v-for="m in groupsStore.messages"
        :key="m.id"
        class="group flex flex-col"
        :class="m.role === 'human' ? 'items-end' : 'items-start'"
      >
        <div v-if="m.role === 'human'" class="flex max-w-[85%] items-start gap-2.5 sm:max-w-[75%]">
          <div class="flex min-w-0 flex-col items-end">
            <div class="whitespace-pre-wrap break-words rounded-2xl bg-accent px-3.5 py-2 text-sm leading-relaxed text-accent-fg shadow-sm">
              {{ m.content }}
            </div>
            <div class="mt-1 flex items-center gap-2 px-1 text-[11px] text-fg-muted">
              <span>{{ fmtTime(m.createdAt) }}</span>
              <CopyButton :text="m.content" class="opacity-0 transition-opacity group-hover:opacity-100" />
            </div>
          </div>
        </div>

        <div v-else-if="m.role === 'bot'" class="flex max-w-[95%] items-start gap-3 sm:max-w-[85%]">
          <div class="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full border border-border bg-surface text-accent">
            <AgentIcon v-if="m.senderBotId && driverForBot(m.senderBotId)" :driver="driverForBot(m.senderBotId)!" :title="senderName(m.senderBotId)" :size="15" />
            <Bot v-else :size="15" />
          </div>
          <div class="flex min-w-0 flex-1 flex-col items-start">
            <div class="mb-1 flex items-center gap-2">
              <span class="text-xs font-semibold text-fg">{{ senderName(m.senderBotId) }}</span>
            </div>
            <div v-if="partsForMessage(m)" class="w-full rounded-xl border border-border bg-surface/40 p-3 shadow-sm">
              <TurnParts
                :parts="partsForMessage(m)!"
                :collapse-trace="true"
                :trace-key="traceKeyForMessage(m)"
              />
            </div>
            <div v-else class="w-full rounded-2xl border border-border bg-surface/50 px-4 py-3 text-sm leading-relaxed text-fg shadow-sm">
              <StreamMarkdown :text="m.content" />
            </div>
            <div class="mt-1 flex items-center gap-2 px-1 text-[11px] text-fg-muted">
              <span>{{ fmtTime(m.createdAt) }}</span>
              <CopyButton :text="m.content" class="opacity-0 transition-opacity group-hover:opacity-100" />
            </div>
          </div>
        </div>

        <div v-else class="w-full py-1 text-center text-xs italic text-fg-muted">
          {{ m.content }}
        </div>
      </div>

      <!-- Collaboration Run card: one card per Run aggregating member turns -->
      <div
        v-if="run"
        data-test="group-run-card"
        :data-run-id="run.id"
        class="rounded-xl border border-border bg-surface/60 p-3 shadow-sm"
      >
        <div class="flex items-center justify-between gap-2">
          <div class="flex items-center gap-2 text-xs font-semibold text-fg">
            <Users :size="13" class="text-accent" />
            <span>{{ $t("group.run.title") }}</span>
            <span
              class="rounded-full px-2 py-0.5 text-[10.5px] font-medium"
              :class="{
                'bg-run/15 text-run': run.state === 'running',
                'bg-warning/15 text-warning': run.state === 'queued' || run.state === 'waiting-human',
                'bg-danger/10 text-danger': run.state === 'failed',
                'bg-fg/10 text-fg-muted': run.state === 'cancelled',
              }"
            >
              {{ run.state }}
            </span>
          </div>
          <button
            v-if="run.state === 'queued' || run.state === 'running' || run.state === 'waiting-human'"
            type="button"
            data-test="group-stop-run-button"
            class="flex items-center gap-1 rounded border border-danger/40 bg-danger/10 px-2 py-0.5 text-[10.5px] font-medium text-danger transition-colors hover:bg-danger/20"
            @click="handleCancel"
          >
            <CircleStop :size="11" />
            <span>{{ $t("bot.prompt.stop") }}</span>
          </button>
        </div>

        <div class="mt-2 space-y-1.5">
          <div
            v-for="turn in turns"
            :key="turn.id"
            data-test="group-member-row"
            :data-bot-id="turn.botId"
            :data-state="turn.state"
            class="rounded-lg border border-border/60 bg-bg/60 px-2.5 py-1.5"
          >
            <button
              type="button"
              data-test="group-member-toggle"
              class="flex w-full items-center gap-2 text-left"
              @click="toggleMember(turn.id)"
            >
              <span class="grid h-6 w-6 shrink-0 place-items-center rounded-full border border-border bg-surface text-accent">
                <AgentIcon v-if="driverForBot(turn.botId)" :driver="driverForBot(turn.botId)!" :title="senderName(turn.botId)" :size="13" />
                <Bot v-else :size="13" />
              </span>
              <span class="min-w-0 flex-1 truncate text-xs font-medium text-fg">{{ senderName(turn.botId) }}</span>
              <span
                class="flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-medium"
                :class="{
                  'bg-run/15 text-run': turn.state === 'running',
                  'bg-warning/15 text-warning': turn.state === 'queued' || turn.state === 'dispatched',
                  'bg-fg/10 text-fg-muted': turn.state === 'completed' || turn.state === 'cancelled',
                  'bg-danger/10 text-danger': turn.state === 'failed',
                }"
              >
                <Loader2 v-if="turn.state === 'running'" :size="10" class="animate-spin" />
                <Clock v-else-if="turn.state === 'queued' || turn.state === 'dispatched'" :size="10" />
                <CheckCircle2 v-else-if="turn.state === 'completed'" :size="10" />
                <AlertCircle v-else-if="turn.state === 'failed'" :size="10" />
                <HelpCircle v-else-if="turn.state === 'indeterminate'" :size="10" />
                <span>{{ turnStateLabel(turn.state) }}</span>
              </span>
              <ChevronDown :size="12" class="shrink-0 text-fg-muted transition-transform" :class="isExpanded(turn.id) ? 'rotate-180' : ''" />
            </button>

            <div v-if="isExpanded(turn.id)" data-test="group-member-activity" class="mt-2">
              <div v-if="liveForMember(turn.id) && liveForMember(turn.id)!.parts.length > 0" class="rounded-lg border border-border bg-surface/50 p-2.5">
                <TurnParts
                  :parts="liveForMember(turn.id)!.parts"
                  :streaming="liveForMember(turn.id)!.status === 'streaming'"
                />
              </div>
              <div v-else-if="partsForMember(turn)?.length" class="rounded-lg border border-border bg-surface/40 p-2.5">
                <TurnParts
                  :parts="partsForMember(turn)!"
                  :collapse-trace="true"
                  :trace-key="`group:${turn.conversationId}:run:${run.id}:member:${turn.id}`"
                />
              </div>
              <div v-else class="flex items-center gap-2 py-1.5 text-xs text-fg-muted">
                <Loader2 v-if="turn.state === 'running' || turn.state === 'queued' || turn.state === 'dispatched'" :size="12" class="animate-spin text-accent" />
                <span>{{ turn.task ?? $t("group.run.memberWaiting") }}</span>
              </div>
              <div v-if="turn.failureReason" class="mt-1.5 text-[11px] text-danger">{{ turn.failureReason }}</div>
            </div>
          </div>
        </div>

        <PlanPanel v-if="groupsStore.planEntries.length > 0" :entries="groupsStore.planEntries" class="mt-2 w-full" />
      </div>

      <div v-if="groupsStore.loadingOlder || groupsStore.hasMoreBefore" class="flex justify-center">
        <button
          type="button"
          data-test="group-load-older-button"
          :disabled="groupsStore.loadingOlder"
          class="rounded-full border border-border bg-surface px-3 py-1 text-xs font-medium text-fg-muted shadow-sm transition-colors hover:bg-raised hover:text-fg disabled:opacity-50"
          @click="handleLoadOlder"
        >
          {{ $t("chat.loadOlder") }}
        </button>
      </div>
    </div>

    <div v-if="run?.state === 'failed'" class="mt-3 flex items-center gap-2 rounded-xl border border-danger/30 bg-danger/10 p-3 text-xs text-danger">
      <AlertCircle :size="16" class="shrink-0" />
      <div class="flex-1">
        <span class="font-semibold">{{ $t("bot.run.failed") }}: </span>
        <span>{{ run.completionReason || $t("bot.run.unknownError") }}</span>
      </div>
    </div>
    <div v-else-if="run?.state === 'cancelled'" class="mt-3 flex items-center gap-2 rounded-xl border border-border bg-surface p-3 text-xs text-fg-muted">
      <CircleStop :size="15" class="shrink-0 text-danger" />
      <span>{{ $t("bot.run.cancelled") }}</span>
    </div>
    <div v-else-if="run?.state === 'indeterminate'" class="mt-3 flex items-center gap-2 rounded-xl border border-warning/30 bg-warning/10 p-3 text-xs text-warning">
      <HelpCircle :size="16" class="shrink-0" />
      <div class="flex-1">
        <span class="font-semibold">{{ $t("bot.run.indeterminate") }}: </span>
        <span>{{ $t("bot.run.indeterminateHint") }}</span>
      </div>
    </div>
  </div>
</template>
