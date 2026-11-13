<script setup lang="ts">
import { computed } from "vue";
import { AlertCircle, Clock, GitFork, MessageSquare } from "lucide-vue-next";
import type { ConversationMessageDto } from "@ganglion/xacpx-relay-protocol";
import TranscriptRow from "./TranscriptRow.vue";
import ConversationBubble from "./ConversationBubble.vue";
import ConversationMeta from "./ConversationMeta.vue";
import BotAvatar from "./BotAvatar.vue";
import StreamMarkdown from "./StreamMarkdown.vue";
import ThinkingDots from "./ThinkingDots.vue";
import {
  participantFor,
  type RoomParticipant,
  type RoomView,
  type TimelineActivityEntry,
  type TimelineLiveTurn,
  type TimelineMessageEntry,
  type TimelineRow,
} from "../lib/room-view";

/**
 * One row of the single timeline (design §8.1).
 *
 * Speech is an ordinary bubble. A handoff is one line under its sender, never a
 * card. An activity row is the speaking position of a member without durable
 * speech — the live bubble lives here and disappears the moment the durable
 * message lands (the parent no longer hands it an overlay). A stopped row
 * aggregates every cancelled member turn of one Run. A notice is one light
 * line.
 */
const props = defineProps<{
  row: TimelineRow;
  room: RoomView;
  /** True while a message's Run is durable but still queued behind the Topic's
   *  standing owner. */
  isRunQueued?: (runId: string | undefined) => boolean;
  /** Present when this row's message may cut a fork boundary. Absent hides the
   *  control: an older core, a peer-scope Topic, or another Topic's row. */
  forkMessage?: (messageId: string) => void;
  /** Group rooms keep each speaker's avatar and name at every breakpoint:
   *  many Bots speak there, so the reader cannot infer the speaker from the
   *  pane. Direct rooms can drop them below lg. */
  keepMobileIdentity?: boolean;
}>();

const emit = defineEmits<{
  openDetail: [payload: { runId?: string; memberTurnId?: string }];
}>();

const message = computed<ConversationMessageDto | null>(() =>
  props.row.kind === "message" ? props.row.entry.message : null);
const live = computed<TimelineLiveTurn | undefined>(() =>
  props.row.kind === "activity" ? props.row.live : undefined);

function speakerOf(botId: string | undefined): RoomParticipant | undefined {
  return participantFor(props.room, botId);
}

const author = computed(() => speakerOf(message.value?.senderBotId));

/** The detail target of a bot message or activity: its exact MemberTurn when
 *  the read model proved ownership, else the Run (the drawer resolves the
 *  member). */
const messageDetail = computed(() => ({
  ...(props.row.kind === "message"
    ? {
        ...(props.row.entry.runId ? { runId: props.row.entry.runId } : {}),
        ...(props.row.entry.memberTurnId ? { memberTurnId: props.row.entry.memberTurnId } : {}),
      }
    : {}),
  ...(props.row.kind === "activity"
    ? {
        ...(props.row.entry.runId ? { runId: props.row.entry.runId } : {}),
        memberTurnId: props.row.entry.memberTurn.id,
      }
    : {}),
}));

/** A handoff is an avatar pair, and consecutive handoffs share one compact row.
 *  The accessible label keeps the member names and assignment task the old
 *  text line exposed. */
function handoffView(entry: TimelineMessageEntry) {
  const handoff = entry.message.handoff;
  const from = speakerOf(entry.message.senderBotId);
  const to = speakerOf(handoff?.to);
  const label = `${from?.name ?? entry.message.senderBotId ?? "Bot"} → ${to?.name ?? handoff?.to ?? "Bot"} · ${handoff?.task ?? ""}`;
  return {
    key: entry.key,
    from,
    to,
    label,
    detail: {
      ...(entry.runId ? { runId: entry.runId } : {}),
      ...(handoff?.memberTurnId ? { memberTurnId: handoff.memberTurnId } : {}),
    },
  };
}
const handoffs = computed(() =>
  props.row.kind === "handoffs" ? props.row.entries.map(handoffView) : []);

