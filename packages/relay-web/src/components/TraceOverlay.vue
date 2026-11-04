<script setup lang="ts">
import { nextTick, ref } from "vue";
import type {
  ConversationRunDto,
  MemberTurnSummaryDto,
  PlanEntryDto,
  TurnPartDto,
} from "@ganglion/xacpx-relay-protocol";
import { navigateBack } from "../lib/mobile-back";
import { useIsMobile } from "../lib/use-dropdown";
import { useDetailScrollMemory } from "../lib/use-detail-scroll-memory";
import MobileSheet from "./MobileSheet.vue";
import TraceOverlayDrawer from "./TraceOverlayDrawer.vue";
import GroupRunDetailHeader from "./GroupRunDetailHeader.vue";
import GroupRunDetailContent from "./GroupRunDetailContent.vue";

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
}>();

const emit = defineEmits<{
  close: [];
  stop: [];
  pause: [];
  attempt: [attempt: number];
  loadMore: [];
  loadEarlier: [];
  retryTrace: [];
}>();

const isMobile = useIsMobile();
const sheet = ref<InstanceType<typeof MobileSheet> | null>(null);

const { remember: memoizeScroll } = useDetailScrollMemory(
  () => sheet.value?.body ?? null,
  () => `${props.memberTurn?.id ?? ""}:${props.attempt ?? ""}`,
  () => props.scrollMemory,
  () => !props.traceLoading && (props.parts?.length ?? 0) > 0,
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
      :title="memberName ? `${memberName} · ${$t('group.detail.title')}` : $t('group.detail.title')"
      :data-run-id="run.id" :data-member-turn-id="memberTurn?.id" :data-attempt="attempt"
      @close="closeSheet" @scroll.capture="memoizeScroll()"
    >
      <template #header>
        <GroupRunDetailHeader
          class="max-h-[45dvh] shrink-0 overflow-y-auto border-b border-fg/5"
          variant="sheet" :run="run" :member-turn="memberTurn" :member-name="memberName" :topic-title="topicTitle"
          :attempt="attempt" :attempts="attempts" :stop-available="stopAvailable" :stop-pending="stopPending"
          :pause-available="pauseAvailable" :pause-pending="pausePending"
          @close="navigateBack" @stop="emit('stop')" @pause="emit('pause')" @attempt="emit('attempt', $event)"
        />
      </template>
      <GroupRunDetailContent
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
      :run="run" :member-turn="memberTurn" :member-name="memberName" :topic-title="topicTitle"
      :attempt="attempt" :attempts="attempts" :parts="parts"
      :recording-state="recordingState" :explanation="explanation"
      :plan="plan" :trace-failure="traceFailure" :trace-loading="traceLoading" :trace-error="traceError"
      :trace-has-more="traceHasMore" :trace-has-earlier="traceHasEarlier" :trace-streaming="traceStreaming"
      :stop-available="stopAvailable" :stop-pending="stopPending"
      :pause-available="pauseAvailable" :pause-pending="pausePending"
      :scroll-memory="scrollMemory"
      @close="emit('close')" @stop="emit('stop')" @pause="emit('pause')" @attempt="emit('attempt', $event)"
      @load-more="emit('loadMore')" @load-earlier="emit('loadEarlier')" @retry-trace="emit('retryTrace')"
    />
  </Teleport>
</template>
