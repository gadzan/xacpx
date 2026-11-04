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
    :class="{ 'is-still': still, 'is-expanded': expanded === true }"
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
  align-items: center;
  justify-content: center;
  min-width: 64px;
  min-height: 40px;
  max-width: 100%;
  margin: 0;
  padding: 0 15px;
  color: rgb(var(--c-fg-muted));
  background: rgb(var(--c-fg) / 0.055);
  border: none;
  border-radius: 4px 16px 16px 16px;
  cursor: pointer;
  transition: color 160ms ease, background-color 160ms ease;
}
/* The painted surface is the entry itself, so the visible bubble and the hit
   target never disagree about what is clickable. */
.dots-trigger:hover { color: rgb(var(--c-fg)); background: rgb(var(--c-fg) / 0.09); }
.dots-trigger:active { transform: scale(0.98); }
.dots-trigger:focus-visible { outline: 2px solid rgb(var(--c-accent)); outline-offset: 1px; }
/* Stillness when waiting on the user: keep the entry, still the wave. */
.dots-trigger.is-still { color: rgb(var(--c-warn)); }
.dots-trigger.is-still :deep(.dot) {
  animation-play-state: paused;
}
.dots-trigger.is-expanded { color: rgb(var(--c-accent)); background: rgb(var(--c-accent) / 0.1); }
@media (prefers-reduced-motion: reduce) {
  .dots-trigger { transition: none; }
  .dots-trigger :deep(.dot) { animation: none; }
}
</style>
