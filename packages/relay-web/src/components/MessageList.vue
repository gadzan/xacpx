<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import type { ScheduledOriginDto } from "@ganglion/xacpx-relay-protocol";
import type { ChatMessage, LiveTurn } from "../stores/chat";
import StreamMarkdown from "./StreamMarkdown.vue";
import ToolCallPanel from "./ToolCallPanel.vue";
import ReasoningPanel from "./ReasoningPanel.vue";
import TurnParts from "./TurnParts.vue";
import CopyButton from "./CopyButton.vue";
import { AlertCircle, CircleStop, Clock, Loader2, RotateCcw, TriangleAlert } from "lucide-vue-next";
import AgentIcon from "./AgentIcon.vue";
import MessageAttachments from "./MessageAttachments.vue";
import { fmtTime, fmtDateTime } from "../lib/format";

const props = defineProps<{ messages: ChatMessage[]; liveTurn: LiveTurn | null; driver?: string | null; hasMoreOlder?: boolean; loadingOlder?: boolean; loadingHistory?: boolean; sessionKey?: string; scrollToScheduled?: { taskId: string; nonce: number } | null; ensureFull?: (messageId: number) => Promise<void> }>();
const emit = defineEmits<{ resend: [message: ChatMessage]; loadOlder: [] }>();

function ensureFullOf(m: ChatMessage): (() => Promise<void>) | undefined {
  const id = m.id;
  if (id === undefined || m.structured?.compact !== true || !props.ensureFull) return undefined;
  return () => props.ensureFull!(id);
}

// A message's schedule origin — set live on the optimistic row (`scheduled`) and
// persisted on history rows (`structured.scheduled`), so the badge survives a reload.
function schedOf(m: ChatMessage): ScheduledOriginDto | undefined {
  return m.scheduled ?? m.structured?.scheduled;
}

function messageKey(m: ChatMessage, index: number): string {
  const recordKey = m.id !== undefined ? `p${m.id}` : `o${m.createdAt}:${index}`;
  return `${m.instanceId}:${m.sessionAlias}:${recordKey}`;
}

// Initial-history skeleton: fills the pane while the first page of a freshly selected
// session loads. Only when the transcript is truly empty — a background reload (e.g.
// turn-finished convergence) or an already-streaming turn never triggers it.
const showSkeleton = computed(() =>
  (props.loadingHistory ?? false)
  && props.messages.length === 0
  && !(props.liveTurn && props.liveTurn.parts.length > 0));

// Alternates agent cards / user bubbles with varied widths so the placeholder reads as
// a conversation, not a form. Rows pulse with a staggered delay (see --sk-delay).
const SKELETON_ROWS = [
  { kind: "agent", w: "64%", lines: 2 },
  { kind: "user", w: "44%", lines: 1 },
  { kind: "agent", w: "82%", lines: 2 },
  { kind: "user", w: "58%", lines: 2 },
  { kind: "agent", w: "38%", lines: 1 },
] as const;

// Stick-to-bottom: keep the newest content in view while the user is at the bottom,
// but don't yank them down if they've scrolled up to read history. A "jump to latest"
// affordance appears whenever we're detached from the bottom.
const scroller = ref<HTMLElement | null>(null);
const atBottom = ref(true);
const THRESHOLD = 48; // px from bottom still counts as "at bottom"
const TOP_THRESHOLD = 240; // px from top that triggers a "load older" page fetch

// Progressive tail-first mounting: switching to a session with a long history would
// otherwise create every row's component tree (markdown-it parse + DOMPurify per text
// part) in a single tick. Mount only the newest INITIAL_ROWS immediately, then reveal
// the older rows in rAF batches — `content-visibility` already keeps them cheap to
// paint, this keeps them cheap to CREATE. `hiddenCount` = oldest rows not yet mounted.
const INITIAL_ROWS = 30;
const REVEAL_BATCH = 30;
const hiddenCount = ref(0);
const visibleMessages = computed(() => (hiddenCount.value > 0 ? props.messages.slice(hiddenCount.value) : props.messages));
let revealRaf = 0;

