<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { CircleStop, Users } from "lucide-vue-next";
import type {
  ConversationRunDto,
  InteractionValueDto,
  MemberTurnSummaryDto,
  PlanEntryDto,
  TurnPartDto,
} from "@ganglion/xacpx-relay-protocol";
import type { PendingInteractionState } from "../stores/direct-bots";
import type { RoomParticipant } from "../lib/room-view";
import {
  canStopMemberInDrawer,
  compareMemberTurns,
  memberOriginKey,
  runReasonKey,
  type RunBudgetView,
} from "../lib/run-detail";
import { memberStateKey, memberStateTone, runStateKey, runStateTone, type StateTone } from "../lib/run-state-label";
import type { TraceReplayStatus } from "../lib/group-run-presentation";
import ConversationInteractionForm from "./ConversationInteractionForm.vue";
import GroupRunDetailContent from "./GroupRunDetailContent.vue";

/**
 * The one Run-wide detail body (design §8.4). The Run's members, state,
 * outcome, budget and open approvals live here; the selected member's trace is
 * rendered by the existing trace content, so there is exactly one process
 * renderer on both the timeline path and the old-daemon fallback.
 */
const props = defineProps<{
  run: ConversationRunDto;
  memberTurns: MemberTurnSummaryDto[];
  selectedMemberTurnId?: string;
  participants?: RoomParticipant[];
  budget?: RunBudgetView;
  interactions?: PendingInteractionState[];
  capability?: { cancelMember: boolean };
  cancelPending?: boolean;
  attempt?: number;
  attempts?: number[];
  parts?: TurnPartDto[];
  recordingState?: TraceReplayStatus;
  plan?: PlanEntryDto[];
  traceLoading?: boolean;
  traceError?: string | null;
  traceHasMore?: boolean;
  traceHasEarlier?: boolean;
  traceStreaming?: boolean;
  traceFailure?: string | null;
}>();

const emit = defineEmits<{
  selectMember: [memberTurnId: string];
  stopMember: [memberTurnId: string];
  loadMore: [];
  loadEarlier: [];
  retryTrace: [];
  interactionAnswer: [requestId: string, key: string, value: InteractionValueDto];
  interactionSubmit: [requestId: string];
  interactionDecline: [requestId: string];
  interactionCancel: [requestId: string];
  interactionDismiss: [requestId: string];
}>();

const { t } = useI18n();

const members = computed(() => [...props.memberTurns].sort(compareMemberTurns));
const selected = computed(() => members.value.find((member) => member.id === props.selectedMemberTurnId)
  ?? members.value.find((member) => member.state === "running" || member.state === "dispatched")
  ?? members.value[members.value.length - 1]);
const selectedAttempt = computed(() => props.attempt ?? selected.value?.attempt);

function participantName(botId: string): string {
  return props.participants?.find((participant) => participant.botId === botId)?.name ?? botId;
}

function toneClass(tone: StateTone): string {
  switch (tone) {
    case "active": return "bg-accent/[0.14] text-accent";
    case "done": return "bg-run/[0.14] text-run";
    case "failed": return "bg-danger/[0.14] text-danger";
    case "waiting": return "bg-warn/[0.16] text-warn";
    case "idle": return "bg-surface-2 text-fg-muted";
  }
}

function reasonText(reason: string | undefined): string | undefined {
  if (!reason) return undefined;
  const key = runReasonKey(reason);
  return key ? t(key) : reason;
}

const completionReason = computed(() => reasonText(props.run.completionReason));
const runFailure = computed(() => props.run.state === "failed" || props.run.state === "indeterminate"
  ? reasonText(props.run.completionReason) ?? t("conversation.runDetail.unknownFailure")
  : undefined);
