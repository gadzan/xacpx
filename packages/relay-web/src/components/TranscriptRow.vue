<script setup lang="ts">
import { Bot } from "lucide-vue-next";
import AgentIcon from "./AgentIcon.vue";

/**
 * One conversation row, shared by every pane (session, Direct Bot, Group).
 *
 * `own` renders the reader's own message: right-aligned, no avatar, no speaker
 * label.
 */
const props = defineProps<{
  driver?: string | null;
  /** Who is speaking. Absent for the reader's own messages. */
  speaker?: string;
  /** Role / description shown after the name. */
  speakerRole?: string;
  own?: boolean;
  hideLeadingAvatar?: boolean;
  /** Stable id for the prepend scroll anchor. */
  rowId?: string;
  /** Enter choreography from the pane's own scroll logic. */
  enterClass?: string;
  enterStyle?: Record<string, string>;
}>();
</script>

<template>
  <div
    class="flex gap-2.5"
    :class="[own ? 'justify-end' : '', enterClass]"
    :style="enterStyle"
    :data-row-id="rowId"
  >
    <div v-if="!own && !hideLeadingAvatar" class="agent-avatar mt-0.5 h-6 w-6 shrink-0 self-start" data-avatar-key="row">
      <span class="grid h-6 w-6 place-items-center overflow-hidden rounded-full border border-border bg-surface">
        <slot name="avatar">
          <AgentIcon v-if="driver" :driver="driver" :size="15" fill />
          <Bot v-else :size="15" class="text-fg-muted" />
        </slot>
      </span>
    </div>

    <div
      class="cv-bubble min-w-0"
      :class="own ? 'flex max-w-[80%] flex-col items-end' : 'flex-1 space-y-2.5'"
    >
      <div v-if="!own && speaker" class="flex items-center gap-2">
        <span class="text-xs font-semibold text-fg">{{ speaker }}</span>
        <span v-if="speakerRole" class="text-[10px] font-normal text-fg-muted">{{ speakerRole }}</span>
      </div>

      <slot />
    </div>
  </div>
</template>

<style scoped>
/* The browser skips layout and paint for off-screen rows, so a long history stays
   smooth no matter how heavy each row is (markdown, tool cards, diffs). Rows stay
   in the DOM, so streaming, expand/collapse, find-in-page and the prepend
   scroll-anchor keep working. */
.cv-bubble {
  content-visibility: auto;
  contain-intrinsic-size: auto 88px;
}

/* The avatar hangs at the scroller top until the next assistant row pushes it
   away. `self-start` keeps it from stretching to full row height, which would
   leave sticky no room to travel. */
.agent-avatar {
  position: sticky;
  top: 0;
  z-index: 5;
}
</style>
