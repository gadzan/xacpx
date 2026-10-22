<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref } from "vue";
import { computeCalloutPlacement } from "../lib/fue-placement";

// Small hover/focus tooltip (relay-web redesign §G): bg-fg text-bg, shown after
// a 300ms hover or on keyboard focus; on touch, a tap shows it for 2s. Used for
// the session-list cold-start hint (an SVG `title` never shows on touch).
// The bubble is teleported to <body> with fixed positioning, so an overflow-hidden
// ancestor (e.g. the sidebar row's swipe clip layer) can never clip it.
// While visible it follows its anchor: any scroll (capture phase, so nested
// scrollers count) or resize re-runs placement once per animation frame; it flips
// to the opposite side when the preferred one doesn't fit, clamps horizontally
// 8px inside the viewport, and hides once the anchor leaves the viewport.
const props = withDefaults(defineProps<{ text: string; placement?: "top" | "bottom" }>(), {
  placement: "bottom",
});

const GAP = 8;
/** Keep the arrow this far from the bubble's rounded corners when clamped. */
const ARROW_INSET = 8;

const visible = ref(false);
const anchor = ref<HTMLElement | null>(null);
const bubble = ref<HTMLElement | null>(null);
const pos = ref({ left: 0, top: 0, side: "below" as "above" | "below", arrowLeft: null as number | null });
let hoverTimer: ReturnType<typeof setTimeout> | null = null;
let touchTimer: ReturnType<typeof setTimeout> | null = null;
let frame: number | null = null;
let tracking = false;

function clearTimers(): void {
  if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
  if (touchTimer) { clearTimeout(touchTimer); touchTimer = null; }
}

function reposition(): void {
  const a = anchor.value;
  if (!a || !visible.value) return;
  const r = a.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  // jsdom reports a zero rect for every element; only measured geometry may
  // prove the anchor scrolled off-screen.
  const measurable = r.width > 0 || r.height > 0;
  if (measurable && (r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw)) {
    hide();
    return;
  }
  const b = bubble.value?.getBoundingClientRect();
  const size = { width: b?.width ?? 0, height: b?.height ?? 0 };
  const p = computeCalloutPlacement(
    { top: r.top, left: r.left, width: r.width, height: r.height },
    size,
    { width: vw, height: vh },
    GAP,
    props.placement === "top" ? "above" : "below",
  );
  // Point the arrow at the anchor's center even when the bubble is clamped.
  const arrowLeft = size.width > 0
    ? Math.min(Math.max(r.left + r.width / 2 - p.left, ARROW_INSET), size.width - ARROW_INSET)
    : null;
  pos.value = { left: p.left, top: p.top, side: p.placement, arrowLeft };
}

function schedule(): void {
  if (frame !== null) return;
  frame = requestAnimationFrame(() => {
    frame = null;
    reposition();
  });
}

function startTracking(): void {
  if (tracking) return;
  tracking = true;
  window.addEventListener("scroll", schedule, { capture: true, passive: true });
  window.addEventListener("resize", schedule, { passive: true });
}

function stopTracking(): void {
  if (!tracking) return;
  tracking = false;
  window.removeEventListener("scroll", schedule, { capture: true });
  window.removeEventListener("resize", schedule);
  if (frame !== null) { cancelAnimationFrame(frame); frame = null; }
}

function show(): void {
  visible.value = true;
  startTracking();
  reposition();
  // Re-place once the bubble has rendered and can be measured.
  void nextTick(reposition);
}
function hide(): void {
  visible.value = false;
  stopTracking();
}

function onPointerEnter(e: PointerEvent): void {
  // Touch/pen: show immediately for 2s, no hover delay.
  if (e.pointerType === "touch" || e.pointerType === "pen") {
    clearTimers();
    show();
    touchTimer = setTimeout(hide, 2000);
    return;
  }
  if (hoverTimer) clearTimeout(hoverTimer);
  hoverTimer = setTimeout(show, 300);
}
function onPointerLeave(): void {
  if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
  if (touchTimer) { clearTimeout(touchTimer); touchTimer = null; }
  hide();
}
onBeforeUnmount(() => {
  clearTimers();
  stopTracking();
});
</script>

<template>
  <span ref="anchor" class="relative inline-flex"
        @pointerenter="onPointerEnter" @pointerleave="onPointerLeave"
        @focusin="show" @focusout="hide">
    <slot />
    <Teleport to="body">
      <span v-if="visible" ref="bubble" role="tooltip" data-test="tooltip" :data-placement="pos.side"
            class="pointer-events-none fixed z-50 whitespace-nowrap rounded-sm bg-fg px-2 py-1 text-xs text-bg shadow-float"
            :style="{ left: `${pos.left}px`, top: `${pos.top}px` }">
        {{ props.text }}
        <span class="absolute h-2 w-2 -translate-x-1/2 rotate-45 bg-fg"
              :class="pos.side === 'above' ? '-bottom-1' : '-top-1'"
              :style="{ left: pos.arrowLeft === null ? '50%' : `${pos.arrowLeft}px` }" />
      </span>
    </Teleport>
  </span>
</template>
