<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { ToolStepDto } from "@ganglion/xacpx-relay-protocol";
import { AlertTriangle, Check, ChevronDown, ChevronRight, Loader2 } from "lucide-vue-next";
import ToolDetail from "./ToolDetail.vue";
import { KIND_ICON, diffStatsOf } from "../lib/tool-summary";

const props = defineProps<{ step: ToolStepDto; ensureFull?: () => Promise<void> }>();

const { t } = useI18n();

// Live elapsed for a running step: `startedAt` is the connector's first-frame stamp
// (step-level, distinct from the turn's startedAt). Terminal steps show the
// connector-measured `durationMs` instead, so the local clock never renders a
// finished step's time and there is nothing to drift after the turn ends.
const nowMs = ref(Date.now());
let clockTimer: ReturnType<typeof setInterval> | undefined;
watch(
  () => props.step.status === "running",
  (running) => {
    if (clockTimer !== undefined) {
      clearInterval(clockTimer);
      clockTimer = undefined;
    }
    if (running) clockTimer = setInterval(() => { nowMs.value = Date.now(); }, 1000);
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  if (clockTimer !== undefined) clearInterval(clockTimer);
});

// Truncation markers emitted by the connector: `cap` appends a suffix, `capTail`
// prepends a prefix. Both must be recognised wherever a capped string is compared
// against an uncapped one.
const TRUNCATED_MARKS = ["…(truncated)", "(truncated)…"];
/** Strip any truncation marker so two capped/uncapped renderings of the same text
 *  can be compared for equality. */
function stripTruncationMarks(s: string): string {
  let out = s;
  for (const mark of TRUNCATED_MARKS) out = out.split(mark).join("");
  return out.trim();
}

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
  // Strip any truncation marker (suffix or prefix) before comparing — the error is
  // capped and the detail body may be capped differently.
  const needle = stripTruncationMarks(err);
  if (!needle) return true;
  return !detailOutput.value.includes(needle);
});

function fmtDuration(ms?: number): string {
  if (ms === undefined) return "";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

// Running steps have no connector duration yet — count up locally from the stamp.
// A missing stamp (older connector) falls back to the old "no time shown" behaviour.
const runningElapsed = computed(() => {
  if (props.step.status !== "running" || props.step.startedAt === undefined) return "";
  return fmtDuration(Math.max(0, nowMs.value - props.step.startedAt));
});
</script>

<template>
  <div data-test="tool-step-card" class="text-xs">
    <component :is="hasDetail ? 'button' : 'div'"
               :type="hasDetail ? 'button' : undefined"
               data-test="tool-step-header"
               class="group flex w-full items-center gap-1.5 py-1 px-1.5 -mx-1.5 rounded-md text-left text-fg-muted"
               :class="hasDetail ? 'hover:text-fg hover:bg-fg/5 transition-colors cursor-pointer' : 'cursor-default select-text'"
               :aria-expanded="hasDetail ? open : undefined"
               @click="hasDetail ? onHeaderClick() : undefined">
      <component :is="KIND_ICON[step.kind]" :size="13" class="shrink-0 transition-colors"
                 :class="step.status === 'error' ? 'text-danger' : step.status === 'running' ? 'text-accent' : hasDetail ? 'text-fg-muted/80 group-hover:text-fg' : 'text-fg-muted/80'" />
      <span class="shrink-0 font-medium text-[11.5px] text-fg-muted transition-colors"
            :class="hasDetail ? 'group-hover:text-fg' : ''">{{ kindLabel }}</span>
      <span v-if="fileExt" data-test="file-ext-badge" class="shrink-0 rounded bg-accent/10 px-1 py-0.5 text-[9px] font-semibold text-accent/80 font-mono leading-none">{{ fileExt }}</span>
      <span class="min-w-0 font-mono text-[11.5px] text-fg-muted/90 break-all"
            :class="[(hasDetail ? 'group-hover:text-fg' : ''), (hasDetail && !open) ? 'truncate' : '']" :title="step.title">{{ step.title }}</span>
      <span class="ml-auto flex shrink-0 items-center gap-1.5">
        <span v-if="diffStats" data-test="step-diff-stats" class="flex items-center gap-1 font-mono text-[11px]">
          <span v-if="diffStats.add" class="text-run font-medium">+{{ diffStats.add }}</span>
          <span v-if="diffStats.del" class="text-danger font-medium">−{{ diffStats.del }}</span>
        </span>
        <span v-if="step.durationMs !== undefined" class="font-mono text-[10.5px] text-fg-muted/70">{{ fmtDuration(step.durationMs) }}</span>
        <span v-else-if="runningElapsed" data-test="step-elapsed" class="font-mono text-[10.5px] text-fg-muted/70">{{ runningElapsed }}</span>
        <Check v-if="step.status === 'success'" data-test="step-status-success" :size="12" class="text-run/70" />
        <Loader2 v-else-if="step.status === 'running'" data-test="step-status-running" :size="12" class="animate-spin motion-reduce:animate-none text-accent" />
        <AlertTriangle v-else data-test="step-status-error" :size="12" class="text-danger" />
        <ChevronDown v-if="hasDetail && open" :size="12" class="shrink-0 opacity-60 group-hover:opacity-100 transition-opacity" />
        <ChevronRight v-else-if="hasDetail" :size="12" class="shrink-0 opacity-40 group-hover:opacity-80 transition-opacity" />
      </span>
    </component>
    <div v-if="hasDetail && open" data-test="tool-step-detail" class="ml-2.5 my-1.5 border-l-2 border-border/50 pl-3 space-y-1">
      <div v-if="hydrating" data-test="tool-step-hydrating" class="flex items-center gap-1.5 py-1 text-fg-muted">
        <Loader2 :size="13" class="animate-spin motion-reduce:animate-none" />
        <span>{{ $t("tools.loadingDetails") }}</span>
      </div>
      <template v-else>
        <div v-if="showErrorBanner" data-test="tool-step-error"
             class="mb-1.5 flex items-start gap-1.5 rounded bg-danger/10 px-2 py-1.5 text-danger font-mono text-[11px]">
          <AlertTriangle :size="13" class="mt-0.5 shrink-0" />
          <span class="whitespace-pre-wrap break-words leading-relaxed">{{ step.error }}</span>
        </div>
        <p v-else-if="step.terminalId && !detailOutput" data-test="tool-step-terminal-only"
           class="py-1 text-fg-muted">{{ $t("tools.terminalOutputNotReported") }}</p>
        <ToolDetail v-if="step.detail" :detail="step.detail" />
      </template>
    </div>
  </div>
</template>