/** Cut a fork boundary at this row. The parent owns the capability gate; the
 *  row only reflects whether the callback exists. */
function forkHere(message: ConversationMessageDto): void {
  props.forkMessage?.(message.id);
}

const activity = computed(() => {
  if (props.row.kind !== "activity") return null;
  const turn = props.row.entry.memberTurn;
  const author = speakerOf(turn.botId)?.name;
  return { turn, author };
});

/** A cancelled Run collapses to one row: one avatar per distinct Bot, even when
 *  a multi-round roundtable cancelled several turns for the same Bot. */
const stoppedMembers = computed(() => {
  if (props.row.kind !== "stopped") return [];
  const byBot = new Map<string, TimelineActivityEntry>();
  for (const turn of props.row.turns) byBot.set(turn.memberTurn.botId, turn);
  return [...byBot.values()].map((turn) => ({
    turn,
    participant: speakerOf(turn.memberTurn.botId),
  }));
});
const stoppedShown = computed(() => stoppedMembers.value.slice(0, 4));
const stoppedOverflow = computed(() => stoppedMembers.value.length - stoppedShown.value.length);

function activityDetail(entry: TimelineActivityEntry): { runId?: string; memberTurnId: string } {
  return {
    ...(entry.runId ? { runId: entry.runId } : {}),
    memberTurnId: entry.memberTurn.id,
  };
}

const activityStateLabel = computed(() => {
  const state = activity.value?.turn.state;
  if (state === "failed") return "conversation.activity.failed";
  if (state === "cancelled") return "conversation.activity.cancelled";
  if (live.value?.status === "streaming") return "conversation.activity.speaking";
  return "conversation.activity.working";
});

const noticeIcon = computed(() => {
  if (props.row.kind !== "notice") return MessageSquare;
  if (props.row.entry.tone === "failed") return AlertCircle;
  if (props.row.entry.tone === "queued") return Clock;
  return MessageSquare;
});

const noticeToneClass = computed(() => {
  if (props.row.kind !== "notice") return "text-fg-muted";
  if (props.row.entry.tone === "failed") return "text-danger";
  return "text-fg-muted";
});
</script>

