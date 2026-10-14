<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
  AlertCircle,
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
import TranscriptRow from "./TranscriptRow.vue";
import TranscriptJumpLatest from "./TranscriptJumpLatest.vue";
import GroupHandoffEntry from "./GroupHandoffEntry.vue";
import CopyButton from "./CopyButton.vue";
import BotAvatar from "./BotAvatar.vue";
import { botAvatarState } from "../lib/bot-avatar-state";
import PlanPanel from "./PlanPanel.vue";
import { fmtTime } from "../lib/format";

const props = defineProps<{
  bots: BotSummaryDto[];
}>();

const { t } = useI18n();
const groupsStore = useGroupsStore();
const directBotsStore = useDirectBotsStore();
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
  const bot = botById.value[botId];
  if (!bot) return botId;
  if (bot.retired) return t("bot.removal.removedName", { name: bot.name });
  return bot.name;
}

const runningNames = computed(() => turns.value.map((turn) => senderName(turn.botId)).join(", "));

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
  // promptRequestId (sourceTurn.turnId) is authoritative when present. A thin
  // local detail may not know its assignment yet; keep canonical message text
  // instead of substituting another assignment of the same Bot. Older messages
  // without source identity can use only an unambiguous member in this scope.
  const runTurns = groupsStore.memberTurns.filter((turn) => turn.runId === m.runId
    && turn.conversationId === m.conversationId && turn.topicId === m.topicId);
  const candidates = m.senderBotId ? runTurns.filter((turn) => turn.botId === m.senderBotId) : [];
  const owner = m.promptRequestId !== undefined
    ? runTurns.find((turn) => turn.promptRequestId === m.promptRequestId)
    : candidates.length === 1 ? candidates[0] : undefined;
  const parts = owner ? partsForMember(owner) : undefined;
  return parts?.length ? parts : undefined;
}

function liveForMember(memberTurnId: string): GroupLiveTurn | null {
  return groupsStore.liveTurnForMember(memberTurnId);
}

function avatarStateForMember(turn: MemberTurnSummaryDto) {
  const active = run.value;
  const scoped = active?.id === turn.runId && active.conversationId === turn.conversationId && active.topicId === turn.topicId;
  return botAvatarState({
    retired: botById.value[turn.botId]?.retired,
    online: groupsStore.instanceId ? instancesStore.byId(groupsStore.instanceId)?.online : undefined,
    runState: scoped ? active.state : undefined,
    memberState: scoped ? turn.state : undefined,
    liveStatus: scoped ? liveForMember(turn.id)?.status : undefined,
    waiting: scoped && !!directBotsStore.interactionForMember(groupsStore.instanceId, turn),
  });
}

