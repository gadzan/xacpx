<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type {
  ConversationRunDto,
  InteractionValueDto,
  MemberTurnSummaryDto,
  PlanEntryDto,
  TurnPartDto,
} from "@ganglion/xacpx-relay-protocol";
import { useModalA11y } from "../lib/use-modal-a11y";
import { useDetailScrollMemory } from "../lib/use-detail-scroll-memory";
import type { PendingInteractionState } from "../stores/direct-bots";
import type { RoomParticipant } from "../lib/room-view";
import type { RunBudgetView } from "../lib/run-detail";
import GroupRunDetailHeader from "./GroupRunDetailHeader.vue";
import ConversationRunDetailContent from "./ConversationRunDetailContent.vue";

/**
 * Desktop (≥lg) execution-process drawer: right-side glass panel over a full
 * scrim. Owns its modal-layer registration (Escape / focus trap / history
 * entry) so the registration lifetime matches the drawer's, and the scroll
 * memory for its own scroller.
 */
const props = defineProps<{
  id: string;
  run: ConversationRunDto;
  topicTitle?: string;
  attempt?: number;
  attempts?: number[];
  parts?: TurnPartDto[];
  recordingState?: "complete" | "recording" | "interrupted" | "unavailable";
  plan?: PlanEntryDto[];
  traceLoading?: boolean;
  traceError?: string | null;
  traceHasMore?: boolean;
  traceHasEarlier?: boolean;
  traceStreaming?: boolean;
  scrollMemory?: Map<string, number>;
  /** The trigger that opened the overlay; focused on close. */
  anchorEl?: HTMLElement | null;
  memberTurns: MemberTurnSummaryDto[];
  selectedMemberTurnId?: string;
  participants?: RoomParticipant[];
  budget?: RunBudgetView;
  interactions?: PendingInteractionState[];
  capability?: { cancelMember: boolean };
  cancelPending?: boolean;
}>();

const emit = defineEmits<{
  close: [];
  attempt: [attempt: number];
  loadMore: [];
  loadEarlier: [];
  retryTrace: [];
  selectMember: [memberTurnId: string];
  stopMember: [memberTurnId: string];
  interactionAnswer: [requestId: string, key: string, value: InteractionValueDto];
  interactionSubmit: [requestId: string];
  interactionDecline: [requestId: string];
  interactionCancel: [requestId: string];
  interactionDismiss: [requestId: string];
}>();

const selectedMember = computed(() =>
  props.memberTurns.find((member) => member.id === props.selectedMemberTurnId)
  ?? props.memberTurns.find((member) => member.state === "running" || member.state === "dispatched")
  ?? props.memberTurns[props.memberTurns.length - 1]);

const drawerEl = ref<HTMLElement | null>(null);
const drawerScroll = ref<HTMLElement | null>(null);

// Focus restore target. Resolved at close-time: the trigger button if still
// connected, else its [data-row-id] ancestor; when the button was detached
// from its row (trigger swap) some engines skip detached subtrees in
// closest(), so the row is finally recovered by the member-turn id the row
// and the drawer share. A promoted (message-anchored) row carries that id in
// data-anchor-id instead — its data-row-id is the reply message id — so the
// scan matches either attribute. The parent clears :anchor-el synchronously
// with the close, so nothing here re-reads the prop after emit.
function resolveFocusFallback(): HTMLElement | null {
  const anchor = props.anchorEl;
  if (anchor?.isConnected) return anchor;
  const memberTurnId = selectedMember.value?.id;
  const row = anchor?.closest<HTMLElement>("[data-row-id]")
    ?? (memberTurnId
      ? Array.from(document.querySelectorAll<HTMLElement>("[data-row-id]"))
        .find((el) => el.getAttribute("data-row-id") === memberTurnId
          || el.getAttribute("data-anchor-id") === memberTurnId)
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
  () => `${props.run.id}:${selectedMember.value?.id ?? ""}:${props.attempt ?? ""}`,
  () => props.scrollMemory,
  () => !props.traceLoading,
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
      :aria-label="$t('conversation.runDetail.title')"
      :data-run-id="run.id" :data-member-turn-id="selectedMember?.id" :data-attempt="attempt"
      class="flex h-full w-full max-w-md flex-col overflow-hidden bg-glass-strong shadow-glass-float backdrop-blur-glass backdrop-saturate-glass"
    >
      <GroupRunDetailHeader
        variant="popover"
        :run="run" :topic-title="topicTitle"
        :attempt="attempt" :attempts="attempts"
        @close="close" @attempt="emit('attempt', $event)"
      />
      <div ref="drawerScroll" class="group-detail-scroll min-h-0 flex-1 overflow-y-auto px-4 pb-4" @scroll.passive="memoizeScroll()">
        <ConversationRunDetailContent
          :run="run" :member-turns="memberTurns" :selected-member-turn-id="selectedMember?.id"
          :participants="participants" :budget="budget" :interactions="interactions"
          :capability="capability" :cancel-pending="cancelPending"
          :attempt="attempt" :attempts="attempts" :parts="parts"
          :recording-state="recordingState" :plan="plan"
          :trace-loading="traceLoading" :trace-error="traceError"
          :trace-has-more="traceHasMore" :trace-has-earlier="traceHasEarlier" :trace-streaming="traceStreaming"
          @select-member="emit('selectMember', $event)" @stop-member="emit('stopMember', $event)"
          @load-more="emit('loadMore')" @load-earlier="emit('loadEarlier')" @retry-trace="emit('retryTrace')"
          @interaction-answer="(requestId, key, value) => emit('interactionAnswer', requestId, key, value)"
          @interaction-submit="emit('interactionSubmit', $event)"
          @interaction-decline="emit('interactionDecline', $event)"
          @interaction-cancel="emit('interactionCancel', $event)"
          @interaction-dismiss="emit('interactionDismiss', $event)"
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
  /* Modal like the accepted demo: a scrim covers the chat while the drawer is
   * open; pointerdown on the scrim reaches the outside-close handler, and
   * keyboard focus stays inside the drawer. */
  pointer-events: auto;
  background: rgb(var(--c-fg) / 0.22);
  backdrop-filter: blur(2px);
}
.detail-drawer-layer > aside {
  pointer-events: auto;
  margin-left: auto;
}
</style>