function revealStep(): void {
  revealRaf = 0;
  if (hiddenCount.value <= 0) return;
  // Revealing rows PREPENDS content: pin the viewport the same way load-older does —
  // re-stick to the bottom when pinned there, else keep distance-from-bottom invariant.
  const el = scroller.value;
  const anchor = el && !atBottom.value ? el.scrollHeight - el.scrollTop : null;
  hiddenCount.value = Math.max(0, hiddenCount.value - REVEAL_BATCH);
  void nextTick(() => {
    const e = scroller.value;
    if (e) {
      if (anchor !== null) e.scrollTop = e.scrollHeight - anchor;
      else if (atBottom.value) e.scrollTop = e.scrollHeight;
    }
    if (hiddenCount.value > 0) revealRaf = requestAnimationFrame(revealStep);
  });
}

function scheduleReveal(): void {
  if (hiddenCount.value <= 0 || revealRaf) return;
  // jsdom / engines without rAF: mount everything synchronously (tests see full lists).
  if (typeof requestAnimationFrame !== "function") {
    hiddenCount.value = 0;
    return;
  }
  revealRaf = requestAnimationFrame(revealStep);
}

onBeforeUnmount(() => {
  if (revealRaf) cancelAnimationFrame(revealRaf);
  revealRaf = 0;
  if (settleRaf) cancelAnimationFrame(settleRaf);
  settleRaf = 0;
  clearEnterWaits();
});

// Arm progressive mounting when a freshly selected session's rows land. Two shapes:
// the 0→many jump (select empties `messages` first, then history lands), and the
// cache-seeded replace (≤INITIAL_ROWS stale rows from the tail cache swap to the full
// authoritative page without passing through 0 — spec #205). The seeded rows are the
// newest of the page, so stable keys keep them mounted; only the PREPENDED older rows
// hide and reveal in rAF batches. The prev-length + big-jump guard keeps ordinary
// in-place convergence (turn-finished reload, small append bursts) and load-older
// prepends (prev is already ≥ a full page there) from churning mounted components.
watch(
  () => props.messages.length,
  (now, prev) => {
    const freshJump = prev === 0 && now > INITIAL_ROWS;
    const cacheSeededReplace = prev > 0 && prev <= INITIAL_ROWS && now - prev >= REVEAL_BATCH;
    if (freshJump || cacheSeededReplace) {
      hiddenCount.value = now - INITIAL_ROWS;
      scheduleReveal();
    } else if (hiddenCount.value > now) {
      hiddenCount.value = Math.max(0, now - INITIAL_ROWS);
    }
  },
);

// Distance-from-bottom captured when a "load older" fetch starts, so we can restore the
// exact scroll position after the older page is PREPENDED (prepend only grows the top, so
// distance-from-bottom is content-invariant). Null when no prepend is pending.
let pendingDistFromBottom: number | null = null;

function onScroll(): void {
  const el = scroller.value;
  if (!el) return;
  atBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight <= THRESHOLD;
  // Near the top while older rows are still mounting locally → nothing to fetch yet;
  // the reveal loop is already draining hiddenCount.
  if (hiddenCount.value > 0) return;
  // Near the top with older history available → fetch the previous page. Capture the
  // anchor first; the prepend watcher below restores position once the rows arrive.
  if (el.scrollTop <= TOP_THRESHOLD && props.hasMoreOlder && !props.loadingOlder && pendingDistFromBottom === null) {
    pendingDistFromBottom = el.scrollHeight - el.scrollTop;
    emit("loadOlder");
  }
}

