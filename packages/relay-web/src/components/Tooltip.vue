<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue";

// Small hover/focus tooltip (relay-web redesign §G): bg-fg text-bg, shown after
// a 300ms hover or on keyboard focus; on touch, a tap shows it for 2s. Used for
// the session-list cold-start hint (an SVG `title` never shows on touch).
// The bubble is teleported to <body> with fixed positioning, so an overflow-hidden
// ancestor (e.g. the sidebar row's swipe clip layer) can never clip it.
const props = defineProps<{ text: string }>();

const visible = ref(false);
const anchor = ref<HTMLElement | null>(null);
const pos = ref({ left: 0, top: 0 });
let hoverTimer: ReturnType<typeof setTimeout> | null = null;
let touchTimer: ReturnType<typeof setTimeout> | null = null;

function clearTimers(): void {
  if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
  if (touchTimer) { clearTimeout(touchTimer); touchTimer = null; }
}
function show(): void {
  const r = anchor.value?.getBoundingClientRect();
  if (r) pos.value = { left: r.left + r.width / 2, top: r.bottom + 8 };
  visible.value = true;
}
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
  <span ref="anchor" class="relative inline-flex"
        @pointerenter="onPointerEnter" @pointerleave="onPointerLeave"
        @focusin="show" @focusout="hide">
    <slot />
    <Teleport to="body">
      <span v-if="visible" role="tooltip" data-test="tooltip"
            class="pointer-events-none fixed z-50 -translate-x-1/2 whitespace-nowrap rounded-sm bg-fg px-2 py-1 text-xs text-bg shadow-float"
            :style="{ left: `${pos.left}px`, top: `${pos.top}px` }">
        {{ props.text }}
        <span class="absolute -top-1 left-1/2 h-2 w-2 -translate-x-1/2 rotate-45 bg-fg" />
      </span>
    </Teleport>
  </span>
</template>
