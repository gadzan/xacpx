<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { GitFork, Loader2, MessagesSquare } from "lucide-vue-next";
import type { ConversationTimelineDto, TopicForkDto } from "@ganglion/xacpx-relay-protocol";
import TimelineRow from "./TimelineRow.vue";
import TranscriptJumpLatest from "./TranscriptJumpLatest.vue";
import {
  buildTimelineRows,
  timelineHasMoreBefore,
  type RoomView,
  type TimelineLiveTurn,
} from "../lib/room-view";

/**
 * The single conversation timeline (design §8.1): Direct and Group render this
 * exact component. The durable projection decides the rows; this component only
 * merges the client's live overlay and drops the empty settlement evidence
 * bubble (the read model keeps that row).
 *
 * Scroll behaviour: bottom-pinned while the reader is there, a prepend anchor
 * when older history is loaded, and an
 * explicit "jump to latest" once they scroll up.
 */
const props = defineProps<{
  room: RoomView;
  timeline: ConversationTimelineDto | null;
  /** Unpersisted streamed text, keyed by MemberTurn (design §4.3 invariant 7). */
  liveOverlay?: TimelineLiveTurn[];
  loading?: boolean;
  loadingOlder?: boolean;
  error?: string | null;
  /** Shown when the room has no rows at all. */
  emptyHint?: string | null;
  /** Extra scroll-padding for the pane's floating identity bar. */
  topInsetClass?: string;
  isRunQueued?: (runId: string | undefined) => boolean;
  /** Async loader; the component keeps the prepend anchor while it runs. */
  loadOlder?: () => Promise<void> | void;
  /** Present when this room is a fork; renders the banner above the scroller. */
  forkedFrom?: TopicForkDto | null;
  /** False once the source Topic is gone, so the jump-to-source link is dropped. */
  forkSourceAvailable?: boolean;
}>();

const emit = defineEmits<{
  loadOlder: [];
  openDetail: [payload: { runId?: string; memberTurnId?: string }];
  openSourceTopic: [];
}>();

const rows = computed(() => buildTimelineRows({
  entries: props.timeline?.entries ?? [],
  liveOverlay: props.liveOverlay,
  conversationId: props.room.conversationId,
  topicId: props.room.topicId,
}));

const hasMoreBefore = computed(() => timelineHasMoreBefore(props.timeline));
const liveRevision = computed(() =>
  (props.liveOverlay ?? []).reduce((sum, live) => sum + (live.revision ?? 0), 0));

const scroller = ref<HTMLElement | null>(null);
const atBottom = ref(true);
const pendingAnchor = ref<number | null>(null);
const THRESHOLD = 64;

function onScroll(): void {
  const el = scroller.value;
  if (!el) return;
  atBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight <= THRESHOLD;
}

function scrollToBottom(smooth = false): void {
  const el = scroller.value;
  if (!el) return;
  if (typeof el.scrollTo === "function") {
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  } else {
    el.scrollTop = el.scrollHeight;
  }
  // content-visibility rows paint at the contained-size estimate and late layout
  // (images, fonts, code) keeps growing the content, so re-pin until the reader
  // takes over. Skipped for smooth jumps and where rAF is unavailable.
  if (smooth || typeof requestAnimationFrame !== "function") return;
  let pinnedHeight = el.scrollHeight;
  let tries = 0;
  const settle = (): void => {
    const current = scroller.value;
    if (!current) return;
    if (pinnedHeight - current.scrollTop - current.clientHeight > THRESHOLD) return;
    if (current.scrollHeight !== pinnedHeight) {
      pinnedHeight = current.scrollHeight;
      current.scrollTop = current.scrollHeight;
    }
    if (++tries < 40) requestAnimationFrame(settle);
  };
  requestAnimationFrame(settle);
}

watch(
  () => rows.value.length,
  (now, previous) => {
    if (pendingAnchor.value !== null && now > previous) {
      const anchor = pendingAnchor.value;
      pendingAnchor.value = null;
      void nextTick(() => {
        const el = scroller.value;
        if (el) el.scrollTop = el.scrollHeight - anchor;
      });
      return;
    }
    if (atBottom.value) void nextTick(() => scrollToBottom(false));
  },
);

