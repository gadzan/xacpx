<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { ChevronLeft, ChevronRight, X } from "lucide-vue-next";
import { closeLightbox, stepLightbox, useImageLightbox } from "../lib/use-image-lightbox";
import { useModalA11y } from "../lib/use-modal-a11y";

// Fullscreen image viewer for message images (attachment thumbnails and
// markdown-embedded images). The parent gates this component with v-if on the
// singleton state (App.vue), so mount == open and every side effect below
// (scroll lock, focus, key handling) is installed/torn down exactly once per
// open/close cycle. Esc + focus trap/restore come from the shared modal stack
// (useModalA11y), so a lightbox opened above another dialog closes alone.
const { state, current, counter, hasPrev, hasNext } = useImageLightbox();

const dialogEl = ref<HTMLElement | null>(null);
useModalA11y(dialogEl, closeLightbox);

// Scroll lock for the open duration. Safe to do in mount/unmount ONLY because the
// parent gates this component with v-if on the singleton state (mount == open);
// a permanently-mounted instance would lock scrolling for the whole app session.
let prevOverflow = "";
onMounted(() => {
  prevOverflow = document.body.style.overflow;
  document.body.style.overflow = "hidden";
});
onBeforeUnmount(() => {
  document.body.style.overflow = prevOverflow;
});

// Swipe: one active pointer; a clearly-horizontal drag ≥48px flips pages and the
// image follows the finger live. Dragging past an end does nothing.
let pointerId: number | null = null;
let startX = 0;
let startY = 0;
let dragging = false;
const dragDx = ref(0);

function onPointerDown(e: PointerEvent): void {
  if (pointerId !== null) return;
  pointerId = e.pointerId;
  startX = e.clientX;
  startY = e.clientY;
  dragging = false;
}

function onPointerMove(e: PointerEvent): void {
  if (e.pointerId !== pointerId || !state.value) return;
  const dx = e.clientX - startX;
  const dy = e.clientY - startY;
  // Only once clearly horizontal, so vertical touch scrolling never hijacks.
  if (!dragging && Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 8) dragging = true;
  if (!dragging) return;
  if ((dx > 0 && !hasPrev.value) || (dx < 0 && !hasNext.value)) return;
  dragDx.value = dx;
}

function onPointerUp(e: PointerEvent): void {
  if (e.pointerId !== pointerId) return;
  const wasDragging = dragging;
  const dx = dragDx.value;
  pointerId = null;
  dragging = false;
  dragDx.value = 0;
  if (wasDragging) {
    if (dx <= -48) stepLightbox(1);
    else if (dx >= 48) stepLightbox(-1);
    return;
  }
  // A still pointer released on the empty backdrop (the stage itself, not the
  // image or a button) closes the viewer.
  if (e.target === e.currentTarget) closeLightbox();
}

function onPointerCancel(): void {
  pointerId = null;
  dragging = false;
  dragDx.value = 0;
}
</script>

<template>
  <Teleport to="body">
    <div
      ref="dialogEl"
      class="fixed inset-0 z-[110] select-none bg-black/90 outline-none backdrop-blur-sm"
      data-test="image-lightbox"
      role="dialog"
      aria-modal="true"
      tabindex="-1"
      :aria-label="current?.alt || $t('chat.lightboxLabel')"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerCancel"
      @keydown.left.prevent="hasPrev && stepLightbox(-1)"
      @keydown.right.prevent="hasNext && stepLightbox(1)"
    >
      <!-- Top bar: position counter + filename, then close. -->
      <div class="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-center gap-3 p-3 text-white/90">
        <span v-if="counter" data-test="lightbox-counter" class="rounded-full bg-white/10 px-2.5 py-1 font-mono text-[11px] tabular-nums">
          {{ counter }}
        </span>
        <span v-if="current?.alt" class="min-w-0 flex-1 truncate text-[12px] text-white/70">{{ current.alt }}</span>
        <button
          type="button"
          data-test="lightbox-close"
          class="pointer-events-auto grid h-9 w-9 shrink-0 place-items-center rounded-full text-white/80 transition-colors hover:bg-white/10 hover:text-white"
          :aria-label="$t('common.dismiss')"
          @click="closeLightbox()"
        >
          <X :size="18" />
        </button>
      </div>

      <!-- The image itself: centered, contain-fit, follows the swipe finger. -->
      <img
        v-if="current"
        data-test="lightbox-image"
        :src="current.src"
        :alt="current.alt ?? ''"
        draggable="false"
        class="absolute inset-0 m-auto max-h-full max-w-full object-contain shadow-2xl"
        :style="{ transform: `translateX(${dragDx}px)`, transition: dragging ? 'none' : 'transform 150ms ease-out' }"
      />

      <!-- Prev/next hidden at the ends (not merely disabled) so mobile users get an
           honest affordance; keyboard stops at the same bounds. -->
      <button
        v-if="hasPrev"
        type="button"
        data-test="lightbox-prev"
        class="absolute left-2 top-1/2 z-20 grid h-11 w-11 -translate-y-1/2 place-items-center rounded-full bg-black/40 text-white/85 backdrop-blur transition-colors hover:bg-black/60 hover:text-white sm:left-4"
        :aria-label="$t('chat.lightboxPrev')"
        @click="stepLightbox(-1)"
      >
        <ChevronLeft :size="22" />
      </button>
      <button
        v-if="hasNext"
        type="button"
        data-test="lightbox-next"
        class="absolute right-2 top-1/2 z-20 grid h-11 w-11 -translate-y-1/2 place-items-center rounded-full bg-black/40 text-white/85 backdrop-blur transition-colors hover:bg-black/60 hover:text-white sm:right-4"
        :aria-label="$t('chat.lightboxNext')"
        @click="stepLightbox(1)"
      >
        <ChevronRight :size="22" />
      </button>
    </div>
  </Teleport>
</template>
