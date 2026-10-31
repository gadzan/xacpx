<script setup lang="ts">
import { computed, ref, type CSSProperties } from "vue";
import { useModalA11y } from "../lib/use-modal-a11y";
import { navigateBack } from "../lib/mobile-back";
import { X } from "lucide-vue-next";
defineOptions({ inheritAttrs: false });

// Bottom sheet for the mobile (<lg) chrome: a glass panel pinned to the bottom edge,
// with a backdrop, a grab handle with pull-to-close, Escape-to-close and focus
// that moves in on open and returns to the trigger on close (useModalA11y).
// Items are the caller's business; keep them >= 48px tall (`min-h-12`) so they
// are comfortable touch targets.
//
// Mount with `v-if` at the call site: useModalA11y's hooks must pair with the panel's
// lifetime (an always-mounted sheet would swallow Escape while closed). Nested sheets
// stack — only the top-most one owns Escape, so closing a child leaves the parent open.
// Two densities: the default header is a title + close row (every row-list sheet). A
// caller that owns its own header — the group run detail, whose header carries a state
// pill, the topic title, the who/when meta row and a Stop action — passes `#header` and
// `:show-close="false"`; the panel keeps the same frame, backdrop, focus contract and
// safe-area padding.
// A custom header can mark a safe initial target with `data-sheet-initial-focus`.
const props = withDefaults(defineProps<{
  /** Accessible dialog name, including when a custom header is provided. */
  title: string;
  testId?: string;
  zClass?: string;
  ddPanel?: boolean;
  /** Retained for call-site compatibility; both densities share the 78dvh cap. */
  height?: "md" | "tall";
  /** Document padding for reading surfaces (the trace) instead of row padding. */
  padded?: boolean;
  /** The `#header` slot supplies its own close control. */
  showClose?: boolean;
}>(), { height: "md", padded: false, showClose: true });
const emit = defineEmits<{ close: [] }>();
const panel = ref<HTMLElement | null>(null);
const body = ref<HTMLElement | null>(null);
defineExpose({ body });

// Pull-to-close. Only the grabber strip starts a drag — the body scrolls — and
// the drag is pointer-driven so mouse and touch share the path. While down the
// panel translates with the finger; releasing past a quarter of the panel
// height (or with a fast downward flick) closes through navigateBack, the same
// close the backdrop and the ✕ use, and a short release springs back through
// the sheet-panel transition (disabled under prefers-reduced-motion).
const dragOffset = ref(0);
const dragging = ref(false);
const panelStyle = computed<CSSProperties>(() =>
  dragOffset.value > 0 ? { transform: `translateY(${dragOffset.value}px)` } : {},
);
const CLOSE_FRACTION = 0.25;
const FLICK_PX_PER_MS = 0.5;
const FLICK_MIN_PX = 24;
let dragStartY = 0;
let dragLastY = 0;
let dragLastT = 0;
let dragVelocity = 0;

function onGrabberDown(e: PointerEvent): void {
  if (e.isPrimary === false) return;
  if (e.pointerType === "mouse" && e.button !== 0) return;
  dragStartY = e.clientY;
  dragLastY = e.clientY;
  dragLastT = performance.now();
  dragVelocity = 0;
  dragOffset.value = 0;
  dragging.value = true;
  // Keep the gesture on the strip when the finger leaves it. Guarded: jsdom
  // (and re-dispatched synthetic events) have no capture API.
  const zone = e.currentTarget as HTMLElement | null;
  if (typeof zone?.setPointerCapture === "function") zone.setPointerCapture(e.pointerId);
}

function onGrabberMove(e: PointerEvent): void {
  if (!dragging.value || e.isPrimary === false) return;
  const now = performance.now();
  const dt = now - dragLastT;
  if (dt > 0) dragVelocity = (e.clientY - dragLastY) / dt;
  dragLastY = e.clientY;
  dragLastT = now;
  dragOffset.value = Math.max(0, e.clientY - dragStartY);
}

