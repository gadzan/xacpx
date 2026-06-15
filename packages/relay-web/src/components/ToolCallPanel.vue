<script setup lang="ts">
import { computed, ref } from "vue";
import type { ToolStepDto } from "@ganglion/xacpx-relay-protocol";
import ToolDetail from "./ToolDetail.vue";
import FueDot from "./FueDot.vue";
import FueCallout from "./FueCallout.vue";
import { useFue } from "../lib/use-fue";
import type { Rect } from "../lib/fue-placement";
import { AUTO_COLLAPSE_THRESHOLD, KIND_ICON, STATUS_ICON, summarizeSteps } from "../lib/tool-summary";

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
  <div class="mt-1 rounded border border-slate-200 text-xs">
    <button ref="header" type="button" class="flex w-full items-center gap-1 px-2 py-1 text-left text-slate-600" @click="onHeaderClick">
      <span>{{ open ? "▾" : "▸" }}</span>
      <span>🔧 Tool calls</span>
      <FueDot v-if="showFueDot" :pulsing="fue.status.value === 'unseen'" />
      <span v-else data-test="tool-count" class="text-slate-400">({{ steps.length }})</span>
      <span data-test="tool-summary" class="ml-1 flex items-center gap-1 text-slate-400">
        <span v-for="k in summary.kinds" :key="'k' + k.icon">{{ k.icon }}{{ k.count }}</span>
        <span v-if="summary.statuses.length" class="text-slate-300">·</span>
        <span v-for="st in summary.statuses" :key="'s' + st.icon">{{ st.icon }}{{ st.count }}</span>
      </span>
    </button>
    <FueCallout
      v-if="fue.status.value === 'engaging'"
      :title="'Tool steps collapsed'"
      :body="'Multi-step tool runs are collapsed by default to keep replies readable. Click the header to expand and inspect each step.'"
      :anchor="anchor"
      @dismiss="fue.dismiss()"
    />
    <ul v-if="open" class="divide-y divide-slate-100">
      <li v-for="s in steps" :key="s.toolCallId">
        <button type="button" data-test="tool-row" class="flex w-full items-center gap-2 px-2 py-1 text-left hover:bg-slate-50" @click="toggleRow(s.toolCallId)">
          <span>{{ STATUS_ICON[s.status] }}</span>
          <span>{{ KIND_ICON[s.kind] }}</span>
          <span class="truncate font-mono text-slate-700">{{ s.title }}</span>
          <span v-if="s.durationMs !== undefined" class="ml-auto text-slate-400">{{ fmtDuration(s.durationMs) }}</span>
        </button>
        <div v-if="expanded.has(s.toolCallId) && s.detail" class="px-2 pb-2">
          <ToolDetail :detail="s.detail" />
        </div>
      </li>
    </ul>
  </div>
</template>
