<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type {
  BotSummaryDto,
  ConversationMessageDto,
  ConversationRunDto,
  MemberTurnSummaryDto,
  TurnPartDto,
} from "@ganglion/xacpx-relay-protocol";
import TranscriptRow from "./TranscriptRow.vue";
import BotAvatar from "./BotAvatar.vue";
import ConversationBubble from "./ConversationBubble.vue";
import ConversationMeta from "./ConversationMeta.vue";
import type { TurnPresentationPlan } from "../lib/turn-presentation";
import AgentThinkingBubble, { type BubbleStatus } from "./AgentThinkingBubble.vue";
import { botAvatarState } from "../lib/bot-avatar-state";

/**
 * One MemberTurn's ordinary Bot-like activity/reply row (frozen spec §3.1/3.2):
 * leading configured 32px avatar, Bot name, the member's task as one quiet
 * line, the status entry below the name, and the final public reply Markdown
 * under the entry. Hidden reasoning and tool text never leak into the copied
 * canonical reply.
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
  /** Whether this entry currently owns the open detail popover. */
  expanded?: boolean;
  /** id of the popover element this trigger controls. */
  controls?: string;
  /** Observed-completion signal from the live run (existing avatar behavior). */
  observedCompletion?: boolean;
  disabled?: boolean;
  parts?: TurnPartDto[];
  presentation?: TurnPresentationPlan;
  singleMember?: boolean;
  elapsed?: string;
  stopAvailable?: boolean;
  stopPending?: boolean;
  runState?: ConversationRunDto["state"];
}>();

const emit = defineEmits<{ toggle: [element: HTMLElement | null]; stop: [] }>();

const { t } = useI18n();

const bubbleStatus = computed<BubbleStatus>(() => {
  if (props.singleMember && props.runState === "waiting-human") return "waiting";
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

/** The task is one quiet line: enough to know what this member was asked for,
 *  never the whole assignment, which stays in the detail. */
const taskHint = computed(() => {
  const task = props.memberTurn.task?.trim();
  if (!task) return undefined;
  return task.length > 60 ? `${task.slice(0, 60)}…` : task;
});

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
    :speaker-role="bot?.role"
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
    <p v-if="taskHint" class="w-full text-xs leading-relaxed text-fg-muted" data-test="group-member-task-hint">
      {{ taskHint }}
    </p>
    <AgentThinkingBubble
      :status="bubbleStatus"
      :label="bubbleLabel"
      :expanded="expanded"
      :attempt="memberTurn.attempt"
      :controls="controls"
      :single-member="singleMember"
      :elapsed="elapsed"
      :stop-available="stopAvailable"
      :stop-pending="stopPending"
      @stop="emit('stop')"
      @toggle="emit('toggle', $event)"
    />
    <template v-if="message">
      <ConversationBubble
        :message="message"
        :attachments="message.attachments"
        :parts="parts"
        :presentation="presentation"
        :collapse-trace="true"
        :trace-key="`group:${memberTurn.conversationId}:${memberTurn.runId}:${memberTurn.id}:${memberTurn.attempt}`"
      />
      <ConversationMeta :message="message" :parts="parts" :presentation="presentation" />
    </template>
  </TranscriptRow>
</template>
