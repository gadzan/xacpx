<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from "vue";
import type { ConversationRunDto, MemberTurnSummaryDto, PlanEntryDto, TurnPartDto } from "@ganglion/xacpx-relay-protocol";
import type { TraceReplayStatus } from "../lib/group-run-presentation";
import MobileSheet from "./MobileSheet.vue";
import GroupRunDetailHeader from "./GroupRunDetailHeader.vue";
import GroupRunDetailContent from "./GroupRunDetailContent.vue";

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
  siblingSummaries?: Array<{ name: string; state: string }>;
  recordingState?: TraceReplayStatus;
  completenessReason?: string;
  explanation?: string;
  plan?: PlanEntryDto[];
  traceLoading?: boolean;
  traceError?: string | null;
  traceHasMore?: boolean;
  traceHasEarlier?: boolean;
  traceStreaming?: boolean;
  stopAvailable?: boolean;
  stopPending?: boolean;
  traceFailure?: string;
  scrollMemory?: Map<string, number>;
}>();
const emit = defineEmits<{
  close: []; stop: []; attempt: [attempt: number];
  loadMore: []; loadEarlier: []; retryTrace: [];
}>();
const sheet = ref<InstanceType<typeof MobileSheet> | null>(null);
const detailKey = () => `${props.memberTurn?.id ?? ""}:${props.attempt ?? ""}`;
async function restoreScroll(): Promise<void> {
  await nextTick();
  const body = sheet.value?.body;
  if (body) body.scrollTop = props.scrollMemory?.get(detailKey()) ?? 0;
}
function rememberScroll(event: Event): void {
  const body = sheet.value?.body;
  if (body && event.target === body) props.scrollMemory?.set(detailKey(), body.scrollTop);
}
function close(): void {
  const trigger = props.anchorEl;
  emit("close");
  void nextTick(() => trigger?.focus({ preventScroll: true }));
}
onMounted(restoreScroll);
watch(() => [props.memberTurn?.id, props.attempt], restoreScroll, { flush: "post" });
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
          @close="close" @stop="emit('stop')" @attempt="emit('attempt', $event)"
        />
      </template>
      <GroupRunDetailContent
        :run="run" :member-turn="memberTurn" :member-name="memberName"
        :attempt="attempt" :attempts="attempts" :parts="parts" :sibling-summaries="siblingSummaries"
        :recording-state="recordingState" :completeness-reason="completenessReason" :explanation="explanation"
        :plan="plan" :trace-failure="traceFailure" :trace-loading="traceLoading" :trace-error="traceError"
        :trace-has-more="traceHasMore" :trace-has-earlier="traceHasEarlier" :trace-streaming="traceStreaming"
        :stop-available="stopAvailable" :stop-pending="stopPending"
        @load-more="emit('loadMore')" @load-earlier="emit('loadEarlier')" @retry-trace="emit('retryTrace')"
      />
    </MobileSheet>
  </Teleport>
</template>