// When a "load older" fetch finishes (loadingOlder true→false, after the store has
// prepended the page), restore the prior view by pinning distance-from-bottom so the
// content the user was reading doesn't jump. Self-clears even on an empty/failed load.
watch(
  () => props.loadingOlder,
  (now, prev) => {
    if (!(prev && !now) || pendingDistFromBottom === null) return;
    const anchor = pendingDistFromBottom;
    pendingDistFromBottom = null;
    void nextTick(() => {
      const el = scroller.value;
      if (el) el.scrollTop = el.scrollHeight - anchor;
    });
  },
);

// Entrance choreography: switching sessions repositions the scroller several times
// before the pane rests at the newest message (the cache seed or first page lands,
// then content-visibility estimates settle). Painting those intermediate states
// reads as a flash-then-yank. Instead HOLD the transcript invisible (opacity only —
// layout and scroll math run as usual) until the FIRST content is pinned to the
// bottom, then PLAY a bottom-anchored staggered rise, so the first frame the user
// perceives is already resting at the latest message. The later authoritative
// replace of a cache-seeded tail is NOT covered by the hold — it stays flicker-free
// through stable row keys and the bottom pin instead (spec #205).
const enterPhase = ref<"idle" | "hold" | "play">("idle");
let enterRaf = 0;
let enterTimer: ReturnType<typeof setTimeout> | null = null;
const ENTER_HOLD_MAX_MS = 800; // safety: never keep landed content hidden if the pin frames stall
// Play window: must cover the CSS enter-rise duration (380ms, see <style>) plus the
// newest row's stagger delay ((ENTER_STAGGER - 1) * ENTER_STEP_MS = 275ms) — keep the
// three in step. Afterwards the anim classes drop so rows return to pristine.
const ENTER_PLAY_MS = 700;

function clearEnterWaits(): void {
  if (enterRaf) { cancelAnimationFrame(enterRaf); enterRaf = 0; }
  if (enterTimer !== null) { clearTimeout(enterTimer); enterTimer = null; }
}

function armEnterCap(): void {
  if (enterTimer !== null) clearTimeout(enterTimer);
  enterTimer = setTimeout(finishEnter, ENTER_HOLD_MAX_MS);
}

function beginEnter(): void {
  clearEnterWaits();
  enterPhase.value = "hold";
  armEnterCap();
}

function finishEnter(): void {
  if (enterPhase.value !== "hold") return;
  clearEnterWaits();
  enterPhase.value = "play";
  // Back to pristine (no animation/filter classes) once the entrance has fully played.
  enterTimer = setTimeout(() => {
    enterTimer = null;
    if (enterPhase.value === "play") enterPhase.value = "idle";
  }, ENTER_PLAY_MS);
}

// The component may mount with a session already selected (page refresh restores the
// selection before ChatPane renders) — that first load needs the same hold.
if (props.sessionKey && props.messages.length === 0) beginEnter();

// Ready signal 1: content landed (history rows or a live turn). Release only once the
// bottom pin has settled — scrollToBottom's content-visibility settle loop re-pins for
// up to 4 frames on long histories, so wait (bounded) for it to drain instead of a
// fixed frame count; releasing earlier would let late settle frames move scrollTop
// mid-PLAY.
watch(
  () => [props.messages.length, props.liveTurn?.parts.length ?? 0] as const,
  ([msgs, liveParts]) => {
    if (enterPhase.value !== "hold" || (msgs === 0 && liveParts === 0)) return;
    void nextTick(() => {
      if (enterPhase.value !== "hold") return;
      if (typeof requestAnimationFrame !== "function") { finishEnter(); return; }
      if (enterRaf) cancelAnimationFrame(enterRaf);
      let framesLeft = 8;
      const waitPinned = (): void => {
        enterRaf = 0;
        if (enterPhase.value !== "hold") return;
        framesLeft -= 1;
        // At least two frames for the pin to paint, then require the settle loop idle.
        if (framesLeft <= 0 || (framesLeft <= 6 && settleRaf === 0)) { finishEnter(); return; }
        enterRaf = requestAnimationFrame(waitPinned);
      };
      enterRaf = requestAnimationFrame(waitPinned);
    });
  },
);