watch(liveRevision, () => {
  if (atBottom.value) void nextTick(() => scrollToBottom(false));
});

async function handleLoadOlder(): Promise<void> {
  const el = scroller.value;
  if (!el || props.loadingOlder) return;
  pendingAnchor.value = el.scrollHeight - el.scrollTop;
  try {
    if (props.loadOlder) await props.loadOlder();
    else emit("loadOlder");
  } finally {
    await nextTick();
    if (el && pendingAnchor.value !== null) {
      el.scrollTop = el.scrollHeight - pendingAnchor.value;
      pendingAnchor.value = null;
    }
  }
}

defineExpose({ scrollToBottom });
</script>

<template>
  <div class="relative flex min-h-0 flex-1 flex-col">
    <div
      v-if="forkedFrom"
      data-test="topic-fork-banner"
      class="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-hairline bg-surface-2 px-4 py-2 text-xs text-fg-muted lg:px-5"
    >
      <GitFork :size="13" class="shrink-0 text-accent" />
      <span data-test="topic-fork-banner-title">
        {{ $t("group.topic.forkBanner", { title: forkedFrom.sourceTitle }) }}
      </span>
      <span data-test="topic-fork-banner-count">
        {{ $t("group.topic.forkCopied", { count: forkedFrom.copiedMessages }) }}
      </span>
      <span v-if="forkedFrom.omittedMessages > 0" data-test="topic-fork-banner-omitted">
        {{ $t("group.topic.forkOmitted", { count: forkedFrom.omittedMessages }) }}
      </span>
      <button
        v-if="forkSourceAvailable"
        type="button"
        data-test="topic-fork-banner-source"
        class="font-medium text-accent underline-offset-2 hover:underline"
        @click="emit('openSourceTopic')"
      >
        {{ $t("group.topic.forkSource") }}
      </button>
    </div>
    <div
      ref="scroller"
      data-test="conversation-timeline-scroller"
      class="thin-scroll min-h-0 flex-1 overflow-y-auto px-4 pb-4 pt-4 lg:pl-5 lg:pr-5 lg:pt-5"
      :class="topInsetClass"
      @scroll.passive="onScroll"
    >
      <div v-if="hasMoreBefore" class="mb-4 flex justify-center">
        <button
          type="button"
          data-test="timeline-load-older"
          :disabled="loadingOlder"
          class="flex items-center gap-1.5 rounded-full bg-surface px-3 py-1 text-xs font-medium text-fg-muted transition-colors hover:bg-raised hover:text-fg disabled:opacity-50"
          @click="handleLoadOlder"
        >
          <Loader2 v-if="loadingOlder" :size="12" class="animate-spin" />
          <span>{{ loadingOlder ? $t("common.loading") : $t("chat.loadOlder") }}</span>
        </button>
      </div>

      <div
        v-if="!loading && rows.length === 0"
        data-test="timeline-empty"
        class="my-auto flex flex-col items-center justify-center gap-2 py-12 text-center"
      >
        <MessagesSquare :size="22" class="text-fg-muted" />
        <p data-test="timeline-empty-hint" class="text-xs text-fg-muted">
          {{ emptyHint ?? $t("conversation.timeline.empty") }}
        </p>
      </div>

      <div v-else class="mx-auto max-w-3xl space-y-5">
        <TimelineRow
          v-for="(row, index) in rows"
          :key="row.key"
          :data-row-key="row.key"
          :data-first="index === 0 ? 'true' : undefined"
          :row="row"
          :room="room"
          :is-run-queued="isRunQueued"
          @open-detail="(payload) => emit('openDetail', payload)"
        />
      </div>

      <p v-if="error" data-test="timeline-error" class="mt-3 text-center text-xs text-danger">
        {{ error }}
      </p>
    </div>

    <TranscriptJumpLatest :visible="!atBottom" @jump="scrollToBottom()" />
  </div>
</template>
