<script setup lang="ts">
/**
 * The quiet execution-process entry that lives INSIDE a conclusion bubble: a
 * hairline separates it from the text and the type stays smaller than the
 * message, so reading the answer never competes with opening its trace.
 * Used by the group transcript and the Direct Bot transcript alike.
 */
defineProps<{
  /** Localized accessible name for the whole entry. */
  label: string;
  text: string;
  expanded?: boolean;
  controls?: string;
  /** Failure tones keep a colour cue next to the word. */
  tone?: "muted" | "warn" | "accent";
}>();

const emit = defineEmits<{ toggle: [trigger: HTMLElement | null] }>();

function onToggle(event: MouseEvent): void {
  emit("toggle", event.currentTarget instanceof HTMLElement ? event.currentTarget : null);
}
</script>

<template>
  <button
    type="button"
    data-test="trace-link"
    class="trace-link"
    :class="`is-${tone ?? 'muted'}`"
    :aria-label="label"
    aria-haspopup="dialog"
    :aria-expanded="expanded === true"
    :aria-controls="controls"
    :title="label"
    @click.stop="onToggle"
  >
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" class="trace-link-icon">
      <circle cx="12" cy="12" r="7.5" fill="none" stroke="currentColor" stroke-width="1.6" />
      <circle cx="12" cy="12" r="2.4" fill="currentColor" />
    </svg>
    <span>{{ text }}</span>
  </button>
</template>

<style scoped>
.trace-link {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-top: 7px;
  padding: 6px 0 0;
  border: 0;
  border-top: 1px solid rgb(var(--c-fg) / 0.08);
  background: transparent;
  color: rgb(var(--c-fg-muted));
  font-size: 10px;
  line-height: 1.4;
  cursor: pointer;
  transition: color 160ms ease;
}
.trace-link:hover { color: rgb(var(--c-fg)); }
.trace-link:focus-visible { outline: 2px solid rgb(var(--c-accent)); outline-offset: 1px; }
.trace-link-icon { width: 11px; height: 11px; flex: none; }
.trace-link.is-warn { color: rgb(var(--c-warn)); }
.trace-link.is-accent { color: rgb(var(--c-accent)); }
@media (prefers-reduced-motion: reduce) {
  .trace-link { transition: none; }
}
</style>
