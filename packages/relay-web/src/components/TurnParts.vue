<script setup lang="ts">
import { computed } from "vue";
import type { ToolStepDto, TurnPartDto } from "@ganglion/xacpx-relay-protocol";
import StreamMarkdown from "./StreamMarkdown.vue";
import ReasoningPanel from "./ReasoningPanel.vue";
import ToolStepCard from "./ToolStepCard.vue";
import SubagentStepCard from "./SubagentStepCard.vue";
import { hasToolStepAncestor, indexToolSteps } from "../lib/subagent-trace";

// Preserve the wire transcript in `parts`, but present it as two visual lanes:
// activity (reasoning/tools) followed by one continuous Markdown narrative. Tool
// events must not split lists, code fences, or prose into separate Markdown roots.
const props = defineProps<{ parts: TurnPartDto[]; streaming?: boolean }>();

type ActivityPart = Exclude<TurnPartDto, { type: "text" }>;
type RenderPart =
  | { key: string; type: "part"; part: ActivityPart }
  | { key: string; type: "subagent"; step: ToolStepDto; children: ToolStepDto[] };

// ACP emits child tools as ordinary turn parts plus a parentToolCallId. Fold those
// parts under their Agent task for display while preserving the wire/history shape.
// If an old history row has only a child (no parent), it remains visible normally.
const renderActivities = computed<RenderPart[]>(() => {
  const parents = new Set(
    props.parts
      .filter((part): part is Extract<TurnPartDto, { type: "tool" }> => part.type === "tool" && part.step.isSubagent === true)
      .map((part) => part.step.toolCallId),
  );
  const toolParts = props.parts.filter(
    (part): part is Extract<TurnPartDto, { type: "tool" }> => part.type === "tool",
  );
  const stepsById = indexToolSteps(toolParts.map((part) => part.step));

  const descendantsOf = (parentToolCallId: string): ToolStepDto[] => toolParts
    .map((part) => part.step)
    .filter((step) => hasToolStepAncestor(step, stepsById, (ancestorId) => ancestorId === parentToolCallId));

  const result: RenderPart[] = [];
  props.parts.forEach((part, index) => {
    if (part.type === "text") return;
    if (part.type === "reasoning" && !part.text.trim()) return;
    if (part.type === "tool" && hasToolStepAncestor(part.step, stepsById, (ancestorId) => parents.has(ancestorId))) return;
    if (part.type === "tool" && part.step.isSubagent) {
      result.push({
        key: `subagent:${part.step.toolCallId}`,
        type: "subagent",
        step: part.step,
        children: descendantsOf(part.step.toolCallId),
      });
      return;
    }
    const key = part.type === "tool" ? `tool:${part.step.toolCallId}` : `reasoning:${index}`;
    result.push({ key, type: "part", part });
  });
  return result;
});

const narrative = computed(() =>
  props.parts
    .filter((part): part is Extract<TurnPartDto, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join(""),
);

const latestVisiblePart = computed(() => {
  for (let i = props.parts.length - 1; i >= 0; i -= 1) {
    const part = props.parts[i];
    if (part.type === "tool" || part.text.trim()) return part;
  }
  return undefined;
});
const narrativeStreaming = computed(() =>
  props.streaming === true && latestVisiblePart.value?.type === "text",
);
const isLastActivity = (i: number): boolean =>
  props.streaming === true
  && latestVisiblePart.value?.type === "reasoning"
  && i === renderActivities.value.length - 1;
</script>

<template>
  <div class="space-y-2.5">
    <div v-if="renderActivities.length" data-test="turn-activity" class="space-y-2.5">
      <template v-for="(item, i) in renderActivities" :key="item.key">
        <SubagentStepCard v-if="item.type === 'subagent'" :step="item.step" :children="item.children" />
        <ReasoningPanel v-else-if="item.part.type === 'reasoning'" :reasoning="item.part.text" :streaming="isLastActivity(i)" :default-open="false" />
        <ToolStepCard v-else-if="item.part.type === 'tool'" :step="item.part.step" />
      </template>
    </div>
    <StreamMarkdown v-if="narrative" :text="narrative" :streaming="narrativeStreaming"
                    class="text-[14px] leading-relaxed text-fg" :class="narrativeStreaming ? 'caret' : ''" />
  </div>
</template>
