<script setup lang="ts">
import { computed, ref } from "vue";
import type {
  ConversationRunDto,
  MemberTurnSummaryDto,
  PlanEntryDto,
  TurnPartDto,
} from "@ganglion/xacpx-relay-protocol";
import { useI18n } from "vue-i18n";
import GroupTraceTimeline from "./GroupTraceTimeline.vue";
import TraceLiveStack from "./TraceLiveStack.vue";
import { isMachineFailureReason } from "../lib/failure-reason";
import { useLiveDuration } from "../lib/run-duration";
import { useIsMobile } from "../lib/use-dropdown";
import PlanPanel from "./PlanPanel.vue";
import type { TraceReplayStatus } from "../lib/group-run-presentation";
import { deriveTurnPresentation } from "../lib/turn-presentation";
import { traceLiveLimit, traceNodeIdentity } from "../lib/trace-live";
import { traceDrawerScopeKey, useTraceDrawerState } from "../lib/trace-drawer-state";

const props = defineProps<{
  run: ConversationRunDto;
  memberTurn?: MemberTurnSummaryDto;
  attempt?: number;
  /** Ordered replayed/combined member trace parts (empty = none recorded). */
  parts?: TurnPartDto[];
  recordingState?: TraceReplayStatus;
  explanation?: string;
  plan?: PlanEntryDto[];
  traceLoading?: boolean;
  traceError?: string | null;
  traceHasMore?: boolean;
  /** Terminal trace event failure (tool/terminal failure surface). */
  traceHasEarlier?: boolean;
  traceStreaming?: boolean;
  /** Exact-current active run ownership: Stop is shown only when all agree. */
  stopAvailable?: boolean;
  stopPending?: boolean;
}>();

const emit = defineEmits<{
  loadMore: [];
  loadEarlier: [];
  retryTrace: [];
}>();

const { t } = useI18n();

const recordingNotice = computed(() => {
  switch (props.recordingState) {
    case "complete": return undefined;
    case "recording": return t("group.detail.recording.recording");
    case "interrupted": return t("group.detail.recording.interrupted");
    case "unavailable": return t("group.detail.recording.unavailable");
    default: return undefined;
  }
});

const recordedParts = computed(() => props.parts ?? []);
const canStop = computed(() => props.stopAvailable === true
  && (props.run.state === "queued" || props.run.state === "running" || props.run.state === "waiting-human"));

const selectedAttempt = computed(() => props.attempt ?? props.memberTurn?.attempt);
const historicalAttempt = computed(() => selectedAttempt.value !== props.memberTurn?.attempt);
const hasBrief = computed(() => !!props.memberTurn
  && !!(props.memberTurn.task || props.memberTurn.expectedOutput));
const duration = useLiveDuration(() => props.memberTurn
  ? undefined
  : { startedAt: props.run.startedAt, finishedAt: props.run.finishedAt, active: props.run.state === "running" });

const nodes = computed(() => deriveTurnPresentation(recordedParts.value, {
  streaming: props.traceStreaming === true,
}).nodes);

const contentEl = ref<HTMLElement | null>(null);
const scopeKey = computed(() => traceDrawerScopeKey(props.memberTurn?.id, selectedAttempt.value));
const traceDrawer = useTraceDrawerState({
  scopeKey: () => scopeKey.value,
  scroller: () => contentEl.value?.closest<HTMLElement>(".group-detail-scroll, .thin-scroll") ?? null,
  root: () => contentEl.value,
  nodeIds: () => nodes.value.map(traceNodeIdentity),
});

const isMobile = useIsMobile();
const liveKeys = computed(() => new Set(
  nodes.value.slice(-traceLiveLimit(isMobile.value)).map((node) => node.key),
));

/** Terminal runs collapse the live stack to one summary line. A terminal run
 *  state wins over a member snapshot that has not caught up yet. */
const terminalState = computed<"done" | "failed" | "cancelled" | null>(() => {
  const member = props.memberTurn?.state;
  const state = member === "completed" || member === "failed" || member === "cancelled"
    ? member
    : props.run.state;
  if (state === "completed") return "done";
  if (state === "failed") return "failed";
  if (state === "cancelled") return "cancelled";
  return null;
});

</script>

