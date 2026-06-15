<script setup lang="ts">
import { ref } from "vue";
import type { ToolStepDto } from "@ganglion/xacpx-relay-protocol";
import { AlertTriangle, Check, ChevronDown, ChevronRight, Loader2 } from "lucide-vue-next";
import ToolDetail from "./ToolDetail.vue";
import { KIND_ICON } from "../lib/tool-summary";

const props = defineProps<{ step: ToolStepDto }>();

// Detail is shown inline by default (the user wants to see what write/read/exec did
// without an extra click); the header still toggles it for long transcripts.
const open = ref(true);

function fmtDuration(ms?: number): string {
  if (ms === undefined) return "";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}
</script>

<template>
  <div data-test="tool-step-card"
       class="overflow-hidden rounded-lg border bg-surface text-xs shadow-e1"
       :class="step.status === 'error' ? 'border-danger/40' : 'border-border'">
    <button type="button" data-test="tool-step-header"
            class="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-bg" @click="open = !open">
      <ChevronDown v-if="open" :size="13" class="text-fg-muted" />
      <ChevronRight v-else :size="13" class="text-fg-muted" />
      <component :is="KIND_ICON[step.kind]" :size="13" class="shrink-0 text-fg-muted" />
      <span class="truncate font-mono text-[11.5px] text-fg">{{ step.title }}</span>
      <span class="ml-auto flex shrink-0 items-center gap-2">
        <span v-if="step.durationMs !== undefined" class="font-mono text-[10.5px] text-fg-muted">{{ fmtDuration(step.durationMs) }}</span>
        <Check v-if="step.status === 'success'" data-test="step-status-success" :size="13" class="text-run" />
        <Loader2 v-else-if="step.status === 'running'" data-test="step-status-running" :size="13" class="animate-spin motion-reduce:animate-none text-accent" />
        <AlertTriangle v-else data-test="step-status-error" :size="13" class="text-danger" />
      </span>
    </button>
    <div v-if="open" class="border-t border-border px-3 pb-2.5 pt-2">
      <div v-if="step.status === 'error' && step.error" data-test="tool-step-error"
           class="mb-1.5 flex items-start gap-1.5 rounded bg-danger/10 px-2 py-1.5 text-danger">
        <AlertTriangle :size="13" class="mt-0.5 shrink-0" />
        <span class="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed">{{ step.error }}</span>
      </div>
      <ToolDetail v-if="step.detail" :detail="step.detail" />
    </div>
  </div>
</template>
