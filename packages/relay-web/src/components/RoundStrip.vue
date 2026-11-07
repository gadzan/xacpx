<script setup lang="ts">
import { computed } from "vue";
import type { ConversationRoundSummaryDto } from "@ganglion/xacpx-relay-protocol";

/**
 * The one-line summary of a multi-speaker Run (design §8.2).
 *
 * It is not a card and not a message: it says which round is current, how much
 * of it has been spoken or passed, and who is speaking now. Direct and
 * single-member Runs never mount it.
 */
const props = defineProps<{
  round: ConversationRoundSummaryDto;
  /** Display name of the member holding the active turn, when known. */
  speakerName?: string;
}>();

const emit = defineEmits<{ openDetail: [] }>();

const roundLabel = computed(() => {
  if (props.round.rounds > 1) {
    return {
      key: "conversation.round.labelOf",
      params: { index: props.round.roundIndex, rounds: props.round.rounds },
    };
  }
  return {
    key: "conversation.round.label",
    params: { index: props.round.roundIndex },
  };
});

const spokenLabel = computed(() => ({
  key: "conversation.round.spoken",
  params: { spoken: props.round.spoken, total: props.round.speakerCount },
}));

const passedLabel = computed(() => ({
  key: "conversation.round.passed",
  params: { count: props.round.passed },
}));

const stateLabel = computed<string | null>(() => {
  if (props.speakerName) {
    return props.round.state === "running" || props.round.state === "queued"
      ? props.speakerName
      : null;
  }
  return null;
});
</script>

<template>
  <div
    data-test="round-strip"
    class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-fg-muted"
  >
    <span data-test="round-strip-round" class="shrink-0 font-medium text-fg">
      {{ $t(roundLabel.key, roundLabel.params) }}
    </span>
    <span aria-hidden="true">·</span>
    <span data-test="round-strip-spoken" class="shrink-0">
      {{ $t(spokenLabel.key, spokenLabel.params) }}
    </span>
    <template v-if="round.passed > 0">
      <span aria-hidden="true">·</span>
      <span data-test="round-strip-passed" class="shrink-0">
        {{ $t(passedLabel.key, passedLabel.params) }}
      </span>
    </template>
    <template v-if="stateLabel">
      <span aria-hidden="true">·</span>
      <button
        type="button"
        data-test="round-strip-speaker"
        class="min-w-0 truncate text-left transition-colors hover:text-fg"
        :title="$t('conversation.status.openDetail')"
        @click="emit('openDetail')"
      >
        {{ $t("conversation.status.speaking", { name: stateLabel }) }}
      </button>
    </template>
  </div>
</template>
