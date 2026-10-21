<script setup lang="ts">
// One status chip for every "a run is in flight" surface: the live transcript row's
// floating bubble (liveTurn) and the Bot pane's run HUD (activeRun). The dot carries the
// liveness, so no caller needs a second spinner in the body, and the states differ by dot
// behaviour rather than by colour alone:
//   running → breathing run dot (the agent is doing work)
//   queued  → static muted dot (waiting its turn; nothing for the user to do)
//   waiting → static warn dot (blocked on the user; stillness IS the signal)
// Elapsed is set off by a hairline and uses fg-muted (5.4:1), not a washed-out tint.
defineProps<{
  state: "running" | "queued" | "waiting";
  label: string;
  elapsed?: string;
  /** Sweep the label like the reasoning text. Only the transcript quip uses it; a run
   *  state label stays plainly legible because it names a lifecycle phase. */
  shimmer?: boolean;
}>();

const DOT_CLASS: Record<"running" | "queued" | "waiting", string> = {
  running: "pulse-dot bg-run-bright",
  queued: "bg-fg-muted/60",
  waiting: "bg-warn",
};
</script>

<template>
  <div
    data-test="run-status"
    class="inline-flex max-w-[17rem] items-center gap-1.5 rounded-[10px] rounded-bl-[2px] border border-border/70 bg-surface/70 py-[2px] pl-2 pr-2.5 text-xs font-medium text-fg shadow-[0_1px_2px_rgba(0,0,0,0.04)] backdrop-blur-md"
    :data-status-state="state"
  >
    <span data-test="hud-dot" aria-hidden="true" class="h-1.5 w-1.5 shrink-0 rounded-full" :class="DOT_CLASS[state]" />
    <span data-test="hud-quip" class="min-w-0 truncate" :class="{ 'shimmer-text': shimmer }">{{ label }}</span>
    <span v-if="elapsed" data-test="hud-elapsed"
          class="shrink-0 border-l border-border pl-1.5 font-mono text-xs tabular-nums text-fg-muted">{{ elapsed }}</span>
  </div>
</template>
