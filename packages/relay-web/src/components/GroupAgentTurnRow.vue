<script setup lang="ts">
import { computed } from "vue";
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
</script>
<template>
  <TranscriptRow
    :row-id="message?.id ?? memberTurn.id"
    data-test="agent-turn-row"
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
    />
    <template v-if="message">
      <div class="w-full text-sm leading-relaxed text-fg">
        <StreamMarkdown :text="message.content" />
      </div>
      <div class="flex items-center gap-1.5 pt-0.5 text-fg-muted">
        <CopyButton :text="message.content" />
        <span class="font-mono text-xs tabular-nums">{{ message.createdAt }}</span>
      </div>
    </template>
  </TranscriptRow>
</template>
