<script setup lang="ts">
import AgentIcon from "./AgentIcon.vue";

// The live turn's leading agent icon. Liveness lives in the ThinkingDots bubble
// rendered in the row body (see MessageList): the icon itself stays static.
defineProps<{
  driver?: string | null;
}>();
</script>

<template>
  <div class="agent-avatar mt-0.5 h-8 w-8 shrink-0 self-start" data-avatar-key="live">
    <span class="grid h-8 w-8 place-items-center overflow-hidden"><AgentIcon :driver="driver" :size="20" fill /></span>
  </div>
</template>
