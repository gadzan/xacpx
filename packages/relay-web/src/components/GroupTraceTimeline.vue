<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import {
  AlertTriangle,
  CircleCheck,
  Loader2,
  ChevronRight,
  Bot,
} from "lucide-vue-next";
import type { PeerMessageHistoryEntry, TurnPartDto } from "@ganglion/xacpx-relay-protocol";
import StreamMarkdown from "./StreamMarkdown.vue";
import ReasoningPanel from "./ReasoningPanel.vue";
import ToolStepDetail from "./ToolStepDetail.vue";
import SubagentStepCard from "./SubagentStepCard.vue";
import AgentMessageCard from "./AgentMessageCard.vue";
import { KIND_ICON } from "../lib/tool-summary";
import { formatStepDuration } from "../lib/use-live-elapsed";
import { resolveSubagentStatus } from "../lib/subagent-status";
import {
  deriveTurnPresentation,
  tallyTrace,
  type TurnPresentationItem,
  type TurnPresentationPlan,
} from "../lib/turn-presentation";

const props = defineProps<{
  parts: TurnPartDto[];
  streaming?: boolean;
  /** Steps kept visible when the trace is long enough to fold. */
  visibleTail?: number;
  sentAgentMessages?: Map<string, PeerMessageHistoryEntry>;
}>();

const { t } = useI18n();

/** Fold only when hiding actually saves the reader work. */
const FOLD_THRESHOLD = 6;
const tailSize = computed(() => props.visibleTail ?? 3);

const presentation = computed<TurnPresentationPlan>(() => deriveTurnPresentation(props.parts, {
  streaming: props.streaming === true,
  ...(props.sentAgentMessages ? { sentAgentMessageById: props.sentAgentMessages } : {}),
}));

/** Steps are the activities; markdown nodes stay in flow between them. */
const stepCount = computed(() =>
  presentation.value.nodes.filter((node) => node.type === "tool" || node.type === "subagent").length,
);
const foldable = computed(() => stepCount.value > FOLD_THRESHOLD);
const folded = ref(true);

const hiddenStepCount = computed(() =>
  foldable.value ? Math.max(0, stepCount.value - tailSize.value) : 0,
);

/** Index (in the node list) of the first step that stays visible when folded. */
const firstVisibleStepIndex = computed(() => {
  if (!foldable.value || !folded.value) return -1;
  let seen = 0;
  const keepFrom = stepCount.value - tailSize.value;
  for (let i = 0; i < presentation.value.nodes.length; i++) {
    const node = presentation.value.nodes[i]!;
    if (node.type !== "tool" && node.type !== "subagent") continue;
    if (seen === keepFrom) return i;
    seen += 1;
  }
  return -1;
});

interface RenderedNode {
  node: TurnPresentationItem;
  /** Step rows get the marker column; prose spans the full width. */
  isStep: boolean;
  key: string;
}

const nodes = computed<RenderedNode[]>(() => {
  const boundary = firstVisibleStepIndex.value;
  const out: RenderedNode[] = [];
  presentation.value.nodes.forEach((node, index) => {
    // Prose before the fold point folds with the steps it explains.
    if (boundary >= 0 && index < boundary) return;
    out.push({ node, isStep: node.type === "tool" || node.type === "subagent", key: node.key });
  });
  return out;
});

const tally = computed(() => tallyTrace(presentation.value.nodes));

