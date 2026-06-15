<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import type { ChatMessage, LiveTurn } from "../stores/chat";
import StreamMarkdown from "./StreamMarkdown.vue";
import ToolCallPanel from "./ToolCallPanel.vue";
import ReasoningPanel from "./ReasoningPanel.vue";
import TurnParts from "./TurnParts.vue";
import CopyButton from "./CopyButton.vue";
import { Bot, CircleStop } from "lucide-vue-next";

const props = defineProps<{ messages: ChatMessage[]; liveTurn: LiveTurn | null }>();

// Stick-to-bottom: keep the newest content in view while the user is at the bottom,
// but don't yank them down if they've scrolled up to read history. A "jump to latest"
// affordance appears whenever we're detached from the bottom.
const scroller = ref<HTMLElement | null>(null);
const atBottom = ref(true);
const THRESHOLD = 48; // px from bottom still counts as "at bottom"

function onScroll(): void {
  const el = scroller.value;
  if (!el) return;
  atBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight <= THRESHOLD;
}

function scrollToBottom(smooth = false): void {
  const el = scroller.value;
  if (!el) return;
  if (typeof el.scrollTo === "function") el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  else el.scrollTop = el.scrollHeight; // jsdom / older engines
  atBottom.value = true;
}

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

// Compact local time for the per-message action/info row (e.g. "15:45").
function fmtTime(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
</script>

<template>
  <div class="relative flex-1 overflow-hidden">
    <div ref="scroller" data-test="msg-scroller" class="thin-scroll h-full overflow-y-auto px-5 py-5" @scroll="onScroll">
      <div class="mx-auto max-w-3xl space-y-5">
        <template v-for="(m, i) in messages" :key="i">
          <!-- USER row -->
          <div v-if="m.direction === 'in'" class="flex justify-end">
            <div data-test="msg-in"
                 class="max-w-[80%] rounded-2xl rounded-tr-md border border-accent/15 bg-accent/10 px-3.5 py-2"
                 :class="m.failed ? 'ring-1 ring-danger' : ''">
              <p class="whitespace-pre-wrap text-[14px] leading-relaxed text-fg">{{ m.text }}</p>
              <span v-if="m.failed" data-test="msg-failed" class="mt-1 inline-block text-xs text-danger">failed</span>
            </div>
          </div>
          <!-- ASSISTANT row -->
          <div v-else class="group flex gap-2.5">
            <div class="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-lg border border-border bg-surface">
              <Bot :size="13" class="text-accent" />
            </div>
            <div data-test="msg-out" class="min-w-0 flex-1 space-y-2.5"
                 :class="m.failed ? 'rounded-lg ring-1 ring-danger' : ''">
              <!-- Ordered transcript (text / reasoning / tools inline). -->
              <TurnParts v-if="m.structured?.parts?.length" :parts="m.structured.parts" />
              <!-- Legacy rows persisted before `parts`: aggregated fallback. -->
              <template v-else>
                <ToolCallPanel v-if="m.structured?.toolSteps?.length" :steps="m.structured.toolSteps" />
                <ReasoningPanel v-if="m.structured?.reasoning" :reasoning="m.structured.reasoning" :default-open="false" />
                <StreamMarkdown v-if="m.text" :text="m.text" class="text-[14px] leading-relaxed text-fg" />
              </template>
              <!-- Dedicated action/info row for this record: copy + time + status, on its own line. -->
              <div data-test="msg-actions" class="flex items-center gap-1.5 pt-0.5 text-fg-muted">
                <CopyButton v-if="m.text" :text="m.text" />
                <span v-if="fmtTime(m.createdAt)" data-test="msg-time" class="font-mono text-[10.5px] tabular-nums">{{ fmtTime(m.createdAt) }}</span>
                <span v-if="m.status === 'cancelled'" data-test="msg-cancelled" class="inline-flex items-center gap-1 text-[11px] text-warn"><CircleStop :size="12" /> Stopped</span>
                <span v-if="m.failed" data-test="msg-failed" class="text-[11px] text-danger">failed</span>
              </div>
            </div>
          </div>
        </template>

        <!-- live streaming assistant row -->
        <div v-if="liveTurn && liveTurn.parts.length" class="flex gap-2.5">
          <div class="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-lg border border-border bg-surface">
            <Bot :size="13" class="text-accent" />
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
      ↓ Latest
    </button>
  </div>
</template>
