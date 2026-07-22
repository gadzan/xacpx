<script setup lang="ts">
import { computed, ref } from "vue";
import type { ToolStepDto } from "@ganglion/xacpx-relay-protocol";
import { AlertTriangle, Check, ChevronDown, ChevronRight, Loader2, Wrench } from "lucide-vue-next";
import ToolDetail from "./ToolDetail.vue";
import FueDot from "./FueDot.vue";
import FueCallout from "./FueCallout.vue";
import { useFue } from "../lib/use-fue";
import type { Rect } from "../lib/fue-placement";
import { GROUP_COLLAPSE_FUE_THRESHOLD, KIND_ICON, summarizeSteps } from "../lib/tool-summary";

const props = defineProps<{ steps: ToolStepDto[] }>();

// Legacy history stores tool calls as one aggregate panel. Keep that panel collapsed
// too, regardless of step count, so old and current transcripts follow the same rule.
const open = ref(false);
const expanded = ref<Set<string>>(new Set());
function toggleRow(id: string) {
  if (expanded.value.has(id)) expanded.value.delete(id); else expanded.value.add(id);
  expanded.value = new Set(expanded.value);
}

const summary = computed(() => summarizeSteps(props.steps));

// First-User-Experience: the first time a user meets an auto-collapsed panel, nudge
// them that it expands. The dot replaces the count badge until acknowledged.
const fue = useFue("tool-group-collapse");
const collapsible = computed(() => props.steps.length > GROUP_COLLAPSE_FUE_THRESHOLD);
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
  <div class="overflow-hidden rounded-lg border border-border bg-surface text-xs shadow-e1">
    <button ref="header" type="button"
            class="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-bg"
            :aria-expanded="open" @click="onHeaderClick">
      <ChevronDown v-if="open" :size="13" class="shrink-0 text-fg-muted" />
      <ChevronRight v-else :size="13" class="shrink-0 text-fg-muted" />
      <span class="inline-flex items-center gap-1.5 text-[11.5px] font-semibold text-fg-muted"><Wrench :size="13" /> {{ $t("tools.toolSteps") }}</span>
      <FueDot v-if="showFueDot" :pulsing="fue.status.value === 'unseen'" />
      <span v-else data-test="tool-count" class="font-mono text-[10.5px] text-fg-muted">{{ steps.length }}</span>
      <span data-test="tool-summary" class="ml-1 flex items-center gap-1.5 text-[10.5px] text-fg-muted">
        <span v-for="k in summary.kinds" :key="'k' + k.label" :data-test="'sum-' + k.label"
              class="inline-flex items-center gap-0.5">
          <component :is="k.icon" :size="11" /><span class="tabular-nums">{{ k.count }}</span>
        </span>
        <span v-if="summary.statuses.length" class="text-fg-muted">·</span>
        <span v-for="st in summary.statuses" :key="'s' + st.label" :data-test="'sum-' + st.label"
              class="inline-flex items-center gap-0.5"
              :class="st.label === 'success' ? 'text-run' : st.label === 'error' ? 'text-danger' : 'text-fg-muted'">
          <component :is="st.icon" :size="11"
                     :class="st.label === 'running' ? 'animate-spin motion-reduce:animate-none' : ''" /><span class="tabular-nums">{{ st.count }}</span>
        </span>
      </span>
    </button>
    <FueCallout
      v-if="fue.status.value === 'engaging'"
      :title="$t('tools.collapsed')"
      :body="$t('tools.collapsedBody')"
      :anchor="anchor"
      @dismiss="fue.dismiss()"
    />
    <ul v-if="open" class="space-y-1 border-t border-border px-3 pb-2.5 pt-2">
      <li v-for="s in steps" :key="s.toolCallId">
        <button type="button" data-test="tool-row" class="flex w-full items-center gap-2 rounded text-left text-[12px] hover:bg-fg/5" @click="toggleRow(s.toolCallId)">
          <span class="grid h-4 w-4 shrink-0 place-items-center rounded-full"
                :class="s.status === 'success' ? 'bg-run/15' : s.status === 'running' ? 'bg-accent/15' : 'bg-danger/15'">
            <Check v-if="s.status === 'success'" data-test="step-status-success" :size="9" class="text-run" />
            <Loader2 v-else-if="s.status === 'running'" data-test="step-status-running" :size="9" class="animate-spin motion-reduce:animate-none text-accent" />
            <AlertTriangle v-else data-test="step-status-error" :size="9" class="text-danger" />
          </span>
          <component :is="KIND_ICON[s.kind]" :size="12" class="shrink-0 text-fg-muted" />
          <span class="truncate font-mono text-[11px] text-fg">{{ s.title }}</span>
          <span v-if="s.durationMs !== undefined" class="ml-auto font-mono text-[10.5px] text-fg-muted">{{ fmtDuration(s.durationMs) }}</span>
        </button>
        <div v-if="expanded.has(s.toolCallId) && s.detail" class="px-2 pb-2 pt-1">
          <ToolDetail :detail="s.detail" />
        </div>
      </li>
    </ul>
  </div>
</template>
