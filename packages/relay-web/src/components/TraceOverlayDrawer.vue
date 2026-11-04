<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
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

// Focus restore target. Resolved at close-time: the trigger button if still
// connected, else its [data-row-id] ancestor; when the button was detached
// from its row (trigger swap) some engines skip detached subtrees in
// closest(), so the row is finally recovered by the member-turn id the row
// and the drawer share. The parent clears :anchor-el synchronously with the
// close, so nothing here re-reads the prop after emit.
function resolveFocusFallback(): HTMLElement | null {
  const anchor = props.anchorEl;
  if (anchor?.isConnected) return anchor;
  const memberTurnId = props.memberTurn?.id;
  const row = anchor?.closest<HTMLElement>("[data-row-id]")
    ?? (memberTurnId
      ? Array.from(document.querySelectorAll<HTMLElement>("[data-row-id]"))
        .find((el) => el.getAttribute("data-row-id") === memberTurnId)
      : undefined);
  return row?.isConnected ? row : null;
}

function close(): void {
  const fallback = resolveFocusFallback();
  emit("close");
  // A trigger swap can detach the button between open and close; focusing a
  // detached node is a silent no-op that drops the reader onto <body>. If
  // nothing else took focus during unmount, fall back to the row.
  void nextTick(() => {
    if (document.activeElement !== document.body && document.activeElement !== null) return;
    fallback?.focus({ preventScroll: true });
  });
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
  // The layer itself is pointer-through (collapsed popover contract): only the
  // drawer intercepts. Clicks that land on the drawer or the anchor's row stay.
  if (rowEl() && event.composedPath().includes(rowEl()!)) return;
  if (drawerEl.value && event.composedPath().includes(drawerEl.value)) return;
  // Outside click closes without refocusing: the pointer is elsewhere now and
  // focus must follow it, not snap back to the bubble.
  emit("close");
}

/** The row outlives the trigger button: the live ⇄ finished branch swap
 *  replaces the button while the detail is open, so intersection and
  * outside-pointer checks anchor to the row, never the swappable button. */
function rowEl(): HTMLElement | null {
  return props.anchorEl?.closest<HTMLElement>("[data-row-id]") ?? null;
}

let anchorObserver: IntersectionObserver | null = null;

// Anchor scrolled out of the transcript or its row was removed (compacted):
// close without touching focus — the reader has already moved on. A trigger
// swap (live ⇄ finished branch) detaches the button but keeps the row; only
// a missing row counts as gone.
function observeAnchor(): void {
  anchorObserver?.disconnect();
  anchorObserver = null;
  const row = rowEl();
  if (!row || typeof IntersectionObserver === "undefined") return;
  anchorObserver = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.target === row && !entry.isIntersecting)) emit("close");
  }, { root: null, threshold: 0 });
  anchorObserver.observe(row);
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
watch(rowEl, observeAnchor, { flush: "post" });
</script>

<template>
  <div
    :id="`${id}-layer`"
    data-test="group-detail-layer"
    class="detail-drawer-layer"
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

<style scoped>
.detail-drawer-layer {
  position: fixed;
  inset: 0;
  z-index: 50;
  /* Non-modal like the anchored popover it replaces: only the drawer itself
   * takes pointer events, the rest of the page stays interactive. */
  pointer-events: none;
}
.detail-drawer-layer > aside {
  pointer-events: auto;
  margin-left: auto;
}
</style>
