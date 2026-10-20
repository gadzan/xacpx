<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
  AlertCircle,
  CircleStop,
  HelpCircle,
  Loader2,
  Users,
} from "lucide-vue-next";
import type {
  BotSummaryDto,
  ConversationMessageDto,
  ConversationRunDto,
  MemberTurnSummaryDto,
  PlanEntryDto,
  TurnPartDto,
} from "@ganglion/xacpx-relay-protocol";
import { useGroupsStore } from "../stores/groups";
import { useDirectBotsStore } from "../stores/direct-bots";
import { useInstancesStore } from "../stores/instances";
import TranscriptRow from "./TranscriptRow.vue";
import TranscriptJumpLatest from "./TranscriptJumpLatest.vue";
import GroupHandoffEntry from "./GroupHandoffEntry.vue";
import CopyButton from "./CopyButton.vue";
import StreamMarkdown from "./StreamMarkdown.vue";
import BotAvatar from "./BotAvatar.vue";
import GroupAgentTurnRow from "./GroupAgentTurnRow.vue";
import AgentThinkingBubble from "./AgentThinkingBubble.vue";
import GroupRunDetailPopover from "./GroupRunDetailPopover.vue";
import {
  projectGroupTranscript,
  traceEventsToParts,
  type GroupRunRecord,
  type GroupTranscriptItem,
  type TraceReplayStatus,
} from "../lib/group-run-presentation";

const props = defineProps<{
  bots: BotSummaryDto[];
}>();

const { t } = useI18n();
const groupsStore = useGroupsStore();
const directBotsStore = useDirectBotsStore();
const instancesStore = useInstancesStore();

const group = computed(() => groupsStore.currentGroup);
const topic = computed(() => groupsStore.currentTopic);
const run = computed(() => groupsStore.activeRun);
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
  const bot = botById.value[botId];
  if (!bot) return botId;
  if (bot.retired) return t("bot.removal.removedName", { name: bot.name });
  return bot.name;
}

// ---------------------------------------------------------------------------
// Scoped run records: history read-model first, activeRun identity as the
// authoritative fallback for the currently executing Run. Old rows keep their
// original run/member identities — never activeRun.
// ---------------------------------------------------------------------------
const runRecords = computed<Record<string, GroupRunRecord>>(() => {
  const out: Record<string, GroupRunRecord> = {};
  void groupsStore.runHistoryDetailRevision; // reactivity dependency
  const details = groupsStore.runHistoryDetails;
  for (const detail of Object.values(details)) {
    if (detail.conversationId !== groupsStore.activeConversationId || detail.topicId !== groupsStore.activeTopicId) continue;
    const scopeKey = `${groupsStore.instanceId}:${detail.conversationId}:${detail.topicId}:${detail.id}`;
    if (details[scopeKey] !== detail) continue;
    out[detail.id] = { run: detail, memberTurns: detail.memberTurns ?? [] };
  }
  const active = groupsStore.activeRun;
  if (active) {
    const activeTurns = groupsStore.memberTurns.filter(
      (turn) => turn.runId === active.id && turn.conversationId === active.conversationId && turn.topicId === active.topicId,
    );
    const existing = out[active.id];
    const merged = new Map<string, MemberTurnSummaryDto>();
    for (const turn of existing?.memberTurns ?? []) merged.set(turn.id, turn);
    for (const turn of activeTurns) merged.set(turn.id, turn);
    out[active.id] = {
      run: active,
      memberTurns: [...merged.values()],
    };
  }
  return out;
});

const items = computed<GroupTranscriptItem[]>(() =>
  projectGroupTranscript({
    messages: groupsStore.messages,
    runs: runRecords.value,
  }),
);

/** Every run id visible in the transcript, batch-fetched non-blocking. */
const visibleRunIds = computed<string[]>(() => {
  const ids: string[] = [];
  for (const message of groupsStore.messages) {
    if (message.runId && !ids.includes(message.runId)) ids.push(message.runId);
  }
  if (groupsStore.activeRun && !ids.includes(groupsStore.activeRun.id)) {
    ids.push(groupsStore.activeRun.id);
  }
  return ids;
});