// Ready signal 2 + slow-load guard: while the initial page is in flight the skeleton
// owns the pane, so SUSPEND the safety cap — otherwise a >800ms load would burn the
// hold behind the skeleton and the late-landing transcript would paint unheld (the
// exact yank this exists to prevent). The load's completion always re-signals: an
// empty session releases immediately (nothing to position); a page with rows is
// released by ready signal 1's pin frames, with the cap re-armed as the fallback.
watch(
  () => props.loadingHistory,
  (now, prev) => {
    if (enterPhase.value !== "hold") return;
    if (now) {
      if (enterTimer !== null) { clearTimeout(enterTimer); enterTimer = null; }
      return;
    }
    if (!prev) return;
    if (props.messages.length === 0 && !(props.liveTurn && props.liveTurn.parts.length)) finishEnter();
    else armEnterCap();
  },
);

// Staggered rise: during PLAY every row shares the same rise, but the last few rows
// cascade individually toward the newest message (largest delay = the freshest row
// lands last). Older rows all start at delay 0 — most sit above the viewport anyway,
// and content-visibility skips painting them.
const ENTER_STAGGER = 6;
const ENTER_STEP_MS = 55;
const enterRowClass = computed(() => (enterPhase.value === "play" ? "enter-row" : ""));
const newestRowIndex = computed(() =>
  visibleMessages.value.length - (props.liveTurn && props.liveTurn.parts.length ? 0 : 1));
function enterStyle(rowIndex: number): Record<string, string> | undefined {
  if (enterPhase.value !== "play") return undefined;
  const fromBottom = newestRowIndex.value - rowIndex;
  const rank = Math.max(0, ENTER_STAGGER - 1 - fromBottom);
  return rank > 0 ? { "--enter-delay": `${rank * ENTER_STEP_MS}ms` } : undefined;
}

let settleRaf = 0;
function scrollToBottom(smooth = false): void {
  const el = scroller.value;
  if (!el) return;
  if (typeof el.scrollTo === "function") el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  else el.scrollTop = el.scrollHeight; // jsdom / older engines
  atBottom.value = true;
  // `content-visibility:auto` rows render lazily at the contain-intrinsic-size ESTIMATE,
  // so on a long history the first jump can stop short of the true bottom (the real row
  // heights aren't known until they paint). Re-pin over the next few frames as the
  // newly-revealed rows settle. Skipped for smooth (the "↓ Latest" affordance) so we
  // don't fight the animation, and where rAF is unavailable (jsdom tests).
  if (smooth || typeof requestAnimationFrame !== "function") return;
  if (settleRaf) cancelAnimationFrame(settleRaf);
  let tries = 0;
  const settle = (): void => {
    settleRaf = 0;
    const e = scroller.value;
    if (!e) return;
    if (e.scrollHeight - e.scrollTop - e.clientHeight > 1) e.scrollTop = e.scrollHeight;
    if (++tries < 4) settleRaf = requestAnimationFrame(settle);
  };
  settleRaf = requestAnimationFrame(settle);
}

// Switching sessions: the newly selected session starts at the bottom (newest message),
// regardless of where the user had scrolled in the previous one. Reset the stick-to-bottom
// state so the history that loads in (async) gets pinned to the bottom by the watch below.
watch(
  () => props.sessionKey,
  () => {
    atBottom.value = true;
    pendingDistFromBottom = null;
    beginEnter();
    void nextTick(() => scrollToBottom(false));
  },
);

