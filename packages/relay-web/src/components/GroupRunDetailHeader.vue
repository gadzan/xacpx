<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { CircleStop, X } from "lucide-vue-next";
import type {
  ConversationRunDto,
  MemberTurnSummaryDto,
} from "@ganglion/xacpx-relay-protocol";
import { fmtTime } from "../lib/format";
import { memberStateKey, memberStateTone, runStateKey, runStateTone, type StateTone } from "../lib/run-state-label";
import { useLiveDuration, memberDurationClock } from "../lib/run-duration";

const props = defineProps<{
  run: ConversationRunDto;
  memberTurn?: MemberTurnSummaryDto;
  /** Localized member display name (retirement-aware). */
  memberName?: string;
  /** Localized topic title; the header's heading falls back to the member. */
  topicTitle?: string;
  attempt?: number;
  attempts?: number[];
  stopAvailable?: boolean;
  stopPending?: boolean;
  /** `sheet` reads as a document header, `popover` as a compact card header. */
  variant: "sheet" | "popover";
}>();

const emit = defineEmits<{ close: []; stop: []; attempt: [attempt: number] }>();

const { t } = useI18n();

const historicalAttempt = computed(() => props.memberTurn && props.attempt !== undefined && props.attempt !== props.memberTurn.attempt);
const stateKey = computed(() => props.memberTurn ? memberStateKey(props.memberTurn.state) : runStateKey(props.run.state));
const tone = computed<StateTone>(() => {
  const member = props.memberTurn;
  return member ? memberStateTone(member.state) : runStateTone(props.run.state);
});

const toneClass = computed(() => {
  switch (tone.value) {
    case "active": return "bg-accent/[0.14] text-accent";
    case "done": return "bg-run/[0.14] text-run";
    case "failed": return "bg-danger/[0.14] text-danger";
    case "waiting": return "bg-warn/[0.16] text-warn";
    case "idle": return "bg-surface-2 text-fg-muted";
  }
});

const title = computed(() => props.topicTitle?.trim() || props.memberName || t("group.detail.title"));

const startedAt = computed(() => props.memberTurn?.startedAt ?? props.run.startedAt ?? props.memberTurn?.createdAt);
const timeLabel = computed(() => historicalAttempt.value ? "" : fmtTime(startedAt.value));

const duration = useLiveDuration(() => memberDurationClock(props.memberTurn, props.attempt));

/** The attempt is only worth showing once a turn has actually been retried. */
const attemptLabel = computed(() => {
  const selected = props.attempt ?? props.memberTurn?.attempt;
  if (selected === undefined) return undefined;
  if (props.attempts && props.attempts.length > 1) return undefined;
  return selected > 1 ? t("group.detail.attempt", { attempt: selected }) : undefined;
});

const meta = computed(() => {
  const parts: string[] = [];
  if (timeLabel.value) parts.push(timeLabel.value);
  if (props.memberName) parts.push(props.memberName);
  if (attemptLabel.value) parts.push(attemptLabel.value);
  if (duration.value) parts.push(t("group.detail.duration", { duration: duration.value }));
  return parts;
});

const dense = computed(() => props.variant === "popover");

const ariaLabel = computed(() =>
  props.memberName ? `${props.memberName} · ${t(stateKey.value)}` : t(stateKey.value),
);
</script>

<template>
  <header
    data-test="group-detail-header"
    :data-variant="variant"
    :class="dense ? 'px-4 pb-2.5 pt-3' : 'px-5 pb-3.5 pt-4'"
  >
    <div class="flex items-start gap-3">
      <span
        v-if="!historicalAttempt"
        data-test="group-detail-state"
        :data-tone="tone"
        class="inline-flex shrink-0 items-center rounded-lg font-semibold"
        :class="[toneClass, dense ? 'h-6 px-2 text-xs' : 'h-7 px-2.5 text-ui']"
        :aria-label="ariaLabel"
        role="status"
      >{{ $t(stateKey) }}</span>
      <div class="ml-auto flex shrink-0 items-center gap-2">
        <button
          v-if="stopAvailable"
          type="button"
          data-test="group-stop-run-button"
          class="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-danger/[0.14] font-medium text-danger transition-colors hover:bg-danger/20 disabled:opacity-60"
          :class="dense ? 'h-7 px-2 text-xs' : 'min-h-11 px-3 text-sm'"
          :disabled="stopPending === true"
          :title="$t('group.detail.stopAllMembers')"
          @click.stop="emit('stop')"
        >
          <CircleStop :size="dense ? 12 : 14" />
          <span>{{ $t("group.detail.stopRun") }}</span>
        </button>
        <button
          type="button"
          data-test="group-detail-close"
          :data-sheet-initial-focus="!dense || undefined"
          class="grid shrink-0 place-items-center rounded-full bg-fg/10 text-fg transition-colors hover:bg-fg/[0.16] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          :class="dense ? 'h-7 w-7' : 'h-11 w-11'"
          :aria-label="$t('group.detail.close')"
          @click.stop="emit('close')"
        >
          <X :size="dense ? 14 : 18" />
        </button>
      </div>
    </div>

    <p v-if="stopAvailable && !dense" data-test="group-stop-run-explanation" class="mt-3 text-xs text-fg-muted">
      {{ $t("group.detail.stopAllMembers") }}
    </p>

    <h2
      data-test="group-detail-title"
      class="break-words font-semibold leading-snug tracking-tight text-fg"
      :class="dense ? 'mt-2.5 text-sm' : 'mt-4 text-xl'"
    >{{ title }}</h2>

    <div
      v-if="meta.length"
      data-test="group-detail-meta"
      class="flex flex-wrap items-center gap-x-2 gap-y-1 text-fg-muted"
      :class="dense ? 'mt-1.5 text-xs' : 'mt-2.5 text-ui'"
    >
      <template v-for="(entry, index) in meta" :key="index">
        <span v-if="index > 0" aria-hidden="true" class="opacity-50">·</span>
        <span :data-test="index === meta.length - 1 && duration ? 'group-detail-duration' : undefined">{{ entry }}</span>
      </template>
    </div>

    <label
      v-if="attempts && attempts.length > 1"
      class="mt-2 inline-flex items-center gap-1.5 text-xs text-fg-muted"
    >
      {{ $t("group.detail.attemptLabel") }}
      <select
        data-test="group-detail-attempt"
        class="rounded-sm bg-surface-2 px-1.5 py-1 text-fg"
        :value="attempt ?? memberTurn?.attempt"
        @change="emit('attempt', Number(($event.target as HTMLSelectElement).value))"
      >
        <option v-for="availableAttempt in attempts" :key="availableAttempt" :value="availableAttempt">
          {{ $t("group.detail.attempt", { attempt: availableAttempt }) }}
        </option>
      </select>
    </label>
  </header>
</template>
