<script setup lang="ts">
import { computed, ref } from "vue";
import type { ToolStepDto } from "@ganglion/xacpx-relay-protocol";
import { AlertTriangle, Check, ChevronDown, ChevronRight, Loader2, Wrench } from "lucide-vue-next";
import ToolDetail from "./ToolDetail.vue";
import FueDot from "./FueDot.vue";
import FueCallout from "./FueCallout.vue";
import { useFue } from "../lib/use-fue";
import type { Rect } from "../lib/fue-placement";
import { AUTO_COLLAPSE_THRESHOLD, KIND_ICON, summarizeSteps } from "../lib/tool-summary";

const props = defineProps<{ steps: ToolStepDto[] }>();

// Long tool runs collapse by default so they don't bury the reply; short ones stay open.
const open = ref(props.steps.length <= AUTO_COLLAPSE_THRESHOLD);
const expanded = ref<Set<string>>(new Set());
function toggleRow(id: string) {
  if (expanded.value.has(id)) expanded.value.delete(id); else expanded.value.add(id);
  expanded.value = new Set(expanded.value);
}

const summary = computed(() => summarizeSteps(props.steps));

// First-User-Experience: the first time a user meets an auto-collapsed panel, nudge
// them that it expands. The dot replaces the count badge until acknowledged.
const fue = useFue("tool-group-collapse");
const collapsible = computed(() => props.steps.length > AUTO_COLLAPSE_THRESHOLD);
const showFueDot = computed(() => collapsible.value && fue.status.value !== "acknowledged");
const header = ref<HTMLElement | null>(null);
const anchor = ref<Rect | null>(null);

function onHeaderClick() {
  open.value = !open.value;
  if (showFueDot.value) {
    const r = header.value?.getBoundingClientRect();
    if (r) anchor.value = { top: r.top, left: r.left, width: r.width, height: r.height };
    fue.engage();
  }
}

function fmtDuration(ms?: number): string {
  if (ms === undefined) return "";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}
</script>

<template>
  <div class="mt-1 rounded-lg border border-border bg-surface text-xs">
    <button ref="header" type="button" class="flex w-full items-center gap-1 px-2 py-1 text-left text-fg-muted" @click="onHeaderClick">
      <ChevronDown v-if="open" :size="14" />
      <ChevronRight v-else :size="14" />
      <span class="inline-flex items-center gap-1"><Wrench :size="14" /> Tool calls</span>
      <FueDot v-if="showFueDot" :pulsing="fue.status.value === 'unseen'" />
      <span v-else data-test="tool-count" class="text-fg-muted">({{ steps.length }})</span>
      <span data-test="tool-summary" class="ml-1 flex items-center gap-1.5 text-fg-muted">
        <span v-for="k in summary.kinds" :key="'k' + k.label" :data-test="'sum-' + k.label"
              class="inline-flex items-center gap-0.5">
          <component :is="k.icon" :size="12" /><span class="tabular-nums">{{ k.count }}</span>
        </span>
        <span v-if="summary.statuses.length" class="text-fg-muted">·</span>
        <span v-for="st in summary.statuses" :key="'s' + st.label" :data-test="'sum-' + st.label"
              class="inline-flex items-center gap-0.5"
              :class="st.label === 'success' ? 'text-run' : st.label === 'error' ? 'text-danger' : 'text-fg-muted'">
          <component :is="st.icon" :size="12"
                     :class="st.label === 'running' ? 'animate-spin motion-reduce:animate-none' : ''" /><span class="tabular-nums">{{ st.count }}</span>
        </span>
      </span>
    </button>
    <FueCallout
      v-if="fue.status.value === 'engaging'"
      :title="'Tool steps collapsed'"
      :body="'Multi-step tool runs are collapsed by default to keep replies readable. Click the header to expand and inspect each step.'"
      :anchor="anchor"
      @dismiss="fue.dismiss()"
    />
    <ul v-if="open" class="divide-y divide-border">
      <li v-for="s in steps" :key="s.toolCallId">
        <button type="button" data-test="tool-row" class="flex w-full items-center gap-2 px-2 py-1 text-left hover:bg-fg/5" @click="toggleRow(s.toolCallId)">
          <Check v-if="s.status === 'success'" data-test="step-status-success" :size="14" class="text-run" />
          <Loader2 v-else-if="s.status === 'running'" data-test="step-status-running" :size="14" class="animate-spin motion-reduce:animate-none text-accent" />
          <AlertTriangle v-else data-test="step-status-error" :size="14" class="text-danger" />
          <span>{{ KIND_ICON[s.kind] }}</span>
          <span class="truncate font-mono text-fg">{{ s.title }}</span>
          <span v-if="s.durationMs !== undefined" class="ml-auto font-mono text-fg-muted">{{ fmtDuration(s.durationMs) }}</span>
        </button>
        <div v-if="expanded.has(s.toolCallId) && s.detail" class="px-2 pb-2">
          <ToolDetail :detail="s.detail" />
        </div>
      </li>
    </ul>
  </div>
</template>