// "View" on a fired task (ScheduledTasks panel) jumps the conversation to that run.
// Nonce-keyed so clicking View again on the same task re-triggers the scroll. Finds the
// inbound row tagged with the task id; if it isn't loaded (older history), pages aren't
// auto-fetched here — the badge still anchors it once scrolled into the loaded range.
watch(
  () => props.scrollToScheduled?.nonce,
  () => {
    const taskId = props.scrollToScheduled?.taskId;
    if (!taskId) return;
    void nextTick(() => {
      // Task ids are sanitized to [0-9a-z], so a plain attribute selector is safe.
      const el = scroller.value?.querySelector(`[data-scheduled-task="${taskId}"]`);
      if (el && typeof el.scrollIntoView === "function") {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        atBottom.value = false;
      }
    });
  },
);

// New messages / streaming chunks / tool steps: follow only if already pinned to bottom.
// The tail signal reacts to new parts AND growth of the final part (text length or a
// tool's status flipping) so streaming keeps the latest content in view.
watch(
  () => {
    const lt = props.liveTurn;
    const last = lt?.parts[lt.parts.length - 1];
    const tail = last ? (last.type === "tool" ? last.step.status : last.text.length) : 0;
    return [props.messages.length, lt?.parts.length ?? 0, tail] as const;
  },
  () => {
    if (atBottom.value) void nextTick(() => scrollToBottom(false));
  },
);
</script>

