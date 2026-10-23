<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { ChevronDown, Loader2 } from "lucide-vue-next";
import BotAvatar from "./BotAvatar.vue";
import type { GroupDispatchPresentation } from "../lib/group-dispatch-presentation";

/**
 * Collapsed aggregate of one leader round: stacked avatars, the dispatched
 * count and the round status. The chevron is a static affordance — this step
 * has no expanded card, so the row never handles clicks.
 */
const props = defineProps<{
  presentation: GroupDispatchPresentation;
}>();

const { t } = useI18n();

const total = computed(() => props.presentation.members.length);
const counts = computed(() => props.presentation.counts);
const summary = computed(() => props.presentation.summary);

const isRunning = computed(() => summary.value === "running");
const isDone = computed(() => summary.value === "done");
const isCancelled = computed(() => summary.value === "cancelled");

const runningText = computed(() => t("group.dispatch.running", { n: counts.value.running }));
const queuedText = computed(() => t("group.dispatch.queued", { n: counts.value.queued }));
const activeText = computed(() => {
  if (counts.value.running > 0 && counts.value.queued > 0) return `${runningText.value} · ${queuedText.value}`;
  if (counts.value.running > 0) return runningText.value;
  return queuedText.value;
});
const doneText = computed(() => t("group.dispatch.done", { n: counts.value.completed }));
const cancelledText = computed(() => t("group.dispatch.cancelled"));
const mixedCancelledText = computed(() => `${counts.value.cancelled} ${cancelledText.value}`);
const failedText = computed(() => t("group.dispatch.failed", { n: counts.value.failed }));
const showFailed = computed(() => counts.value.failed > 0);
const hasLeadingStatus = computed(
  () => isRunning.value || isDone.value || isCancelled.value || counts.value.completed > 0 || counts.value.cancelled > 0,
);
</script>

<template>
  <div
    data-test="group-dispatch-row"
    class="flex min-w-0 items-center gap-2 rounded-lg bg-surface px-2.5 py-2 transition-colors hover:bg-surface-2"
  >
    <div data-test="group-dispatch-avatars" class="flex shrink-0 items-center" aria-hidden="true">
      <span
        v-for="(avatar, index) in presentation.avatars.items"
        :key="avatar.botId"
        :class="index > 0 ? '-ml-2' : ''"
        class="grid h-6 w-6 shrink-0 place-items-center overflow-hidden rounded-full bg-surface"
      >
        <BotAvatar :avatar="avatar.avatar" :driver="avatar.driver" :name="avatar.name" :size="24" static />
      </span>
      <span
        v-if="presentation.avatars.overflow > 0"
        data-test="group-dispatch-overflow"
        class="-ml-2 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-surface-2 text-[10px] font-medium text-fg-muted"
      >
        +{{ presentation.avatars.overflow }}
      </span>
    </div>
    <span data-test="group-dispatch-title" class="shrink-0 text-xs font-medium text-fg">
      {{ t("group.dispatch.sentTo", { n: total }) }}
    </span>
    <span data-test="group-dispatch-status" class="flex min-w-0 flex-wrap items-center gap-x-1 text-xs">
      <template v-if="isRunning">
        <Loader2 :size="12" class="shrink-0 animate-spin text-accent" aria-hidden="true" />
        <span data-test="group-dispatch-status-active" class="text-accent">{{ activeText }}</span>
      </template>
      <template v-else-if="isDone">
        <span data-test="group-dispatch-status-done" class="font-medium text-success">✓ {{ doneText }}</span>
      </template>
      <template v-else-if="isCancelled">
        <span data-test="group-dispatch-status-cancelled" class="text-fg-muted">⊘ {{ cancelledText }}</span>
      </template>
      <template v-else>
        <span v-if="counts.completed > 0" data-test="group-dispatch-status-done" class="text-fg">✓ {{ doneText }}</span>
        <span v-if="counts.completed > 0 && counts.cancelled > 0" aria-hidden="true" class="text-fg-muted">·</span>
        <span v-if="counts.cancelled > 0" data-test="group-dispatch-status-cancelled" class="text-fg-muted">{{ mixedCancelledText }}</span>
      </template>
      <span v-if="showFailed && hasLeadingStatus" aria-hidden="true" class="text-fg-muted">·</span>
      <span v-if="showFailed" data-test="group-dispatch-status-failed" class="font-medium text-danger">{{ failedText }}</span>
    </span>
    <ChevronDown :size="14" data-test="group-dispatch-chevron" class="ml-auto shrink-0 text-fg-muted" aria-hidden="true" />
  </div>
</template>
