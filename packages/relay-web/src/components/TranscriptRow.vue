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
    class="flex gap-3"
    :class="[own ? 'justify-end' : '', enterClass]"
    :style="enterStyle"
    :data-row-id="rowId"
  >
    <div v-if="!own && !hideLeadingAvatar" class="agent-avatar mt-0.5 h-8 w-8 shrink-0 self-start" data-avatar-key="row">
      <!-- A slotted BotAvatar draws its own silhouette: no round backing (it reads as a
           halo in the dark theme) and no clipping, so its status badge stays whole. The
           driver-icon fallback keeps the round surface backing. -->
      <span class="grid h-8 w-8 place-items-center" :class="$slots.avatar ? '' : 'overflow-hidden rounded-full bg-surface'">
        <slot name="avatar">
          <AgentIcon v-if="driver" :driver="driver" :size="20" fill />
          <Bot v-else :size="20" class="text-fg-muted" />
        </slot>
      </span>
    </div>

    <div
      class="cv-bubble min-w-0"
      :class="own ? 'flex max-w-[80%] flex-col items-end' : 'flex-1 space-y-2.5'"
    >
      <div v-if="!own && speaker" class="flex items-center gap-2">
        <span class="text-xs font-semibold text-fg">{{ speaker }}</span>
        <span v-if="speakerRole" class="text-xs font-normal text-fg-muted">{{ speakerRole }}</span>
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
