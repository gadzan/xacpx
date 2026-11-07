<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
  AlertTriangle,
  Ban,
  Bot,
  Brain,
  CircleCheck,
  FileText,
  MessageSquare,
  Wrench,
} from "lucide-vue-next";
import type { TurnPresentationItem } from "../lib/turn-presentation";
import { traceLiveItems, traceLiveLimit, type TraceLiveItem } from "../lib/trace-live";
import { useIsMobile } from "../lib/use-dropdown";

/**
 * Fixed "what is happening now" stack above the full process.
 *
 * Input is the same `presentation.nodes` the timeline renders; `node.key` is the
 * identity, so a status/text update rewrites its row in place and an entrance
 * animation plays once per event, never once per part. Updates are coalesced to
 * one visual step per 120ms — fast runs read as the latest snapshot instead of a
 * flicker. A terminal run collapses the stack to one summary line and stops all
 * animation; the full process below is untouched.
 */
const props = withDefaults(defineProps<{
  nodes: TurnPresentationItem[];
  streaming?: boolean;
  terminal?: "done" | "failed" | "cancelled" | null;
}>(), {
  streaming: false,
  terminal: null,
});

const emit = defineEmits<{ reveal: [key: string] }>();

const { t } = useI18n();
const isMobile = useIsMobile();
const limit = computed(() => traceLiveLimit(isMobile.value));

const THROTTLE_MS = 120;
const BURST_MS = 600;
const ROW_HEIGHT = 34;

const labels = computed(() => ({
  text: t("group.detail.live.text"),
  reasoning: t("group.detail.live.reasoning"),
  message: t("group.detail.live.message"),
}));

const snapshot = ref<TraceLiveItem[]>([]);
/** Fast runs coalesce updates; those are exactly the ones that must not animate. */
const burst = ref(false);

let throttleTimer: ReturnType<typeof setTimeout> | undefined;
let burstTimer: ReturnType<typeof setTimeout> | undefined;
let pending: TraceLiveItem[] | undefined;
let lastFlushAt = 0;

const stackHeight = computed(() => `${limit.value * ROW_HEIGHT}px`);

function flush(): void {
  throttleTimer = undefined;
  lastFlushAt = Date.now();
  if (!pending) return;
  snapshot.value = pending;
  pending = undefined;
}

function markBurst(): void {
  burst.value = true;
  clearTimeout(burstTimer);
  burstTimer = setTimeout(() => { burst.value = false; }, BURST_MS);
}

function schedule(): void {
  if (props.terminal) {
    clearTimeout(throttleTimer);
    throttleTimer = undefined;
    pending = undefined;
    return;
  }
  const next = traceLiveItems(props.nodes, limit.value, labels.value, props.streaming);
  const now = Date.now();
  if (throttleTimer === undefined && now - lastFlushAt >= THROTTLE_MS) {
    lastFlushAt = now;
    snapshot.value = next;
    return;
  }
  if (throttleTimer !== undefined) markBurst();
  pending = next;
  if (throttleTimer !== undefined) return;
  throttleTimer = setTimeout(flush, THROTTLE_MS);
}

watch(
  () => [props.nodes, limit.value, props.streaming, props.terminal, labels.value] as const,
  schedule,
  { immediate: true },
);

onBeforeUnmount(() => {
  clearTimeout(throttleTimer);
  clearTimeout(burstTimer);
  throttleTimer = undefined;
  burstTimer = undefined;
});

const summary = computed(() => {
  switch (props.terminal) {
    case "done": return { label: t("group.detail.live.done"), cls: "text-run", icon: CircleCheck };
    case "failed": return { label: t("group.detail.live.failed"), cls: "text-danger", icon: AlertTriangle };
    case "cancelled": return { label: t("group.detail.live.cancelled"), cls: "text-fg-muted", icon: Ban };
    default: return null;
  }
});

