<script setup lang="ts">
import CopyButton from "./CopyButton.vue";

// Full step title as selectable, copyable drawer text. Lives at the expanded
// container layer (ToolStepCard / ToolCallPanel / SubagentTraceDialog), never
// inside ToolDetail: the header preview stays single-line truncated, and touch
// users have no hover tooltip — this row is their only full-title surface.
defineProps<{ text: string }>();
</script>

<template>
  <div class="flex min-w-0 items-start gap-2" data-test="detail-headline">
    <p class="min-w-0 flex-1 font-mono text-[11px] text-fg break-all whitespace-pre-wrap select-text">{{ text }}</p>
    <CopyButton :text="text" />
  </div>
</template>
