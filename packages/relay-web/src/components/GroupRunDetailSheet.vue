<script setup lang="ts">
import { nextTick, ref } from "vue";
import type { ConversationRunDto, MemberTurnSummaryDto, PlanEntryDto, TurnPartDto } from "@ganglion/xacpx-relay-protocol";
import type { TraceReplayStatus } from "../lib/group-run-presentation";
import MobileSheet from "./MobileSheet.vue";
import GroupRunDetailHeader from "./GroupRunDetailHeader.vue";
import GroupRunDetailContent from "./GroupRunDetailContent.vue";
import { useDetailScrollMemory } from "../lib/use-detail-scroll-memory";
import { navigateBack } from "../lib/mobile-back";

const props = defineProps<{
  id: string;
  anchorEl: HTMLElement | null;
  scrollerEl: HTMLElement | null;
  run: ConversationRunDto;
  memberTurn?: MemberTurnSummaryDto;
  memberName?: string;
  topicTitle?: string;
  attempt?: number;
  attempts?: number[];
  parts?: TurnPartDto[];
  recordingState?: TraceReplayStatus;
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
}>();
const emit = defineEmits<{
  close: []; stop: []; pause: []; attempt: [attempt: number];
  loadMore: []; loadEarlier: []; retryTrace: [];
}>();
const sheet = ref<InstanceType<typeof MobileSheet> | null>(null);
const { remember } = useDetailScrollMemory(
  () => sheet.value?.body,
  () => `${props.memberTurn?.id ?? ""}:${props.attempt ?? ""}`,
  () => props.scrollMemory,
  () => !props.traceLoading && (props.parts?.length ?? 0) > 0,
);
function rememberScroll(event: Event): void {
  if (event.target === sheet.value?.body) remember();
}
function close(): void {
  const trigger = props.anchorEl;
  emit("close");
  void nextTick(() => trigger?.focus({ preventScroll: true }));
}
</script>

<template>
  <Teleport to="body">
    <MobileSheet
      :id="id" ref="sheet" height="tall" padded :show-close="false" z-class="z-[60]"
      test-id="group-detail-sheet"
      :title="memberName ? `${memberName} · ${$t('group.detail.title')}` : $t('group.detail.title')"
      :data-run-id="run.id" :data-member-turn-id="memberTurn?.id" :data-attempt="attempt"
      @close="close" @scroll.capture="rememberScroll"
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
</template>