function onGrabberUp(e: PointerEvent): void {
  if (!dragging.value || e.isPrimary === false) return;
  dragging.value = false;
  const height = panel.value?.getBoundingClientRect().height ?? 0;
  const pastThreshold = height > 0 && dragOffset.value > height * CLOSE_FRACTION;
  const flick = dragVelocity > FLICK_PX_PER_MS && dragOffset.value > FLICK_MIN_PX;
  dragVelocity = 0;
  if (pastThreshold || flick) {
    // The close unmounts the panel, so leave it where the finger left it.
    navigateBack();
    return;
  }
  // Clearing the offset lets the sheet-panel transition carry it home.
  dragOffset.value = 0;
}

function onGrabberCancel(): void {
  // The platform took the gesture: park the panel instead of closing it.
  if (!dragging.value) return;
  dragging.value = false;
  dragVelocity = 0;
  dragOffset.value = 0;
}
useModalA11y(panel, () => emit("close"), {
  mobileOnly: true,
  initialFocus: () => panel.value?.querySelector<HTMLElement>("[data-sheet-initial-focus]") ?? null,
});
</script>

<template>
  <!-- Attributes belong to the dialog, not its backdrop. -->
  <div data-test="sheet-backdrop" class="sheet-backdrop fixed inset-0 bg-scrim backdrop-blur-sm lg:hidden" :class="zClass ?? 'z-40'" @click="navigateBack" />
  <div ref="panel" v-bind="$attrs" role="dialog" aria-modal="true" :aria-label="title" tabindex="-1"
       :data-dd-panel="ddPanel || undefined"
       :data-test="testId"
       class="sheet-panel fixed inset-x-0 bottom-0 flex max-h-[78dvh] flex-col overflow-hidden rounded-t-[24px] bg-glass-strong shadow-glass-float backdrop-blur-glass backdrop-saturate-glass lg:hidden"
       :class="[zClass ?? 'z-40', dragging ? 'sheet-dragging' : '']" :style="panelStyle">
    <!-- Pull-to-close hot zone: the bar is decorative, the strip takes the drag. -->
    <div data-test="sheet-grabber" aria-hidden="true"
         class="shrink-0 cursor-grab touch-none select-none px-4 pb-1 pt-2 active:cursor-grabbing"
         @pointerdown="onGrabberDown" @pointermove="onGrabberMove"
         @pointerup="onGrabberUp" @pointercancel="onGrabberCancel">
      <div class="mx-auto h-[5px] w-9 rounded-full bg-fill-strong" />
    </div>
    <slot name="header">
      <div class="flex shrink-0 items-center justify-between gap-2 px-4 pb-1 pt-1">
        <h2 class="min-w-0 truncate text-[17px] font-semibold text-fg">{{ title }}</h2>
        <button v-if="showClose" type="button" data-test="sheet-close" :aria-label='$t("common.close")'
                class="grid h-11 w-11 shrink-0 place-items-center rounded-full text-fg-muted transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                @click="navigateBack"><X :size="18" /></button>
      </div>
    </slot>
    <div ref="body" class="thin-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain break-words"
         :class="padded
           ? ['detail-scroll px-5 pt-1', $slots.footer ? 'pb-2' : 'pb-[calc(1.25rem+env(safe-area-inset-bottom))]']
           : ['px-2', $slots.footer ? 'pb-2' : 'pb-[calc(0.5rem+env(safe-area-inset-bottom))]']">
      <slot />
    </div>
    <!-- Pinned action row (e.g. stop all): outside the scroller, above the
         safe-area inset so the button is never cut off. -->
    <div v-if="$slots.footer" class="shrink-0 border-t border-fg/5 px-4 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-3">
      <slot name="footer" />
    </div>
  </div>
</template>

<style scoped>
/* The sheet rises from the bottom edge; the backdrop fades. Only the entry is
   animated (the panel unmounts on close, so there is no exit frame to run). A
   short downward release after a grabber drag springs home through a
   transform-only transition — the glass blur and shadow stay out of it. */
.sheet-panel {
  animation: sheet-rise 280ms cubic-bezier(.32,.72,0,1);
  transition: transform 220ms cubic-bezier(.32,.72,0,1);
}
.sheet-panel.sheet-dragging { transition: none; }
.sheet-backdrop { animation: sheet-fade 150ms ease-out; }
@keyframes sheet-rise {
  from { transform: translateY(100%); }
  to { transform: translateY(0); }
}
@keyframes sheet-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .sheet-panel, .sheet-backdrop { animation: none; transition: none; }
}
</style>
