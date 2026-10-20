<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { X } from "lucide-vue-next";
import { computePopoverPlacement } from "../lib/group-run-presentation";
import { useI18n } from "vue-i18n";
import GroupRunDetailContent from "./GroupRunDetailContent.vue";
import type {
  ConversationRunDto,
  MemberTurnSummaryDto,
  PlanEntryDto,
  TurnPartDto,
} from "@ganglion/xacpx-relay-protocol";
import type { TraceReplayStatus } from "../lib/group-run-presentation";

const props = defineProps<{
  id: string;
  anchorEl: HTMLElement | null;
  scrollerEl: HTMLElement | null;
  run: ConversationRunDto;
  memberTurn?: MemberTurnSummaryDto;
  memberName?: string;
  attempt?: number;
  attempts?: number[];
  parts?: TurnPartDto[];
  siblingSummaries?: Array<{ name: string; state: string }>;
  recordingState?: TraceReplayStatus;
  completenessReason?: string;
  explanation?: string;
  plan?: PlanEntryDto[];
  traceLoading?: boolean;
  traceError?: string | null;
  traceHasMore?: boolean;
  traceHasEarlier?: boolean;
  traceStreaming?: boolean;
  stopAvailable?: boolean;
  stopPending?: boolean;
  traceFailure?: string;
}>();

const emit = defineEmits<{
  close: [];
  stop: [];
  attempt: [attempt: number];
  loadMore: [];
  loadEarlier: [];
  retryTrace: [];
}>();

const layerEl = ref<HTMLElement | null>(null);
const contentEl = ref<HTMLElement | null>(null);
/** Fit the viewport before the first frame: a phone must never render the
 *  desktop width and then shrink once placement is measured. */
const fitWidth = (): number => Math.max(0, Math.min(420, window.innerWidth - 16));
const width = ref(fitWidth());
const placement = ref({ top: 0, left: 0, maxHeight: 320, placement: "below" as "below" | "above" });
let measureHandle: number | null = null;
let resizeObserver: ResizeObserver | null = null;
let intersectionObserver: IntersectionObserver | null = null;

function updatePlacement(): void {
  const anchor = props.anchorEl;
  if (!anchor || !anchor.isConnected) {
    emit("close");
    return;
  }
  const anchorRect = anchor.getBoundingClientRect();
  // jsdom reports a zero rect for every element; a real anchor scrolled out
  // still has measurable area, so only measured geometry may prove off-screen.
  const measurable = anchorRect.width > 0 || anchorRect.height > 0;
  const scrollerRect = props.scrollerEl?.getBoundingClientRect();
  const scoped = !!scrollerRect && (scrollerRect.width > 0 || scrollerRect.height > 0);
  const top = scoped ? Math.max(0, scrollerRect!.top) : 0;
  const bottom = scoped ? Math.min(window.innerHeight, scrollerRect!.bottom) : window.innerHeight;
  const left = scoped ? Math.max(0, scrollerRect!.left) : 0;
  const right = scoped ? Math.min(window.innerWidth, scrollerRect!.right) : window.innerWidth;
  if (measurable && (anchorRect.bottom <= top || anchorRect.top >= bottom || anchorRect.right <= left || anchorRect.left >= right)) {
    emit("close");
    return;
  }
  width.value = fitWidth();
  const height = Math.min((contentEl.value?.scrollHeight ?? 280) + 46, window.innerHeight - 16);
  placement.value = computePopoverPlacement(
    { top: anchorRect.top, left: anchorRect.left, width: anchorRect.width, height: anchorRect.height },
    { width: window.innerWidth, height: window.innerHeight },
    { width: width.value, height },
  );
}

function schedulePlacement(): void {
  if (measureHandle !== null) return;
  measureHandle = requestAnimationFrame(() => {
    measureHandle = null;
    updatePlacement();
  });
}

function observeAnchor(): void {
  intersectionObserver?.disconnect();
  resizeObserver?.disconnect();
  if (props.anchorEl && typeof IntersectionObserver !== "undefined") {
    intersectionObserver = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.target === props.anchorEl && !entry.isIntersecting)) emit("close");
    }, { root: props.scrollerEl, threshold: 0 });
    intersectionObserver.observe(props.anchorEl);
  }
  if (typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(schedulePlacement);
    for (const element of [props.anchorEl, props.scrollerEl, layerEl.value, contentEl.value]) {
      if (element) resizeObserver.observe(element);
    }
  }
  void nextTick(schedulePlacement);
}

