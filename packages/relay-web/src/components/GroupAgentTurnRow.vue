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
import { textBubblesOf } from "../lib/turn-presentation";
import StreamMarkdown from "./StreamMarkdown.vue";
import ThinkingDotsTrigger from "./ThinkingDotsTrigger.vue";
import TraceLink from "./TraceLink.vue";

/**
 * One MemberTurn's ordinary Bot-like activity/reply row (frozen spec §3.1/3.2):
 * leading configured 32px avatar, Bot name, the member's task as one quiet
 * line, the status entry below the name, and the final public reply Markdown
 * under the entry. Hidden reasoning and tool text never leak into the copied
 * canonical reply.
 */
const props = withDefaults(defineProps<{
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
  /** Live streaming parts for the still-running member: rendered as the
   *  member's newest text bubble plus the thinking-dots entry, never the
   *  detail popover content. Absent for finished/posted rows. */
  liveParts?: TurnPartDto[];
  segment?: { text: string; last: boolean };
  rowId?: string;
  anchorId?: string;
  /** Dots under the member's live bubble; shown only while the member runs. */
  liveDots?: boolean;
  /** Streaming caret on the live bubble; shown only while the member runs. */
  liveStreaming?: boolean;
}>(), {
  liveDots: true,
  liveStreaming: true,
});

const { t } = useI18n();

const livePreviewText = computed(() => {
  const texts = props.liveParts ? textBubblesOf(props.liveParts) : [];
  for (let index = texts.length - 1; index >= 0; index -= 1) {
    const text = texts[index]!;
    if (text.trim().length > 0) return text;
  }
  return "";
});
const finishedBubbles = computed(() => {
  const message = props.message;
  if (!message) return [];
  if (props.segment) return [{ segment: props.segment.text, message, last: props.segment.last }];
  return [{ segment: (message.content ?? "").trimEnd(), message, last: true }];
});
const showMeta = computed(() => !props.segment || props.segment.last);
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
/** Finished rows name what the entry opens; a non-completed member keeps its
 *  word so a failure never hides behind a neutral label. */
const traceText = computed(() => {
  if (props.stopped) return `${t("bot.run.viewProcess")} · ${t("group.bubble.status.stopped")}`;
  const state = bubbleStatus.value;
  return state === "done"
    ? t("bot.run.viewProcess")
    : `${t("bot.run.viewProcess")} · ${t(`group.bubble.status.${state}`)}`;
});
const traceTone = computed<"muted" | "warn" | "accent">(() => {
  if (props.stopped) return "muted";
  switch (bubbleStatus.value) {
    case "failed":
    case "indeterminate":
    case "waiting":
      return "warn";
    case "cancelled":
      return "muted";
    default:
      return "muted";
  }
});
/** The accessible name's state part: a stop says "stopped" regardless of the
 *  member's own durable state, anything else says what the row is. */
const statusWord = computed(() =>
  props.stopped ? t("group.bubble.status.stopped") : t(`group.bubble.status.${bubbleStatus.value}`));



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
    :row-id="rowId ?? message?.id ?? memberTurn.id"
    data-test="agent-turn-row"
    :data-member-turn-id="memberTurn.id"
    :data-run-id="memberTurn.runId"
    :data-message-id="message?.id"
    :data-anchor-id="anchorId ?? memberTurn.id"
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
    <template v-if="liveParts !== undefined">
      <div
        v-if="livePreviewText"
        :key="`${memberTurn.id}:text`"
        class="conversation-bubble agent-bubble min-w-0 max-w-full text-sm leading-relaxed text-fg"
        data-test="group-member-text-bubble"
      >
        <StreamMarkdown :text="livePreviewText" :streaming="liveStreaming !== false" />
      </div>
      <ThinkingDotsTrigger
        v-if="liveDots !== false"
        :label="bubbleLabel"
        :still="singleMember && runState === 'waiting-human'"
        :expanded="expanded"
        :controls="controls"
        @open="emit('toggle', $event)"
      />
    </template>
    <template v-else>
      <!-- One settled bubble per message; the process entry, meta and copy render once. -->
      <template v-if="finishedBubbles.length">
        <div
          v-for="(row, index) in finishedBubbles"
          :key="`${memberTurn.id}:settled:${index}`"
          class="conversation-bubble agent-bubble min-w-0 max-w-full text-sm leading-relaxed text-fg"
          data-test="group-finished-text-bubble"
        >
          <ConversationBubble
            :message="{ ...row.message, content: row.segment }"
            :attachments="row.last ? row.message.attachments : undefined"
          />
          <TraceLink
            v-if="row.last"
            :label="bubbleLabel"
            :text="traceText"
            :state-word="stopped || bubbleStatus !== 'done' ? statusWord : undefined"
            :expanded="expanded"
            :controls="controls"
            :tone="traceTone"
            @toggle="emit('toggle', $event)"
          />
        </div>
      </template>
      <AgentThinkingBubble
        v-else
        :status="bubbleStatus"
        :label="bubbleLabel"
        :expanded="expanded"
        :attempt="memberTurn.attempt"
        :controls="controls"
        :stopped="stopped === true"
        @toggle="emit('toggle', $event)"
      />
      <ConversationMeta v-if="message && showMeta" :message="message" />
    </template>
  </TranscriptRow>
</template>
