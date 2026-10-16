<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue";

// Small hover/focus tooltip (relay-web redesign §G): bg-fg text-bg, shown after
// a 300ms hover or on keyboard focus; on touch, a tap shows it for 2s. Used for
// the session-list cold-start hint (an SVG `title` never shows on touch).
const props = defineProps<{ text: string }>();

const visible = ref(false);
let hoverTimer: ReturnType<typeof setTimeout> | null = null;
let touchTimer: ReturnType<typeof setTimeout> | null = null;

function clearTimers(): void {
  if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
  if (touchTimer) { clearTimeout(touchTimer); touchTimer = null; }
}
function show(): void { visible.value = true; }
function hide(): void { visible.value = false; }

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
onBeforeUnmount(clearTimers);
</script>

<template>
  <span class="relative inline-flex"
        @pointerenter="onPointerEnter" @pointerleave="onPointerLeave"
        @focusin="show" @focusout="hide">
    <slot />
    <span v-if="visible" role="tooltip" data-test="tooltip"
          class="pointer-events-none absolute left-1/2 top-full z-50 mt-2 -translate-x-1/2 whitespace-nowrap rounded-sm bg-fg px-2 py-1 text-xs text-bg shadow-float">
      {{ text }}
      <span class="absolute -top-1 left-1/2 h-2 w-2 -translate-x-1/2 rotate-45 bg-fg" />
    </span>
  </span>
</template>