function rowIcon(item: TraceLiveItem) {
  switch (item.kind) {
    case "reasoning": return Brain;
    case "subagent": return Bot;
    case "markdown": return FileText;
    case "agent-message": return MessageSquare;
    default: return Wrench;
  }
}

function showsPreview(item: TraceLiveItem): boolean {
  return (item.kind === "markdown" || item.kind === "reasoning") && !!item.preview;
}
</script>

<template>
  <section
    v-if="terminal || snapshot.length"
    data-test="trace-live-stack"
    class="sticky top-0 z-20 -mx-1 mb-1 rounded-lg bg-surface/85 px-1.5 py-1 shadow-sm backdrop-blur-sm"
  >
    <div
      v-if="summary"
      data-test="trace-live-summary"
      class="flex h-9 items-center gap-1.5 px-1 text-xs font-medium"
      :class="summary.cls"
    >
      <component :is="summary.icon" :size="14" class="shrink-0" aria-hidden="true" />
      <span>{{ summary.label }}</span>
    </div>
    <template v-else>
      <p data-test="trace-live-label" class="px-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-fg-muted/70">
        {{ $t("group.detail.live.label") }}
      </p>
      <TransitionGroup
        tag="ol"
        name="trace-live"
        class="relative"
        :class="{ 'trace-live--static': burst }"
        :style="{ height: stackHeight }"
      >
        <li
          v-for="item in snapshot"
          :key="item.key"
          data-test="trace-live-item"
          class="h-[34px]"
        >
          <button
            type="button"
            data-test="trace-live-row"
            class="flex h-full w-full min-w-0 items-center gap-1.5 rounded-sm px-1 text-left transition-colors hover:bg-fg/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            @click="emit('reveal', item.targetKey)"
          >
            <component :is="rowIcon(item)" :size="12" class="shrink-0 text-fg-muted" aria-hidden="true" />
            <span class="min-w-0 flex-1">
              <span class="flex min-w-0 items-center gap-1.5">
                <span class="truncate text-ui font-medium text-fg">{{ item.title }}</span>
                <span
                  v-if="item.status"
                  data-test="trace-live-status"
                  :data-status="item.status"
                  class="h-1.5 w-1.5 shrink-0 rounded-full"
                  :class="item.status === 'running' ? 'bg-accent animate-pulse motion-reduce:animate-none'
                    : item.status === 'error' ? 'bg-danger' : 'bg-run'"
                  :aria-label="$t(`tools.${item.status === 'running' ? 'running' : item.status === 'error' ? 'failed' : 'finished'}`)"
                />
                <span v-if="item.duration" class="shrink-0 font-mono text-[11px] tabular-nums text-fg-muted/70">{{ item.duration }}</span>
              </span>
              <span v-if="showsPreview(item)" data-test="trace-live-preview" class="block truncate text-[11px] leading-tight text-fg-muted/80">
                {{ item.preview }}
              </span>
            </span>
          </button>
        </li>
      </TransitionGroup>
    </template>
  </section>
</template>

<style scoped>
/* Transform + opacity only: no height/top animation, so live output never
 * triggers layout. `prefers-reduced-motion` turns the whole stack static. */
.trace-live-enter-active,
.trace-live-leave-active {
  transition: transform 160ms ease, opacity 160ms ease;
}
.trace-live-enter-from {
  opacity: 0;
  transform: translateY(-8px);
}
.trace-live-leave-to {
  opacity: 0;
  transform: translateY(6px);
}
.trace-live-leave-active {
  position: absolute;
  inset-inline: 0;
}
.trace-live-move {
  transition: transform 160ms ease;
}
.trace-live--static .trace-live-enter-active,
.trace-live--static .trace-live-move {
  transition: none;
}

@media (prefers-reduced-motion: reduce) {
  .trace-live-enter-active,
  .trace-live-leave-active,
  .trace-live-move {
    transition: none;
  }
}
</style>
