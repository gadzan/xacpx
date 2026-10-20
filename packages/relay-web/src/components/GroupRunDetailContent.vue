<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { Clock, HelpCircle, AlertCircle, CircleX, Loader2 } from "lucide-vue-next";
import type {
  ConversationRunDto,
  MemberTurnSummaryDto,
  PlanEntryDto,
  TurnPartDto,
} from "@ganglion/xacpx-relay-protocol";
import { useI18n } from "vue-i18n";
import TurnParts from "./TurnParts.vue";
import PlanPanel from "./PlanPanel.vue";
import type { TraceReplayStatus } from "../lib/group-run-presentation";

/**
 * Member/Run detail inside the anchored popover (frozen spec §3.4).
 * Everything the old run card showed lives here: member status, assignment and
 * task, attempt, duration, failure/blocked reason, expected output, recorded
 * TurnParts, Run state/reason/budget/routing decision, Plan, worktree/shared
 * workspace note, and the waiting-human question. The Run-level Stop lives in
 * the popover header and targets the whole exact active Run — never one member.
 */
const props = defineProps<{
  run: ConversationRunDto;
  memberTurn?: MemberTurnSummaryDto;
  memberName?: string;
  attempt?: number;
  attempts?: number[];
  /** Ordered replayed/combined member trace parts (empty = none recorded). */
  parts?: TurnPartDto[];
  /** Other members of the same Run, summarized by name and state only. */
  siblingSummaries?: Array<{ name: string; state: string }>;
  recordingState?: TraceReplayStatus;
  completenessReason?: string;
  explanation?: string;
  plan?: PlanEntryDto[];
  traceLoading?: boolean;
  traceError?: string | null;
  traceHasMore?: boolean;
  /** Terminal trace event failure (tool/terminal failure surface). */
  traceFailure?: string | null;
  traceHasEarlier?: boolean;
  traceStreaming?: boolean;
  /** Exact-current active run ownership: Stop is shown only when all agree. */
  stopAvailable?: boolean;
  stopPending?: boolean;
}>();

const emit = defineEmits<{
  stop: [];
  attempt: [attempt: number];
  loadMore: [];
  loadEarlier: [];
  retryTrace: [];
}>();

const { t } = useI18n();

const runStateLabel = computed(() => {
  switch (props.run.state) {
    case "queued": return t("bot.run.queued");
    case "running": return t("bot.run.running");
    case "waiting-human": return t("bot.run.waitingHuman");
    case "completed": return t("group.run.memberCompleted");
    case "failed": return t("bot.run.failed");
    case "cancelled": return t("bot.run.cancelled");
    case "indeterminate": return t("bot.run.indeterminate");
  }
});

const stateIcon = computed(() => {
  switch (props.run.state) {
    case "queued": return Clock;
    case "running": return Loader2;
    case "waiting-human": return HelpCircle;
    case "completed": return undefined;
    case "failed": return AlertCircle;
    case "cancelled": return CircleX;
    case "indeterminate": return HelpCircle;
  }
});

const memberStateLabel = computed(() => {
  const state = props.memberTurn?.state;
  if (!state) return undefined;
  switch (state) {
    case "queued":
    case "dispatched": return t("bot.run.queued");
    case "running": return t("bot.run.running");
    case "completed": return t("group.run.memberCompleted");
    case "failed": return t("bot.run.failed");
    case "cancelled": return t("bot.run.cancelled");
    case "indeterminate": return t("bot.run.indeterminate");
  }
});