const openKeys = ref<Set<string>>(new Set());
function toggle(key: string): void {
  const next = new Set(openKeys.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  openKeys.value = next;
}

function stepState(node: TurnPresentationItem): "success" | "running" | "error" | "pending" {
  if (node.type === "subagent") return resolveSubagentStatus(node.step, node.children);
  if (node.type === "tool") {
    const status = node.step.status;
    return status === "success" ? "success" : status === "running" ? "running" : "error";
  }
  return "pending";
}


function stepDuration(node: TurnPresentationItem): string | undefined {
  if (node.type !== "tool" && node.type !== "subagent") return undefined;
  const ms = node.step.durationMs;
  return formatStepDuration(ms);
}

function kindLabel(node: TurnPresentationItem): string {
  if (node.type === "subagent") return t("tools.subagent");
  if (node.type === "tool") {
    const name = (node.step.toolName || "").toLowerCase();
    if (node.step.kind === "edit") {
      return name.includes("write") || name.includes("create")
        ? t("tools.kinds.write")
        : t("tools.kinds.edit");
    }
    if (node.step.kind === "delete" || node.step.kind === "move" || node.step.kind === "fetch") return t("tools.kinds.other");
    return t("tools.kinds." + node.step.kind);
  }
  return "";
}
</script>

<template>
  <div data-test="group-trace-timeline" class="min-w-0">
    <button
      v-if="foldable"
      type="button"
      data-test="group-trace-fold"
      class="rounded-sm text-ui font-medium text-accent transition-colors hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      :aria-expanded="!folded"
      @click="folded = !folded"
    >{{ folded
      ? $t("group.detail.showEarlierSteps", { count: hiddenStepCount })
      : $t("group.detail.hideEarlierSteps") }}</button>

    <ol class="mt-1 space-y-0">
      <li
        v-for="(entry, index) in nodes"
        :key="entry.key"
        :data-test="entry.isStep ? 'group-trace-step' : undefined"
        :data-state="entry.isStep ? stepState(entry.node) : undefined"
        class="relative flex gap-3"
        :class="{ 'trace-connected': entry.isStep && nodes[index + 1]?.isStep }"
      >
        <!-- Marker column: the dot belongs to a step, so prose never gets one. -->
        <span
          v-if="entry.isStep"
          data-test="group-trace-step-marker"
          class="relative z-10 mt-1.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-raised"
          :class="{
            'text-run': stepState(entry.node) === 'success',
            'text-accent': stepState(entry.node) === 'running',
            'text-danger': stepState(entry.node) === 'error',
          }"
          aria-hidden="true"
        >
          <Loader2 v-if="stepState(entry.node) === 'running'" :size="15"
                   class="animate-spin motion-reduce:animate-none" />
          <AlertTriangle v-else-if="stepState(entry.node) === 'error'" :size="15" />
          <CircleCheck v-else :size="18" />
        </span>

        <div class="min-w-0 flex-1 pb-3.5">
          <!-- Tool / subagent step -->
          <template v-if="entry.node.type === 'tool'">
            <button
              type="button"
              data-test="group-trace-step-head"
              class="group flex min-h-11 w-full items-start gap-2 rounded-sm text-left"
              :aria-expanded="openKeys.has(entry.key)"
              @click="toggle(entry.key)"
            >
              <span class="min-w-0 flex-1">
                <span class="block break-words [overflow-wrap:anywhere] text-sm font-medium leading-snug text-fg">
                  {{ entry.node.step.title }}
                </span>
                <span class="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-fg-muted">
                  <component :is="KIND_ICON[entry.node.step.kind]" :size="12" class="shrink-0" />
                  <span>{{ kindLabel(entry.node) }}</span>
                  <template v-if="stepDuration(entry.node)">
                    <span aria-hidden="true" class="opacity-50">·</span>
                    <span class="font-mono tabular-nums">{{ stepDuration(entry.node) }}</span>
                  </template>
                </span>
              </span>
              <ChevronRight
                :size="16"
                class="mt-0.5 shrink-0 text-fg-muted transition-transform"
                :class="openKeys.has(entry.key) ? 'rotate-90' : ''"
                aria-hidden="true"
              />
            </button>
            <div v-if="openKeys.has(entry.key)" class="mt-2 rounded-lg bg-surface px-3 py-2 text-xs text-fg-muted">
              <ToolStepDetail :step="entry.node.step" />
            </div>
          </template>

          <template v-else-if="entry.node.type === 'subagent'">
            <button
              type="button"
              data-test="group-trace-step-head"
              class="group flex min-h-11 w-full items-start gap-2 rounded-sm text-left"
              :aria-expanded="openKeys.has(entry.key)"
              @click="toggle(entry.key)"
            >
              <span class="min-w-0 flex-1">
                <span class="block break-words [overflow-wrap:anywhere] text-sm font-medium leading-snug text-fg">
                  {{ entry.node.step.title }}
                </span>
                <span class="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-accent">
                  <Bot :size="12" class="shrink-0" />
                  <span>{{ $t("tools.subagent") }}</span>
                </span>
              </span>
              <ChevronRight
                :size="16"
                class="mt-0.5 shrink-0 text-fg-muted transition-transform"
                :class="openKeys.has(entry.key) ? 'rotate-90' : ''"
                aria-hidden="true"
              />
            </button>
            <div v-if="openKeys.has(entry.key)" class="mt-2">
              <SubagentStepCard :step="entry.node.step" :children="entry.node.children" />
            </div>
          </template>

          <!-- Prose: narrative in flow, no marker column claim. -->
          <StreamMarkdown
            v-else-if="entry.node.type === 'markdown'"
            data-test="group-trace-narrative"
            :rendered-html="entry.node.html"
            :streaming="streaming === true && entry.node.isLatest"
            class="text-sm leading-relaxed text-fg"
          />
          <ReasoningPanel
            v-else-if="entry.node.type === 'reasoning'"
            :reasoning="entry.node.text"
            :streaming="streaming === true && entry.node.isLatest"
            :default-open="false"
          />
          <div v-else-if="entry.node.type === 'agent-message'" data-test="group-trace-agent-message">
            <AgentMessageCard :message="entry.node.message" anchored />
          </div>
        </div>
      </li>
    </ol>

    <!-- What the trace did, in one line: the folded reader still learns the shape
         of the work without opening every step. -->
    <p v-if="tally.byVerb.length || tally.failed > 0" data-test="group-trace-tally"
       class="mt-1 flex flex-wrap items-center gap-x-1.5 text-xs text-fg-muted">
      <template v-for="(entry, index) in tally.byVerb" :key="entry.verb">
        <span v-if="index > 0" aria-hidden="true" class="opacity-50">·</span>
        <span>{{ t(`turnTrace.verbs.${entry.verb}`, entry.count) }}</span>
      </template>
      <span v-if="tally.failed > 0" class="inline-flex items-center rounded-full bg-danger/10 px-1.5 py-0.5 font-medium text-danger">
        {{ t("turnTrace.failedSteps", tally.failed) }}
      </span>
    </p>
  </div>
</template>

<style scoped>
.trace-connected::before {
  content: "";
  position: absolute;
  left: 9px;
  top: 28px;
  bottom: -4px;
  border-left: 1px dashed rgb(var(--c-fg) / 0.22);
}
</style>
