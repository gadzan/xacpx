<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import type {
  ConversationRunDto,
  InteractionValueDto,
  MemberTurnSummaryDto,
  PlanEntryDto,
  TurnPartDto,
} from "@ganglion/xacpx-relay-protocol";
import { navigateBack } from "../lib/mobile-back";
import { useIsMobile } from "../lib/use-dropdown";
import { useDetailScrollMemory } from "../lib/use-detail-scroll-memory";
import type { PendingInteractionState } from "../stores/direct-bots";
import type { RoomParticipant } from "../lib/room-view";
import type { RunBudgetView } from "../lib/run-detail";
import MobileSheet from "./MobileSheet.vue";
import TraceOverlayDrawer from "./TraceOverlayDrawer.vue";
import GroupRunDetailHeader from "./GroupRunDetailHeader.vue";
import GroupRunDetailContent from "./GroupRunDetailContent.vue";
import ConversationRunDetailContent from "./ConversationRunDetailContent.vue";

/**
 * Execution-process surface: desktop right-side drawer, mobile bottom sheet.
 * Each frame owns its own modal-layer registration and scroll memory; this
 * component only branches on the viewport and forwards the shared detail.
 */
const props = defineProps<{
  id: string;
  run: ConversationRunDto;
  memberTurn?: MemberTurnSummaryDto;
  memberName?: string;
  topicTitle?: string;
  attempt?: number;
  attempts?: number[];
  parts?: TurnPartDto[];
  recordingState?: "complete" | "recording" | "interrupted" | "unavailable";
  explanation?: string;
  plan?: PlanEntryDto[];
  traceLoading?: boolean;
  traceError?: string | null;
  traceHasMore?: boolean;
  traceHasEarlier?: boolean;
  traceStreaming?: boolean;
  stopAvailable?: boolean;
  stopPending?: boolean;
  pauseAvailable?: boolean;
  pausePending?: boolean;
  traceFailure?: string;
  scrollMemory?: Map<string, number>;
  /** The trigger that opened the overlay; focused on close. */
  anchorEl?: HTMLElement | null;
  /** Run-wide mode: every durable member turn of the Run. Passing this (even
   *  empty) switches the drawer from one member's process to the Run drawer. */
  memberTurns?: MemberTurnSummaryDto[];
  selectedMemberTurnId?: string;
  participants?: RoomParticipant[];
  budget?: RunBudgetView;
  interactions?: PendingInteractionState[];
  capability?: { cancelMember: boolean };
  cancelPending?: boolean;
}>();

const emit = defineEmits<{
  close: [];
  stop: [];
  pause: [];
  attempt: [attempt: number];
  loadMore: [];
  loadEarlier: [];
  retryTrace: [];
  selectMember: [memberTurnId: string];
  stopMember: [memberTurnId: string];
  interactionAnswer: [requestId: string, key: string, value: InteractionValueDto];
  interactionSubmit: [requestId: string];
  interactionDecline: [requestId: string];
  interactionCancel: [requestId: string];
  interactionDismiss: [requestId: string];
}>();

const runWide = computed(() => props.memberTurns !== undefined);
const selectedMember = computed(() => {
  if (!runWide.value) return props.memberTurn;
  return props.memberTurns?.find((member) => member.id === props.selectedMemberTurnId)
    ?? props.memberTurns?.find((member) => member.state === "running" || member.state === "dispatched")
    ?? props.memberTurns?.[props.memberTurns.length - 1];
});


const isMobile = useIsMobile();
const sheet = ref<InstanceType<typeof MobileSheet> | null>(null);

const { remember: memoizeScroll } = useDetailScrollMemory(
  () => sheet.value?.body ?? null,
  () => runWide.value
    ? `${props.run.id}:${selectedMember.value?.id ?? ""}:${props.attempt ?? ""}`
    : `${props.memberTurn?.id ?? ""}:${props.attempt ?? ""}`,
  () => props.scrollMemory,
  () => runWide.value
    ? !props.traceLoading
    : !props.traceLoading && (props.parts?.length ?? 0) > 0,
);

function closeSheet(): void {
  const anchor = props.anchorEl;
  emit("close");
  // The sheet's own modal layer restores focus; align it with the trigger
  // when that failed (unmounted or re-rendered trigger).
  void nextTick(() => {
    if (document.activeElement === document.body || document.activeElement === null) {
      anchor?.focus({ preventScroll: true });
    }
  });
}
</script>

