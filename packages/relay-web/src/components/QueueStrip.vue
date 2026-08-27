<script setup lang="ts">
import { X } from "lucide-vue-next";
import { useChatStore } from "../stores/chat";

const chat = useChatStore();
</script>

<template>
  <!-- Server-side pending-prompt queue for the selected session (Task 6's sessionQueue).
       Renders nothing when the queue is empty — no v-if needed at the call site. -->
  <div v-if="chat.sessionQueue.length" data-test="queue-strip"
       class="flex items-center gap-2 rounded-lg border border-border/70 bg-surface/95 px-3 py-1.5 backdrop-blur-md">
    <span class="shrink-0 text-[11px] font-semibold uppercase tracking-wide text-fg-muted">{{ $t("chat.queuedHeader") }}</span>
    <TransitionGroup tag="div"
        move-class="transition-transform duration-200 ease-out motion-reduce:transition-none"
        enter-active-class="transition-all duration-200 ease-out motion-reduce:transition-none"
        enter-from-class="opacity-0 -translate-y-1"
        leave-active-class="transition-all duration-150 ease-in motion-reduce:transition-none absolute"
        leave-to-class="opacity-0 scale-95"
        class="relative flex flex-1 flex-wrap items-center gap-1.5 overflow-hidden">
      <span v-for="item in chat.sessionQueue" :key="item.id" data-test="queue-item"
            class="inline-flex max-w-[220px] items-center gap-1.5 rounded-full border border-border bg-bg px-2.5 py-1 text-[11.5px] text-fg-muted">
        <span class="truncate">{{ item.textPreview }}</span>
        <button type="button" data-test="queue-cancel" :aria-label="$t('chat.queueCancelAria')"
                class="grid h-4 w-4 shrink-0 place-items-center rounded-full text-fg-muted transition-colors hover:bg-danger/15 hover:text-danger"
                @click="chat.cancelQueuedItem(chat.instanceId!, chat.sessionAlias!, item.id)">
          <X :size="10" />
        </button>
      </span>
    </TransitionGroup>
  </div>
</template>
