<script setup lang="ts">
import { computed } from "vue";
import type { ToolStepDto } from "@ganglion/xacpx-relay-protocol";
import { AlertTriangle, Loader2 } from "lucide-vue-next";
import ToolDetail from "./ToolDetail.vue";
import DetailHeadline from "./DetailHeadline.vue";
import { stripTruncationMarks } from "../lib/tool-summary";

/**
 * The expanded body of one tool step: headline, hydration state, failure banner and
 * the structured detail. Shared by the inline activity stream (`ToolStepCard`) and the
 * run-detail timeline (`GroupTraceTimeline`) so both surfaces show the same output for
 * the same step instead of growing two renderers that drift.
 *
 * The caller owns the disclosure control; this component renders the body only.
 */
const props = defineProps<{ step: ToolStepDto; hydrating?: boolean }>();

/** Text the detail body already prints below, so a banner would repeat it. */
const detailOutput = computed(() => {
  const d = props.step.detail;
  if (!d) return "";
  if (d.type === "command" || d.type === "search" || d.type === "fields") return d.output ?? "";
  if (d.type === "read") return d.preview ?? "";
  if (d.type === "text") return d.text ?? "";
  return "";
});

/** Red banner only when the failure is not already visible in the body: a failed
 *  command echoes its stderr in its output, so a banner would print it twice. */
const showErrorBanner = computed(() => {
  if (props.step.status !== "error") return false;
  const err = props.step.error?.trim();
  if (!err) return false;
  const needle = stripTruncationMarks(err);
  if (!needle) return true;
  return !detailOutput.value.includes(needle);
});
</script>

<template>
  <div data-test="tool-step-body" class="space-y-1">
    <DetailHeadline :text="step.title" />
    <div v-if="hydrating" data-test="tool-step-hydrating" class="flex items-center gap-1.5 py-1 text-fg-muted">
      <Loader2 :size="13" class="animate-spin motion-reduce:animate-none" />
      <span>{{ $t("tools.loadingDetails") }}</span>
    </div>
    <template v-else>
      <div v-if="showErrorBanner" data-test="tool-step-error"
           class="mb-1.5 flex items-start gap-1.5 rounded-sm bg-danger/10 px-2 py-1.5 text-danger font-mono text-xs">
        <AlertTriangle :size="13" class="mt-0.5 shrink-0" />
        <span class="whitespace-pre-wrap break-words leading-relaxed">{{ step.error }}</span>
      </div>
      <p v-else-if="step.terminalId && !detailOutput" data-test="tool-step-terminal-only"
         class="py-1 text-fg-muted">{{ $t("tools.terminalOutputNotReported") }}</p>
      <ToolDetail v-if="step.detail" :detail="step.detail" />
    </template>
  </div>
</template>
