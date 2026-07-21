<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { ToolStepDto } from "@ganglion/xacpx-relay-protocol";
import { AlertTriangle, Bot, Check, ChevronDown, ChevronRight, ExternalLink, Loader2 } from "lucide-vue-next";
import { KIND_ICON } from "../lib/tool-summary";
import { resolveSubagentStatus } from "../lib/subagent-status";
import SubagentTraceDialog from "./SubagentTraceDialog.vue";

const props = defineProps<{ step: ToolStepDto; children: ToolStepDto[] }>();
const open = ref(false);
const dialogOpen = ref(false);
const paused = ref(false);
const activityIndex = ref(0);
let activityTimer: ReturnType<typeof setInterval> | undefined;

const status = computed(() => resolveSubagentStatus(props.step, props.children));
const activity = computed(() => {
  const running = props.children.filter((child) => child.status === "running");
  return running.length ? running : props.children.slice(-3);
});
const currentActivity = computed(() => activity.value.length ? activity.value[activityIndex.value % activity.value.length] : undefined);

watch(() => activity.value.map((step) => step.toolCallId).join("\0"), () => { activityIndex.value = 0; });

onMounted(() => {
  const reduceMotion = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduceMotion) return;
  activityTimer = setInterval(() => {
    if (!paused.value && !open.value && activity.value.length > 1) activityIndex.value += 1;
  }, 2400);
});
onBeforeUnmount(() => { if (activityTimer) clearInterval(activityTimer); });
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
          <span class="rounded-full bg-accent/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.12em] text-accent">{{ $t("tools.subagent") }}</span>
          <span class="truncate text-[12px] font-semibold text-fg">{{ step.title }}</span>
        </span>
        <span class="mt-0.5 block text-[10.5px] text-fg-muted">{{ $t("tools.traceCount", { count: children.length }) }}</span>
      </span>
      <span class="shrink-0">
        <Loader2 v-if="status === 'running'" data-test="subagent-running" :size="14" class="animate-spin motion-reduce:animate-none text-accent" />
        <AlertTriangle v-else-if="status === 'error'" data-test="subagent-error" :size="14" class="text-danger" />
        <Check v-else data-test="subagent-success" :size="14" class="text-run" />
      </span>
    </button>

    <div v-if="!open" data-test="subagent-activity" class="border-t border-border/70 bg-bg/45 px-3 py-2">
      <Transition name="activity-slide" mode="out-in">
        <div v-if="currentActivity" :key="currentActivity.toolCallId" class="flex min-w-0 items-center gap-2">
          <span class="h-1.5 w-1.5 shrink-0 rounded-full" :class="currentActivity.status === 'running' ? 'bg-accent' : currentActivity.status === 'error' ? 'bg-danger' : 'bg-run'" />
          <component :is="KIND_ICON[currentActivity.kind]" :size="12" class="shrink-0 text-fg-muted" />
          <span class="truncate font-mono text-[10.5px] text-fg-muted">{{ currentActivity.title }}</span>
          <span v-if="activity.length > 1" class="ml-auto shrink-0 font-mono text-[9.5px] tabular-nums text-fg-muted/70">
            {{ activityIndex % activity.length + 1 }}/{{ activity.length }}
          </span>
        </div>
        <div v-else key="waiting" class="flex items-center gap-2 text-[10.5px] text-fg-muted">
          <Loader2 v-if="status === 'running'" :size="12" class="animate-spin motion-reduce:animate-none text-accent" />
          <Check v-else :size="12" class="text-run" />
          <span>{{ status === "running" ? $t("tools.waitingForActivity") : $t("tools.noRecordedActivity") }}</span>
        </div>
      </Transition>
    </div>

    <div v-else data-test="subagent-timeline" class="border-t border-border bg-bg/30 px-3 pb-3 pt-2.5">
      <ol v-if="children.length" class="relative ml-1 space-y-1.5 before:absolute before:bottom-2 before:left-[7px] before:top-2 before:w-px before:bg-border">
        <li v-for="child in children" :key="child.toolCallId" class="relative flex min-w-0 items-center gap-2 pl-5">
          <span class="absolute left-0 grid h-3.5 w-3.5 place-items-center rounded-full border border-border bg-surface">
            <span class="h-1.5 w-1.5 rounded-full" :class="child.status === 'running' ? 'bg-accent' : child.status === 'error' ? 'bg-danger' : 'bg-run'" />
          </span>
          <component :is="KIND_ICON[child.kind]" :size="12" class="shrink-0 text-fg-muted" />
          <span class="truncate font-mono text-[10.5px] text-fg-muted">{{ child.title }}</span>
        </li>
      </ol>
      <p v-else class="py-1 text-[10.5px] text-fg-muted">{{ $t("tools.waitingForActivity") }}</p>
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