watch(
  [visibleRunIds, () => groupsStore.instanceId, () => groupsStore.activeConversationId, () => groupsStore.activeTopicId],
  () => {
    if (visibleRunIds.value.length) groupsStore.ensureRunDetails(visibleRunIds.value);
  },
  { immediate: true },
);
const openDetailKey = ref<string | null>(null);
const detailTriggerEl = ref<HTMLElement | null>(null);
const detailId = `group-detail-${useId()}`;
const selectedAttempt = ref<number | undefined>();

interface OpenDetail {
  itemKey: string;
  run: ConversationRunDto;
  memberTurn?: MemberTurnSummaryDto;
  explanation?: string;
  identityUncertain?: boolean;
}
const openDetail = computed<OpenDetail | null>(() => {
  if (!openDetailKey.value) return null;
  for (const item of items.value) {
    if (item.kind === "message" && item.bubbleAnchor && item.memberTurn && item.run) {
      const key = `bubble:${item.memberTurn.id}`;
      if (key === openDetailKey.value) return { itemKey: key, run: item.run.run, memberTurn: item.memberTurn };
    }
    if (item.kind === "member-activity" && `bubble:${item.memberTurn.id}` === openDetailKey.value) {
      const identityUncertain = !!item.explanation && item.explanation !== "missing-request" && item.explanation !== "request-mismatch";
      return { itemKey: openDetailKey.value, run: item.run.run, memberTurn: item.memberTurn, explanation: item.explanation, identityUncertain };
    }
    if (item.kind === "routing" && `routing:${item.run.run.id}` === openDetailKey.value) {
      const identityUncertain = !!item.explanation && item.explanation !== "missing-request" && item.explanation !== "request-mismatch";
      return { itemKey: openDetailKey.value, run: item.run.run, memberTurn: undefined, explanation: item.explanation, identityUncertain };
    }
  }
  return null;
});

watch(openDetail, (detail) => {
  if (detail === null && openDetailKey.value) closeDetail();
});

function closeDetail(): void {
  openDetailKey.value = null;
  detailTriggerEl.value = null;
  selectedAttempt.value = undefined;
  groupsStore.setOpenTrace(null);
}

watch(
  () => [openDetail.value?.memberTurn?.id ?? null, selectedAttempt.value ?? null, openDetail.value?.identityUncertain === true] as const,
  ([memberId, attempt, uncertain]) => {
    groupsStore.setOpenTrace(memberId && !uncertain ? memberId : null, typeof attempt === "number" ? attempt : undefined);
  },
  { immediate: true },
);
onBeforeUnmount(() => groupsStore.setOpenTrace(null));

watch(
  [() => groupsStore.instanceId, () => groupsStore.activeConversationId, () => groupsStore.activeTopicId],
  () => { closeDetail(); },
);

function toggleDetail(key: string, trigger: HTMLElement | null): void {
  if (openDetailKey.value === key) { closeDetail(); return; }
  openDetailKey.value = key;
  detailTriggerEl.value = trigger;
  selectedAttempt.value = undefined;
  const detail = openDetail.value;
  if (detail?.memberTurn) selectedAttempt.value = detail.memberTurn.attempt;
}

function changeAttempt(attempt: number): void {
  if (!detailAttempts.value.includes(attempt)) return;
  selectedAttempt.value = attempt;
}

function loadTrace(afterSeq?: number): void {
  const detail = openDetail.value;
  if (!detail?.memberTurn || detail.identityUncertain || selectedAttempt.value === undefined) return;
  void groupsStore.ensureTracePage(detail.memberTurn.id, selectedAttempt.value, afterSeq);
}

function bubbleKeyOf(memberTurnId: string): string { return `bubble:${memberTurnId}`; }
function routingKeyOf(runId: string): string { return `routing:${runId}`; }

