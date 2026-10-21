<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";

/**
 * Compact animated thought-bubble trigger (frozen spec §3.1).
 * A small thought outline with three staggered dots; pulses in running/streaming
 * states only, static (still actionable) once finished. The clickable region is
 * >= 44x44 CSS px; reduced-motion turns the pulse off.
 */
export type BubbleStatus =
  | "queued"
  | "running"
  | "streaming"
  | "done"
  | "failed"
  | "cancelled"
  | "indeterminate"
  | "routing";

const props = defineProps<{
  status: BubbleStatus;
  /** Accessible name; localized by the caller so titles stay in one place. */
  label: string;
  /** True when this bubble currently owns the open detail popover. */
  expanded?: boolean;
  /** id of the popover element this trigger controls. */
  controls?: string;
  /** Durable attempt index; > 1 earns a small numeric badge so a retried
   *  member is spottable before any failure is visible. */
  attempt?: number;
}>();

const emit = defineEmits<{ toggle: [element: HTMLElement | null] }>();

const { t } = useI18n();

function onToggle(event: MouseEvent): void {
  emit("toggle", event.currentTarget instanceof HTMLElement ? event.currentTarget : null);
}

const stateTitle = computed(() => {
  switch (props.status) {
    case "queued": return t("bot.run.queued");
    case "running": return t("bot.run.running");
    case "streaming": return t("bot.run.running");
    case "done": return t("group.run.memberCompleted");
    case "failed": return t("bot.run.failed");
    case "cancelled": return t("bot.run.cancelled");
    case "indeterminate": return t("bot.run.indeterminate");
    case "routing": return t("group.bubble.status.routing");
  }
});

const pulsing = computed(() => props.status === "running" || props.status === "streaming");
</script>

<template>
  <button
    type="button"
    data-test="agent-thinking-bubble"
    class="group-bubble-trigger"
    :class="[`is-${status}`, { 'is-pulsing': pulsing, 'is-expanded': expanded }]"
    :aria-label="label"
    aria-haspopup="dialog"
    :aria-expanded="expanded === true"
    :aria-controls="controls"
    :title="`${label} — ${stateTitle}`"
    @click.stop="onToggle"
  >
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" class="group-bubble-icon">
      <!-- thought cloud outline -->
      <path
        d="M7.5 14.5a3.5 3.5 0 0 1-.4-6.98 4.6 4.6 0 0 1 8.9-1.1A3.8 3.8 0 0 1 17 14.2a3.6 3.6 0 0 1-3.2 1.9H9.4a3.4 3.4 0 0 1-1.9-1.6Z"
        fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"
      />
      <!-- three staggered dots -->
      <circle class="group-bubble-dot" cx="7.6" cy="18.6" r="1.15" fill="currentColor" />
      <circle class="group-bubble-dot" cx="10.7" cy="20.6" r="0.95" fill="currentColor" />
      <circle class="group-bubble-dot" cx="13.3" cy="22.1" r="0.75" fill="currentColor" />
    </svg>
    <span v-if="attempt !== undefined && attempt > 1" class="group-bubble-attempt" aria-hidden="true">{{ attempt }}</span>
    <span class="sr-only">{{ stateTitle }}</span>
  </button>
</template>

<style scoped>
.group-bubble-trigger {
  position: relative;
  display: inline-grid;
  place-items: center;
  width: 44px;
  height: 44px;
  margin: 0;
  border-radius: 12px;
  color: rgb(var(--c-fg-muted));
  background: transparent;
  border: none;
  cursor: pointer;
  transition: background-color 120ms ease, color 120ms ease;
}
.group-bubble-trigger:hover { background: rgb(var(--c-fg) / 0.06); color: rgb(var(--c-fg)); }
.group-bubble-trigger:focus-visible { outline: 2px solid rgb(var(--c-accent)); outline-offset: 1px; }
.group-bubble-icon { width: 20px; height: 20px; }
.group-bubble-dot { opacity: 0.9; }
.is-pulsing .group-bubble-dot { animation: bubble-dot 1.4s ease-in-out infinite; }
.is-pulsing .group-bubble-dot:nth-of-type(2) { animation-delay: 0.2s; }
.is-pulsing .group-bubble-dot:nth-of-type(3) { animation-delay: 0.4s; }
@keyframes bubble-dot {
  0%, 100% { opacity: 0.45; }
  50% { opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .is-pulsing .group-bubble-dot { animation: none; }
}
/* Understated state coloration — never color alone (the localized title and
   detail carry the meaning; the outline shape is identical). */
.is-failed { color: rgb(var(--c-danger)); }
.is-cancelled { color: rgb(var(--c-fg-muted)); }
.is-indeterminate { color: rgb(var(--c-warn)); }
.is-done { color: rgb(var(--c-fg-muted)); }
.is-expanded { background: rgb(var(--c-accent) / 0.12); color: rgb(var(--c-accent)); }
/* Retry hint: a small corner digit, not color or animation — an attempt count
   is data, not a state. The 44px hit target stays untouched. */
.group-bubble-attempt {
  position: absolute;
  top: 1px;
  right: 1px;
  min-width: 15px;
  height: 15px;
  border-radius: 8px;
  background: rgb(var(--c-accent) / 0.16);
  color: rgb(var(--c-accent));
  font-size: 9px;
  line-height: 15px;
  font-weight: 600;
  text-align: center;
}
</style>