<template>
  <div class="relative flex-1 overflow-hidden">
    <div ref="scroller" data-test="msg-scroller" class="thin-scroll h-full overflow-y-auto py-4 pl-3 pr-3 lg:py-5 lg:pl-5 lg:pr-5"
         @scroll="onScroll">
      <!-- Initial-history skeleton: top-anchored to match how the real transcript stacks
           top-to-bottom, then swap for the real content the instant rows arrive. -->
      <div v-if="showSkeleton" data-test="history-skeleton" aria-hidden="true"
           class="mx-auto flex max-w-3xl flex-col gap-5">
        <template v-for="(row, i) in SKELETON_ROWS" :key="i">
          <!-- user bubble -->
          <div v-if="row.kind === 'user'" class="flex justify-end" :style="{ '--sk-delay': `${i * 160}ms` }">
            <div class="space-y-1.5 rounded-2xl rounded-tr-md border border-accent/10 bg-accent/5 px-3.5 py-2.5" :style="{ width: row.w }">
              <div v-for="n in row.lines" :key="n" class="sk-bar h-3 rounded bg-accent/15"
                   :style="{ width: n === row.lines ? '58%' : '100%' }" />
            </div>
          </div>
          <!-- agent response -->
          <div v-else class="flex gap-2.5" :style="{ '--sk-delay': `${i * 160}ms` }">
            <div class="sk-bar mt-0.5 h-6 w-6 shrink-0 rounded-full bg-fg/10" />
            <div class="min-w-0 flex-1 space-y-2 py-1">
              <div v-for="n in row.lines" :key="n" class="sk-bar h-3 rounded bg-fg/10"
                   :style="{ width: n === row.lines ? row.w : '100%' }" />
            </div>
          </div>
        </template>
      </div>
      <div v-else class="mx-auto max-w-3xl space-y-5" :class="{ 'enter-hold': enterPhase === 'hold' }">
        <!-- Older-history affordance: a spinner while a page loads, else a hint that more
             exists. Prepending older rows keeps the scroll position pinned (see watcher). -->
        <div v-if="loadingOlder" data-test="loading-older" class="flex justify-center py-1 text-[11px] text-fg-muted">
          <Loader2 :size="13" class="animate-spin motion-reduce:animate-none" />
        </div>
        <!-- Stable keys (persisted id, else an optimistic-row key) so a prepend doesn't
             re-key/re-render every row — avoids markdown re-parse + scroll jank.
             `visibleMessages` mounts tail-first (progressive reveal, see hiddenCount);
             the key index is translated back to the FULL-array index so optimistic-row
             keys stay stable while older rows are still being revealed above. -->
        <template v-for="(m, i) in visibleMessages" :key="messageKey(m, hiddenCount + i)">
          <!-- USER row -->
          <div v-if="m.direction === 'in'" class="cv-row flex justify-end" :class="enterRowClass"
               :style="enterStyle(i)"
               :data-scheduled-task="schedOf(m)?.taskId">
            <!-- min-w-0: without it the flex item's min-width:auto tracks a wide <pre>/table
                 min-content and can defeat the max-w-[80%] cap. -->
            <div class="flex min-w-0 max-w-[80%] flex-col items-end">
              <!-- Provenance badge for a fired scheduled task: this prompt wasn't typed now. -->
              <span v-if="schedOf(m)" data-test="msg-scheduled-badge"
                    class="mb-1 inline-flex items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-[10.5px] font-medium text-accent"
                    :title="`${$t('chat.scheduledFor')} ${fmtDateTime(schedOf(m)!.executeAt)}`">
                <Clock :size="11" />{{ $t("chat.scheduled") }}
              </span>
              <div data-test="msg-in"
                   class="min-w-0 max-w-full rounded-2xl rounded-tr-md border px-3.5 py-2"
                   :class="m.failed ? 'border-danger/30 bg-danger/5' : 'border-accent/15 bg-accent/10'">
                <StreamMarkdown v-if="m.text" :text="m.text" class="text-[14px] leading-relaxed text-fg" />
                <MessageAttachments v-if="m.attachments?.length" :attachments="m.attachments" />
              </div>
              <!-- Markdown rendering is lossy (headers, lists, fences reshape the text);
                   copy hands back the verbatim source the user actually sent. -->
              <div v-if="m.text" class="mt-0.5 flex items-center text-fg-muted">
                <CopyButton :text="m.text" />
              </div>
              <!-- Failed sends get a compact retry affordance on their own line below. -->
              <div v-if="m.failed" class="mt-1.5 flex items-center gap-2">
                <span data-test="msg-failed" class="inline-flex items-center gap-1 text-[11px] font-medium text-danger">
                  <AlertCircle :size="12" class="shrink-0" />{{ $t("chat.failedToSend") }}</span>
                <button type="button" data-test="msg-resend"
                        class="inline-flex items-center gap-1 rounded-md border border-accent/30 bg-accent/10 px-2 py-0.5 text-[11px] font-medium text-accent transition-colors hover:bg-accent/20"
                        :title='$t("chat.resendThis")' @click="emit('resend', m)"><RotateCcw :size="11" />{{ $t("chat.resend") }}</button>
              </div>
            </div>
          </div>
          <!-- ASSISTANT row -->
          <div v-else class="cv-row group flex gap-2.5" :class="enterRowClass" :style="enterStyle(i)">
            <div class="mt-0.5 grid h-6 w-6 shrink-0 place-items-center overflow-hidden">
              <AgentIcon :driver="driver" :size="15" fill />
            </div>
            <div data-test="msg-out" class="min-w-0 flex-1 space-y-2.5"
                 :class="m.failed ? 'rounded-lg ring-1 ring-danger/40' : ''">
              <!-- Structured transcript: activity cards stay grouped above one continuous
                   Markdown narrative. Tool cards own their collapsed state. -->
              <div data-test="msg-content" class="space-y-2.5">
                <TurnParts v-if="m.structured?.parts?.length" :parts="m.structured.parts" :ensure-full="ensureFullOf(m)" />
                <!-- Legacy rows persisted before `parts`: aggregated fallback. -->
                <template v-else>
                  <ToolCallPanel v-if="m.structured?.toolSteps?.length" :steps="m.structured.toolSteps" :ensure-full="ensureFullOf(m)" />
                  <ReasoningPanel v-if="m.structured?.reasoning?.trim()" :reasoning="m.structured.reasoning" :default-open="false" />
                  <StreamMarkdown v-if="m.text" :text="m.text" class="text-[14px] leading-relaxed text-fg" />
                </template>
              </div>
              <div data-test="msg-actions" class="flex items-center gap-1.5 pt-0.5 text-fg-muted">
                <CopyButton v-if="m.text" :text="m.text" />
                <span v-if="fmtTime(m.createdAt)" data-test="msg-time" class="font-mono text-[10.5px] tabular-nums">{{ fmtTime(m.createdAt) }}</span>
                <span v-if="m.structured?.truncated" data-test="msg-truncated" class="inline-flex items-center gap-1 text-[11px] text-warn"><TriangleAlert :size="12" /> {{ $t("chat.truncated") }}</span>
                <span v-if="m.status === 'cancelled'" data-test="msg-cancelled" class="inline-flex items-center gap-1 text-[11px] text-warn"><CircleStop :size="12" /> {{ $t("chat.stopped") }}</span>
                <span v-if="m.failed" data-test="msg-failed" class="inline-flex items-center gap-1 text-[11px] text-danger"><AlertCircle :size="11" />{{ $t("chat.failed") }}</span>
              </div>
            </div>
          </div>
        </template>

        <!-- live streaming assistant row -->
        <div v-if="liveTurn && liveTurn.parts.length" class="flex gap-2.5" :class="enterRowClass"
             :style="enterStyle(visibleMessages.length)">
          <div class="mt-0.5 grid h-6 w-6 shrink-0 place-items-center overflow-hidden">
            <AgentIcon :driver="driver" :size="15" fill />
          </div>
          <div data-test="msg-streaming" class="min-w-0 flex-1">
            <TurnParts :parts="liveTurn.parts" :streaming="true" />
          </div>
        </div>
      </div>
    </div>

    <button
      v-show="!atBottom"
      data-test="jump-latest"
      type="button"
      class="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-border bg-raised px-3 py-1 text-xs text-fg-muted shadow hover:bg-fg/5"
      @click="scrollToBottom(true)"
    >
      {{ $t("chat.jumpLatest") }}
    </button>
  </div>
