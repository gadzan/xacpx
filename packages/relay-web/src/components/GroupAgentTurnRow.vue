<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import type {
  BotSummaryDto,
  ConversationMessageDto,
  MemberTurnSummaryDto,
} from "@ganglion/xacpx-relay-protocol";
import TranscriptRow from "./TranscriptRow.vue";
import BotAvatar from "./BotAvatar.vue";
import StreamMarkdown from "./StreamMarkdown.vue";
import CopyButton from "./CopyButton.vue";
import AgentThinkingBubble, { type BubbleStatus } from "./AgentThinkingBubble.vue";
import { botAvatarState } from "../lib/bot-avatar-state";

/**
 * One MemberTurn's ordinary Bot-like activity/reply row (frozen spec §3.1/3.2):
 * leading configured 32px avatar, Bot name, thought-bubble trigger below the
 * name, and the final public reply Markdown under the bubble. Hidden reasoning
 * and tool text never leak into the copied canonical reply.
 */
const props = defineProps<{
  /** Durable MemberTurn owning this row. */
  memberTurn: MemberTurnSummaryDto;
  bot?: BotSummaryDto;
  driver?: string | null;
  /** Final public reply; absent while the member has not produced one. */
  message?: ConversationMessageDto;
  /** Localized bot display name (retirement-aware). */
  name: string;
  /** Whether this bubble currently owns the open detail popover. */
  expanded?: boolean;
  /** id of the popover element this trigger controls. */
  controls?: string;
  /** Observed-completion signal from the live run (existing avatar behavior). */
  observedCompletion?: boolean;
  disabled?: boolean;
}>();

const emit = defineEmits<{ toggle: [element: HTMLElement | null] }>();

const { t } = useI18n();

const bubbleStatus = computed<BubbleStatus>(() => {
  const state = props.memberTurn.state;
  switch (state) {
    case "queued":
    case "dispatched":
      return "queued";
    case "running":
      return "running";
    case "completed":
      return "done";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "indeterminate":
      return "indeterminate";
  }
});

const bubbleLabel = computed(() =>
  t("group.bubble.openDetail", { name: props.name }),
);

const avatarState = computed(() =>
  botAvatarState({
    retired: props.bot?.retired,
    online: undefined,
    runState: undefined,
    memberState: props.memberTurn.state,
    liveStatus: undefined,
    waiting: false,
  }),
);

defineExpose({ bubbleStatus });

/** Pointer rests on the bubble, or the detail is open: wash the reply so the
 *  bubble reads as a handle on the text below it, never as a detached icon. */
const bubbleHovered = ref(false);
const replyWashed = computed(() => bubbleHovered.value || props.expanded === true);
</script>
<template>
  <TranscriptRow
    :row-id="message?.id ?? memberTurn.id"
    data-test="agent-turn-row"
    :class="expanded ? 'is-detail-open' : ''"
    :data-member-turn-id="memberTurn.id"
    :data-run-id="memberTurn.runId"
    :data-message-id="message?.id"
    :data-anchor-id="memberTurn.id"
    :driver="driver"
    :speaker="name"
  >
    <template #avatar>
      <BotAvatar
        :avatar="bot?.avatar"
        :driver="driver"
        :name="name"
        :size="32"
        static
        :state="avatarState"
        :activity-key="`${memberTurn.conversationId}:${memberTurn.runId}:${memberTurn.id}`"
        :observed-completion="observedCompletion"
        :disabled="disabled"
        :retired="bot?.retired"
      />
    </template>
    <AgentThinkingBubble
      :status="bubbleStatus"
      :label="bubbleLabel"
      :expanded="expanded"
      :controls="controls"
      @toggle="emit('toggle', $event)"
      @mouseenter="bubbleHovered = true"
      @mouseleave="bubbleHovered = false"
    />
    <template v-if="message">
      <div
        class="w-full text-sm leading-relaxed text-fg"
        :class="replyWashed ? 'turn-reply-wash' : ''"
      >
        <StreamMarkdown :text="message.content" />
      </div>
      <div class="flex items-center gap-1.5 pt-0.5 text-fg-muted">
        <CopyButton :text="message.content" />
        <span class="font-mono text-xs tabular-nums">{{ message.createdAt }}</span>
      </div>
    </template>
  </TranscriptRow>
</template>
<style scoped>
/* Expanded row: a quiet left accent so the open detail's owner is findable
   while scanning a long transcript. Paints on the row root, outside the
   content-visibility container, so containment cannot clip it. */
.is-detail-open { box-shadow: inset 2px 0 0 rgb(var(--c-accent)); border-radius: 10px; }
/* Bubble hover or open detail: a halo behind the reply body ties the trigger
   to the text it explains. Box-shadow keeps the halo proportional without
   changing layout mid-scroll. */
.turn-reply-wash { border-radius: 12px; box-shadow: 0 0 0 10px rgb(var(--c-accent) / 0.05); }
</style>
