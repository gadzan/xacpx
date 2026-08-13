<script setup lang="ts">
import { computed, ref } from "vue";
import type { ToolStepDto } from "@ganglion/xacpx-relay-protocol";
import { AlertTriangle, Check, ChevronDown, ChevronRight, Loader2 } from "lucide-vue-next";
import ToolDetail from "./ToolDetail.vue";
import { KIND_ICON } from "../lib/tool-summary";

const props = defineProps<{ step: ToolStepDto; ensureFull?: () => Promise<void> }>();

// Keep the tool's one-line summary visible without letting command output, diffs, and
// file previews dominate the message list. Users can expand the detail on demand.
const open = ref(false);
const hydrating = ref(false);

async function onHeaderClick(): Promise<void> {
  if (open.value) {
    open.value = false;
    return;
  }
  open.value = true;
  if (!props.ensureFull) return;
  hydrating.value = true;
  try {
    await props.ensureFull();
  } catch {
    // Stub detail remains; collapsing and expanding retries.
  } finally {
    hydrating.value = false;
  }
}

// The text the detail body already prints below (so we don't repeat it in the banner).
const detailOutput = computed(() => {
  const d = props.step.detail;
  if (!d) return "";
  if (d.type === "command" || d.type === "search" || d.type === "fields") return d.output ?? "";
  if (d.type === "read") return d.preview ?? "";
  if (d.type === "text") return d.text ?? "";
  return "";
});

// Show the red error banner only when the failure isn't ALREADY visible in the detail
// body. A failed command echoes its stderr in its output (plus a nonzero exit and a red
// border), so a banner there just prints the same text twice. The error is capped with a
// "…(truncated)" marker the output won't carry, so compare against the pre-marker prefix.
const showErrorBanner = computed(() => {
  if (props.step.status !== "error") return false;
  const err = props.step.error?.trim();
  if (!err) return false;
  const mark = err.indexOf("…(truncated)");
  const needle = (mark >= 0 ? err.slice(0, mark) : err).trim();
  if (!needle) return true;
  return !detailOutput.value.includes(needle);
});

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
            class="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-bg"
            :aria-expanded="open" @click="onHeaderClick">
      <ChevronDown v-if="open" :size="13" class="shrink-0 text-fg-muted" />
      <ChevronRight v-else :size="13" class="shrink-0 text-fg-muted" />
      <component :is="KIND_ICON[step.kind]" :size="13" class="shrink-0 text-fg-muted" />
      <span class="min-w-0 truncate font-mono text-[11.5px] text-fg">{{ step.title }}</span>
      <span class="ml-auto flex shrink-0 items-center gap-2">
        <span v-if="step.durationMs !== undefined" class="font-mono text-[10.5px] text-fg-muted">{{ fmtDuration(step.durationMs) }}</span>
        <Check v-if="step.status === 'success'" data-test="step-status-success" :size="13" class="text-run" />
        <Loader2 v-else-if="step.status === 'running'" data-test="step-status-running" :size="13" class="animate-spin motion-reduce:animate-none text-accent" />
        <AlertTriangle v-else data-test="step-status-error" :size="13" class="text-danger" />
      </span>
    </button>
    <div v-if="open" data-test="tool-step-detail" class="border-t border-border px-3 pb-2.5 pt-2">
      <div v-if="hydrating" data-test="tool-step-hydrating" class="flex items-center gap-1.5 py-1 text-fg-muted">
        <Loader2 :size="13" class="animate-spin motion-reduce:animate-none" />
        <span>{{ $t("tools.loadingDetails") }}</span>
      </div>
      <template v-else>
        <div v-if="showErrorBanner" data-test="tool-step-error"
             class="mb-1.5 flex items-start gap-1.5 rounded bg-danger/10 px-2 py-1.5 text-danger">
          <AlertTriangle :size="13" class="mt-0.5 shrink-0" />
          <span class="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed">{{ step.error }}</span>
        </div>
        <ToolDetail v-if="step.detail" :detail="step.detail" />
      </template>
    </div>
  </div>
</template>
