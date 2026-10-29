<script setup lang="ts">
// The "thinking" bubble: a plain gray pill with three pulsing dots — the only
// liveness signal while an agent turn has produced nothing visible yet, in the
// session transcript and the Direct Bot transcript alike. It carries no label,
// elapsed clock, or stop action: streamed content replaces it, and Stop lives
// in the composer.
</script>

<template>
  <div
    role="status"
    :aria-label="$t('bot.chat.working')"
    class="inline-flex items-center gap-1.5 rounded-2xl rounded-bl-[4px] bg-surface px-4 py-3"
  >
    <span class="dot" /><span class="dot" /><span class="dot" />
  </div>
</template>

<style scoped>
.dot {
  width: 6px;
  height: 6px;
  border-radius: 9999px;
  background: rgb(var(--c-fg-muted) / 0.55);
  animation: dot-wave 1.3s ease-in-out infinite;
  will-change: transform, opacity;
}
.dot:nth-child(2) { animation-delay: 0.16s; }
.dot:nth-child(3) { animation-delay: 0.32s; }
/* Wave: each dot lifts in turn, so the three read as a travelling ripple while the
   opacity pulse keeps the bubble legible when motion is ambient. */
@keyframes dot-wave {
  0%, 55%, 100% { transform: translateY(0); opacity: 0.45; }
  25% { transform: translateY(-3.5px); opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .dot { animation: none; opacity: 0.6; transform: none; }
}
</style>
