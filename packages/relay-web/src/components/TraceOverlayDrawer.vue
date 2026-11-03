<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import type {
  ConversationRunDto,
  MemberTurnSummaryDto,
  PlanEntryDto,
  TurnPartDto,
} from "@ganglion/xacpx-relay-protocol";
import { useModalA11y } from "../lib/use-modal-a11y";
import { useDetailScrollMemory } from "../lib/use-detail-scroll-memory";
import GroupRunDetailHeader from "./GroupRunDetailHeader.vue";
import GroupRunDetailContent from "./GroupRunDetailContent.vue";

/**
 * Desktop (≥lg) execution-process drawer: right-side glass panel over a full
 * scrim. Owns its modal-layer registration (Escape / focus trap / history
 * entry) so the registration lifetime matches the drawer's, and the scroll
 * memory for its own scroller.
 */
const props = defineProps<{
  id: string;
  run: ConversationRunDto;
  memberTurn?: MemberTurnSummaryDto;
  memberName?: string;
  topicTitle?: string;
  attempt?: number;
  attempts?: number[];
  parts?: TurnPartDto[];
  recordingState?: "complete" | "recording" | "interrupted" | "unavailable";
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
  /** The trigger that opened the overlay; focused on close. */
  anchorEl?: HTMLElement | null;
}>();

const emit = defineEmits<{
  close: [];
  stop: [];
  pause: [];
  attempt: [attempt: number];
  loadMore: [];
  loadEarlier: [];
  retryTrace: [];
}>();

const drawerEl = ref<HTMLElement | null>(null);
const drawerScroll = ref<HTMLElement | null>(null);

function close(): void {
  const anchor = props.anchorEl;
  emit("close");
  anchor?.focus({ preventScroll: true });
}

// Escape closes through the same focus-restoring path as the ✕ button — not
// through navigateBack, which would pop a history entry without refocusing.
useModalA11y(drawerEl, () => close(), {
  onEscape: () => { close(); return true; },
  // The drawer has no pre-appointed control to open with: keep focus on the
  // dialog element itself instead of stealing it for the ✕ button.
  initialFocus: () => drawerEl.value,
});

const { remember: memoizeScroll } = useDetailScrollMemory(
  () => drawerScroll.value,
  () => `${props.memberTurn?.id ?? ""}:${props.attempt ?? ""}`,
  () => props.scrollMemory,
  () => !props.traceLoading && (props.parts?.length ?? 0) > 0,
);

function onOutsidePointer(event: PointerEvent): void {
  if (document.querySelector('[data-composer-confirm]')) return;
  const layer = drawerEl.value?.parentElement;
  if (layer && event.composedPath().includes(layer)) return;
  if (props.anchorEl && event.composedPath().includes(props.anchorEl)) return;
  // Outside click closes without refocusing: the pointer is elsewhere now and
  // focus must follow it, not snap back to the bubble.
  emit("close");
}

let anchorObserver: IntersectionObserver | null = null;

// Anchor scrolled out of the transcript or its row was removed (compacted):
// close without touching focus — the reader has already moved on.
function observeAnchor(): void {
  anchorObserver?.disconnect();
  anchorObserver = null;
  const anchor = props.anchorEl;
  if (!anchor || typeof IntersectionObserver === "undefined") return;
  anchorObserver = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.target === props.anchorEl && !entry.isIntersecting)) emit("close");
  }, { root: null, threshold: 0 });
  anchorObserver.observe(anchor);
}

onMounted(() => {
  document.addEventListener("pointerdown", onOutsidePointer, true);
  observeAnchor();
});
onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", onOutsidePointer, true);
  anchorObserver?.disconnect();
  anchorObserver = null;
});
watch(() => props.anchorEl, observeAnchor, { flush: "post" });
</script>

<template>
  <div
    :id="`${id}-layer`"
    data-test="group-detail-layer"
    class="fixed inset-0 z-50 flex justify-end bg-scrim backdrop-blur-sm"
    @click.self="close"
  >
    <aside
      :id="id"
      ref="drawerEl" tabindex="-1" role="dialog" aria-modal="true"
      data-test="group-detail-card"
      :aria-label="memberName ? `${memberName} · ${$t('group.detail.title')}` : $t('group.detail.title')"
      :data-run-id="run.id" :data-member-turn-id="memberTurn?.id" :data-attempt="attempt"
      class="flex h-full w-full max-w-md flex-col overflow-hidden bg-glass-strong shadow-glass-float backdrop-blur-glass backdrop-saturate-glass"
    >
      <GroupRunDetailHeader
        variant="popover"
        :run="run" :member-turn="memberTurn" :member-name="memberName" :topic-title="topicTitle"
        :attempt="attempt" :attempts="attempts" :stop-available="stopAvailable" :stop-pending="stopPending"
        :pause-available="pauseAvailable" :pause-pending="pausePending"
        @close="close" @stop="emit('stop')" @pause="emit('pause')" @attempt="emit('attempt', $event)"
      />
      <div ref="drawerScroll" class="group-detail-scroll min-h-0 flex-1 overflow-y-auto px-4 pb-4" @scroll.passive="memoizeScroll()">
        <GroupRunDetailContent
          :run="run" :member-turn="memberTurn" :member-name="memberName"
          :attempt="attempt" :attempts="attempts" :parts="parts"
          :recording-state="recordingState" :explanation="explanation"
          :plan="plan" :trace-failure="traceFailure" :trace-loading="traceLoading" :trace-error="traceError"
          :trace-has-more="traceHasMore" :trace-has-earlier="traceHasEarlier" :trace-streaming="traceStreaming"
          :stop-available="stopAvailable" :stop-pending="stopPending"
          @load-more="emit('loadMore')" @load-earlier="emit('loadEarlier')" @retry-trace="emit('retryTrace')"
        />
      </div>
    </aside>
  </div>
</template>
