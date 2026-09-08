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

const props = defineProps<{ steps: ToolStepDto[]; ensureFull?: () => Promise<void> }>();

// Legacy history stores tool calls as one aggregate panel. Keep that panel collapsed
// too, regardless of step count, so old and current transcripts follow the same rule.
const open = ref(false);
const expanded = ref<Set<string>>(new Set());

const summary = computed(() => summarizeSteps(props.steps));

// First-User-Experience: the first time a user meets an auto-collapsed panel, nudge
// them that it expands. The dot replaces the count badge until acknowledged.
const fue = useFue("tool-group-collapse");
const collapsible = computed(() => props.steps.length > GROUP_COLLAPSE_FUE_THRESHOLD);
const showFueDot = computed(() => collapsible.value && fue.status.value !== "acknowledged");
const header = ref<HTMLElement | null>(null);
const anchor = ref<Rect | null>(null);

async function onHeaderClick() {
  if (!open.value && props.ensureFull) {
    try { await props.ensureFull(); } catch { /* stub remains */ }
  }
  open.value = !open.value;
  if (showFueDot.value) {
    const r = header.value?.getBoundingClientRect();
    if (r) anchor.value = { top: r.top, left: r.left, width: r.width, height: r.height };
    fue.engage();
  }
}

async function toggleRow(id: string) {
  if (!expanded.value.has(id) && props.ensureFull) {
    try { await props.ensureFull(); } catch { /* stub remains */ }
  }
  if (expanded.value.has(id)) expanded.value.delete(id); else expanded.value.add(id);
  expanded.value = new Set(expanded.value);
}

function fmtDuration(ms?: number): string {
  if (ms === undefined) return "";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}
</script>

<template>
  <div data-test="tool-call-panel" class="text-xs">
    <button ref="header" type="button"
            class="group flex w-full items-center gap-1.5 py-1 px-1.5 -mx-1.5 rounded-md text-left text-fg-muted hover:text-fg hover:bg-fg/5 transition-colors"
            :aria-expanded="open" @click="onHeaderClick">
      <Wrench :size="13" class="shrink-0 text-fg-muted group-hover:text-fg" />
      <span class="text-[11.5px] font-medium text-fg-muted group-hover:text-fg">{{ $t("tools.toolSteps") }}</span>
      <FueDot v-if="showFueDot" :pulsing="fue.status.value === 'unseen'" />
      <span v-else data-test="tool-count" class="font-mono text-[10.5px] text-fg-muted/70">{{ steps.length }}</span>
      <span data-test="tool-summary" class="ml-1 flex items-center gap-1.5 text-[10.5px] text-fg-muted/70">
        <span v-for="k in summary.kinds" :key="'k' + k.label" :data-test="'sum-' + k.label"
              class="inline-flex items-center gap-0.5">
          <component :is="k.icon" :size="11" /><span class="tabular-nums">{{ k.count }}</span>
        </span>
        <span v-if="summary.statuses.length" class="text-fg-muted/50">·</span>
        <span v-for="st in summary.statuses" :key="'s' + st.label" :data-test="'sum-' + st.label"
              class="inline-flex items-center gap-0.5"
              :class="st.label === 'success' ? 'text-run' : st.label === 'error' ? 'text-danger' : 'text-fg-muted'">
          <component :is="st.icon" :size="11"
                     :class="st.label === 'running' ? 'animate-spin motion-reduce:animate-none' : ''" /><span class="tabular-nums">{{ st.count }}</span>
        </span>
      </span>
      <span class="ml-auto flex shrink-0 items-center">
        <ChevronDown v-if="open" :size="12" class="shrink-0 opacity-60 group-hover:opacity-100" />
        <ChevronRight v-else :size="12" class="shrink-0 opacity-40 group-hover:opacity-80" />
      </span>
    </button>
    <FueCallout
      v-if="fue.status.value === 'engaging'"
      :title="$t('tools.collapsed')"
      :body="$t('tools.collapsedBody')"
      :anchor="anchor"
      @dismiss="fue.dismiss()"
    />
    <ul v-if="open" class="ml-2.5 my-1.5 border-l-2 border-border/50 pl-3 space-y-1">
      <li v-for="s in steps" :key="s.toolCallId">
        <button type="button" data-test="tool-row" class="flex w-full items-center gap-1.5 py-0.5 text-left text-[11.5px] text-fg-muted hover:text-fg transition-colors" @click="toggleRow(s.toolCallId)">
          <component :is="KIND_ICON[s.kind]" :size="12" class="shrink-0 text-fg-muted" />
          <span class="truncate font-mono text-[11px]">{{ s.title }}</span>
          <span v-if="s.durationMs !== undefined" class="ml-auto font-mono text-[10px] text-fg-muted/70">{{ fmtDuration(s.durationMs) }}</span>
          <Check v-if="s.status === 'success'" data-test="step-status-success" :size="11" class="text-run/70" />
          <Loader2 v-else-if="s.status === 'running'" data-test="step-status-running" :size="11" class="animate-spin motion-reduce:animate-none text-accent" />
          <AlertTriangle v-else data-test="step-status-error" :size="11" class="text-danger" />
        </button>
        <div v-if="expanded.has(s.toolCallId) && s.detail" class="pl-3 py-1">
          <ToolDetail :detail="s.detail" />
        </div>
      </li>
    </ul>
  </div>
</template>
