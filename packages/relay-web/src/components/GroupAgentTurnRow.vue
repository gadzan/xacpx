<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import type {
  BotSummaryDto,
  ConversationMessageDto,
  ConversationRunDto,
  MemberTurnSummaryDto,
  TurnPartDto,
} from "@ganglion/xacpx-relay-protocol";
import BotAvatar from "./BotAvatar.vue";
import ConversationBubble from "./ConversationBubble.vue";
import TranscriptRow from "./TranscriptRow.vue";
import ConversationMeta from "./ConversationMeta.vue";
import AgentThinkingBubble, { type BubbleStatus } from "./AgentThinkingBubble.vue";
import { botAvatarState } from "../lib/bot-avatar-state";
import { textSegmentsOf } from "../lib/turn-presentation";
import StreamMarkdown from "./StreamMarkdown.vue";
import ThinkingDotsTrigger from "./ThinkingDotsTrigger.vue";

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
  singleMember?: boolean;
  runState?: ConversationRunDto["state"];
  /** True when the user stopped this member: the bubble names the stop
   *  instead of the member's own durable state. */
  stopped?: boolean;
  /** Live streaming parts for the still-running member: rendered as one text
   *  bubble per text segment plus the thinking-dots entry, never the detail
   *  popover content. Absent for finished/posted rows. */
  liveParts?: TurnPartDto[];
}>();

const { t } = useI18n();

const liveTexts = computed(() => props.liveParts ? textSegmentsOf(props.liveParts).filter((text) => text.length > 0) : []);
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

const bubbleStatusText = computed(() => {
  if (props.stopped) return `⊘ ${t("group.bubble.status.stopped")}`;
  const state = bubbleStatus.value;
  if (state === "done") return t("group.bubble.status.done");
  return t(`group.bubble.status.${state}`);
});

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

const emit = defineEmits<{ toggle: [trigger: HTMLElement | null] }>();

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
    <template v-if="liveParts !== undefined && memberTurn.state !== 'completed' && memberTurn.state !== 'failed' && memberTurn.state !== 'cancelled' && memberTurn.state !== 'indeterminate'">
      <!-- Running member: one text bubble per segment, dots beneath the last.
           No status entry, no tool/reasoning rows, no folded trace header. -->
      <div
        v-for="(text, index) in liveTexts"
        :key="`${memberTurn.id}:text:${index}`"
        class="conversation-bubble min-w-0 max-w-full text-sm leading-relaxed text-fg"
        data-test="group-member-text-bubble"
      >
        <StreamMarkdown :text="text" :streaming="index === liveTexts.length - 1" />
      </div>
      <ThinkingDotsTrigger
        :label="bubbleLabel"
        :still="singleMember && runState === 'waiting-human'"
        :expanded="expanded"
        :controls="controls"
        :status="bubbleStatusText"
        @open="emit('toggle', $event)"
      />
    </template>
    <template v-else>
      <AgentThinkingBubble
        :status="bubbleStatus"
        :label="bubbleLabel"
        :expanded="expanded"
        :attempt="memberTurn.attempt"
        :controls="controls"
        :stopped="stopped === true"
        @toggle="emit('toggle', $event)"
      />
      <template v-if="message">
        <ConversationBubble
          :message="message"
          :attachments="message.attachments"
        />
        <ConversationMeta :message="message" />
      </template>
    </template>
  </TranscriptRow>
</template>