<template>
  <!-- `overflow-anchor: none`: this content grows at the tail while output
       streams. The browser otherwise re-anchors by a few pixels when a
       viewport-skipped row re-estimates its height, nudging a reader who is
       above the tail. Follow/freeze is owned by useTraceDrawerState instead. -->
  <div ref="contentEl" class="flex flex-col gap-3 text-sm [overflow-anchor:none]" data-test="group-run-detail">
    <TraceLiveStack
      v-if="nodes.length"
      :nodes="nodes"
      :streaming="traceStreaming === true && !terminalState"
      :terminal="terminalState"
      @reveal="traceDrawer.reveal"
    />
    <div v-if="memberTurn" class="min-w-0">
      <details v-if="hasBrief" data-test="group-member-brief" class="mt-2 text-xs text-fg-muted">
        <summary class="cursor-pointer rounded-md py-1 font-medium outline-none focus-visible:ring-2 focus-visible:ring-accent">
          {{ $t("group.detail.brief") }}
        </summary>
        <div class="mt-1.5 space-y-1.5 rounded-lg bg-surface/50 p-2.5">
          <p v-if="memberTurn.task" data-test="group-member-task" class="break-words leading-relaxed text-fg">{{ memberTurn.task }}</p>
          <p v-if="memberTurn.expectedOutput" data-test="group-member-expected" class="break-words">
            {{ $t("group.detail.expectedOutput") }} {{ memberTurn.expectedOutput }}
          </p>
        </div>
      </details>
      <p v-if="memberTurn.blockedReason" data-test="group-member-blocked" class="mt-1 break-words text-xs text-warning">
        {{ memberTurn.blockedReason === "human-authority-required"
          ? $t("group.run.blockedHumanRequired")
          : $t("group.run.blockedHumanUnknown") }}
      </p>
      <p v-if="memberTurn.failureReason && !historicalAttempt && !isMachineFailureReason(memberTurn.failureReason)"
         data-test="group-member-failure" class="mt-1 break-words text-xs text-danger">
        {{ memberTurn.failureReason }}
      </p>
    </div>

    <!-- Stop feedback stays at the top: the user closed the run deliberately
         and needs its outcome without scrolling past a trace. -->
    <p v-if="run.state === 'cancelled'" data-test="group-detail-stopped" class="rounded-lg bg-surface/50 px-2.5 py-2 text-xs leading-relaxed text-fg-muted">
      {{ $t("group.detail.stoppedNote") }}
    </p>

    <p v-if="run.state === 'paused'" data-test="group-detail-paused"
       class="rounded-lg bg-warning/10 px-2.5 py-2 text-xs leading-relaxed text-fg">
      {{ $t("group.detail.pausedNote") }}
    </p>

    <div v-if="run.state === 'waiting-human'" data-test="group-waiting-human"
         class="rounded-lg bg-warning/10 px-2.5 py-2 text-xs leading-relaxed text-fg">
      <p v-if="run.waitingQuestion" data-test="group-waiting-question">{{ run.waitingQuestion }}</p>
      <p class="mt-1 text-fg-muted">{{ $t("group.run.waitingManual") }}</p>
    </div>

    <!-- Contradictory identity retained without trace or stop ownership. -->
    <p v-if="explanation" data-test="group-detail-explanation" class="text-xs text-warning">{{ explanation }}</p>
    <p v-if="!memberTurn && duration" data-test="group-detail-duration" class="text-xs text-fg-muted">
      {{ $t("group.detail.duration", { duration }) }}
    </p>

    <!-- Recorded member trace -->
    <div v-if="nodes.length" class="min-w-0">
      <GroupTraceTimeline
        :key="`${memberTurn?.id}:${selectedAttempt}`"
        :nodes="nodes"
        :streaming="traceStreaming === true"
        :expanded-keys="traceDrawer.state.expanded"
        :live-keys="liveKeys"
        :highlight-key="traceDrawer.state.highlight"
        @toggle="traceDrawer.toggle"
      />
    </div>

    <!-- Trace completeness/pagination/failure status: always audible, even
         when a partial window is all that exists. -->
    <div
      v-if="memberTurn && (recordingNotice || traceHasMore || traceHasEarlier || traceLoading || traceError)"
      data-test="group-trace-status"
      class="space-y-1 text-xs text-fg-muted"
      aria-live="polite"
      aria-atomic="true"
    >
      <p v-if="recordingNotice">{{ recordingNotice }}</p>
      <p v-if="recordingState === 'complete' && (traceHasMore || traceHasEarlier)" class="break-words">
        {{ traceHasEarlier ? $t("group.detail.earlierWindow") : $t("group.detail.partialPage") }}
      </p>
      <p v-if="traceLoading">{{ $t("group.detail.loading") }}</p>
      <p v-if="traceError" role="alert" class="break-words text-danger">{{ traceError }}</p>
      <div class="flex flex-wrap gap-2">
        <button v-if="traceHasEarlier" type="button" data-test="group-trace-load-earlier"
                class="underline disabled:opacity-50" :disabled="traceLoading" @click="emit('loadEarlier')">
          {{ $t("group.detail.loadEarlier") }}
        </button>
        <button v-if="traceHasMore" type="button" data-test="group-trace-load-more"
                class="underline disabled:opacity-50" :disabled="traceLoading" @click="emit('loadMore')">
          {{ $t("group.detail.loadMore") }}
        </button>
        <button v-if="traceError" type="button" data-test="group-trace-retry"
                class="underline disabled:opacity-50" :disabled="traceLoading" @click="emit('retryTrace')">
          {{ $t("group.detail.retryTrace") }}
        </button>
      </div>
    </div>

    <!-- Plan: the run's own plan, kept near the process it explains. -->
    <PlanPanel v-if="plan && plan.length" :entries="plan" class="w-full" />

    <button
      v-if="traceDrawer.state.unread > 0 && !traceDrawer.state.following && !terminalState"
      type="button"
      data-test="group-trace-new-events"
      class="sticky bottom-2 z-20 mx-auto rounded-full bg-accent px-3 py-1 text-xs font-medium text-bg shadow-md"
      @click="traceDrawer.jumpToLatest()"
    >{{ $t("group.detail.newEvents", traceDrawer.state.unread) }}</button>
  </div>
</template>
