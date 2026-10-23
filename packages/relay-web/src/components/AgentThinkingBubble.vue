<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";

/**
 * Compact status entry for one member turn (frozen spec §3.1).
 *
 * The entry reads as "icon + short status", so a reader can tell who is
 * working and what state they are in without opening anything. The thought
 * outline pulses in running/streaming states only and stays actionable once
 * finished. The clickable region is >= 44x44 CSS px; reduced-motion turns the
 * pulse off.
 */
export type BubbleStatus =
  | "queued"
  | "running"
  | "streaming"
  | "done"
  | "failed"
  | "cancelled"
  | "indeterminate"
  | "waiting"
  | "routing";

const props = defineProps<{
  status: BubbleStatus;
  /** Accessible name; localized by the caller so titles stay in one place. */
  label: string;
  /** True when this entry currently owns the open detail popover. */
  expanded?: boolean;
  /** id of the popover element this trigger controls. */
  controls?: string;
  /** Durable attempt index; > 1 earns a small numeric badge so a retried
   *  member is spottable before any failure is visible. */
  attempt?: number;
}>();

const emit = defineEmits<{
  toggle: [element: HTMLElement | null];
}>();

const { t } = useI18n();

function onToggle(event: MouseEvent): void {
  emit("toggle", event.currentTarget instanceof HTMLElement ? event.currentTarget : null);
}

const stateTitle = computed(() => {
  switch (props.status) {
    case "queued": return t("group.bubble.status.queued");
    case "running": return t("group.bubble.status.running");
    case "streaming": return t("group.bubble.status.running");
    case "done": return t("group.bubble.status.done");
    case "failed": return t("group.bubble.status.failed");
    case "cancelled": return t("group.bubble.status.cancelled");
    case "indeterminate": return t("group.bubble.status.indeterminate");
    case "waiting": return t("group.bubble.status.waiting");
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
    :aria-label="`${label} — ${stateTitle}`"
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
    <span class="group-bubble-status" aria-hidden="true">{{ stateTitle }}</span>
    <span v-if="attempt !== undefined && attempt > 1" class="group-bubble-attempt" aria-hidden="true">{{ attempt }}</span>
  </button>
</template>

<style scoped>
.group-bubble-trigger {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-width: 44px;
  min-height: 44px;
  max-width: 100%;
  margin: 0;
  padding: 0 10px;
  color: rgb(var(--c-fg-muted));
  background: transparent;
  border: none;
  border-radius: 12px;
  cursor: pointer;
  transition: color 160ms ease, background-color 160ms ease;
}
/* The painted surface is the entry itself, so the visible chip and the hit
   target never disagree about what is clickable. */
.group-bubble-trigger:hover { color: rgb(var(--c-fg)); background: rgb(var(--c-fg) / 0.05); }
.group-bubble-trigger:active { transform: scale(0.98); }
.group-bubble-trigger:focus-visible { outline: 2px solid rgb(var(--c-accent)); outline-offset: 1px; }
.group-bubble-icon { width: 18px; height: 18px; flex: none; }
.group-bubble-status {
  display: block;
  min-width: 0;
  max-width: 11rem;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 12px;
  line-height: 1.35;
  font-weight: 500;
}
.group-bubble-dot { opacity: 0.9; }
.is-pulsing .group-bubble-dot { animation: bubble-dot 1.4s ease-in-out infinite; }
.is-pulsing .group-bubble-dot:nth-of-type(2) { animation-delay: 0.2s; }
.is-pulsing .group-bubble-dot:nth-of-type(3) { animation-delay: 0.4s; }
@keyframes bubble-dot {
  0%, 100% { opacity: 0.45; }
  50% { opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .group-bubble-trigger { transition: none; }
  .is-pulsing .group-bubble-dot { animation: none; }
}
/* Understated state coloration — never color alone (the visible status word
   carries the meaning; the outline shape is identical). */
.is-running, .is-queued, .is-routing { color: rgb(var(--c-accent)); }
.is-waiting { color: rgb(var(--c-warn)); }
.is-failed { color: rgb(var(--c-danger)); }
.is-cancelled { color: rgb(var(--c-fg-muted)); }
.is-indeterminate { color: rgb(var(--c-warn)); }
.is-done { color: rgb(var(--c-fg-muted)); }
/* Open state echoes hover: a slightly stronger chip, no full-width paint. */
.is-expanded { color: rgb(var(--c-accent)); background: rgb(var(--c-accent) / 0.1); }
/* Retry hint: a small digit, not color or animation — an attempt count is
   data, not a state. It rides next to the status so it can never be read as
   belonging to the neighbouring reply. */
.group-bubble-attempt {
  display: inline-grid;
  place-items: center;
  min-width: 16px;
  height: 16px;
  padding-inline: 4px;
  border-radius: 8px;
  background: rgb(var(--c-accent) / 0.16);
  color: rgb(var(--c-accent));
  font-size: 9px;
  line-height: 1;
  font-weight: 600;
}
</style>
