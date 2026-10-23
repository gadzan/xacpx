<script setup lang="ts">
import { Loader2, Square } from "lucide-vue-next";

defineProps<{
  state: "running" | "queued" | "waiting";
  label: string;
  elapsed?: string;
  /** Sweep the label like the reasoning text. Only the transcript quip uses it; a run
   *  state label stays plainly legible because it names a lifecycle phase. */
  shimmer?: boolean;
  stopAvailable?: boolean;
  stopPending?: boolean;
  stopLabel?: string;
}>();

defineEmits<{ stop: [] }>();

const DOT_CLASS: Record<"running" | "queued" | "waiting", string> = {
  running: "pulse-dot bg-run-bright",
  queued: "bg-fg-muted/60",
  waiting: "bg-warn",
};
</script>

<template>
  <div
    data-test="run-status"
    class="inline-flex max-w-full items-center gap-2 rounded-full border border-border/70 bg-surface/70 py-1 pl-3 pr-1.5 text-xs font-medium text-fg shadow-[0_1px_2px_rgba(0,0,0,0.04)] backdrop-blur-md"
    :data-status-state="state"
  >
    <span data-test="hud-dot" aria-hidden="true" class="h-2 w-2 shrink-0 rounded-full" :class="DOT_CLASS[state]" />
    <slot name="label">
      <span data-test="hud-quip" class="min-w-0 truncate" :class="{ 'shimmer-text': shimmer }">{{ label }}</span>
    </slot>
    <span v-if="elapsed" data-test="hud-elapsed"
          class="shrink-0 font-mono text-xs tabular-nums text-fg-muted">{{ elapsed }}</span>
    <span v-if="stopAvailable || $slots.stop" class="h-3.5 w-px shrink-0 bg-border" aria-hidden="true" />
    <slot name="stop" :pending="stopPending" :available="stopAvailable">
      <button
        v-if="stopAvailable"
        type="button"
        data-test="run-stop-button"
        :disabled="stopPending"
        :aria-busy="stopPending || undefined"
        class="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-[11px] font-medium text-fg transition-colors hover:bg-danger/10 hover:text-danger disabled:cursor-wait disabled:opacity-60"
        @click.stop="$emit('stop')"
      >
        <Loader2 v-if="stopPending" :size="11" class="animate-spin" />
        <Square v-else :size="11" fill="currentColor" />
        <span>{{ stopLabel || $t("bot.prompt.stop") }}</span>
      </button>
    </slot>
  </div>
</template>