function avatarActivityKeyForMember(turn: MemberTurnSummaryDto): string {
  return [
    groupsStore.instanceId, turn.botId, turn.conversationId, turn.topicId, turn.runId, turn.id,
  ].join(":");
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

const scroller = ref<HTMLElement | null>(null);
const atBottom = ref(true);
const THRESHOLD = 64;

/** What the reader was looking at when older history started loading.
 *  Identity-based, not distance-based: a live message appended below the
 *  viewport while the request is pending must not move the reader, and only a
 *  prepend above the anchor may shift `scrollTop`. */
interface ScrollAnchor {
  /** The first message at least partly visible when the load started. */
  messageId: string;
  /** Its top edge relative to the viewport at capture time. */
  offsetTop: number;
}
const pendingAnchor = ref<ScrollAnchor | null>(null);

function onScroll(): void {
  const el = scroller.value;
  if (!el) return;
  atBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight <= THRESHOLD;
}

function scrollToBottom(): void {
  const el = scroller.value;
  if (!el) return;
  // Assigning scrollHeight directly relies on the browser clamping it to
  // scrollHeight - clientHeight. Be explicit so the intent (and any non-browser
  // host that does not clamp) still lands exactly at the bottom.
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

// History that lands in the store (Topic open, history switch, reconnect) must put
// the reader at the newest message: the DOM starts at scrollTop 0, which is the
// OLDEST of the loaded page rather than the end of the transcript.
watch(
  () => groupsStore.topicReady,
  (ready) => {
    if (ready) void nextTick(() => scrollToBottom());
  },
);

// While an older page is loading, any length growth — a live tail append or
// the eventual prepend — must not move the reader on its own. `handleLoadOlder`
// owns the single restore authority: it compares the anchored row's element
// top before and after, so a tail append (which leaves that top untouched) is
// naturally a no-op while a real prepend produces exactly its inserted shift.
watch(
  () => groupsStore.messages.length,
  () => {
    if (pendingAnchor.value !== null) {
      return;
    }
    if (atBottom.value) {
      void nextTick(() => scrollToBottom());
    }
  },
);

// Streaming output mutates parts in place, so follow the live turn revision —
// and never yank a reader who scrolled up to review something.
watch(
  () => {
    let max = 0;
    for (const live of Object.values(groupsStore.liveTurnsByMember)) {
      if (live.revision > max) max = live.revision;
    }
    return max;
  },
  () => {
    if (atBottom.value) void nextTick(() => scrollToBottom());
  },
);

onMounted(() => {
  void nextTick(() => scrollToBottom());
});

/** First message at least partly visible in the current viewport. Walks the
 *  rendered rows in transcript order and takes the first whose bottom edge is
 *  below the viewport top. Falls back to the newest message when no row is
 *  measurable (e.g. empty transcript), which keeps `atBottom` callers sane. */
function captureAnchor(): ScrollAnchor | null {
  const el = scroller.value;
  if (!el) return null;
  const rows = el.querySelectorAll<HTMLElement>("[data-message-id]");
  const viewportTop = el.getBoundingClientRect().top;
  for (const row of rows) {
    const rect = row.getBoundingClientRect();
    if (rect.bottom > viewportTop) {
      return { messageId: row.dataset["messageId"] ?? "", offsetTop: rect.top - viewportTop };
    }
  }
  const last = groupsStore.messages[groupsStore.messages.length - 1];
  return last ? { messageId: last.id, offsetTop: el.clientHeight } : null;
}

/** Put the anchored message back where it was. Only content inserted ABOVE the
 *  anchor (older history) moves its top edge; a tail append below the viewport
 *  leaves it untouched, so the reader is not shoved when live traffic arrives
 *  mid-load. A missing row means the anchored message is gone (deleted or
 *  re-rendered away) — better to hold still than to jump somewhere arbitrary. */
function restoreAnchor(anchor: ScrollAnchor): void {
  const el = scroller.value;
  if (!el) return;
  const row = el.querySelector<HTMLElement>(`[data-message-id="${anchor.messageId}"]`);
  if (!row) {
    return;
  }
  const viewportTop = el.getBoundingClientRect().top;
  const shift = row.getBoundingClientRect().top - viewportTop - anchor.offsetTop;
  // A zero shift is a no-op by construction (the anchored row did not move),
  // but skipping the write keeps scroll-write logs — and any real browser
  // that fires scroll events on programmatic sets — quiet.
  if (shift !== 0) {
    el.scrollTop += shift;
  }
}
async function handleLoadOlder(): Promise<void> {
  const el = scroller.value;
  if (!el || groupsStore.loadingOlder) return;
  pendingAnchor.value = captureAnchor();
  try {
    await groupsStore.loadOlder();
  } finally {
    await nextTick();
    const anchor = pendingAnchor.value;
    if (el && anchor !== null) {
      restoreAnchor(anchor);
      // Offscreen rows replace intrinsic heights after the restored viewport paints.
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
  <div ref="scroller" data-test="group-transcript-scroller" class="thin-scroll relative flex-1 overflow-y-auto py-4 pl-3 pr-3 lg:py-5 lg:pl-5 lg:pr-5" @scroll.passive="onScroll">
    <div v-if="!groupsStore.loadingHistory && groupsStore.messages.length === 0 && turns.length === 0 && !(run && (run.state === 'failed' || run.state === 'cancelled' || run.state === 'indeterminate'))" class="my-auto flex flex-col items-center justify-center py-12 text-center">
      <div class="mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-accent/10 text-accent">
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
        class="flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1 text-xs font-medium text-fg-muted shadow-sm transition-colors hover:bg-raised hover:text-fg disabled:opacity-50"
        @click="handleLoadOlder"
      >
        <Loader2 v-if="groupsStore.loadingOlder" :size="12" class="animate-spin" />
        <span>{{ groupsStore.loadingOlder ? $t("common.loading") : $t("chat.loadOlder") }}</span>
      </button>
    </div>

    <div class="mx-auto max-w-3xl space-y-5">
      <TranscriptRow
        v-for="m in groupsStore.messages"
        :key="m.id"
        :data-message-id="m.id"
        :row-id="m.id"
        :own="m.role === 'human'"
        :driver="m.role === 'bot' && m.senderBotId ? driverForBot(m.senderBotId) : undefined"
        :speaker="!m.handoff && m.role === 'bot' ? senderName(m.senderBotId) : undefined"
        :hide-leading-avatar="!!m.handoff"
      >
        <template v-if="m.role === 'bot' && !m.handoff" #avatar>
          <BotAvatar :avatar="m.senderBotId ? botById[m.senderBotId]?.avatar : undefined"
                     :driver="m.senderBotId ? driverForBot(m.senderBotId) : undefined"
                     :name="senderName(m.senderBotId)" :size="24" static
                     :retired="m.senderBotId ? botById[m.senderBotId]?.retired : false" />
        </template>
        <GroupHandoffEntry
          v-if="m.handoff"
          :message="m"
          :from-name="senderName(m.senderBotId)"
          :to-name="senderName(m.handoff.to)"
          :from-driver="m.senderBotId ? driverForBot(m.senderBotId) : undefined"
          :to-driver="driverForBot(m.handoff.to)"
          :from-avatar="m.senderBotId ? botById[m.senderBotId]?.avatar : undefined"
          :to-avatar="botById[m.handoff.to]?.avatar"
          @jump="jumpToMessage"
        />
        <template v-else-if="m.role === 'human'">
          <div class="whitespace-pre-wrap break-words rounded-2xl rounded-tr-md border border-accent/15 bg-accent/10 px-3.5 py-2 text-[14px] leading-relaxed text-fg">
            {{ m.content }}
          </div>
          <div class="mt-0.5 flex items-center gap-1.5 text-fg-muted">
            <CopyButton :text="m.content" />
            <span class="font-mono text-[10.5px] tabular-nums">{{ fmtTime(m.createdAt) }}</span>
          </div>
        </template>

        <template v-else-if="m.role === 'bot'">
          <div v-if="partsForMessage(m)" class="w-full">
            <TurnParts
              :parts="partsForMessage(m)!"
              :collapse-trace="true"
              :trace-key="traceKeyForMessage(m)"
            />
          </div>
          <div v-else class="w-full text-[14px] leading-relaxed text-fg">
            <StreamMarkdown :text="m.content" />
          </div>
          <div class="flex items-center gap-1.5 pt-0.5 text-fg-muted">
            <CopyButton :text="m.content" />
            <span class="font-mono text-[10.5px] tabular-nums">{{ fmtTime(m.createdAt) }}</span>
          </div>
        </template>

        <template v-else>
          <p class="w-full py-1 text-center text-xs italic text-fg-muted">{{ m.content }}</p>
        </template>
      </TranscriptRow>

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
            <span v-if="runningNames" data-test="group-running-members" class="font-normal text-fg-muted">{{ $t("group.run.runningMembers", { names: runningNames }) }}</span>
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

        <p
          v-if="run.maxMemberTurns !== undefined"
          data-test="group-run-budget"
          class="mt-2 text-[11px] text-fg-muted"
        >
          {{ $t("group.run.budget", { consumed: run.consumedMemberTurns ?? 0, max: run.maxMemberTurns }) }}
        </p>
        <div
          v-if="run.state === 'waiting-human'"
          data-test="group-waiting-human"
          class="mt-2 rounded-lg border border-warning/30 bg-warning/10 px-2.5 py-2 text-[11px] leading-relaxed text-fg"
        >
          <p v-if="run.waitingQuestion" data-test="group-waiting-question">{{ run.waitingQuestion }}</p>
          <p class="mt-1 text-fg-muted">{{ $t("group.run.waitingManual") }}</p>
        </div>
        <p
          v-if="topic?.executionTarget?.isolation === 'shared-single-writer'"
          data-test="group-write-queue"
          class="mt-2 text-[11px] text-fg-muted"
        >
          {{ $t("group.run.writeQueue") }}
        </p>
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
              <BotAvatar :key="avatarActivityKeyForMember(turn)" :avatar="botById[turn.botId]?.avatar"
                         :driver="driverForBot(turn.botId)" :name="senderName(turn.botId)" :size="24"
                         :state="avatarStateForMember(turn)" :activity-key="avatarActivityKeyForMember(turn)"
                         :observed-completion="groupsStore.liveCompletedMemberTurns?.runId === turn.runId && groupsStore.liveCompletedMemberTurns.ids[turn.id] === true"
                         :disabled="botById[turn.botId] ? !botById[turn.botId]!.enabled : false" :retired="botById[turn.botId]?.retired" />
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
            <div v-if="turn.assignmentId || turn.task || turn.dependsOn?.length || turn.blockedReason" class="mt-1 space-y-0.5 pl-8 text-[11px] text-fg-muted">
              <p v-if="turn.assignmentId" data-test="group-member-assignment">{{ $t("group.run.assignment") }} {{ turn.assignmentId }}</p>
              <p v-if="turn.task" data-test="group-member-task">{{ turn.task }}</p>
              <p v-if="turn.dependsOn?.length" data-test="group-member-depends">{{ $t("group.run.dependsOn") }} {{ turn.dependsOn.join(", ") }}</p>
              <p v-if="turn.blockedReason" data-test="group-member-blocked" class="text-warning">
                {{ turn.blockedReason === "human-authority-required" ? $t("group.run.blockedHumanRequired") : $t("group.run.blockedHumanUnknown") }}
              </p>
            </div>

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

    <TranscriptJumpLatest :visible="!atBottom" @jump="scrollToBottom()" />
  </div>
</template>
