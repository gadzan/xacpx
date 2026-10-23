<script setup lang="ts">
import type { AttachmentMetadata, PeerMessageHistoryEntry, TurnPartDto } from "@ganglion/xacpx-relay-protocol";
import type { ConversationMessageContent } from "../lib/message-copy";
import type { TraceTally, TurnPresentationPlan } from "../lib/turn-presentation";
import StreamMarkdown from "./StreamMarkdown.vue";
import TurnParts from "./TurnParts.vue";
import MessageAttachments from "./MessageAttachments.vue";

defineProps<{
  message: ConversationMessageContent;
  own?: boolean;
  attachments?: AttachmentMetadata[];
  parts?: TurnPartDto[];
  presentation?: TurnPresentationPlan;
  collapseTrace?: boolean;
  traceKey?: string;
  traceElapsedMs?: number | null;
  tally?: TraceTally;
  ensureFull?: () => Promise<void>;
  sentAgentMessages?: Map<string, PeerMessageHistoryEntry>;
}>();
</script>

<template>
  <div
    class="conversation-bubble min-w-0 max-w-full text-sm leading-relaxed text-fg"
    :class="own ? 'rounded-2xl rounded-br-[4px] bg-accent-soft px-3.5 py-2' : 'w-full space-y-2.5'"
  >
    <slot>
      <TurnParts
        v-if="parts?.length"
        :parts="parts"
        :presentation="presentation"
        :collapse-trace="collapseTrace"
        :trace-key="traceKey"
        :trace-elapsed-ms="traceElapsedMs"
        :tally="tally"
        :ensure-full="ensureFull"
        :sent-agent-messages="sentAgentMessages"
      />
      <StreamMarkdown v-else-if="message.content || message.text" :text="message.content ?? message.text ?? ''" />
    </slot>
    <MessageAttachments v-if="attachments?.length" :attachments="attachments" />
  </div>
</template>

<style scoped>
.conversation-bubble {
  overflow-wrap: anywhere;
}
.conversation-bubble :deep(pre),
.conversation-bubble :deep(.md-table-wrap) {
  max-width: 100%;
  overflow-x: auto;
}
</style>
