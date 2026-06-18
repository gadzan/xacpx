<script setup lang="ts">
import type { TurnPartDto } from "@ganglion/xacpx-relay-protocol";
import StreamMarkdown from "./StreamMarkdown.vue";
import ReasoningPanel from "./ReasoningPanel.vue";
import ToolStepCard from "./ToolStepCard.vue";

// Renders a turn's transcript inline, in arrival order: text, reasoning (collapsed),
// and tool calls interleaved exactly as the agent produced them — no Feishu-style
// bucketing. When `streaming`, the final part shows the live affordance (caret/shimmer).
const props = defineProps<{ parts: TurnPartDto[]; streaming?: boolean }>();

const isLast = (i: number): boolean => props.streaming === true && i === props.parts.length - 1;
</script>

<template>
  <div class="space-y-2.5">
    <template v-for="(p, i) in parts" :key="i">
      <ReasoningPanel v-if="p.type === 'reasoning'" :reasoning="p.text" :streaming="isLast(i)" :default-open="false" />
      <ToolStepCard v-else-if="p.type === 'tool'" :step="p.step" />
      <StreamMarkdown v-else :text="p.text" :streaming="isLast(i)"
                      class="text-[14px] leading-relaxed text-fg" :class="isLast(i) ? 'caret' : ''" />
    </template>
  </div>
</template>
