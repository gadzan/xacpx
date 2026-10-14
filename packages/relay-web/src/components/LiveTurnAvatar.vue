<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import AgentIcon from "./AgentIcon.vue";
import WorkingQuip from "./WorkingQuip.vue";

defineProps<{
  driver?: string | null;
  status: string;
  elapsed: string;
}>();

// The working bubble floats above the icon head, riding the sticky avatar (its
// containing block) so it moves with layout natively during scroll — zero JS
// positioning, zero lag. When the icon is pinned at the scroller's top edge there is
// no room above and the scroller would clip the bubble, so an IntersectionObserver on
// the sentinel strip above the icon flips it beside the icon. No scroll listeners, no
// per-frame measurement.
const avatarEl = ref<HTMLElement | null>(null);
const besideIcon = ref(false);
const BUBBLE_SPACE_PX = 26; // bubble height (~22px) plus the 4px gap above the head

onMounted(() => {
  const sentinel = avatarEl.value?.querySelector(".quip-sentinel");
  const scroller = avatarEl.value?.closest('[data-test="msg-scroller"]');
  if (!sentinel || !scroller || typeof IntersectionObserver === "undefined") return;
  const io = new IntersectionObserver(
    (entries) => { besideIcon.value = entries[0]?.isIntersecting !== true; },
    {
      root: scroller,
      // The sentinel is the strip the bubble needs above the head. Fully inside the
      // scrollport → room above → the bubble floats; clipped at the top → beside the
      // icon. The root grows by the same strip at the bottom so a live row entering
      // from below never reads as pinned.
      rootMargin: `0px 0px ${BUBBLE_SPACE_PX}px 0px`,
      threshold: 1,
    },
  );
  io.observe(sentinel);
  onBeforeUnmount(() => io.disconnect());
});
</script>

<template>
  <div ref="avatarEl" class="agent-avatar mt-0.5 h-6 w-6 shrink-0 self-start" data-avatar-key="live"
       :class="{ 'quip-beside': besideIcon }">
    <span class="grid h-6 w-6 place-items-center overflow-hidden"><AgentIcon :driver="driver" :size="15" fill /></span>
    <WorkingQuip class="working-quip" :status="status" :elapsed="elapsed" />
    <span class="quip-sentinel" aria-hidden="true" :style="{ height: `${BUBBLE_SPACE_PX}px` }" />
  </div>
</template>

<style scoped>
/* Rides the sticky avatar: absolutely positioned against it (sticky is a containing
   block), just above the icon head, above the transcript content. */
.working-quip {
  position: absolute;
  bottom: calc(100% + 4px);
  left: 0;
  z-index: 40;
  pointer-events: none;
  white-space: nowrap;
}
/* Flipped beside the icon when the sentinel reports no room above it. */
.quip-beside .working-quip {
  bottom: auto;
  top: 0;
  left: calc(100% + 4px);
}
/* Invisible strip the observer watches: the space the bubble needs above the head. */
.quip-sentinel {
  position: absolute;
  bottom: 100%;
  left: 0;
  width: 100%;
  pointer-events: none;
}
</style>
