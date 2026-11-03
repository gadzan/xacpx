<script setup lang="ts">
import ThinkingDots from "./ThinkingDots.vue";

/**
 * Clickable wrapper around the thinking dots: the entry into a turn's
 * execution process overlay. Same visual as the bare ThinkingDots, but a real
 * button — keyboard reachable, focus ring, and a still variant that pauses the
 * wave animation when the member is blocked on the user (waiting-human) and
 * therefore no longer "thinking".
 */
defineProps<{
  /** Localized accessible name; the dots themselves carry no label. */
  label: string;
  disabled?: boolean;
  still?: boolean;
  /** True when this entry currently owns the open overlay (mirrors the
   *  finished bubble's expanded contract for e2e/a11y parity). */
  expanded?: boolean;
  /** id of the overlay element this trigger controls. */
  controls?: string;
}>();

const emit = defineEmits<{ open: [trigger: HTMLElement | null] }>();

function onOpen(event: Event): void {
  emit("open", event.currentTarget instanceof HTMLElement ? event.currentTarget : null);
}
</script>

<template>
  <button
    type="button"
    data-test="agent-thinking-bubble"
    class="dots-trigger"
    :class="{ 'is-still': still }"
    :aria-label="label"
    :aria-haspopup="disabled ? undefined : 'dialog'"
    :aria-expanded="expanded === true"
    :aria-controls="controls"
    :disabled="disabled"
    @click.stop="onOpen"
  >
    <ThinkingDots />
  </button>
</template>

<style scoped>
.dots-trigger {
  display: inline-flex;
  border-radius: 9999px;
  cursor: pointer;
}
.dots-trigger:focus-visible {
  outline: 2px solid rgb(var(--c-accent));
  outline-offset: 2px;
}
.dots-trigger:disabled {
  cursor: default;
}
/* A paused member is not thinking: keep the pill but still the wave. */
.dots-trigger.is-still :deep(.dot) {
  animation-play-state: paused;
}
</style>
