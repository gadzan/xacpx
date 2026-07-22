<script setup lang="ts">
import { nextTick, ref, useId, watch } from "vue";
import type { ChatMessage, LiveTurn } from "../stores/chat";
import StreamMarkdown from "./StreamMarkdown.vue";
import ToolCallPanel from "./ToolCallPanel.vue";
import ReasoningPanel from "./ReasoningPanel.vue";
import TurnParts from "./TurnParts.vue";
import CopyButton from "./CopyButton.vue";
import { AlertCircle, ChevronRight, CircleStop, Clock, Loader2, RotateCcw } from "lucide-vue-next";
import AgentIcon from "./AgentIcon.vue";
import MessageAttachments from "./MessageAttachments.vue";
import { fmtTime, fmtDateTime } from "../lib/format";

const props = defineProps<{ messages: ChatMessage[]; liveTurn: LiveTurn | null; driver?: string | null; hasMoreOlder?: boolean; loadingOlder?: boolean; sessionKey?: string; scrollToScheduled?: { taskId: string; nonce: number } | null }>();
const emit = defineEmits<{ resend: [message: ChatMessage]; loadOlder: [] }>();

import type { ScheduledOriginDto } from "@ganglion/xacpx-relay-protocol";
// A message's schedule origin — set live on the optimistic row (`scheduled`) and
// persisted on history rows (`structured.scheduled`), so the badge survives a reload.
function schedOf(m: ChatMessage): ScheduledOriginDto | undefined {
  return m.scheduled ?? m.structured?.scheduled;
}

// Completed agent messages are compact history cards. Each row starts collapsed and
// owns its open state for as long as this message list stays mounted; live output uses
// the separate streaming row below and remains fully visible while the agent works.
const expandedMessages = ref<Set<string>>(new Set());
const messageListId = useId();

function messageKey(m: ChatMessage, index: number): string {
  const recordKey = m.id !== undefined ? `p${m.id}` : `o${m.createdAt}:${index}`;
  return `${m.instanceId}:${m.sessionAlias}:${recordKey}`;
}

function isMessageExpanded(m: ChatMessage, index: number): boolean {
  return expandedMessages.value.has(messageKey(m, index));
}