</template>

<style scoped>
/* Virtualize the transcript without a JS windowing library: the browser skips layout
   and paint for off-screen rows, so a long history (paginated in via load-older) stays
   smooth no matter how heavy each row is (markdown, tool cards, diffs). `auto` in
   contain-intrinsic-size makes each row remember its real size once rendered, keeping
   the scrollbar stable; the 88px is only the first-paint estimate for never-seen rows.
   Rows remain in the DOM, so streaming, variable heights, expand/collapse, find-in-page
   and the prepend scroll-anchor all keep working. */
.cv-row {
  content-visibility: auto;
  contain-intrinsic-size: auto 88px;
}

/* Entrance choreography (see enterPhase): HOLD keeps the transcript laid out but
   invisible while the scroller is being positioned — opacity (not display/visibility)
   so scrollHeight/scrollTop math behaves exactly as when visible. PLAY then lifts the
   rows in from below with a slight de-blur; each of the last few rows adds
   --enter-delay so the cascade lands on the newest message. */
.enter-hold {
  opacity: 0;
}
.enter-row {
  animation: enter-rise 380ms cubic-bezier(0.22, 1, 0.36, 1) both;
  animation-delay: var(--enter-delay, 0ms);
}
@keyframes enter-rise {
  from {
    opacity: 0;
    transform: translateY(18px) scale(0.985);
    filter: blur(4px);
  }
  to {
    opacity: 1;
    transform: none;
    filter: none;
  }
}
@media (prefers-reduced-motion: reduce) {
  .enter-row { animation: none; }
}

/* Skeleton shimmer: each row inherits --sk-delay from its root so the pulse cascades
   top-to-bottom instead of breathing in unison. */
.sk-bar {
  animation: sk-pulse 1.8s ease-in-out infinite;
  animation-delay: var(--sk-delay, 0ms);
}
@keyframes sk-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.45; }
}
@media (prefers-reduced-motion: reduce) {
  .sk-bar { animation: none; }
}
</style>
