<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { ChevronLeft, ChevronRight, X } from "lucide-vue-next";
import { closeLightbox, stepLightbox, useImageLightbox } from "../lib/use-image-lightbox";

// Fullscreen image viewer for message images (attachment thumbnails and
// markdown-embedded images). Rendered only while a set is open (parent v-if /
// internal state): mount == open. Esc / tap-on-empty-black / ✕ close; arrow keys,
// buttons and horizontal swipe move within the bubble's image list.
const { state, current, counter, hasPrev, hasNext } = useImageLightbox();

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

function onKeydown(e: KeyboardEvent): void {
  if (e.key === "Escape") {
    e.preventDefault();
    closeLightbox();
  } else if (e.key === "ArrowLeft" && hasPrev.value) {
    stepLightbox(-1);
  } else if (e.key === "ArrowRight" && hasNext.value) {
    stepLightbox(1);
  }
}

// Light focus + scroll-lock treatment (MermaidViewer-style): lock body overflow
// while open and restore both scroll and focus on unmount.
let prevOverflow = "";
let previouslyFocused: HTMLElement | null = null;
onMounted(() => {
  previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  prevOverflow = document.body.style.overflow;
  document.body.style.overflow = "hidden";
  document.addEventListener("keydown", onKeydown);
});
onBeforeUnmount(() => {
  document.removeEventListener("keydown", onKeydown);
  document.body.style.overflow = prevOverflow;
  previouslyFocused?.focus?.();
});
</script>

<template>
  <Teleport to="body">
    <div
      v-if="state"
      class="fixed inset-0 z-[110] select-none bg-black/90 backdrop-blur-sm"
      data-test="image-lightbox"
      role="dialog"
      aria-modal="true"
      :aria-label="current?.alt || $t('chat.lightboxLabel')"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerCancel"
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