function toggleMessage(m: ChatMessage, index: number): void {
  const key = messageKey(m, index);
  const next = new Set(expandedMessages.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  expandedMessages.value = next;
}

function messagePreview(m: ChatMessage): string {
  return m.text.trim().replace(/\s+/g, " ");
}

// Stick-to-bottom: keep the newest content in view while the user is at the bottom,
// but don't yank them down if they've scrolled up to read history. A "jump to latest"
// affordance appears whenever we're detached from the bottom.
const scroller = ref<HTMLElement | null>(null);
const atBottom = ref(true);
const THRESHOLD = 48; // px from bottom still counts as "at bottom"
const TOP_THRESHOLD = 240; // px from top that triggers a "load older" page fetch

// Distance-from-bottom captured when a "load older" fetch starts, so we can restore the
// exact scroll position after the older page is PREPENDED (prepend only grows the top, so
// distance-from-bottom is content-invariant). Null when no prepend is pending.
let pendingDistFromBottom: number | null = null;

function onScroll(): void {
  const el = scroller.value;
  if (!el) return;
  atBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight <= THRESHOLD;
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
    <div ref="scroller" data-test="msg-scroller" class="thin-scroll h-full overflow-y-auto px-3 py-4 lg:px-5 lg:py-5" @scroll="onScroll">
      <div class="mx-auto max-w-3xl space-y-5">
        <!-- Older-history affordance: a spinner while a page loads, else a hint that more
             exists. Prepending older rows keeps the scroll position pinned (see watcher). -->
        <div v-if="loadingOlder" data-test="loading-older" class="flex justify-center py-1 text-[11px] text-fg-muted">
          <Loader2 :size="13" class="animate-spin motion-reduce:animate-none" />
        </div>
        <!-- Stable keys (persisted id, else an optimistic-row key) so a prepend doesn't
             re-key/re-render every row — avoids markdown re-parse + scroll jank. -->
        <template v-for="(m, i) in messages" :key="messageKey(m, i)">
          <!-- USER row -->
          <div v-if="m.direction === 'in'" class="cv-row flex justify-end"
               :data-scheduled-task="schedOf(m)?.taskId">
            <div class="flex max-w-[80%] flex-col items-end">
              <!-- Provenance badge for a fired scheduled task: this prompt wasn't typed now. -->
              <span v-if="schedOf(m)" data-test="msg-scheduled-badge"
                    class="mb-1 inline-flex items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-[10.5px] font-medium text-accent"
                    :title="`${$t('chat.scheduledFor')} ${fmtDateTime(schedOf(m)!.executeAt)}`">
                <Clock :size="11" />{{ $t("chat.scheduled") }}
              </span>
              <div data-test="msg-in"
                   class="rounded-2xl rounded-tr-md border px-3.5 py-2"
                   :class="m.failed ? 'border-danger/30 bg-danger/5' : 'border-accent/15 bg-accent/10'">
                <p class="whitespace-pre-wrap text-[14px] leading-relaxed text-fg">{{ m.text }}</p>
                <MessageAttachments v-if="m.attachments?.length" :attachments="m.attachments" />
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
          <div v-else class="cv-row group flex gap-2.5">
            <div class="mt-0.5 grid h-6 w-6 shrink-0 place-items-center overflow-hidden">
              <AgentIcon :driver="driver" :size="15" fill />
            </div>
            <div data-test="msg-out" class="min-w-0 flex-1 overflow-hidden rounded-lg border border-border/70 bg-raised/35"
                 :class="m.failed ? 'ring-1 ring-danger/40' : ''">
              <button type="button" data-test="msg-toggle"
                      class="flex w-full min-w-0 items-center gap-1.5 px-2.5 py-1.5 text-left transition-colors hover:bg-fg/5"
                      :aria-expanded="isMessageExpanded(m, i)"
                      :aria-controls="`${messageListId}-agent-message-content-${i}`"
                      :aria-label="$t(isMessageExpanded(m, i) ? 'chat.collapseAgentMessage' : 'chat.expandAgentMessage')"
                      @click="toggleMessage(m, i)">
                <ChevronRight :size="13" class="shrink-0 text-fg-muted transition-transform"
                              :class="isMessageExpanded(m, i) ? 'rotate-90' : ''" />
                <span class="min-w-0 flex-1 truncate text-[13px] text-fg-muted">
                  {{ messagePreview(m) || $t("chat.agentActivity") }}
                </span>
                <span v-if="m.status === 'cancelled'" data-test="msg-cancelled" class="inline-flex shrink-0 items-center gap-1 text-[11px] text-warn"><CircleStop :size="12" /> {{ $t("chat.stopped") }}</span>
                <span v-if="m.failed" data-test="msg-failed" class="inline-flex shrink-0 items-center gap-1 text-[11px] text-danger"><AlertCircle :size="11" />{{ $t("chat.failed") }}</span>
                <span v-if="fmtTime(m.createdAt)" data-test="msg-time" class="shrink-0 font-mono text-[10.5px] tabular-nums text-fg-muted">{{ fmtTime(m.createdAt) }}</span>
              </button>
              <div v-if="isMessageExpanded(m, i)" :id="`${messageListId}-agent-message-content-${i}`" data-test="msg-content"
                   class="space-y-2.5 border-t border-border/70 px-2.5 py-2.5">
                <!-- Ordered transcript (text / reasoning / tools inline). -->
                <TurnParts v-if="m.structured?.parts?.length" :parts="m.structured.parts" />
                <!-- Legacy rows persisted before `parts`: aggregated fallback. -->
                <template v-else>
                  <ToolCallPanel v-if="m.structured?.toolSteps?.length" :steps="m.structured.toolSteps" />
                  <ReasoningPanel v-if="m.structured?.reasoning?.trim()" :reasoning="m.structured.reasoning" :default-open="false" />
                  <StreamMarkdown v-if="m.text" :text="m.text" class="text-[14px] leading-relaxed text-fg" />
                </template>
                <!-- Time and status stay in the always-visible header; expanded content
                     only needs the copy action on its own final line. -->
                <div v-if="m.text" data-test="msg-actions" class="flex items-center pt-0.5 text-fg-muted">
                  <CopyButton :text="m.text" />
                </div>
              </div>
            </div>
          </div>
        </template>

        <!-- live streaming assistant row -->
        <div v-if="liveTurn && liveTurn.parts.length" class="flex gap-2.5">
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
</style>