const detailPage = computed(() => {
  const detail = openDetail.value;
  if (!detail?.memberTurn || detail.identityUncertain || selectedAttempt.value === undefined) return null;
  const scope = [groupsStore.instanceId, groupsStore.activeConversationId, groupsStore.activeTopicId].join(":");
  return groupsStore.tracePages[`${scope}:${detail.memberTurn.id}:${selectedAttempt.value}`] ?? null;
});
const detailAttempts = computed(() => {
  const member = openDetail.value?.memberTurn;
  if (!member) return [];
  return [...new Set([member.attempt, selectedAttempt.value ?? 0, ...(detailPage.value?.attempts ?? [])])]
    .filter((attempt) => attempt > 0).sort((a, b) => a - b);
});
const detailReplay = computed(() => detailPage.value ? traceEventsToParts(detailPage.value.events) : undefined);
const detailLive = computed(() => {
  const detail = openDetail.value;
  if (!detail?.memberTurn || detail.identityUncertain || selectedAttempt.value !== detail.memberTurn.attempt) return undefined;
  const live = groupsStore.liveTurnForMember(detail.memberTurn.id);
  if (live && live.attempt !== undefined && live.attempt !== selectedAttempt.value) return undefined;
  return live;
});
const detailParts = computed<TurnPartDto[] | undefined>(() => {
  if (detailReplay.value?.parts.length || detailPage.value?.events.length) return detailReplay.value?.parts;
  return detailLive.value?.parts;
});

const detailRecordingState = computed<TraceReplayStatus | undefined>(() => {
  if (detailPage.value?.recordingState) return detailPage.value.recordingState;
  return detailLive.value?.status === "streaming" ? "recording" : undefined;
});
const detailTraceFailure = computed(() => {
  const terminal = detailReplay.value?.terminal;
  if (!terminal || terminal.ok) return undefined;
  return terminal.errorMessage || t(terminal.cancelled ? "bot.run.cancelled" : "bot.run.failed");
});
const detailPlan = computed<PlanEntryDto[] | undefined>(() => {
  const page = detailPage.value;
  if (page?.plan?.length) return page.plan;
  const detail = openDetail.value;
  if (detail && !detail.identityUncertain && selectedAttempt.value === detail.memberTurn?.attempt
    && groupsStore.activeRun?.id === detail.run.id) {
    const entries = groupsStore.planByRunId[detail.run.id];
    if (entries?.length) return entries;
  }
  return undefined;
});
const siblingSummaries = computed<Array<{ name: string; state: string }> | undefined>(() => {
  const detail = openDetail.value;
  if (!detail?.memberTurn) return undefined;
  const record = runRecords.value[detail.run.id];
  if (!record) return undefined;
  const out: Array<{ name: string; state: string }> = [];
  for (const turn of record.memberTurns) {
    if (turn.id === detail.memberTurn.id) continue;
    out.push({ name: senderName(turn.botId), state: turn.state });
  }
  return out;
});
const stopAvailable = computed(() => {
  const detail = openDetail.value;
  if (!detail || detail.identityUncertain || !groupsStore.topicReady) return false;
  if (groupsStore.ownershipUncertain || groupsStore.ownerUnconfirmed) return false;
  const active = groupsStore.activeRun;
  return !!active
    && active.id === detail.run.id
    && active.conversationId === detail.run.conversationId
    && active.topicId === detail.run.topicId
    && active.conversationId === groupsStore.activeConversationId
    && active.topicId === groupsStore.activeTopicId
    && groupsStore.isRunActive;
});
const stopPending = computed(() => {
  const detail = openDetail.value;
  if (!detail) return false;
  return groupsStore.cancellingRunId === detail.run.id;
});
function handleStop(): void {
  if (stopAvailable.value && !stopPending.value) void groupsStore.cancelCurrentRun();
}
function handleToggle(key: string, event: unknown): void {
  toggleDetail(key, event instanceof HTMLElement ? event : null);
}
const explanationText = (explanation: string): string => {
  switch (explanation) {
    case "missing-request": return t("group.detail.requestMissing");
    case "request-mismatch": return t("group.detail.requestMismatch");
    case "ambiguous-owner": return t("group.bubble.unresolvedAmbiguous");
    case "owner-mismatch": return t("group.bubble.unresolvedMismatch");
    case "missing-run": return t("group.bubble.unresolvedMissingRun");
    case "no-member": return t("group.bubble.unresolvedNoMember");
    default: return t("group.bubble.unresolvedMissingRun");
  }
};
const scroller = ref<HTMLElement | null>(null);
const atBottom = ref(true);
const THRESHOLD = 64;
interface ScrollAnchor { rowId: string; offsetTop: number; }
const pendingAnchor = ref<ScrollAnchor | null>(null);
function onScroll(): void {
  const el = scroller.value;
  if (!el) return;
  atBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight <= THRESHOLD;
}
function scrollToBottom(): void {
  const el = scroller.value;
  if (!el) return;
  el.scrollTop = el.scrollHeight - el.clientHeight;
}
function jumpToMessage(messageId: string): void {
  const el = scroller.value;
  if (!el) return;
  const row = Array.from(el.querySelectorAll<HTMLElement>("[data-message-id]"))
    .find((candidate) => candidate.dataset["messageId"] === messageId);
  if (!row) return;
  row.tabIndex = -1;
  row.focus({ preventScroll: true });
  el.scrollTop += row.getBoundingClientRect().top - el.getBoundingClientRect().top;
}
watch(() => groupsStore.topicReady, (ready) => {
  if (ready) void nextTick(() => scrollToBottom());
});
// Follow on item identity, not item count: a member activity promoted to its
// canonical reply (recovery/history) keeps the count, swaps the key and grows
// the row without any live revision. Content-only growth keeps its key and is
// followed by the live revision watch below.
watch(() => {
  let signature = "";
  for (const item of items.value) signature += `${item.key}\u0000`;
  return signature;
}, (next, prev) => {
  if (prev === undefined) return;
  if (pendingAnchor.value !== null) return;
  if (atBottom.value) void nextTick(() => scrollToBottom());
});
watch(() => {
  let max = 0;
  for (const live of Object.values(groupsStore.liveTurnsByMember)) {
    if (live.revision > max) max = live.revision;
  }
  return max;
}, () => {
  if (atBottom.value) void nextTick(() => scrollToBottom());
});
onMounted(() => {
  void nextTick(() => scrollToBottom());
});

