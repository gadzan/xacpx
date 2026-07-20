<script setup lang="ts">
import { computed } from "vue";
import type { ToolStepDto, TurnPartDto } from "@ganglion/xacpx-relay-protocol";
import StreamMarkdown from "./StreamMarkdown.vue";
import ReasoningPanel from "./ReasoningPanel.vue";
import ToolStepCard from "./ToolStepCard.vue";
import SubagentStepCard from "./SubagentStepCard.vue";

// Renders a turn's transcript inline, in arrival order: text, reasoning (collapsed),
// and tool calls interleaved exactly as the agent produced them — no Feishu-style
// bucketing. When `streaming`, the final part shows the live affordance (caret/shimmer).
const props = defineProps<{ parts: TurnPartDto[]; streaming?: boolean }>();

type RenderPart =
  | { key: string; type: "part"; part: TurnPartDto }
  | { key: string; type: "subagent"; step: ToolStepDto; children: ToolStepDto[] };

// ACP emits child tools as ordinary turn parts plus a parentToolCallId. Fold those
// parts under their Agent task for display while preserving the wire/history shape.
// If an old history row has only a child (no parent), it remains visible normally.
const renderParts = computed<RenderPart[]>(() => {
  const parents = new Set(
    props.parts
      .filter((part): part is Extract<TurnPartDto, { type: "tool" }> => part.type === "tool" && part.step.isSubagent === true)
      .map((part) => part.step.toolCallId),
  );
  const children = new Map<string, ToolStepDto[]>();
  for (const part of props.parts) {
    if (part.type !== "tool" || !part.step.parentToolCallId || !parents.has(part.step.parentToolCallId)) continue;
    const list = children.get(part.step.parentToolCallId) ?? [];
    list.push(part.step);
    children.set(part.step.parentToolCallId, list);
  }

  const result: RenderPart[] = [];
  props.parts.forEach((part, index) => {
    if (part.type === "tool" && part.step.parentToolCallId && parents.has(part.step.parentToolCallId)) return;
    if (part.type === "tool" && part.step.isSubagent) {
      result.push({
        key: `subagent:${part.step.toolCallId}`,
        type: "subagent",
        step: part.step,
        children: children.get(part.step.toolCallId) ?? [],
      });
      return;
    }
    const key = part.type === "tool" ? `tool:${part.step.toolCallId}` : `${part.type}:${index}`;
    result.push({ key, type: "part", part });
  });
  return result;
});

const isLast = (i: number): boolean => props.streaming === true && i === renderParts.value.length - 1;
</script>

<template>
  <div class="space-y-2.5">
    <template v-for="(item, i) in renderParts" :key="item.key">
      <SubagentStepCard v-if="item.type === 'subagent'" :step="item.step" :children="item.children" />
      <ReasoningPanel v-else-if="item.part.type === 'reasoning' && item.part.text.trim()" :reasoning="item.part.text" :streaming="isLast(i)" :default-open="false" />
      <ToolStepCard v-else-if="item.part.type === 'tool'" :step="item.part.step" />
      <StreamMarkdown v-else :text="item.part.text" :streaming="isLast(i)"
                      class="text-[14px] leading-relaxed text-fg" :class="isLast(i) ? 'caret' : ''" />
    </template>
  </div>
</template>
