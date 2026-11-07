<script setup lang="ts">
import { computed } from "vue";
import { CircleStop, Loader2 } from "lucide-vue-next";
import type {
  ConversationRoundSummaryDto,
  ConversationRunDto,
  MemberTurnSummaryDto,
} from "@ganglion/xacpx-relay-protocol";
import RoundStrip from "./RoundStrip.vue";
import { activeSpeakerTurnId, isRunActive, showsRoundStrip } from "../lib/room-view";

/**
 * One line above the composer (design §8.2, §8.5): who is speaking, how much of
 * the Run has been spoken or passed, and Stop all. A multi-speaker Run adds the
 * RoundStrip; Direct and single-member fanout never show it.
 *
 * Stop all lives here — not in the composer — because it is a Run-level action.
 */
const props = defineProps<{
  run?: ConversationRunDto | null;
  memberTurns?: MemberTurnSummaryDto[];
  round?: ConversationRoundSummaryDto;
  /** Display name of the member holding the active turn, when known. */
  activeSpeakerName?: string;
  /** A Stop-all request is in flight. */
  stopping?: boolean;
}>();

const emit = defineEmits<{
  stopAll: [];
  /** The speaker segment opens the same detail drawer as a bot bubble. */
  openDetail: [payload: { runId?: string; memberTurnId?: string }];
}>();

const turns = computed<MemberTurnSummaryDto[]>(() => props.memberTurns ?? []);
const active = computed(() => isRunActive(props.run));
const roundVisible = computed(() => showsRoundStrip(props.round));

const spoken = computed(() =>
  props.round?.spoken
  ?? turns.value.filter((turn) => turn.state === "completed" && turn.speechOutcome !== "pass").length);
const passed = computed(() =>
  props.round?.passed ?? turns.value.filter((turn) => turn.speechOutcome === "pass").length);
const total = computed(() => props.round?.speakerCount ?? turns.value.length);
const activeCount = computed(() =>
  turns.value.filter((turn) => turn.state === "running" || turn.state === "dispatched").length);

const speakerTurnId = computed(() => activeSpeakerTurnId(props.round, turns.value));
const detailTarget = computed(() => ({
  ...(props.run?.id ? { runId: props.run.id } : {}),
  ...(speakerTurnId.value ? { memberTurnId: speakerTurnId.value } : {}),
}));

const statusText = computed<string>(() => props.activeSpeakerName ?? "");
</script>

<template>
  <div
    v-if="active || roundVisible"
    data-test="conversation-status-bar"
    class="mx-auto flex w-full max-w-3xl items-center gap-2 px-2.5 pb-1 pt-1.5 text-xs text-fg-muted lg:px-0"
  >
    <span
      class="h-1.5 w-1.5 shrink-0 rounded-full"
      :class="props.run?.state === 'queued' ? 'bg-fg-muted' : 'bg-run'"
      aria-hidden="true"
    />

    <RoundStrip
      v-if="roundVisible && round"
      :round="round"
      :speaker-name="activeSpeakerName"
      @open-detail="emit('openDetail', detailTarget)"
    />

    <template v-else>
      <button
        v-if="run?.id"
        type="button"
        data-test="conversation-status-speaker"
        class="min-w-0 truncate text-left transition-colors hover:text-fg"
        :title="$t('conversation.status.openDetail')"
        @click="emit('openDetail', detailTarget)"
      >
        <span v-if="statusText">{{ $t("conversation.status.speaking", { name: statusText }) }}</span>
        <span v-else-if="run?.state === 'queued'">{{ $t("conversation.status.queued") }}</span>
        <span v-else-if="run?.state === 'waiting-human'">{{ $t("conversation.status.waiting") }}</span>
        <span v-else>{{ $t("conversation.status.working") }}</span>
      </button>
      <span v-else class="min-w-0 truncate">{{ $t("conversation.status.working") }}</span>

      <template v-if="total > 1">
        <span aria-hidden="true">·</span>
        <span data-test="conversation-status-spoken" class="shrink-0">
          {{ $t("conversation.round.spoken", { spoken, total }) }}
        </span>
        <template v-if="passed > 0">
          <span aria-hidden="true">·</span>
          <span data-test="conversation-status-passed" class="shrink-0">
            {{ $t("conversation.round.passed", { count: passed }) }}
          </span>
        </template>
        <template v-if="activeCount > 0">
          <span aria-hidden="true">·</span>
          <span data-test="conversation-status-active" class="shrink-0">
            {{ $t("conversation.status.active", { count: activeCount }) }}
          </span>
        </template>
      </template>
    </template>

    <button
      v-if="active"
      type="button"
      data-test="conversation-stop-all"
      :disabled="stopping"
      class="ml-auto flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-0.5 text-xs font-medium text-danger transition-colors hover:bg-danger/10 disabled:opacity-50"
      @click="emit('stopAll')"
    >
      <Loader2 v-if="stopping" :size="11" class="animate-spin" />
      <CircleStop v-else :size="11" />
      <span>{{ $t("conversation.status.stopAll") }}</span>
    </button>
  </div>
</template>
