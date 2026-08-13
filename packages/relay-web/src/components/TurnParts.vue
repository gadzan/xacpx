<script setup lang="ts">
import { computed } from "vue";
import type { TurnPartDto } from "@ganglion/xacpx-relay-protocol";
import StreamMarkdown from "./StreamMarkdown.vue";
import ReasoningPanel from "./ReasoningPanel.vue";
import ToolStepCard from "./ToolStepCard.vue";
import SubagentStepCard from "./SubagentStepCard.vue";
import { deriveTurnPresentation } from "../lib/turn-presentation";

// Wire parts preserve arrival order, but transport events are not necessarily safe
// Markdown boundaries. The presentation module anchors activity after the top-level
// Markdown block that was in progress when the activity arrived.
const props = defineProps<{ parts: TurnPartDto[]; streaming?: boolean; ensureFull?: () => Promise<void> }>();
const presentation = computed(() => deriveTurnPresentation(props.parts));
</script>

<template>
  <div class="space-y-2.5">
    <template v-for="item in presentation" :key="item.key">
      <StreamMarkdown v-if="item.type === 'text'" data-test="turn-narrative"
                      :text="item.text" :streaming="streaming === true && item.isLatest"
                      class="text-[14px] leading-relaxed text-fg"
                      :class="streaming === true && item.isLatest ? 'caret' : ''" />
      <ReasoningPanel v-else-if="item.type === 'reasoning'"
                      :reasoning="item.text"
                      :streaming="streaming === true && item.isLatest"
                      :default-open="false" />
      <ToolStepCard v-else-if="item.type === 'tool'" :step="item.step" :ensure-full="ensureFull" />
      <SubagentStepCard v-else :step="item.step" :children="item.children" :ensure-full="ensureFull" />
    </template>
  </div>
</template>
