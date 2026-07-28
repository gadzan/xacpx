<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { ToolDetailDto, ToolStepDto } from "@ganglion/xacpx-relay-protocol";
import { AlertTriangle, Bot, Check, ChevronDown, ChevronRight, ExternalLink, Loader2 } from "lucide-vue-next";
import { KIND_ICON } from "../lib/tool-summary";
import { resolveSubagentStatus } from "../lib/subagent-status";
import SubagentTraceDialog from "./SubagentTraceDialog.vue";
import StreamMarkdown from "./StreamMarkdown.vue";

const props = defineProps<{ step: ToolStepDto; children: ToolStepDto[] }>();
const open = ref(false);
const dialogOpen = ref(false);
const paused = ref(false);
const activityIndex = ref(0);
let activityTimer: ReturnType<typeof setInterval> | undefined;

const status = computed(() => resolveSubagentStatus(props.step, props.children));

// A real child-tool timeline (Claude) is an optional upgrade. Adapters that never emit
// parentToolCallId (qoder/kimi/codex) leave `children` empty for the whole run, so the
// card falls back to the delegated prompt + streamed output carried on the step's own detail.
const hasTrace = computed(() => props.children.length > 0);

// The delegated prompt (tool input) and the subagent's streamed/finished output (tool
// output) both ride on the step's detail. `text` steps carry them as text/output; other
// detail shapes degrade gracefully so pre-spec connectors still show something.
function detailPrompt(d: ToolDetailDto | undefined): string {
  if (!d) return "";
  return d.type === "text" ? d.text
    : d.type === "command" ? d.command
    : d.type === "search" ? d.query
    : d.type === "read" ? d.path
    : d.type === "fields" ? d.fields.map((f) => f.value).find((v) => v.trim()) ?? ""
    : "";
}
function detailOutput(d: ToolDetailDto | undefined): string {
  if (!d) return "";
  return d.type === "text" ? d.output ?? ""
    : d.type === "command" ? d.output ?? ""
    : d.type === "search" ? d.output ?? ""
    : d.type === "read" ? d.preview ?? ""
    : d.type === "fields" ? d.output ?? ""
    : "";
}
const promptText = computed(() => detailPrompt(props.step.detail));
const outputText = computed(() => detailOutput(props.step.detail));
const detailSnippet = computed(() => {
  const text = outputText.value || promptText.value;
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1] : "";
});

const activity = computed(() => {
  const running = props.children.filter((child) => child.status === "running");
  return running.length ? running : props.children.slice(-3);
});
const currentActivity = computed(() => activity.value.length ? activity.value[activityIndex.value % activity.value.length] : undefined);

// Client-side heartbeat + elapsed for traceless runs: `startedAt` approximates when the
// card first appeared and `lastChangeAt` tracks the newest output frame. Both are best-effort
// (reset on reload), which is fine — persisted history rows are never in the running state.
const startedAt = Date.now();
const lastChangeAt = ref(Date.now());
const nowMs = ref(Date.now());
let clockTimer: ReturnType<typeof setInterval> | undefined;
watch(outputText, () => { lastChangeAt.value = Date.now(); });

function compact(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}
const elapsedLabel = computed(() => compact(nowMs.value - startedAt));
const heartbeatLabel = computed(() => compact(nowMs.value - lastChangeAt.value));

const streamEl = ref<HTMLElement | null>(null);
watch([outputText, open], async () => {
  if (!open.value || hasTrace.value || status.value !== "running") return;
  await nextTick();
  const el = streamEl.value;
  if (el) el.scrollTop = el.scrollHeight;
});

watch(() => activity.value.map((step) => step.toolCallId).join("\0"), () => { activityIndex.value = 0; });