<template>
  <!-- Mobile: bottom sheet, matching the detail sheet chrome. -->
  <Teleport v-if="isMobile" to="body">
    <MobileSheet
      :id="id" ref="sheet" height="tall" padded :show-close="false" z-class="z-[60]"
      test-id="group-detail-sheet"
      :title="runWide
        ? $t('conversation.runDetail.title')
        : memberName ? `${memberName} · ${$t('group.detail.title')}` : $t('group.detail.title')"
      :data-run-id="run.id" :data-member-turn-id="selectedMember?.id" :data-attempt="attempt"
      @close="closeSheet" @scroll.capture="memoizeScroll()"
    >
      <template #header>
        <GroupRunDetailHeader
          class="max-h-[45dvh] shrink-0 overflow-y-auto border-b border-fg/5"
          variant="sheet" :run="run"
          :member-turn="runWide ? undefined : memberTurn"
          :member-name="runWide ? undefined : memberName"
          :topic-title="topicTitle"
          :attempt="attempt" :attempts="attempts"
          :stop-available="runWide ? false : stopAvailable"
          :stop-pending="stopPending"
          :pause-available="runWide ? false : pauseAvailable"
          :pause-pending="pausePending"
          @close="navigateBack" @stop="emit('stop')" @pause="emit('pause')" @attempt="emit('attempt', $event)"
        />
      </template>
      <ConversationRunDetailContent
        v-if="runWide"
        :run="run" :member-turns="memberTurns!" :selected-member-turn-id="selectedMember?.id"
        :participants="participants" :budget="budget" :interactions="interactions"
        :capability="capability" :cancel-pending="cancelPending"
        :attempt="attempt" :attempts="attempts" :parts="parts"
        :recording-state="recordingState" :plan="plan" :trace-failure="traceFailure"
        :trace-loading="traceLoading" :trace-error="traceError"
        :trace-has-more="traceHasMore" :trace-has-earlier="traceHasEarlier" :trace-streaming="traceStreaming"
        @select-member="emit('selectMember', $event)" @stop-member="emit('stopMember', $event)"
        @load-more="emit('loadMore')" @load-earlier="emit('loadEarlier')" @retry-trace="emit('retryTrace')"
        @interaction-answer="(requestId, key, value) => emit('interactionAnswer', requestId, key, value)"
        @interaction-submit="emit('interactionSubmit', $event)"
        @interaction-decline="emit('interactionDecline', $event)"
        @interaction-cancel="emit('interactionCancel', $event)"
        @interaction-dismiss="emit('interactionDismiss', $event)"
      />
      <GroupRunDetailContent
        v-else
        :run="run" :member-turn="memberTurn" :member-name="memberName"
        :attempt="attempt" :attempts="attempts" :parts="parts"
        :recording-state="recordingState" :explanation="explanation"
        :plan="plan" :trace-failure="traceFailure" :trace-loading="traceLoading" :trace-error="traceError"
        :trace-has-more="traceHasMore" :trace-has-earlier="traceHasEarlier" :trace-streaming="traceStreaming"
        :stop-available="stopAvailable" :stop-pending="stopPending"
        @load-more="emit('loadMore')" @load-earlier="emit('loadEarlier')" @retry-trace="emit('retryTrace')"
      />
    </MobileSheet>
  </Teleport>

  <!-- Desktop: right-side drawer; owns its own modal registration. -->
  <Teleport v-else to="body">
    <TraceOverlayDrawer
      :id="id" :anchor-el="anchorEl"
      :run="run" :member-turn="runWide ? selectedMember : memberTurn"
      :member-name="runWide ? undefined : memberName" :topic-title="topicTitle"
      :attempt="attempt" :attempts="attempts" :parts="parts"
      :recording-state="recordingState" :explanation="explanation"
      :plan="plan" :trace-failure="traceFailure" :trace-loading="traceLoading" :trace-error="traceError"
      :trace-has-more="traceHasMore" :trace-has-earlier="traceHasEarlier" :trace-streaming="traceStreaming"
      :stop-available="runWide ? false : stopAvailable" :stop-pending="stopPending"
      :pause-available="runWide ? false : pauseAvailable" :pause-pending="pausePending"
      :scroll-memory="scrollMemory"
      :run-wide="runWide"
      :member-turns="memberTurns" :selected-member-turn-id="selectedMember?.id"
      :participants="participants" :budget="budget" :interactions="interactions"
      :capability="capability" :cancel-pending="cancelPending"
      @close="emit('close')" @stop="emit('stop')" @pause="emit('pause')" @attempt="emit('attempt', $event)"
      @load-more="emit('loadMore')" @load-earlier="emit('loadEarlier')" @retry-trace="emit('retryTrace')"
      @select-member="emit('selectMember', $event)" @stop-member="emit('stopMember', $event)"
      @interaction-answer="(requestId, key, value) => emit('interactionAnswer', requestId, key, value)"
      @interaction-submit="emit('interactionSubmit', $event)"
      @interaction-decline="emit('interactionDecline', $event)"
      @interaction-cancel="emit('interactionCancel', $event)"
      @interaction-dismiss="emit('interactionDismiss', $event)"
    />
  </Teleport>
</template>