function captureAnchor(): ScrollAnchor | null {
  const el = scroller.value;
  if (!el) return null;
  const rows = el.querySelectorAll<HTMLElement>("[data-anchor-id]");
  const viewportTop = el.getBoundingClientRect().top;
  for (const row of rows) {
    const rect = row.getBoundingClientRect();
    if (rect.bottom > viewportTop) return { rowId: row.dataset["anchorId"] ?? "", offsetTop: rect.top - viewportTop };
  }
  const last = groupsStore.messages[groupsStore.messages.length - 1];
  return last ? { rowId: last.id, offsetTop: el.clientHeight } : null;
}
function restoreAnchor(anchor: ScrollAnchor): void {
  const el = scroller.value;
  if (!el) return;
  const rows = Array.from(el.querySelectorAll<HTMLElement>("[data-anchor-id]"));
  const row = rows.find((candidate) => candidate.dataset["anchorId"] === anchor.rowId);
  if (!row) return;
  const viewportTop = el.getBoundingClientRect().top;
  const shift = row.getBoundingClientRect().top - viewportTop - anchor.offsetTop;
  if (shift !== 0) el.scrollTop += shift;
}
async function handleLoadOlder(): Promise<void> {
  const el = scroller.value;
  if (!el || groupsStore.loadingOlder) return;
  pendingAnchor.value = captureAnchor();
  try { await groupsStore.loadOlder(); }
  finally {
    await nextTick();
    const anchor = pendingAnchor.value;
    if (el && anchor !== null) {
      restoreAnchor(anchor);
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      if (pendingAnchor.value === anchor) {
        restoreAnchor(anchor);
        pendingAnchor.value = null;
      }
    }
  }
}
</script>

