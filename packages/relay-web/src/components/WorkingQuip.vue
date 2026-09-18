<script setup lang="ts">
defineProps<{ status: string; elapsed: string }>();
</script>

<template>
  <!-- Speech-bubble "assistant is working" chip riding the sticky agent-icon: a rounded
       rectangle (not a pill) with a lightly-frosted surface + hairline border. The status
       text reuses the reasoning shimmer sweep so it reads as "thinking" (no dot). -->
  <div class="relative inline-flex max-w-[15rem] items-center gap-1.5 rounded-[10px] rounded-bl-[2px] border border-border/70 bg-surface/55 py-[2px] pl-2 pr-2.5 text-[11px] font-medium text-fg shadow-[0_1px_2px_rgba(0,0,0,0.04)] backdrop-blur-md">
    <span data-test="hud-quip" class="shimmer-text min-w-0 truncate">{{ status }}</span>
    <span v-if="elapsed" data-test="hud-elapsed" class="shrink-0 font-mono text-[10.5px] tabular-nums text-fg/40">{{ elapsed }}</span>
  </div>
</template>
