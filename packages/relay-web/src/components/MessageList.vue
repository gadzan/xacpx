<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import type { ChatMessage, LiveTurn } from "../stores/chat";
import StreamMarkdown from "./StreamMarkdown.vue";
import ToolCallPanel from "./ToolCallPanel.vue";
import ReasoningPanel from "./ReasoningPanel.vue";
import CopyButton from "./CopyButton.vue";
import { CircleStop } from "lucide-vue-next";

const props = defineProps<{ messages: ChatMessage[]; streaming: string; liveTurn: LiveTurn | null }>();

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
watch(
  () => [props.messages.length, props.streaming, props.liveTurn?.toolSteps.length, props.liveTurn?.reasoning],
  () => {
    if (atBottom.value) void nextTick(() => scrollToBottom(false));
  },
);
</script>

<template>
  <div class="relative flex-1 overflow-hidden">
    <div ref="scroller" data-test="msg-scroller" class="h-full space-y-2 overflow-y-auto p-4" @scroll="onScroll">
      <div v-for="(m, i) in messages" :key="i" class="group flex" :class="m.direction === 'in' ? 'justify-end' : 'justify-start'">
        <pre v-if="m.direction === 'in'" data-test="msg-in"
             class="max-w-[80%] whitespace-pre-wrap rounded-lg bg-accent/10 px-3 py-2 text-sm leading-relaxed text-fg"
             :class="m.failed ? 'ring-1 ring-danger' : ''">{{ m.text }}<span v-if="m.failed" data-test="msg-failed" class="ml-2 text-xs text-danger">failed</span></pre>
        <div v-else data-test="msg-out"
             class="relative max-w-[80%] rounded-lg bg-surface px-3 py-2 text-sm leading-relaxed text-fg"
             :class="m.failed ? 'ring-1 ring-danger' : ''">
          <ToolCallPanel v-if="m.structured?.toolSteps?.length" :steps="m.structured.toolSteps" />
          <ReasoningPanel v-if="m.structured?.reasoning" :reasoning="m.structured.reasoning" :default-open="false" />
          <StreamMarkdown :text="m.text" />
          <span v-if="m.status === 'cancelled'" data-test="msg-cancelled" class="inline-flex items-center gap-1 text-xs text-warn"><CircleStop :size="12" /> Stopped</span>
          <span v-if="m.failed" data-test="msg-failed" class="text-xs text-danger">failed</span>
          <CopyButton v-if="m.text" :text="m.text" class="absolute right-1 top-1 opacity-0 transition-opacity group-hover:opacity-100" />
        </div>
      </div>
      <div v-if="streaming || liveTurn?.toolSteps.length || liveTurn?.reasoning" class="flex justify-start">
        <div data-test="msg-streaming" class="max-w-[80%] rounded-lg bg-surface px-3 py-2 text-sm leading-relaxed text-fg opacity-90">
          <ToolCallPanel v-if="liveTurn?.toolSteps.length" :steps="liveTurn.toolSteps" />
          <ReasoningPanel v-if="liveTurn?.reasoning" :reasoning="liveTurn.reasoning" :streaming="true" />
          <StreamMarkdown v-if="streaming" :text="streaming" :streaming="true" />
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
