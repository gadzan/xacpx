<script setup lang="ts">
import { computed } from "vue";
import type { TurnPartDto } from "@ganglion/xacpx-relay-protocol";
import { fmtTime } from "../lib/format";
import { messageCopyText, type ConversationMessageContent } from "../lib/message-copy";
import type { TurnPresentationPlan } from "../lib/turn-presentation";
import CopyButton from "./CopyButton.vue";

const props = defineProps<{
  message: ConversationMessageContent;
  parts?: TurnPartDto[];
  presentation?: TurnPresentationPlan;
}>();
const copyText = computed(() => messageCopyText(props.message, props.parts, props.presentation));
const timestamp = computed(() => fmtTime(props.message.createdAt));
const dateTime = computed(() => {
  const date = new Date(props.message.createdAt);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
});
</script>

<template>
  <div data-test="msg-actions" class="conversation-meta flex min-h-[22px] max-w-full items-center gap-1.5 pt-0.5 text-fg-muted">
    <time data-test="msg-time" class="shrink-0 whitespace-nowrap font-mono text-xs tabular-nums" :datetime="dateTime">{{ timestamp }}</time>
    <slot />
    <div class="conversation-operations flex shrink-0 items-center gap-1.5">
      <CopyButton v-if="copyText" :text="copyText" />
      <slot name="operations" />
    </div>
  </div>
</template>

<style scoped>
.conversation-operations {
  opacity: 0;
  transition: opacity 120ms;
}
.conversation-meta:hover .conversation-operations,
.conversation-meta:focus-within .conversation-operations,
:global(.conversation-row:hover) .conversation-operations,
:global(.conversation-row:focus-within) .conversation-operations {
  opacity: 1;
}
@media (hover: none) {
  .conversation-operations {
    opacity: 1;
  }
}
</style>
