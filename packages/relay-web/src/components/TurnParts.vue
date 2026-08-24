<script setup lang="ts">
import { computed } from "vue";
import type { PeerMessageHistoryEntry, TurnPartDto } from "@ganglion/xacpx-relay-protocol";
import StreamMarkdown from "./StreamMarkdown.vue";
import ReasoningPanel from "./ReasoningPanel.vue";
import ToolStepCard from "./ToolStepCard.vue";
import SubagentStepCard from "./SubagentStepCard.vue";
import AgentMessageCard from "./AgentMessageCard.vue";
import { deriveTurnPresentation } from "../lib/turn-presentation";

// Wire parts preserve arrival order, but transport events are not necessarily safe
// Markdown boundaries. The presentation module anchors activity after the top-level
// Markdown block that was in progress when the activity arrived.
const props = defineProps<{
  parts: TurnPartDto[];
  streaming?: boolean;
  ensureFull?: () => Promise<void>;
  sentAgentMessages?: Map<string, PeerMessageHistoryEntry>;
}>();
const presentation = computed(() =>
  deriveTurnPresentation(
    props.parts,
    props.sentAgentMessages ? { sentAgentMessageById: props.sentAgentMessages } : undefined,
  ),
);
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
      <!-- Sent peer-message card joined to the agent_send step right above it;
           left-aligned flush with the tool steps (no chat-bubble right shift). -->
      <div v-else-if="item.type === 'agent-message'" data-test="turn-agent-message">
        <AgentMessageCard :message="item.message" anchored />
      </div>
      <SubagentStepCard v-else :step="item.step" :children="item.children" :ensure-full="ensureFull" />
    </template>
  </div>
</template>
