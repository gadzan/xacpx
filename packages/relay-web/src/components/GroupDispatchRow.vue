<script setup lang="ts">
import { computed, ref, useId } from "vue";
import { useI18n } from "vue-i18n";
import BotAvatar from "./BotAvatar.vue";
import MobileSheet from "./MobileSheet.vue";
import { useIsMobile } from "../lib/use-dropdown";
import type { GroupDispatchPresentation } from "../lib/group-dispatch-presentation";

/**
 * Collapsed aggregate of one leader round: stacked avatars, the dispatched
 * count and the round status. Clicking the row expands a card below it with
 * the round's dispatch text and one line per dispatched bot.
 *
 * The card is display only apart from two stop actions: one per dispatched
 * member and, while any member is still active, a round-level stop all that
 * the transcript confirms before cancelling.
 */
const props = defineProps<{
  presentation: GroupDispatchPresentation;
}>();

/**
 * Jump to a member's reply message id. Emitted only for members that have one.
 * Stop one member of the round: emitted with the durable run and member turn
 * the scoped cancellation needs.
 */
const emit = defineEmits<{
  jump: [messageId: string];
  stopMember: [payload: { runId: string; memberTurnId: string }];
  /** Ask the transcript to stop every dispatched member of this round. */
  stopAll: [];
}>();

const { t } = useI18n();

const expanded = ref(false);
/** Mobile: the row opens a bottom sheet instead of the inline card. */
const sheetOpen = ref(false);
const isMobile = useIsMobile();
const idBase = useId().replace(/[^a-zA-Z0-9_-]/g, "_");
const cardId = `group-dispatch-card-${idBase}`;
const sheetId = `group-dispatch-sheet-${idBase}`;

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

/**
 * One line, no wrapping: the mobile row trades the desktop title + status
 * spans for `{n} bots · {status}`, so it fits a single narrow line.
 */
const mobileStatusText = computed(() => {
  const parts: string[] = [];
  if (isRunning.value) parts.push(activeText.value);
  else if (isDone.value) parts.push(doneText.value);
  else if (isCancelled.value) parts.push(cancelledText.value);
  else {
    if (counts.value.completed > 0) parts.push(doneText.value);
    if (counts.value.cancelled > 0) parts.push(mixedCancelledText.value);
  }
  if (showFailed.value) parts.push(failedText.value);
  return parts.join(" · ");
});
const mobileSummaryText = computed(() =>
  mobileStatusText.value
    ? t("group.dispatch.mobileSummary", { n: total.value, status: mobileStatusText.value })
    : t("group.dispatch.mobileBots", { n: total.value }),
);

/** Mobile opens the sheet; desktop toggles the inline card. */
function toggle(): void {
  if (isMobile.value) {
    sheetOpen.value = true;
    return;
  }
  expanded.value = !expanded.value;
}

/** A member's own state, worded like the rest of the group transcript. */
function memberStatusText(status: GroupDispatchPresentation["members"][number]["status"]): string {
  return t(`group.handoff.states.${status}`);
}

/** A member without a reply has no target: its line stays inert. */
function jumpToMember(botId: string): void {
  const member = props.presentation.members.find((candidate) => candidate.botId === botId);
  if (!member?.replyId) return;
  emit("jump", member.replyId);
}

/** Stop one dispatched member; the durable ids travel with the request. */
function stopMember(member: GroupDispatchPresentation["members"][number]): void {
  emit("stopMember", { runId: member.runId, memberTurnId: member.memberTurnId });
}

/** Round-level stop: the transcript owns the confirmation and cancellation. */
function stopAll(): void {
  emit("stopAll");
}
</script>

