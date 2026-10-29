<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type {
  BotSummaryDto,
  ConversationMessageDto,
  ConversationRunDto,
  MemberTurnSummaryDto,
} from "@ganglion/xacpx-relay-protocol";
import TranscriptRow from "./TranscriptRow.vue";
import BotAvatar from "./BotAvatar.vue";
import ConversationBubble from "./ConversationBubble.vue";
import ConversationMeta from "./ConversationMeta.vue";
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
  singleMember?: boolean;
  runState?: ConversationRunDto["state"];
  /** True when the user stopped this member: the bubble names the stop
   *  instead of the member's own durable state. */
  stopped?: boolean;
  /**
   * True when this terminal turn is an intermediate conclusion, not the
   * run's final answer: its bubble starts folded, with only the verdict
   * line as the summary. The distinction comes from the backend's
   * finalReportVerdict / run-final computation, never from parsing text.
   */
  collapsed?: boolean;
}>();

const emit = defineEmits<{ toggle: [element: HTMLElement | null] }>();

const { t } = useI18n();

/**
 * Timeline projection: when the store derived a structured report or a
 * stop notice for this message, the timeline shows that projection. The
 * raw output stays in `message.content` and in the execution detail; this
 * only chooses which text the timeline bubble renders.
 */
const displayMessage = computed(() =>
  props.message && props.message.timelineContent
    ? { ...props.message, content: props.message.timelineContent }
    : props.message,
);

/** Verdict line for a folded intermediate conclusion; never the turn state. */
const verdictLabel = computed(() => {
  const verdict = props.memberTurn.finalReportVerdict;
  if (verdict === "achieved") return t("group.bubble.finalVerdict.achieved");
  if (verdict === "not-achieved") return t("group.bubble.finalVerdict.notAchieved");
  if (verdict === "interrupted") return t("group.bubble.finalVerdict.interrupted");
  return t("group.bubble.finalVerdict.none");
});

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
      :stopped="stopped === true"
      @toggle="emit('toggle', $event)"
    />
    <template v-if="displayMessage">
      <details v-if="collapsed" data-test="group-intermediate-conclusion">
        <summary class="cursor-pointer text-xs text-fg-muted">
          {{ t("group.bubble.intermediateSummary", { name }) }} — {{ verdictLabel }}
        </summary>
        <ConversationBubble
          :message="displayMessage"
          :attachments="displayMessage.attachments"
          :collapse-trace="true"
          :trace-key="`group:${memberTurn.conversationId}:${memberTurn.runId}:${memberTurn.id}:${memberTurn.attempt}`"
          :data-final-verdict="memberTurn.finalReportVerdict ?? 'none'"
        />
      </details>
      <ConversationBubble
        v-else
        :message="displayMessage"
        :attachments="displayMessage.attachments"
        :collapse-trace="true"
        :trace-key="`group:${memberTurn.conversationId}:${memberTurn.runId}:${memberTurn.id}:${memberTurn.attempt}`"
        :data-final-verdict="memberTurn.finalReportVerdict ?? 'none'"
      />
      <ConversationMeta :message="message" />
    </template>
  </TranscriptRow>
</template>
