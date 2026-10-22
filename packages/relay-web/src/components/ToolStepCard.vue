<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { ToolStepDto } from "@ganglion/xacpx-relay-protocol";
import { AlertTriangle, Check, ChevronDown, ChevronRight, Loader2 } from "lucide-vue-next";
import ToolStepDetail from "./ToolStepDetail.vue";
import { KIND_ICON, diffStatsOf, isPathTitle } from "../lib/tool-summary";
import { formatStepDuration, useLiveElapsed } from "../lib/use-live-elapsed";

const props = defineProps<{ step: ToolStepDto; ensureFull?: () => Promise<void> }>();

const { t } = useI18n();

// Running steps count up locally from the connector's first-frame stamp (shared
// clock with the legacy ToolCallPanel); terminal steps show the connector's own
// durationMs instead, so nothing drifts after the turn ends.
const liveElapsed = useLiveElapsed(
  () => props.step.startedAt,
  () => props.step.status === "running",
);

// Keep the tool's one-line summary visible without letting command output, diffs, and
// file previews dominate the message list. Users can expand the detail on demand.
const open = ref(false);
const hydrating = ref(false);
const hasDetail = computed(() => {
  return props.step.detail !== undefined || props.step.error !== undefined || props.step.terminalId !== undefined || props.ensureFull !== undefined;
});

async function onHeaderClick(): Promise<void> {
  if (!hasDetail.value) return;
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
// Header +N/−N for edit/diff steps; shared with ToolCallPanel legacy rows
// (tool-summary.diffStatsOf) so both surfaces agree.
const diffStats = computed(() => diffStatsOf(props.step.detail));

const isWrite = computed(() => {
  const name = (props.step.toolName || "").toLowerCase();
  return name.includes("write") || name.includes("create");
});

const kindLabel = computed(() => {
  if (props.step.kind === "edit") {
    return isWrite.value ? t("tools.kinds.write") : t("tools.kinds.edit");
  }
  return t("tools.kinds." + props.step.kind);
});

// File extension badge for file operations (e.g. TS, VUE, PY, JSON).
const fileExt = computed(() => {
  if (props.step.kind !== "read" && props.step.kind !== "edit") return "";
  const title = props.step.detail?.type === "diff" || props.step.detail?.type === "read"
    ? props.step.detail.path
    : props.step.title || "";
  // Isolate basename first so Windows drive letters (C:\...) or scheme colons (file://...)
  // are not stripped. Then strip trailing line/query specifiers so dotted directory
  // names (e.g. "src.v2/x", "a.b/c") or dotfiles (".gitignore") are not misidentified.
  const basename = title.split(/[\\/]/).pop() ?? "";
  const cleanBasename = basename.split(/[\s:#?]/)[0] ?? "";
  const dot = cleanBasename.lastIndexOf(".");
  if (dot <= 0 || dot === cleanBasename.length - 1) return "";
  const raw = cleanBasename.slice(dot + 1).toUpperCase();
  return raw.length <= 4 ? raw : "";
});

// Path titles ellipsis at the head (…tail) so the filename stays visible in
// the one-line preview; the full path remains in the tooltip and the detail.
const pathTitle = computed(() => isPathTitle(props.step));
// A missing stamp (older connector) falls back to the old "no time shown" behaviour.
const runningElapsed = computed(() => formatStepDuration(liveElapsed.elapsedMs()));
</script>

<template>
  <div data-test="tool-step-card" class="text-xs">
    <component :is="hasDetail ? 'button' : 'div'"
               :type="hasDetail ? 'button' : undefined"
               data-test="tool-step-header"
               class="group flex w-full items-center gap-1.5 py-1 px-1.5 -mx-1.5 rounded-sm text-left text-fg-muted"
               :class="hasDetail ? 'hover:text-fg hover:bg-fg/5 transition-colors cursor-pointer' : 'cursor-default select-text'"
               :aria-expanded="hasDetail ? open : undefined"
               @click="hasDetail ? onHeaderClick() : undefined">
      <component :is="KIND_ICON[step.kind]" :size="13" class="shrink-0 transition-colors"
                 :class="step.status === 'error' ? 'text-danger' : step.status === 'running' ? 'text-accent' : hasDetail ? 'text-fg-muted/80 group-hover:text-fg' : 'text-fg-muted/80'" />
      <span class="shrink-0 font-medium text-xs text-fg-muted transition-colors"
            :class="hasDetail ? 'group-hover:text-fg' : ''">{{ kindLabel }}</span>
      <span v-if="fileExt" data-test="file-ext-badge" class="shrink-0 rounded-sm bg-accent-soft px-1 py-0.5 text-xs font-semibold text-accent/80 font-mono leading-none">{{ fileExt }}</span>
      <span class="min-w-0 font-mono text-xs text-fg-muted/90 break-all"
            :class="[(hasDetail ? 'group-hover:text-fg' : ''), hasDetail ? 'truncate' : '']" :title="step.title" :dir="hasDetail && pathTitle ? 'rtl' : undefined">{{ step.title }}</span>
      <span class="ml-auto flex shrink-0 items-center gap-1.5">
        <span v-if="diffStats" data-test="step-diff-stats" class="flex items-center gap-1 font-mono text-xs">
          <span v-if="diffStats.add" class="text-run font-medium">+{{ diffStats.add }}</span>
          <span v-if="diffStats.del" class="text-danger font-medium">−{{ diffStats.del }}</span>
        </span>
        <span v-if="step.durationMs !== undefined" class="font-mono text-xs text-fg-muted/70">{{ formatStepDuration(step.durationMs) }}</span>
        <span v-else-if="runningElapsed" data-test="step-elapsed" class="font-mono text-xs text-fg-muted/70">{{ runningElapsed }}</span>
        <Check v-if="step.status === 'success'" data-test="step-status-success" :size="12" class="text-run/70" />
        <Loader2 v-else-if="step.status === 'running'" data-test="step-status-running" :size="12" class="animate-spin motion-reduce:animate-none text-accent" />
        <AlertTriangle v-else data-test="step-status-error" :size="12" class="text-danger" />
        <ChevronDown v-if="hasDetail && open" :size="12" class="shrink-0 opacity-60 group-hover:opacity-100 transition-opacity" />
        <ChevronRight v-else-if="hasDetail" :size="12" class="shrink-0 opacity-40 group-hover:opacity-80 transition-opacity" />
      </span>
    </component>
    <div v-if="hasDetail && open" data-test="tool-step-detail" class="ml-2.5 my-1.5 border-l-2 border-border/50 pl-3 space-y-1">
      <ToolStepDetail :step="step" :hydrating="hydrating" />
    </div>
  </div>
</template>