onMounted(() => {
  clockTimer = setInterval(() => { if (status.value === "running") nowMs.value = Date.now(); }, 1000);
  const reduceMotion = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduceMotion) return;
  activityTimer = setInterval(() => {
    if (!paused.value && !open.value && activity.value.length > 1) activityIndex.value += 1;
  }, 2400);
});
onBeforeUnmount(() => {
  if (activityTimer) clearInterval(activityTimer);
  if (clockTimer) clearInterval(clockTimer);
});
</script>

<template>
  <article data-test="subagent-card"
           class="overflow-hidden rounded-xl border bg-surface text-xs shadow-e1 transition-colors"
           :class="status === 'error' ? 'border-danger/40' : status === 'running' ? 'border-accent/35' : 'border-border'"
           @mouseenter="paused = true" @mouseleave="paused = false" @focusin="paused = true" @focusout="paused = false">
    <button type="button" data-test="subagent-header"
            class="group flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-bg/70"
            :aria-expanded="open" @click="open = !open">
      <ChevronDown v-if="open" :size="14" class="shrink-0 text-fg-muted" />
      <ChevronRight v-else :size="14" class="shrink-0 text-fg-muted" />
      <span class="relative grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-accent/20 bg-accent/10 text-accent">
        <Bot :size="15" />
        <span v-if="status === 'running'" class="pulse-dot absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-run-bright" />
      </span>
      <span class="min-w-0 flex-1">
        <span class="flex items-center gap-2">
          <span class="shrink-0 whitespace-nowrap rounded-full bg-accent/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.12em] text-accent">{{ $t("tools.subagent") }}</span>
          <span class="truncate text-[12px] font-semibold text-fg">{{ step.title }}</span>
        </span>
        <span class="mt-0.5 block text-[10.5px] text-fg-muted">
          <template v-if="hasTrace">{{ $t("tools.traceCount", { count: children.length }) }}</template>
          <template v-else-if="status === 'running'">{{ $t("tools.running") }} · {{ elapsedLabel }}</template>
          <template v-else>{{ status === "error" ? $t("tools.failed") : $t("tools.finished") }}</template>
        </span>
      </span>
      <span class="shrink-0">
        <Loader2 v-if="status === 'running'" data-test="subagent-running" :size="14" class="animate-spin motion-reduce:animate-none text-accent" />
        <AlertTriangle v-else-if="status === 'error'" data-test="subagent-error" :size="14" class="text-danger" />
        <Check v-else data-test="subagent-success" :size="14" class="text-run" />
      </span>
    </button>

    <div v-if="!open" data-test="subagent-activity" class="border-t border-border/70 bg-bg/45 px-3 py-2">
      <Transition v-if="hasTrace" name="activity-slide" mode="out-in">
        <div v-if="currentActivity" :key="currentActivity.toolCallId" class="flex min-w-0 items-center gap-2">
          <span class="h-1.5 w-1.5 shrink-0 rounded-full" :class="currentActivity.status === 'running' ? 'bg-accent' : currentActivity.status === 'error' ? 'bg-danger' : 'bg-run'" />
          <component :is="KIND_ICON[currentActivity.kind]" :size="12" class="shrink-0 text-fg-muted" />
          <span class="truncate font-mono text-[10.5px] text-fg-muted">{{ currentActivity.title }}</span>
          <span v-if="activity.length > 1" class="ml-auto shrink-0 font-mono text-[9.5px] tabular-nums text-fg-muted/70">
            {{ activityIndex % activity.length + 1 }}/{{ activity.length }}
          </span>
        </div>
        <div v-else key="waiting" class="flex min-w-0 items-center gap-2 text-[10.5px] text-fg-muted">
          <Loader2 v-if="status === 'running'" :size="12" class="shrink-0 animate-spin motion-reduce:animate-none text-accent" />
          <Check v-else :size="12" class="shrink-0 text-run" />
          <span>{{ status === "running" ? $t("tools.runningNoActivityYet") : $t("tools.noRecordedActivity") }}</span>
        </div>
      </Transition>
      <div v-else class="flex min-w-0 items-center gap-2 text-[10.5px] text-fg-muted">
        <Loader2 v-if="status === 'running'" :size="12" class="shrink-0 animate-spin motion-reduce:animate-none text-accent" />
        <AlertTriangle v-else-if="status === 'error'" :size="12" class="shrink-0 text-danger" />
        <Check v-else :size="12" class="shrink-0 text-run" />
        <span v-if="detailSnippet" data-test="subagent-detail-snippet" class="truncate font-mono">{{ detailSnippet }}</span>
        <span v-else>{{ status === "running" ? $t("tools.runningNoActivityYet") : $t("tools.noRecordedActivity") }}</span>
        <span v-if="status === 'running'" class="ml-auto shrink-0 tabular-nums text-fg-muted/70">
          {{ outputText ? $t("tools.updatedAgo", { ago: heartbeatLabel }) : elapsedLabel }}
        </span>
      </div>
    </div>

    <div v-else data-test="subagent-timeline" class="border-t border-border bg-bg/30 px-3 pb-3 pt-2.5">
      <ol v-if="hasTrace" class="relative ml-1 space-y-1.5 before:absolute before:bottom-2 before:left-[7px] before:top-2 before:w-px before:bg-border">
        <li v-for="child in children" :key="child.toolCallId" class="relative flex min-w-0 items-center gap-2 pl-5">
          <span class="absolute left-0 grid h-3.5 w-3.5 place-items-center rounded-full border border-border bg-surface">
            <span class="h-1.5 w-1.5 rounded-full" :class="child.status === 'running' ? 'bg-accent' : child.status === 'error' ? 'bg-danger' : 'bg-run'" />
          </span>
          <component :is="KIND_ICON[child.kind]" :size="12" class="shrink-0 text-fg-muted" />
          <span class="truncate font-mono text-[10.5px] text-fg-muted">{{ child.title }}</span>
        </li>
      </ol>
      <template v-else>
        <div v-if="promptText" class="mb-2.5">
          <p class="mb-1 text-[9px] font-semibold uppercase tracking-[0.12em] text-fg-muted">{{ $t("tools.delegatedTask") }}</p>
          <p class="truncate font-mono text-[10.5px] text-fg-muted">{{ promptText }}</p>
        </div>
        <div v-if="outputText" data-test="subagent-report">
          <p class="mb-1 text-[9px] font-semibold uppercase tracking-[0.12em] text-fg-muted">{{ $t("tools.report") }}</p>
          <StreamMarkdown v-if="status !== 'running'" :text="outputText" />
          <pre v-else ref="streamEl" data-test="subagent-stream"
               class="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-bg/60 p-2 font-mono text-[10.5px] leading-relaxed text-fg-muted">{{ outputText }}</pre>
        </div>
        <p v-else class="py-1 text-[10.5px] text-fg-muted">
          {{ status === "running" ? $t("tools.runningNoActivityYet") : $t("tools.noRecordedActivity") }}
        </p>
      </template>
      <button type="button" data-test="subagent-open-trace"
              class="mt-2.5 inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-[10.5px] font-medium text-fg-muted transition-colors hover:border-accent/40 hover:text-accent"
              @click="dialogOpen = true">
        <ExternalLink :size="12" /> {{ $t("tools.viewFullTrace") }}
      </button>
    </div>
  </article>

  <SubagentTraceDialog v-if="dialogOpen" :step="step" :children="children" @close="dialogOpen = false" />
</template>

<style scoped>
.activity-slide-enter-active,
.activity-slide-leave-active { transition: opacity 160ms ease, transform 160ms ease; }
.activity-slide-enter-from { opacity: 0; transform: translateY(4px); }
.activity-slide-leave-to { opacity: 0; transform: translateY(-4px); }
@media (prefers-reduced-motion: reduce) {
  .activity-slide-enter-active,
  .activity-slide-leave-active { transition: none; }
}
</style>