function onOutsidePointer(event: PointerEvent): void {
  const path = event.composedPath();
  if (layerEl.value && path.includes(layerEl.value)) return;
  if (props.anchorEl && path.includes(props.anchorEl)) return;
  emit("close");
}

function closeWithFocus(): void {
  emit("close");
  props.anchorEl?.focus({ preventScroll: true });
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== "Escape") return;
  event.preventDefault();
  event.stopPropagation();
  closeWithFocus();
}

watch([() => props.anchorEl, () => props.scrollerEl], observeAnchor, { flush: "post" });
watch(() => [props.attempt, props.parts, props.plan, props.traceLoading, props.traceError, props.recordingState],
  () => void nextTick(schedulePlacement), { deep: true, flush: "post" });

onMounted(() => {
  document.addEventListener("pointerdown", onOutsidePointer, true);
  window.addEventListener("keydown", onKeydown, true);
  window.addEventListener("resize", schedulePlacement, { passive: true });
  window.addEventListener("scroll", schedulePlacement, true);
  observeAnchor();
});

onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", onOutsidePointer, true);
  window.removeEventListener("keydown", onKeydown, true);
  window.removeEventListener("resize", schedulePlacement);
  window.removeEventListener("scroll", schedulePlacement, true);
  resizeObserver?.disconnect();
  intersectionObserver?.disconnect();
  if (measureHandle !== null) cancelAnimationFrame(measureHandle);
});

const style = computed(() => ({
  top: `${placement.value.top}px`,
  left: `${placement.value.left}px`,
  width: `${width.value}px`,
  maxHeight: `${placement.value.maxHeight}px`,
}));
</script>

<template>
  <Teleport to="body">
    <div class="group-detail-layer" data-test="group-detail-layer">
      <div
        :id="id"
        ref="layerEl"
        class="group-detail-card"
        data-test="group-detail-card"
        :data-run-id="run.id"
        :data-member-turn-id="memberTurn?.id"
        :data-attempt="attempt"
        role="dialog"
        :aria-label="$t('group.detail.title')"
        :style="style"
        :data-placement="placement.placement"
      >
        <div class="flex shrink-0 items-center justify-between gap-2 border-b border-fg/10 px-3 py-2">
          <span class="text-xs font-semibold text-fg-muted">{{ $t("group.detail.title") }}</span>
          <button
            type="button"
            data-test="group-detail-close"
            class="grid h-7 w-7 place-items-center rounded-sm text-fg-muted transition-colors hover:bg-fg/5 hover:text-fg"
            :aria-label="$t('group.detail.close')"
            @click.stop="closeWithFocus"
          >
            <X :size="14" />
          </button>
        </div>
        <div class="group-detail-scroll px-3 py-2">
          <div ref="contentEl">
            <GroupRunDetailContent
              :run="run"
              :member-turn="memberTurn"
              :member-name="memberName"
              :attempt="attempt"
              :attempts="attempts"
              :parts="parts"
              :sibling-summaries="siblingSummaries"
              :recording-state="recordingState"
              :completeness-reason="completenessReason"
              :explanation="explanation"
              :plan="plan"
              :trace-failure="traceFailure"
              :trace-loading="traceLoading"
              :trace-error="traceError"
              :trace-has-more="traceHasMore"
              :trace-has-earlier="traceHasEarlier"
              :trace-streaming="traceStreaming"
              :stop-available="stopAvailable"
              :stop-pending="stopPending"
              @stop="emit('stop')"
              @attempt="emit('attempt', $event)"
              @load-more="emit('loadMore')"
              @load-earlier="emit('loadEarlier')"
              @retry-trace="emit('retryTrace')"
            />
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.group-detail-layer {
  position: fixed;
  inset: 0;
  z-index: 60;
  pointer-events: none;
}
.group-detail-card {
  position: absolute;
  box-sizing: border-box;
  pointer-events: auto;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-radius: 14px;
  background: rgb(var(--c-surface));
  color: rgb(var(--c-fg));
  box-shadow: 0 12px 32px rgb(0 0 0 / 0.28), 0 2px 8px rgb(0 0 0 / 0.18);
  border: 1px solid rgb(var(--c-fg) / 0.08);
}
.group-detail-scroll {
  overflow-y: auto;
  overflow-wrap: anywhere;
  min-height: 0;
}
</style>
