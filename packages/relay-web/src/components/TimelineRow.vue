<script setup lang="ts">
import { computed } from "vue";
import { AlertCircle, ArrowRight, Clock, MessageSquare } from "lucide-vue-next";
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
  type TimelineLiveTurn,
  type TimelineRow,
} from "../lib/room-view";

/**
 * One row of the single timeline (design §8.1).
 *
 * Speech is an ordinary bubble. A handoff is one line under its sender, never a
 * card. An activity row is the speaking position of a member without durable
 * speech — the live bubble lives here and disappears the moment the durable
 * message lands (the parent no longer hands it an overlay). A notice is one
 * light line.
 */
const props = defineProps<{
  row: TimelineRow;
  room: RoomView;
  /** True while a message's Run is durable but still queued behind the Topic's
   *  standing owner. */
  isRunQueued?: (runId: string | undefined) => boolean;
}>();

const emit = defineEmits<{
  openDetail: [payload: { runId?: string; memberTurnId?: string }];
}>();

const message = computed<ConversationMessageDto | null>(() =>
  props.row.kind === "message" ? props.row.entry.message : null);
const handoff = computed(() => message.value?.handoff);
const live = computed<TimelineLiveTurn | undefined>(() =>
  props.row.kind === "activity" ? props.row.live : undefined);

function speakerOf(botId: string | undefined): RoomParticipant | undefined {
  return participantFor(props.room, botId);
}

const author = computed(() => speakerOf(message.value?.senderBotId));
const handoffFrom = computed(() =>
  speakerOf(message.value?.senderBotId)?.name
  ?? message.value?.senderBotId
  ?? "");
const handoffTo = computed(() => {
  const target = handoff.value?.to;
  return speakerOf(target)?.name ?? target ?? "";
});

/** The detail target of a bot message: its exact MemberTurn when the read model
 *  proved ownership, else the Run (the drawer resolves the member). */
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

/** A handoff opens the assignment it created, not the sender that wrote it. */
const handoffDetail = computed(() => ({
  ...(props.row.kind === "message" && props.row.entry.runId ? { runId: props.row.entry.runId } : {}),
  ...(handoff.value?.memberTurnId ? { memberTurnId: handoff.value.memberTurnId } : {}),
}));

const activity = computed(() => {
  if (props.row.kind !== "activity") return null;
  const turn = props.row.entry.memberTurn;
  const author = speakerOf(turn.botId)?.name;
  return { turn, author };
});

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
      <ConversationMeta :message="message" />
      <p
        v-if="isRunQueued?.(message.runId)"
        data-test="queued-prompt"
        class="mt-1 text-xs text-fg-muted"
      >
        {{ $t("common.queuedPrompt") }}
      </p>
    </template>
  </TranscriptRow>

  <!-- Handoff: one line under the sender, never a card. -->
  <div
    v-else-if="row.kind === 'message' && handoff"
    class="flex w-full"
  >
    <button
      type="button"
      data-test="timeline-handoff"
      class="ml-11 flex min-w-0 max-w-full items-center gap-1.5 rounded-lg border border-hairline bg-surface/60 px-2 py-1 text-left text-xs text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg"
      :title="$t('conversation.handoff.open', { name: handoffTo })"
      @click="emit('openDetail', handoffDetail)"
    >
      <span class="shrink-0 font-medium text-fg">{{ handoffFrom }}</span>
      <ArrowRight :size="12" class="shrink-0" aria-hidden="true" />
      <span class="shrink-0 font-medium text-fg">{{ handoffTo }}</span>
      <span aria-hidden="true">·</span>
      <span class="min-w-0 truncate">{{ handoff.task }}</span>
    </button>
  </div>

  <!-- Bot message: ordinary bubble, meta/avatar open the detail drawer. -->
  <TranscriptRow
    v-else-if="row.kind === 'message' && message?.role === 'bot'"
    :driver="author?.driver"
    :row-id="message.id"
    hide-identity-on-mobile
    :speaker="author?.name"
    :speaker-role="author?.role"
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
      <ConversationMeta :message="message" />
      <button
        v-if="message.runId"
        type="button"
        data-test="timeline-open-detail"
        class="shrink-0 text-xs font-medium text-fg-muted transition-colors hover:text-fg"
        @click="emit('openDetail', messageDetail)"
      >
        {{ $t("conversation.timeline.openDetail", { name: author?.name ?? 'Bot' }) }}
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
    hide-identity-on-mobile
    :speaker="activity.author"
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
      <ThinkingDots v-else />
    </div>
  </TranscriptRow>

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
