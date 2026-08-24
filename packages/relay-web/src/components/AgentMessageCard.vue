<script setup lang="ts">
import { computed } from "vue";
import type { PeerMessageHistoryEntry } from "@ganglion/xacpx-relay-protocol";
import CopyButton from "./CopyButton.vue";
import StreamMarkdown from "./StreamMarkdown.vue";
import AgentIcon from "./AgentIcon.vue";
import { fmtTime } from "../lib/format";
import { ArrowRight, ArrowLeft, Folder, AlertCircle, CheckCircle2, Send, Clock3 } from "lucide-vue-next";

const props = withDefaults(
  defineProps<{
    message: PeerMessageHistoryEntry;
    /** Anchored inside an assistant turn's timeline: left-align with the tool
     *  steps instead of the standalone chat-bubble right alignment. */
    anchored?: boolean;
  }>(),
  { anchored: false },
);

const isSent = computed(() => props.message.direction === "sent");
const peerName = computed(() => props.message.peer.displayName || props.message.peer.handle);
const timeStr = computed(() => fmtTime(new Date(props.message.createdAt).toISOString()));

// v0.3 sender-card completion state (spec §36): notify/result sends surface an
// asynchronous system-managed lifecycle chip instead of the delivery chips.
// none/absent keeps the legacy delivery presentation ("Sent"/"Delivered"/…).
interface CompletionChip {
  key: string;
  icon: typeof CheckCircle2;
  cls: string;
  test: string;
  pulse?: boolean;
}

const completionChip = computed<CompletionChip | null>(() => {
  if (!isSent.value) return null;
  const completion = props.message.completion;
  if (!completion || completion === "none") return null;
  const status = props.message.completionStatus;
  if (completion === "notify") {
    if (status === "completed") return { key: "agentMessage.completed", icon: CheckCircle2, cls: "text-accent", test: "msg-status-completed" };
    if (status === "failed") return { key: "agentMessage.failed", icon: AlertCircle, cls: "text-danger", test: "msg-status-failed" };
    if (status === "cancelled") return { key: "agentMessage.cancelled", icon: AlertCircle, cls: "text-danger", test: "msg-status-cancelled" };
    return { key: "agentMessage.waitingForCompletion", icon: Clock3, cls: "text-fg-muted", test: "msg-status-waiting", pulse: true };
  }
  // completion === "result"
  if (status === "completed") return { key: "agentMessage.resultReturned", icon: CheckCircle2, cls: "text-accent", test: "msg-status-result-returned" };
  if (status === "failed") return { key: "agentMessage.failed", icon: AlertCircle, cls: "text-danger", test: "msg-status-failed" };
  if (status === "cancelled") return { key: "agentMessage.cancelled", icon: AlertCircle, cls: "text-danger", test: "msg-status-cancelled" };
  return { key: "agentMessage.waitingForResult", icon: Clock3, cls: "text-fg-muted", test: "msg-status-waiting", pulse: true };
});
</script>

<template>
  <div
    data-test="agent-message-card"
    class="cv-row my-2 w-full max-w-2xl rounded-xl border transition-all"
    :class="[
      isSent
        ? 'border-accent/25 bg-accent/5'
        : 'border-border bg-surface shadow-sm',
      anchored ? 'mr-auto' : 'mx-auto',
    ]"
    :data-direction="message.direction"
  >
    <!-- Header -->
    <div
      class="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 border-b px-3.5 py-2 text-[12px]"
      :class="isSent ? 'border-accent/15 text-accent' : 'border-border text-fg-muted'"
    >
      <div class="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 font-medium">
        <span v-if="isSent" data-test="direction-sent" class="inline-flex items-center gap-1 font-semibold text-accent">
          <ArrowRight :size="13" class="shrink-0" />
          <span>{{ $t("chat.sentTo") || "Sent to" }}</span>
        </span>
        <span v-else data-test="direction-received" class="inline-flex items-center gap-1 font-semibold text-fg">
          <ArrowLeft :size="13" class="shrink-0 text-accent" />
          <span>{{ $t("chat.fromPeer") || "From" }}</span>
        </span>

        <span data-test="peer-name" class="truncate font-semibold text-fg">{{ peerName }}</span>

        <!-- Peer meta badges travel as ONE wrap unit: on narrow screens the pair
             drops to its own line together instead of fragmenting row-by-row. -->
        <span
          v-if="message.peer.agent || message.peer.workspace"
          class="inline-flex min-w-0 flex-wrap items-center gap-1"
        >
          <span
            v-if="message.peer.agent"
            data-test="peer-agent"
            class="inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-surface px-1.5 py-0.5 text-[11px] text-fg-muted"
          >
            <AgentIcon :driver="message.peer.agent" :size="11" />
            <span>{{ message.peer.agent }}</span>
          </span>

          <span
            v-if="message.peer.workspace"
            data-test="peer-workspace"
            class="inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-surface px-1.5 py-0.5 text-[11px] text-fg-muted"
          >
            <Folder :size="10" class="text-warn" />
            <span>{{ message.peer.workspace }}</span>
          </span>
        </span>
      </div>

      <div class="ml-auto flex shrink-0 items-center gap-2 text-[11px] text-fg-muted">
        <span
          v-if="completionChip"
          :data-test="completionChip.test"
          class="inline-flex items-center gap-1"
          :class="completionChip.cls"
        >
          <component :is="completionChip.icon" :size="11" :class="{ 'animate-pulse': completionChip.pulse }" />
          {{ $t(completionChip.key) }}
        </span>
        <template v-else>
          <span v-if="message.status === 'failed'" data-test="msg-status-failed" class="inline-flex items-center gap-1 text-danger">
            <AlertCircle :size="11" /> Failed
          </span>
          <span v-else-if="message.status === 'sending'" data-test="msg-status-sending" class="inline-flex items-center gap-1 text-fg-muted">
            <Send :size="11" class="animate-pulse" /> Sending
          </span>
          <span v-else-if="message.status === 'delivered'" data-test="msg-status-delivered" class="inline-flex items-center gap-1 text-accent">
            <CheckCircle2 :size="11" /> Delivered
          </span>
          <span v-else-if="isSent && (message.status === 'sent' || message.status === 'queued')" data-test="msg-status-sent" class="inline-flex items-center gap-1 text-fg-muted">
            <CheckCircle2 :size="11" /> {{ $t("agentMessage.sent") }}
          </span>
        </template>
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