<template>
  <!-- Human message: the reader's own bubble. -->
  <TranscriptRow
    v-if="row.kind === 'message' && message?.role === 'human'"
    own
    :row-id="message.id"
  >
    <ConversationBubble :message="message" :attachments="message.attachments" own />
    <template #meta>
      <ConversationMeta :message="message">
        <template v-if="forkMessage" #operations>
          <button
            type="button"
            data-test="timeline-fork-message"
            :aria-label="$t('group.topic.forkMessage')"
            :title="$t('group.topic.forkMessage')"
            class="shrink-0 rounded-sm p-1 leading-[0] text-fg-muted hover:bg-fg/5 hover:text-fg [&_svg]:block"
            @click.stop="forkHere(message)"
          >
            <GitFork :size="14" />
          </button>
        </template>
      </ConversationMeta>
      <p
        v-if="isRunQueued?.(message.runId)"
        data-test="queued-prompt"
        class="mt-1 text-xs text-fg-muted"
      >
        {{ $t("common.queuedPrompt") }}
      </p>
    </template>
  </TranscriptRow>

  <!-- Handoff: compact avatar pairs, consecutive assignments share one row. -->
  <div
    v-else-if="row.kind === 'handoffs'"
    data-test="timeline-handoffs"
    class="ml-11 flex w-full flex-wrap items-center gap-1"
  >
    <button
      v-for="handoff in handoffs"
      :key="handoff.key"
      type="button"
      data-test="timeline-handoff"
      class="flex items-center rounded-lg p-0.5 transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      :title="handoff.label"
      :aria-label="handoff.label"
      @click="emit('openDetail', handoff.detail)"
    >
      <span class="flex items-center -space-x-1.5">
        <span class="grid rounded-full" style="box-shadow: 0 0 0 2px rgb(var(--c-bg))">
          <BotAvatar
            :avatar="handoff.from?.avatar"
            :driver="handoff.from?.driver"
            :name="handoff.from?.name"
            :size="20"
            static
            :retired="handoff.from?.retired"
          />
        </span>
        <span class="grid rounded-full" style="box-shadow: 0 0 0 2px rgb(var(--c-bg))">
          <BotAvatar
            :avatar="handoff.to?.avatar"
            :driver="handoff.to?.driver"
            :name="handoff.to?.name"
            :size="20"
            static
            :retired="handoff.to?.retired"
          />
        </span>
      </span>
      <span class="sr-only">{{ handoff.label }}</span>
    </button>
  </div>

  <!-- Bot message: ordinary bubble, meta/avatar open the detail drawer. -->
  <TranscriptRow
    v-else-if="row.kind === 'message' && message?.role === 'bot'"
    :driver="author?.driver"
    :row-id="message.id"
    :hide-identity-on-mobile="!keepMobileIdentity"
    :speaker="author?.name"
    :speaker-role="author?.role"
    speaker-clickable
    @speaker-click="emit('openDetail', messageDetail)"
  >
    <template #avatar>
      <button
        type="button"
        data-test="timeline-open-detail-avatar"
        class="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        :aria-label="$t('conversation.timeline.openDetail', { name: author?.name ?? 'Bot' })"
        @click="emit('openDetail', messageDetail)"
      >
        <BotAvatar
          :avatar="author?.avatar"
          :driver="author?.driver"
          :name="author?.name"
          :size="32"
          static
          :retired="author?.retired"
        />
      </button>
    </template>
    <div class="flex w-full min-w-0 flex-col items-start space-y-2">
      <div
        data-test="timeline-bot-message"
        class="conversation-bubble agent-bubble min-w-0 max-w-full text-sm leading-relaxed text-fg"
      >
        <ConversationBubble :message="message" :attachments="message.attachments" />
      </div>
      <p
        v-if="row.entry.ownership === 'unresolved'"
        data-test="timeline-unresolved"
        class="text-xs text-fg-muted/80"
      >
        {{ $t("conversation.timeline.unresolved") }}
      </p>
    </div>
    <template #meta>
      <ConversationMeta :message="message">
        <template v-if="forkMessage" #operations>
          <button
            type="button"
            data-test="timeline-fork-message"
            :aria-label="$t('group.topic.forkMessage')"
            :title="$t('group.topic.forkMessage')"
            class="shrink-0 rounded-sm p-1 leading-[0] text-fg-muted hover:bg-fg/5 hover:text-fg [&_svg]:block"
            @click.stop="forkHere(message)"
          >
            <GitFork :size="14" />
          </button>
        </template>
      </ConversationMeta>
      <button
        v-if="message.runId"
        type="button"
        data-test="timeline-open-detail"
        class="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-fg-muted transition-colors hover:text-fg"
        @click="emit('openDetail', messageDetail)"
      >
        <span>{{ $t("conversation.timeline.openDetailPrefix") }}</span>
        <BotAvatar
          :avatar="author?.avatar"
          :driver="author?.driver"
          :name="author?.name"
          :size="16"
          static
          aria-hidden="true"
        />
        <span v-if="$t('conversation.timeline.openDetailSuffix')">{{ $t("conversation.timeline.openDetailSuffix") }}</span>
      </button>
    </template>
  </TranscriptRow>

  <!-- Other system message: one light line. -->
  <div
    v-else-if="row.kind === 'message'"
    class="w-full py-1 text-center text-xs italic text-fg-muted"
  >
    {{ message?.content }}
  </div>

  <!-- Activity: the speaking position of a member without durable speech. -->
  <TranscriptRow
    v-else-if="row.kind === 'activity' && activity"
    data-test="timeline-activity"
    :data-state="activity.turn.state"
    :driver="speakerOf(activity.turn.botId)?.driver"
    :row-id="activity.turn.id"
    :hide-identity-on-mobile="!keepMobileIdentity"
    :speaker="activity.author"
    speaker-clickable
    @speaker-click="emit('openDetail', messageDetail)"
  >
    <template #avatar>
      <button
        type="button"
        data-test="timeline-activity-avatar"
        class="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        :aria-label="$t('conversation.timeline.openDetail', { name: activity.author ?? 'Bot' })"
        @click="emit('openDetail', messageDetail)"
      >
        <BotAvatar
          :avatar="speakerOf(activity.turn.botId)?.avatar"
          :driver="speakerOf(activity.turn.botId)?.driver"
          :name="activity.author"
          :size="32"
          :static="!live"
          :retired="speakerOf(activity.turn.botId)?.retired"
        />
      </button>
    </template>
    <div class="flex w-full min-w-0 flex-col items-start space-y-1.5">
      <span data-test="timeline-activity-state" class="text-xs text-fg-muted">
        {{ $t(activityStateLabel) }}
      </span>
      <div
        v-if="live"
        data-test="timeline-live-bubble"
        class="conversation-bubble agent-bubble min-w-0 max-w-full text-sm leading-relaxed text-fg"
      >
        <StreamMarkdown
          v-if="live.text"
          :text="live.text"
          :streaming="live.status === 'streaming'"
        />
        <ThinkingDots v-else />
      </div>
      <ThinkingDots v-else-if="activity.turn.state !== 'failed'" />
    </div>
  </TranscriptRow>

  <!-- A cancelled Run: one terminal row with each Bot's avatar, never a
       per-member status row (and never a spinner for a terminal state). -->
  <div
    v-else-if="row.kind === 'stopped'"
    data-test="timeline-stopped"
    :data-run-id="row.runId"
    class="ml-11 flex w-full flex-wrap items-center gap-2 py-1"
  >
    <div class="flex items-center -space-x-1.5">
      <button
        v-for="member in stoppedShown"
        :key="member.turn.memberTurn.id"
        type="button"
        data-test="timeline-stopped-avatar"
        class="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        :aria-label="$t('conversation.timeline.openDetail', { name: member.participant?.name ?? 'Bot' })"
        :title="member.participant?.name"
        @click="emit('openDetail', activityDetail(member.turn))"
      >
        <span
          class="grid rounded-full"
          style="box-shadow: 0 0 0 2px rgb(var(--c-bg))"
        >
          <BotAvatar
            :avatar="member.participant?.avatar"
            :driver="member.participant?.driver"
            :name="member.participant?.name"
            :size="20"
            static
            :retired="member.participant?.retired"
          />
        </span>
      </button>
      <span
        v-if="stoppedOverflow > 0"
        class="grid h-5 min-w-5 place-items-center rounded-full bg-surface-2 px-1 text-[10px] font-medium text-fg-muted"
        style="box-shadow: 0 0 0 2px rgb(var(--c-bg))"
      >+{{ stoppedOverflow }}</span>
    </div>
    <span data-test="timeline-stopped-state" class="text-xs text-fg-muted">
      {{ $t("conversation.activity.cancelled") }}
    </span>
  </div>

  <!-- Notice: queued / all-pass / failed, one light line. -->
  <div
    v-else-if="row.kind === 'notice'"
    data-test="timeline-notice"
    :data-tone="row.entry.tone"
    class="flex w-full items-center gap-1.5 py-0.5 text-xs"
    :class="noticeToneClass"
  >
    <component :is="noticeIcon" :size="12" class="shrink-0" aria-hidden="true" />
    <span class="min-w-0">
      {{ $t(`conversation.notice.${row.entry.tone}`) }}
    </span>
    <span v-if="row.entry.tone === 'failed'" class="min-w-0 truncate text-fg-muted">
      {{ row.entry.text }}
    </span>
  </div>
</template>
