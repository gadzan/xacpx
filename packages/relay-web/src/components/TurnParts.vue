<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { ChevronDown, ChevronRight } from "lucide-vue-next";
import type { PeerMessageHistoryEntry, TurnPartDto } from "@ganglion/xacpx-relay-protocol";
import StreamMarkdown from "./StreamMarkdown.vue";
import ReasoningPanel from "./ReasoningPanel.vue";
import ToolStepCard from "./ToolStepCard.vue";
import SubagentStepCard from "./SubagentStepCard.vue";
import AgentMessageCard from "./AgentMessageCard.vue";
import { deriveTurnPresentation } from "../lib/turn-presentation";
import { expandedTraces } from "../lib/trace-expansion";

// Wire parts preserve arrival order, but transport events are not necessarily safe
// Markdown boundaries. The presentation module anchors activity after the top-level
// Markdown block that was in progress when the activity arrived.
const props = defineProps<{
  parts: TurnPartDto[];
  streaming?: boolean;
  ensureFull?: () => Promise<void>;
  sentAgentMessages?: Map<string, PeerMessageHistoryEntry>;
  /** Turn has finished and may collapse its trace — policy (done vs failed) and
   *  trace availability live with the caller (MessageList rows). */
  collapseTrace?: boolean;
  /** Stable identity for the expand-toggle memory — `«instance»:«session»:t:«startedAt»`
   *  built by MessageList (hub-stamped startedAt is identical on optimistic and
   *  persisted rows, so the key survives hub history convergence); legacy rows fall
   *  back to `…:id:«n»`. Absent = toggle not remembered. */
  traceKey?: string;
  /** Display-only turn duration (finished rows). Absent/non-positive → counts only. */
  traceElapsedMs?: number | null;
}>();

const { t, locale } = useI18n();

const presentation = computed(() =>
  deriveTurnPresentation(
    props.parts,
    props.sentAgentMessages ? { sentAgentMessageById: props.sentAgentMessages } : undefined,
  ),
);

// Trace = activity cards that fold away on turn end; text and agent-message cards
// are the reply itself and never collapse.
const hasTrace = computed(() =>
  presentation.value.some((item) => item.type !== "text" && item.type !== "agent-message"),
);
const collapsible = computed(() => props.collapseTrace === true && hasTrace.value);
// Keyed rows remember toggles in the module set (survives hub history convergence,
// which replaces the message row and rebuilds this component); anonymous rows fall
// back to component-local state — lost on rebuild, but they have no stable identity.
const localExpanded = ref(false);
const expanded = computed(() => {
  if (!collapsible.value) return false;
  return props.traceKey ? expandedTraces.has(props.traceKey) : localExpanded.value;
});
// When collapsed, only reply-shaped items render; the header summarizes the hidden rest.
const visibleItems = computed(() =>
  expanded.value || !collapsible.value
    ? presentation.value
    : presentation.value.filter((item) => item.type === "text" || item.type === "agent-message"),
);
const toolCount = computed(() =>
  presentation.value.filter((item) => item.type === "tool" || item.type === "subagent").length,
);
const thoughtCount = computed(() => presentation.value.filter((item) => item.type === "reasoning").length);

function formatElapsed(ms: number): string {
  if (ms < 1000) return locale.value.startsWith("zh") ? "<1秒" : "<1s";
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return locale.value.startsWith("zh") ? (m > 0 ? `${m}分${s}秒` : `${s}秒`) : m > 0 ? `${m}m ${s}s` : `${s}s`;
}
const elapsedText = computed(() => {
  const ms = props.traceElapsedMs;
  return typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? formatElapsed(ms) : "";
});
// One " · "-separated label (zcode-style) so segments never wrap apart; vue-i18n
// plural picks "1 tool step" vs "2 tool steps".
const headerLabel = computed(() => {
  const parts: string[] = [];
  if (elapsedText.value) parts.push(`${t("turnTrace.worked")} ${elapsedText.value}`);
  if (toolCount.value > 0) parts.push(t("turnTrace.tools", toolCount.value));
  if (thoughtCount.value > 0) parts.push(t("turnTrace.thoughts", thoughtCount.value));
  return parts.join(" · ");
});

function toggleTrace(): void {
  if (props.traceKey) {
    if (expandedTraces.has(props.traceKey)) expandedTraces.delete(props.traceKey);
    else expandedTraces.add(props.traceKey);
  } else {
    localExpanded.value = !localExpanded.value;
  }
}
</script>

<template>
  <div class="space-y-1.5">
    <!-- Collapsed-trace header (finished turns): one muted row summarizing the hidden
         activity; expanding re-renders the trace items inline below it. -->
    <button v-if="collapsible" type="button" data-test="trace-toggle"
            class="flex w-full flex-wrap items-center gap-x-1.5 gap-y-0.5 py-0.5 text-left text-[11.5px] text-fg-muted transition-colors hover:text-fg"
            :aria-expanded="expanded" :aria-label="$t('turnTrace.toggleTrace')"
            :data-trace-key="traceKey ?? ''" @click="toggleTrace">
      <ChevronDown v-if="expanded" :size="12" class="shrink-0" />
      <ChevronRight v-else :size="12" class="shrink-0" />
      <span data-test="trace-label">{{ headerLabel }}</span>
    </button>
    <template v-for="item in visibleItems" :key="item.key">
      <StreamMarkdown v-if="item.type === 'text'" data-test="turn-narrative"
                      :text="item.text" :streaming="streaming === true && item.isLatest"
                      class="text-[14px] leading-relaxed text-fg my-1"
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