const recordingLabel = computed(() => {
  switch (props.recordingState) {
    case "complete": return t("group.detail.recording.complete");
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
const now = ref(Date.now());
let durationTimer: ReturnType<typeof setInterval> | undefined;
onMounted(() => { durationTimer = setInterval(() => { now.value = Date.now(); }, 1000); });
onBeforeUnmount(() => { if (durationTimer !== undefined) clearInterval(durationTimer); });

/** Live elapsed/finished duration for the current attempt only; historical
 *  attempts keep their recorded outcome without a synthetic live timer. */
const duration = computed(() => {
  if (historicalAttempt.value) return undefined;
  const startedAt = props.memberTurn ? props.memberTurn.startedAt : props.run.startedAt;
  if (!startedAt) return undefined;
  const finishedAt = props.memberTurn ? props.memberTurn.finishedAt : props.run.finishedAt;
  const active = props.memberTurn
    ? props.memberTurn.state === "running" || props.memberTurn.state === "dispatched"
    : props.run.state === "running";
  if (!finishedAt && !active) return undefined;
  const start = Date.parse(startedAt);
  const end = finishedAt ? Date.parse(finishedAt) : now.value;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined;
  const seconds = Math.floor((end - start) / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
});

function selectAttempt(event: Event): void {
  if (event.target instanceof HTMLSelectElement) emit("attempt", Number(event.target.value));
}
</script>

<template>
  <div class="flex flex-col gap-2 text-sm" data-test="group-run-detail">
    <!-- Member header: identity + attempt + duration + state -->
    <div v-if="memberTurn" class="min-w-0">
      <p v-if="memberName" data-test="group-member-name" class="mb-1 font-medium text-fg">{{ memberName }}</p>
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span
          v-if="!historicalAttempt"
          class="rounded-full px-2 py-0.5 font-medium"
          :class="{
            'bg-run/15 text-run': memberTurn.state === 'running',
            'bg-warning/15 text-warning': memberTurn.state === 'queued' || memberTurn.state === 'dispatched',
            'bg-fg/10 text-fg-muted': memberTurn.state === 'completed' || memberTurn.state === 'cancelled',
            'bg-danger/10 text-danger': memberTurn.state === 'failed',
            'bg-warning/10 text-warning': memberTurn.state === 'indeterminate',
          }"
        >{{ memberStateLabel }}</span>
        <label v-if="attempts && attempts.length > 1" class="flex items-center gap-1 text-fg-muted">
          {{ $t("group.detail.attemptLabel") }}
          <select
            data-test="group-detail-attempt"
            class="rounded-sm bg-surface px-1 py-0.5 text-fg"
            :value="selectedAttempt"
            @change="selectAttempt"
          >
            <option v-for="availableAttempt in attempts" :key="availableAttempt" :value="availableAttempt">
              {{ $t("group.detail.attempt", { attempt: availableAttempt }) }}
            </option>
          </select>
        </label>
        <span v-else data-test="group-detail-attempt-text" class="text-fg-muted">
          {{ $t("group.detail.attempt", { attempt: selectedAttempt }) }}
        </span>
        <span v-if="duration" data-test="group-detail-duration" class="text-fg-muted">
          {{ $t("group.detail.duration", { duration }) }}
        </span>
      </div>
      <p v-if="memberTurn.assignmentId" data-test="group-member-assignment" class="mt-1 break-words text-xs text-fg-muted">
        {{ $t("group.run.assignment") }} {{ memberTurn.assignmentId }}
      </p>
      <p v-if="memberTurn.task" data-test="group-member-task" class="break-words text-xs text-fg">
        {{ memberTurn.task }}
      </p>
      <p v-if="memberTurn.expectedOutput" data-test="group-member-expected" class="break-words text-xs text-fg-muted">
        {{ $t("group.detail.expectedOutput") }} {{ memberTurn.expectedOutput }}
      </p>
      <p v-if="memberTurn.dependsOn?.length" data-test="group-member-depends" class="break-words text-xs text-fg-muted">
        {{ $t("group.run.dependsOn") }} {{ memberTurn.dependsOn.join(", ") }}
      </p>
      <p v-if="memberTurn.blockedReason" data-test="group-member-blocked" class="break-words text-xs text-warning">
        {{ memberTurn.blockedReason === "human-authority-required"
          ? $t("group.run.blockedHumanRequired")
          : $t("group.run.blockedHumanUnknown") }}
      </p>
      <p v-if="memberTurn.failureReason && !historicalAttempt" data-test="group-member-failure" class="break-words text-xs text-danger">
        {{ memberTurn.failureReason }}
      </p>
    </div>

    <!-- Waiting-human: question + existing guidance only; no invented resume. -->
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
    <div v-if="recordedParts.length" class="min-w-0">
      <TurnParts :parts="recordedParts" :streaming="traceStreaming === true" />
    </div>

    <!-- Trace completeness/pagination/failure status: always audible, even
         when a partial window is all that exists. -->
    <div
      v-if="memberTurn && (recordingLabel || traceHasMore || traceHasEarlier || traceLoading || traceError || traceFailure || completenessReason)"
      data-test="group-trace-status"
      class="space-y-1 text-xs text-fg-muted"
      aria-live="polite"
      aria-atomic="true"
    >
      <p v-if="recordingLabel">{{ recordingLabel }}</p>
      <p v-if="recordingState === 'complete' && (traceHasMore || traceHasEarlier)" class="break-words">
        {{ traceHasEarlier ? $t("group.detail.earlierWindow") : $t("group.detail.partialPage") }}
      </p>
      <p v-if="traceLoading">{{ $t("group.detail.loading") }}</p>
      <p v-if="traceError" role="alert" class="break-words text-danger">{{ traceError }}</p>
      <p v-if="traceFailure" role="alert" class="break-words text-danger">{{ traceFailure }}</p>
      <p v-if="completenessReason" class="break-words">{{ completenessReason }}</p>
      <div class="flex flex-wrap gap-2">
        <button v-if="traceHasEarlier" type="button" data-test="group-trace-load-earlier"
                class="underline disabled:opacity-50" :disabled="traceLoading" @click="emit('loadEarlier')">
          {{ $t("group.detail.loadEarlier") }}
        </button>
        <button v-if="traceHasMore" type="button" data-test="group-trace-load-more"
                class="underline disabled:opacity-50" :disabled="traceLoading" @click="emit('loadMore')">
          {{ $t("group.detail.loadMore") }}
        </button>
        <button v-if="traceError || traceFailure" type="button" data-test="group-trace-retry"
                class="underline disabled:opacity-50" :disabled="traceLoading" @click="emit('retryTrace')">
          {{ $t("group.detail.retryTrace") }}
        </button>
      </div>
    </div>

    <!-- Plan -->
    <PlanPanel v-if="plan && plan.length" :entries="plan" class="w-full" />

    <!-- Run metadata -->
    <div class="space-y-1 rounded-lg bg-surface/50 p-2.5 text-xs text-fg-muted" data-test="group-detail-run">
      <p class="flex items-center gap-1.5 font-medium text-fg">
        <component :is="stateIcon" v-if="stateIcon" :size="12"
                   :class="run.state === 'running' ? 'animate-spin motion-reduce:animate-none' : ''" />
        <span>{{ runStateLabel }}</span>
        <span v-if="run.completionReason" class="font-normal text-fg-muted">· {{ run.completionReason }}</span>
      </p>
      <p v-if="run.mode === 'automatic' && run.routingReason" data-test="group-run-routing-reason" class="break-words">
        {{ run.routingReason }}
      </p>
      <p v-if="run.maxMemberTurns !== undefined" data-test="group-run-budget">
        {{ $t("group.run.budget", { consumed: run.consumedMemberTurns ?? 0, max: run.maxMemberTurns }) }}
      </p>
      <p v-if="run.routingState && run.mode === 'automatic'" class="break-words">
        {{ $t("group.detail.routingState", { state: run.routingState }) }}
      </p>
      <p data-test="group-detail-workspace">{{ $t(run.worktree ? "group.detail.worktree" : "group.detail.sharedWriter") }}</p>
      <p v-if="siblingSummaries?.length" class="break-words">
        {{ $t("group.detail.siblings") }}:
        <template v-for="(sibling, i) in siblingSummaries" :key="i">
          <span v-if="i > 0"> · </span>
          <span class="text-fg">{{ sibling.name }}</span>
          <span> ({{ sibling.state }})</span>
        </template>
      </p>
      <p v-if="completenessReason && !memberTurn" class="break-words italic">{{ completenessReason }}</p>
    </div>

    <!-- Run-level Stop: whole exact active Run, all members. -->
    <p v-if="canStop" data-test="group-stop-explanation" class="text-xs text-fg-muted">
      {{ $t("group.detail.stopAllMembers") }}
    </p>
  </div>
</template>