const selectedFailure = computed(() => selected.value?.failureReason);
const stopAvailable = computed(() => canStopMemberInDrawer({
  run: props.run,
  member: selected.value,
  cancelMemberCapability: props.capability?.cancelMember === true,
}));
const budgetLabel = computed(() => {
  const budget = props.budget;
  if (!budget || (budget.consumed === undefined && budget.max === undefined)) return undefined;
  if (budget.consumed !== undefined && budget.max !== undefined) {
    return { key: "conversation.runDetail.budget", params: { consumed: budget.consumed, max: budget.max } };
  }
  return { key: "conversation.runDetail.budgetConsumed", params: { consumed: budget.consumed ?? 0 } };
});
const budgetMeta = computed(() => {
  const parts: string[] = [];
  if (props.budget?.epoch !== undefined) {
    parts.push(t("conversation.runDetail.budgetEpoch", { epoch: props.budget.epoch }));
  }
  if (props.budget?.activeBatch !== undefined) {
    parts.push(t("conversation.runDetail.activeBatch", { batch: props.budget.activeBatch }));
  }
  return parts;
});

function roundLabel(member: MemberTurnSummaryDto): string | undefined {
  if (member.roundIndex === undefined) return undefined;
  return member.speakerIndex === undefined
    ? t("conversation.runDetail.round", { round: member.roundIndex })
    : t("conversation.runDetail.roundPosition", {
        round: member.roundIndex,
        speaker: member.speakerIndex + 1,
      });
}

function interactionFor(requestId: string): PendingInteractionState | undefined {
  return props.interactions?.find((interaction) => interaction.request.requestId === requestId);
}

function answer(requestId: string, key: string, value: InteractionValueDto): void {
  if (interactionFor(requestId)) emit("interactionAnswer", requestId, key, value);
}
</script>

