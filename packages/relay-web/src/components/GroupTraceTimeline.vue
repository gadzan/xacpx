<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import {
  AlertTriangle,
  CircleCheck,
  Loader2,
  ChevronRight,
  Bot,
} from "lucide-vue-next";
import StreamMarkdown from "./StreamMarkdown.vue";
import ReasoningPanel from "./ReasoningPanel.vue";
import ToolStepDetail from "./ToolStepDetail.vue";
import SubagentStepCard from "./SubagentStepCard.vue";
import AgentMessageCard from "./AgentMessageCard.vue";
import { KIND_ICON } from "../lib/tool-summary";
import { formatStepDuration } from "../lib/use-live-elapsed";
import { resolveSubagentStatus } from "../lib/subagent-status";
import { tallyTrace, type TurnPresentationItem } from "../lib/turn-presentation";

/**
 * The full, chronological process. Every presentation node is rendered — there
 * is no fold window, because a moving window unloads the row the reader just
 * opened. Expansion is controlled by the drawer layer (`expandedKeys` +
 * `toggle`), so appending events, re-rendering and the drawer's own scroll
 * handling never reset it.
 *
 * Rows opt into `content-visibility: auto` (skipped layout/paint offscreen)
 * unless the reader expanded them, they are in the live stack, or they failed.
 * Windowing is absent: stable scroll height and find-in-page are worth more than
 * unmounting rows.
 */
const props = defineProps<{
  nodes: TurnPresentationItem[];
  streaming?: boolean;
  expandedKeys: ReadonlySet<string>;
  /** Keys currently presented by the fixed Live Stack. */
  liveKeys?: ReadonlySet<string>;
  /** Key highlighted after a Live Stack row was clicked. */
  highlightKey?: string | null;
}>();

const emit = defineEmits<{ toggle: [key: string] }>();

const { t } = useI18n();

interface RenderedNode {
  node: TurnPresentationItem;
  /** Step rows get the marker column; prose spans the full width. */
  isStep: boolean;
  key: string;
}

const rendered = computed<RenderedNode[]>(() =>
  props.nodes.map((node) => ({
    node,
    isStep: node.type === "tool" || node.type === "subagent",
    key: node.key,
  })),
);

const tally = computed(() => tallyTrace(props.nodes));

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
  return formatStepDuration(node.step.durationMs);
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

function alwaysRendered(entry: RenderedNode): boolean {
  return props.expandedKeys.has(entry.key)
    || props.liveKeys?.has(entry.key) === true
    || stepState(entry.node) === "error";
}
</script>

<template>
  <div data-test="group-trace-timeline" class="min-w-0">
    <ol class="mt-1 space-y-0">
      <li
        v-for="(entry, index) in rendered"
        :key="entry.key"
        :data-test="entry.isStep ? 'group-trace-step' : undefined"
        :data-state="entry.isStep ? stepState(entry.node) : undefined"
        :data-trace-key="entry.key"
        :data-highlight="highlightKey === entry.key ? 'true' : undefined"
        class="trace-row relative flex gap-3"
        :class="{
          'trace-connected': entry.isStep && rendered[index + 1]?.isStep,
          'trace-row--always': alwaysRendered(entry),
          'trace-row--flash': highlightKey === entry.key,
        }"
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
              :aria-expanded="expandedKeys.has(entry.key)"
              @click="emit('toggle', entry.key)"
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
                :class="expandedKeys.has(entry.key) ? 'rotate-90' : ''"
                aria-hidden="true"
              />
            </button>
            <div v-if="expandedKeys.has(entry.key)" class="mt-2 rounded-lg bg-surface px-3 py-2 text-xs text-fg-muted">
              <ToolStepDetail :step="entry.node.step" />
            </div>
          </template>

          <template v-else-if="entry.node.type === 'subagent'">
            <button
              type="button"
              data-test="group-trace-step-head"
              class="group flex min-h-11 w-full items-start gap-2 rounded-sm text-left"
              :aria-expanded="expandedKeys.has(entry.key)"
              @click="emit('toggle', entry.key)"
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
                :class="expandedKeys.has(entry.key) ? 'rotate-90' : ''"
                aria-hidden="true"
              />
            </button>
            <div v-if="expandedKeys.has(entry.key)" class="mt-2">
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
            :expanded="expandedKeys.has(entry.key)"
            @toggle="emit('toggle', entry.key)"
          />
          <div v-else-if="entry.node.type === 'agent-message'" data-test="group-trace-agent-message">
            <AgentMessageCard :message="entry.node.message" anchored />
          </div>
        </div>
      </li>
    </ol>

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

/* Skip layout and paint for rows far outside the viewport. The DOM stays, so
 * scroll height and find-in-page keep working; the intrinsic size keeps the
 * scrollbar stable before a row has ever been measured. */
.trace-row {
  content-visibility: auto;
  contain-intrinsic-size: auto 72px;
}
.trace-row--always {
  content-visibility: visible;
}

.trace-row--flash {
  animation: trace-row-flash 1.2s ease-out;
}
@keyframes trace-row-flash {
  from { background-color: rgb(var(--c-accent) / 0.18); }
  to { background-color: transparent; }
}
@media (prefers-reduced-motion: reduce) {
  .trace-row--flash {
    animation: none;
    outline: 2px solid rgb(var(--c-accent) / 0.55);
  }
}
</style>
