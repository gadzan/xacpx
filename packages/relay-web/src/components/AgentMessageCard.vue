<script setup lang="ts">
import { computed } from "vue";
import type { PeerMessageHistoryEntry } from "@ganglion/xacpx-relay-protocol";
import CopyButton from "./CopyButton.vue";
import StreamMarkdown from "./StreamMarkdown.vue";
import AgentIcon from "./AgentIcon.vue";
import { fmtTime } from "../lib/format";
import { ArrowRight, ArrowLeft, Folder, AlertCircle, CheckCircle2, Send } from "lucide-vue-next";

const props = defineProps<{
  message: PeerMessageHistoryEntry;
}>();

const isSent = computed(() => props.message.direction === "sent");
const peerName = computed(() => props.message.peer.displayName || props.message.peer.handle);
const timeStr = computed(() => fmtTime(new Date(props.message.createdAt).toISOString()));
</script>

<template>
  <div
    data-test="agent-message-card"
    class="cv-row my-2 w-full max-w-2xl rounded-xl border transition-all"
    :class="[
      isSent
        ? 'ml-auto border-accent/25 bg-accent/5'
        : 'mr-auto border-border bg-surface shadow-sm',
    ]"
    :data-direction="message.direction"
  >
    <!-- Header -->
    <div
      class="flex items-center justify-between gap-2 border-b px-3.5 py-2 text-[12px]"
      :class="isSent ? 'border-accent/15 text-accent' : 'border-border text-fg-muted'"
    >
      <div class="flex min-w-0 items-center gap-1.5 font-medium">
        <span v-if="isSent" data-test="direction-sent" class="inline-flex items-center gap-1 font-semibold text-accent">
          <ArrowRight :size="13" class="shrink-0" />
          <span>{{ $t("chat.sentTo") || "Sent to" }}</span>
        </span>
        <span v-else data-test="direction-received" class="inline-flex items-center gap-1 font-semibold text-fg">
          <ArrowLeft :size="13" class="shrink-0 text-accent" />
          <span>{{ $t("chat.fromPeer") || "From" }}</span>
        </span>

        <span data-test="peer-name" class="truncate font-semibold text-fg">{{ peerName }}</span>

        <!-- Agent badge -->
        <span
          v-if="message.peer.agent"
          data-test="peer-agent"
          class="inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-surface px-1.5 py-0.5 text-[11px] text-fg-muted"
        >
          <AgentIcon :driver="message.peer.agent" :size="11" />
          <span>{{ message.peer.agent }}</span>
        </span>

        <!-- Workspace badge -->
        <span
          v-if="message.peer.workspace"
          data-test="peer-workspace"
          class="inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-surface px-1.5 py-0.5 text-[11px] text-fg-muted"
        >
          <Folder :size="10" class="text-warn" />
          <span>{{ message.peer.workspace }}</span>
        </span>
      </div>

      <div class="flex shrink-0 items-center gap-2 text-[11px] text-fg-muted">
        <span v-if="message.status === 'failed'" data-test="msg-status-failed" class="inline-flex items-center gap-1 text-danger">
          <AlertCircle :size="11" /> Failed
        </span>
        <span v-else-if="message.status === 'sending'" data-test="msg-status-sending" class="inline-flex items-center gap-1 text-fg-muted">
          <Send :size="11" class="animate-pulse" /> Sending
        </span>
        <span v-else-if="message.status === 'delivered'" data-test="msg-status-delivered" class="inline-flex items-center gap-1 text-accent">
          <CheckCircle2 :size="11" /> Delivered
        </span>
        <span v-if="timeStr" data-test="msg-time" class="font-mono tabular-nums">{{ timeStr }}</span>
      </div>
    </div>

    <!-- Message Content Body -->
    <div class="px-3.5 py-2.5">
      <StreamMarkdown v-if="message.content" :text="message.content" class="text-[13.5px] leading-relaxed text-fg" />
      <div class="mt-1 flex items-center justify-end text-fg-muted">
        <CopyButton v-if="message.content" :text="message.content" />
      </div>
    </div>
  </div>
</template>