<template>
  <div class="flex flex-col gap-3 text-sm" data-test="run-detail">
    <section class="rounded-xl bg-surface/50 p-2.5" data-test="run-detail-summary">
      <div class="flex flex-wrap items-center gap-2">
        <span
          data-test="run-detail-state"
          :data-tone="runStateTone(run.state)"
          :aria-label="$t(runStateKey(run.state))"
          class="inline-flex h-6 shrink-0 items-center rounded-lg px-2 text-xs font-semibold"
          :class="toneClass(runStateTone(run.state))"
        >{{ $t(runStateKey(run.state)) }}</span>
        <span v-if="completionReason" data-test="run-detail-completion" class="min-w-0 flex-1 text-xs text-fg-muted">
          {{ completionReason }}
        </span>
      </div>
      <p v-if="runFailure" data-test="run-detail-failure" class="mt-1.5 break-words text-xs text-danger">
        {{ $t("conversation.runDetail.failure", { reason: runFailure }) }}
      </p>
      <p
        v-if="budgetLabel"
        data-test="run-detail-budget"
        class="mt-1.5 flex flex-wrap items-center gap-x-2 text-xs text-fg-muted"
      >
        <span>{{ $t(budgetLabel.key, budgetLabel.params) }}</span>
        <span v-for="entry in budgetMeta" :key="entry" class="opacity-70">{{ entry }}</span>
      </p>
    </section>

    <section class="min-w-0" data-test="run-member-section">
      <h3 class="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-fg-muted">
        <Users :size="12" aria-hidden="true" />
        <span>{{ $t("conversation.runDetail.members") }}</span>
      </h3>
      <p v-if="members.length === 0" data-test="run-detail-no-members" class="text-xs text-fg-muted">
        {{ $t("conversation.runDetail.noMembers") }}
      </p>
      <ul v-else class="flex flex-col gap-1" data-test="run-member-list">
        <li v-for="member in members" :key="member.id">
          <button
            type="button"
            data-test="run-member-row"
            :data-member-turn-id="member.id"
            :data-selected="selected?.id === member.id ? 'true' : 'false'"
            :data-state="member.state"
            :aria-pressed="selected?.id === member.id"
            class="flex w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 rounded-lg px-2 py-1.5 text-left text-xs transition-colors"
            :class="selected?.id === member.id ? 'bg-accent/[0.12] text-fg' : 'text-fg-muted hover:bg-surface-2 hover:text-fg'"
            @click="emit('selectMember', member.id)"
          >
            <span data-test="run-member-name" class="min-w-0 truncate font-medium text-fg">
              {{ participantName(member.botId) }}
            </span>
            <span
              data-test="run-member-state"
              :data-tone="memberStateTone(member.state)"
              class="shrink-0 rounded px-1.5 py-0.5"
              :class="toneClass(memberStateTone(member.state))"
            >{{ $t(memberStateKey(member.state)) }}</span>
            <span data-test="run-member-origin" class="shrink-0">{{ $t(memberOriginKey(member.origin)) }}</span>
            <span v-if="roundLabel(member)" data-test="run-member-round" class="shrink-0">{{ roundLabel(member) }}</span>
            <span v-if="member.attempt > 1" data-test="run-member-attempt" class="shrink-0">
              {{ $t("group.detail.attempt", { attempt: member.attempt }) }}
            </span>
            <span v-if="member.speechOutcome === 'pass'" data-test="run-member-pass" class="shrink-0">
              {{ $t("conversation.runDetail.pass") }}
            </span>
            <span
              v-if="member.failureReason"
              data-test="run-member-failure"
              class="min-w-0 basis-full truncate text-danger"
              :title="member.failureReason"
            >{{ member.failureReason }}</span>
          </button>
        </li>
      </ul>
    </section>

    <section v-if="interactions && interactions.length" class="min-w-0 space-y-2" data-test="run-interactions">
      <h3 class="text-xs font-semibold uppercase tracking-wide text-fg-muted">
        {{ $t("conversation.runDetail.approvals") }}
      </h3>
      <div
        v-for="interaction in interactions"
        :key="interaction.request.requestId"
        data-test="run-interaction"
        :data-request-id="interaction.request.requestId"
      >
        <ConversationInteractionForm
          :request="interaction.request"
          :answers="interaction.answers"
          :submitting="interaction.submitting"
          :error-code="interaction.errorCode"
          :outcome="interaction.outcome"
          @answer="(key: string, value: InteractionValueDto) => answer(interaction.request.requestId, key, value)"
          @submit="emit('interactionSubmit', interaction.request.requestId)"
          @decline="emit('interactionDecline', interaction.request.requestId)"
          @cancel="emit('interactionCancel', interaction.request.requestId)"
          @dismiss="emit('interactionDismiss', interaction.request.requestId)"
        />
      </div>
    </section>

    <div v-if="selected" class="min-w-0" data-test="run-selected-member" :data-member-turn-id="selected.id">
      <div class="flex flex-wrap items-center gap-2">
        <p class="min-w-0 flex-1 text-xs font-semibold text-fg">
          {{ $t("conversation.runDetail.selectedMember", { name: participantName(selected.botId) }) }}
        </p>
        <button
          v-if="stopAvailable"
          type="button"
          data-test="run-stop-member"
          :data-member-turn-id="selected.id"
          :disabled="cancelPending === true"
          class="inline-flex shrink-0 items-center gap-1 rounded-full bg-danger/[0.14] px-2 py-1 text-xs font-medium text-danger transition-colors hover:bg-danger/20 disabled:opacity-60"
          :aria-label="$t('conversation.runDetail.stopMember', { name: participantName(selected.botId) })"
          @click="emit('stopMember', selected.id)"
        >
          <CircleStop :size="11" aria-hidden="true" />
          <span>{{ $t("conversation.runDetail.stopMember", { name: participantName(selected.botId) }) }}</span>
        </button>
      </div>
      <p v-if="selectedFailure" data-test="run-member-selected-failure" class="mt-1 break-words text-xs text-danger">
        {{ $t("conversation.runDetail.failure", { reason: selectedFailure }) }}
      </p>
      <GroupRunDetailContent
        :key="`${selected.id}:${selectedAttempt}`"
        class="mt-1"
        :run="run"
        :member-turn="selected"
        :member-name="participantName(selected.botId)"
        :attempt="selectedAttempt"
        :parts="parts"
        :recording-state="recordingState"
        :plan="plan"
        :trace-failure="traceFailure ?? undefined"
        :trace-loading="traceLoading"
        :trace-error="traceError"
        :trace-has-more="traceHasMore"
        :trace-has-earlier="traceHasEarlier"
        :trace-streaming="traceStreaming"
        @load-more="emit('loadMore')"
        @load-earlier="emit('loadEarlier')"
        @retry-trace="emit('retryTrace')"
      />
    </div>
    <p v-else data-test="run-detail-no-member" class="text-xs text-fg-muted">
      {{ $t("conversation.runDetail.noMember") }}
    </p>
  </div>
</template>