<template>
  <div class="relative flex min-h-0 flex-1 flex-col">
  <div ref="scroller" data-test="group-transcript-scroller" class="thin-scroll min-h-0 flex-1 overflow-y-auto py-4 pl-3 pr-3 lg:py-5 lg:pl-5 lg:pr-5" @scroll.passive="onScroll">
    <div v-if="!groupsStore.loadingHistory && groupsStore.messages.length === 0 && items.length === 0 && !(run && (run.state === 'failed' || run.state === 'cancelled' || run.state === 'indeterminate'))" class="my-auto flex flex-col items-center justify-center py-12 text-center">
      <div class="mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-accent-soft text-accent">
        <Users :size="22" />
      </div>
      <h3 class="text-base font-semibold text-fg">{{ group?.title ?? "Group" }}</h3>
      <p class="mt-4 text-xs text-fg-muted">{{ $t("group.chat.emptyHint") }}</p>
    </div>

    <div v-if="groupsStore.loadingOlder || groupsStore.hasMoreBefore" class="mb-4 flex justify-center">
      <button
        type="button"
        data-test="group-load-older-button"
        :disabled="groupsStore.loadingOlder"
        class="flex items-center gap-1.5 rounded-full bg-surface px-3 py-1 text-xs font-medium text-fg-muted transition-colors hover:bg-raised hover:text-fg disabled:opacity-50"
        @click="handleLoadOlder"
      >
        <Loader2 v-if="groupsStore.loadingOlder" :size="12" class="animate-spin" />
        <span>{{ groupsStore.loadingOlder ? $t("common.loading") : $t("chat.loadOlder") }}</span>
      </button>
    </div>

    <div class="mx-auto max-w-3xl space-y-5">
      <template v-for="item in items" :key="item.key">
        <!-- Durable message / handoff / system rows -->
        <template v-if="item.kind === 'message' && !(item.bubbleAnchor && item.memberTurn)">
          <TranscriptRow
            v-if="!item.memberTurn"
            :key="item.key"
            :row-id="item.message.id"
            :data-anchor-id="item.message.id"
            :data-message-id="item.message.id"
            :own="item.message.role === 'human'"
            :driver="item.message.role === 'bot' && item.message.senderBotId ? driverForBot(item.message.senderBotId) : undefined"
            :speaker="!item.message.handoff && item.message.role === 'bot' ? senderName(item.message.senderBotId) : undefined"
            :hide-leading-avatar="!!item.message.handoff"
          >
            <template v-if="item.message.role === 'bot' && !item.message.handoff" #avatar>
              <BotAvatar :avatar="item.message.senderBotId ? botById[item.message.senderBotId]?.avatar : undefined"
                         :driver="item.message.senderBotId ? driverForBot(item.message.senderBotId) : undefined"
                         :name="senderName(item.message.senderBotId)" :size="32" static
                         :retired="item.message.senderBotId ? botById[item.message.senderBotId]?.retired : false" />
            </template>
            <GroupHandoffEntry
              v-if="item.message.handoff"
              :message="item.message"
              :from-name="senderName(item.message.senderBotId)"
              :to-name="senderName(item.message.handoff.to)"
              :from-driver="item.message.senderBotId ? driverForBot(item.message.senderBotId) : undefined"
              :to-driver="driverForBot(item.message.handoff.to)"
              :from-avatar="item.message.senderBotId ? botById[item.message.senderBotId]?.avatar : undefined"
              :to-avatar="botById[item.message.handoff.to]?.avatar"
              @jump="jumpToMessage"
            />
            <template v-else-if="item.message.role === 'human'">
              <div class="whitespace-pre-wrap break-words rounded-2xl rounded-tr-sm bg-accent-soft px-3.5 py-2 text-sm leading-relaxed text-fg">
                {{ item.message.content }}
              </div>
              <div class="mt-0.5 flex items-center gap-1.5 text-fg-muted">
                <CopyButton :text="item.message.content" />
                <span class="font-mono text-xs tabular-nums">{{ item.message.createdAt }}</span>
              </div>
            </template>

            <template v-else-if="item.message.role === 'bot'">
              <div class="w-full text-sm leading-relaxed text-fg">
                <StreamMarkdown :text="item.message.content" />
              </div>
              <div class="flex items-center gap-1.5 pt-0.5 text-fg-muted">
                <CopyButton :text="item.message.content" />
                <span class="font-mono text-xs tabular-nums">{{ item.message.createdAt }}</span>
              </div>
            </template>

            <template v-else>
              <p class="w-full py-1 text-center text-xs italic text-fg-muted">{{ item.message.content }}</p>
            </template>
          </TranscriptRow>
          <!-- Plain bot message that shares its member bubble with an earlier row -->
          <TranscriptRow
            v-else
            :key="item.key"
            :row-id="item.message.id"
            :data-anchor-id="item.message.id"
            :data-message-id="item.message.id"
            :driver="item.message.senderBotId ? driverForBot(item.message.senderBotId) : undefined"
            :speaker="senderName(item.message.senderBotId)"
          >
            <template #avatar>
              <BotAvatar :avatar="item.message.senderBotId ? botById[item.message.senderBotId]?.avatar : undefined"
                         :driver="item.message.senderBotId ? driverForBot(item.message.senderBotId) : undefined"
                         :name="senderName(item.message.senderBotId)" :size="32" static
                         :retired="item.message.senderBotId ? botById[item.message.senderBotId]?.retired : false" />
            </template>
            <div class="w-full text-sm leading-relaxed text-fg">
              <StreamMarkdown :text="item.message.content" />
            </div>
            <div class="flex items-center gap-1.5 pt-0.5 text-fg-muted">
              <CopyButton :text="item.message.content" />
              <span class="font-mono text-xs tabular-nums">{{ item.message.createdAt }}</span>
            </div>
          </TranscriptRow>
        </template>

        <!-- Canonical bubble-anchored reply: bubble above the reply body -->
        <GroupAgentTurnRow
          v-else-if="item.kind === 'message' && item.bubbleAnchor && item.memberTurn"
          :key="item.key"
          :member-turn="item.memberTurn"
          :bot="item.memberTurn.botId ? botById[item.memberTurn.botId] : undefined"
          :driver="item.memberTurn.botId ? driverForBot(item.memberTurn.botId) : undefined"
          :message="item.message"
          :name="senderName(item.memberTurn.botId)"
          :expanded="openDetailKey === bubbleKeyOf(item.memberTurn.id)"
          :controls="openDetailKey === bubbleKeyOf(item.memberTurn.id) ? detailId : undefined"
          :observed-completion="groupsStore.liveCompletedMemberTurns?.runId === item.memberTurn.runId && groupsStore.liveCompletedMemberTurns.ids[item.memberTurn.id] === true"
          :disabled="item.memberTurn.botId ? botById[item.memberTurn.botId] ? !botById[item.memberTurn.botId]!.enabled : false : false"
          @toggle="handleToggle(bubbleKeyOf(item.memberTurn.id), $event)"
        />
        <!-- Projection order keeps activity, routing and unresolved rows at their owning request. -->
        <div v-else-if="item.kind === 'member-activity'"
          :data-member-turn-id="item.memberTurn.id"
        >
          <p v-if="item.explanation" class="mb-1 text-xs text-warning" data-test="group-unresolved-activity">{{ explanationText(item.explanation) }}</p>
          <GroupAgentTurnRow
            :member-turn="item.memberTurn"
            :bot="botById[item.memberTurn.botId]"
            :driver="driverForBot(item.memberTurn.botId)"
            :name="senderName(item.memberTurn.botId)"
            :expanded="openDetailKey === bubbleKeyOf(item.memberTurn.id)"
            :controls="openDetailKey === bubbleKeyOf(item.memberTurn.id) ? detailId : undefined"
            :observed-completion="groupsStore.liveCompletedMemberTurns?.runId === item.memberTurn.runId && groupsStore.liveCompletedMemberTurns.ids[item.memberTurn.id] === true"
            :disabled="botById[item.memberTurn.botId] ? !botById[item.memberTurn.botId]!.enabled : false"
            @toggle="handleToggle(bubbleKeyOf(item.memberTurn.id), $event)"
          />
        </div>

        <!-- Neutral routing entry: no invented Bot identity -->
        <TranscriptRow
          v-else-if="item.kind === 'routing'"
          data-test="group-routing-row"
          :row-id="`routing:${item.run.run.id}`"
          :data-anchor-id="`routing:${item.run.run.id}`"
          :data-run-id="item.run.run.id"
        >
          <div class="flex items-start gap-2">
            <AgentThinkingBubble
              status="routing"
              :label="$t('group.bubble.routingLabel')"
              :expanded="openDetailKey === routingKeyOf(item.run.run.id)"
              :controls="openDetailKey === routingKeyOf(item.run.run.id) ? detailId : undefined"
              @toggle="handleToggle(routingKeyOf(item.run.run.id), $event)"
            />
            <div class="min-w-0 flex-1">
              <p class="text-xs font-medium text-fg-muted">{{ $t("group.bubble.routingTitle") }}</p>
              <p v-if="item.run.run.routingReason" class="mt-0.5 break-words text-xs text-fg-muted">{{ item.run.run.routingReason }}</p>
              <p v-if="item.explanation" class="mt-0.5 text-xs text-warning">{{ explanationText(item.explanation) }}</p>
            </div>
          </div>
        </TranscriptRow>

        <!-- Unresolved public reply: labeled, never guessed -->
        <TranscriptRow
          v-else-if="item.kind === 'unresolved'"
          :row-id="item.message.id"
          :data-anchor-id="item.message.id"
          :data-message-id="item.message.id"
          :driver="item.message.senderBotId ? driverForBot(item.message.senderBotId) : undefined"
          :speaker="senderName(item.message.senderBotId)"
        >
          <template #avatar>
            <BotAvatar :avatar="item.message.senderBotId ? botById[item.message.senderBotId]?.avatar : undefined"
                       :driver="item.message.senderBotId ? driverForBot(item.message.senderBotId) : undefined"
                       :name="senderName(item.message.senderBotId)" :size="32" static
                       :retired="item.message.senderBotId ? botById[item.message.senderBotId]?.retired : false" />
          </template>
          <div class="rounded-lg bg-warning/10 px-2.5 py-1.5 text-xs text-warning" data-test="group-unresolved">
            <HelpCircle :size="12" class="mr-1 inline" />
            {{ explanationText(item.explanation) }}
          </div>
          <div class="w-full text-sm leading-relaxed text-fg">
            <StreamMarkdown :text="item.message.content" />
          </div>
          <div class="flex items-center gap-1.5 pt-0.5 text-fg-muted">
            <CopyButton :text="item.message.content" />
            <span class="font-mono text-xs tabular-nums">{{ item.message.createdAt }}</span>
          </div>
        </TranscriptRow>
      </template>
    </div>

  </div>

  <!-- Anchored floating detail (single open). Stop stays inside the detail. -->
  <GroupRunDetailPopover
    v-if="openDetail"
    :id="detailId"
    :scroller-el="scroller"
    :anchor-el="detailTriggerEl"
    :run="openDetail.run"
    :member-turn="openDetail.memberTurn"
    :member-name="openDetail.memberTurn ? senderName(openDetail.memberTurn.botId) : undefined"
    :attempt="selectedAttempt"
    :attempts="detailAttempts"
    :explanation="openDetail.explanation ? explanationText(openDetail.explanation) : undefined"
    :parts="detailParts"
    :sibling-summaries="siblingSummaries"
    :recording-state="detailRecordingState"
    :completeness-reason="detailPage?.completenessReason"
    :plan="detailPlan"
    :trace-loading="detailPage?.loading"
    :trace-error="detailPage?.error"
    :trace-has-more="detailPage?.hasMore"
    :trace-has-earlier="detailPage?.hasEarlier"
    :trace-streaming="!!detailLive && !detailPage?.events.length"
    :trace-failure="detailTraceFailure"
    :stop-available="stopAvailable"
    :stop-pending="stopPending"
    @close="closeDetail"
    @stop="handleStop"
    @attempt="changeAttempt"
    @load-more="loadTrace()"
    @load-earlier="loadTrace(0)"
    @retry-trace="loadTrace()"
  />

  <!-- Terminal run states remain visible without a banner card: the neutral
       routing entry (or member bubbles) carries them in the popover. -->
  <TranscriptJumpLatest :visible="!atBottom" @jump="scrollToBottom()" />
</div>
</template>