<template>
  <div class="min-w-0">
    <button
      type="button"
      data-test="group-dispatch-row"
      :aria-expanded="isMobile ? sheetOpen : expanded"
      :aria-controls="isMobile ? sheetId : cardId"
      :aria-haspopup="isMobile ? 'dialog' : undefined"
      class="flex min-w-0 items-center gap-2 rounded-lg bg-surface px-2.5 py-2 text-left transition-colors hover:bg-surface-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      @click="toggle"
      @keydown.enter.prevent="toggle"
      @keydown.space.prevent="toggle"
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
      <span
        v-if="isMobile"
        data-test="group-dispatch-summary"
        class="min-w-0 flex-1 truncate whitespace-nowrap text-xs font-medium text-fg"
      >{{ mobileSummaryText }}</span>
      <span v-else data-test="group-dispatch-title" class="shrink-0 text-xs font-medium text-fg">
        {{ t("group.dispatch.sentTo", { n: total }) }}
      </span>
      <span v-if="!isMobile" data-test="group-dispatch-status" class="flex min-w-0 flex-wrap items-center gap-x-1 text-xs">
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
      <ChevronDown
        v-if="!isMobile"
        :size="14"
        data-test="group-dispatch-chevron"
        class="ml-auto shrink-0 text-fg-muted transition-transform"
        :class="expanded ? 'rotate-180' : ''"
        aria-hidden="true"
      />
    </button>

    <div
      v-if="expanded"
      :id="cardId"
      data-test="group-dispatch-card"
      class="mt-2 max-w-[560px] rounded-2xl bg-surface p-3 text-xs"
    >
      <p data-test="group-dispatch-instructions-label" class="text-fg-muted">{{ t("group.dispatch.instructions") }}</p>
      <p data-test="group-dispatch-instructions" class="mt-1 line-clamp-2 text-fg">{{ presentation.instructions }}</p>
      <ul class="mt-2 space-y-1">
        <li v-for="member in presentation.members" :key="member.botId" class="flex items-center gap-1">
          <button
            type="button"
            data-test="group-dispatch-member"
            :data-bot-id="member.botId"
            :disabled="!member.replyId"
            class="flex min-w-0 flex-1 items-center gap-2 rounded-sm px-1 py-0.5 text-left transition-colors hover:bg-surface-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-default disabled:opacity-70 disabled:hover:bg-transparent"
            @click="jumpToMember(member.botId)"
          >
            <span class="grid h-5 w-5 shrink-0 place-items-center overflow-hidden rounded-full bg-surface-2" aria-hidden="true">
              <BotAvatar :avatar="member.avatar" :driver="member.driver" :name="member.name" :size="20" static />
            </span>
            <span data-test="group-dispatch-member-name" class="shrink-0 font-medium text-fg">{{ member.name }}</span>
            <span data-test="group-dispatch-member-status" class="shrink-0 text-fg-muted">{{ memberStatusText(member.status) }}</span>
            <span
              v-if="member.replyPreview"
              data-test="group-dispatch-member-preview"
              class="min-w-0 flex-1 truncate text-fg-muted"
            >{{ member.replyPreview }}</span>
          </button>
          <!-- Scoped stop: only the row's own member, never the whole round. -->
          <button
            v-if="member.canStop"
            type="button"
            data-test="group-dispatch-stop-member"
            :data-bot-id="member.botId"
            :aria-label="t('group.dispatch.stopMember', { name: member.name })"
            class="grid h-6 w-6 shrink-0 place-items-center rounded-sm text-fg-muted transition-colors hover:bg-danger/10 hover:text-danger focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-danger"
            @click.stop="stopMember(member)"
          >
            <Square :size="12" aria-hidden="true" />
          </button>
        </li>
      </ul>
      <div v-if="presentation.capability.anyActive" class="mt-2 flex justify-end">
        <button
          type="button"
          data-test="group-dispatch-stop-all"
          class="rounded-sm px-1 py-0.5 text-xs font-medium text-danger transition-colors hover:bg-danger/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-danger"
          @click.stop="stopAll"
        >
          {{ t("group.dispatch.stopAll") }}
        </button>
      </div>
    </div>

    <!-- Mobile: the same content as the inline card, as a bottom sheet. The
         stop-all action reuses the transcript's confirmation path verbatim. -->
    <MobileSheet
      v-if="isMobile && sheetOpen"
      :id="sheetId"
      height="tall"
      test-id="group-dispatch-sheet"
      :title="t('group.dispatch.sentTo', { n: total })"
      @close="sheetOpen = false"
    >
      <p data-test="group-dispatch-sheet-instructions-label" class="px-2 pt-1 text-xs text-fg-muted">
        {{ t("group.dispatch.instructions") }}
      </p>
      <p data-test="group-dispatch-sheet-instructions" class="mt-1 px-2 text-sm text-fg">{{ presentation.instructions }}</p>
      <ul class="mt-3">
        <li
          v-for="member in presentation.members"
          :key="member.botId"
          data-test="group-dispatch-sheet-row"
          :data-bot-id="member.botId"
          class="flex min-h-11 items-center gap-2 px-2"
        >
          <span data-test="group-dispatch-sheet-member-name" class="min-w-0 truncate text-sm font-medium text-fg">{{ member.name }}</span>
          <span data-test="group-dispatch-sheet-member-status" class="ml-auto shrink-0 text-xs text-fg-muted">
            {{ memberStatusText(member.status) }}
          </span>
        </li>
      </ul>
      <template #footer>
        <button
          v-if="presentation.capability.anyActive"
          type="button"
          data-test="group-dispatch-sheet-stop-all"
          class="w-full rounded-xl bg-danger/10 px-4 py-3 text-sm font-medium text-danger transition-colors hover:bg-danger/15 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-danger"
          @click="stopAll"
        >
          {{ t("group.dispatch.stopAll") }}
        </button>
      </template>
    </MobileSheet>
  </div>
</template>
