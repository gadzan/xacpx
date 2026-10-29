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
  /** Mobile (<lg) transcripts drop per-row identity: the avatar + speaker ride the
   *  pane's pinned top bar instead of fronting every bubble (see the chat reference
   *  design). Group transcripts keep per-row identity — many Bots speak there. */
  hideIdentityOnMobile?: boolean;
  /** Stable id for the prepend scroll anchor. */
  rowId?: string;
  enterClass?: string;
  enterStyle?: Record<string, string>;
}>();
</script>

<template>
  <div
    class="conversation-row group flex w-full flex-col"
    :class="[own ? 'items-end' : '', enterClass]"
    :style="enterStyle"
    :data-row-id="rowId"
  >
    <div class="flex w-full gap-3" :class="own ? 'justify-end' : ''">
      <div v-if="!own && !hideLeadingAvatar" class="agent-avatar mt-0.5 h-8 w-8 shrink-0 self-start" :class="hideIdentityOnMobile ? 'hidden lg:block' : ''" data-avatar-key="row">
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
        <div v-if="!own && speaker" class="flex items-center gap-2" :class="hideIdentityOnMobile ? 'hidden lg:flex' : ''">
          <span class="text-xs font-semibold text-fg">{{ speaker }}</span>
          <span v-if="speakerRole" class="text-xs font-normal text-fg-muted">{{ speakerRole }}</span>
        </div>

        <slot />
      </div>
    </div>

    <!-- Opt-in meta row under the bubble. It deliberately lives OUTSIDE the
         max-w-[80%] / content-visibility column: on iOS Safari that column keeps
         its bubble width and paint-clips a wider time+copy row, cutting the
         timestamp. Out here the meta's containing block is the full-width row, so
         fit-content can never spill past it in any engine. -->
    <slot name="meta" />
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
