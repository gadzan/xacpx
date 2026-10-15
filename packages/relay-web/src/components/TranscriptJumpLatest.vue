<script setup lang="ts">
import { ArrowDown } from "lucide-vue-next";

defineProps<{
  visible: boolean;
}>();

const emit = defineEmits<{ jump: [] }>();
</script>

<template>
  <div v-show="visible" aria-hidden="true" class="jump-scrim" />
  <button
    v-show="visible"
    data-test="jump-latest"
    type="button"
    :aria-label="$t('chat.jumpLatest')"
    :title="$t('chat.jumpLatest')"
 class="absolute bottom-3 left-1/2 z-10 grid h-7 w-7 -translate-x-1/2 place-items-center rounded-md bg-surface/85 text-fg shadow-[0_1px_2px_rgba(0,0,0,0.05)] backdrop-blur-md transition-colors hover:bg-surface"
    @click="emit('jump')"
  >
    <ArrowDown :size="13" :stroke-width="2.5" />
  </button>
</template>

<style scoped>
/* The mask fades the backdrop blur itself, so content blurs out toward the bottom
   edge instead of ending at a hard band. */
.jump-scrim {
  position: absolute;
  inset: auto 0 0 0;
  height: 4.5rem;
  pointer-events: none;
  background: linear-gradient(to top, rgb(var(--c-bg) / 0.9), rgb(var(--c-bg) / 0));
  -webkit-mask-image: linear-gradient(to top, #000 30%, transparent);
  mask-image: linear-gradient(to top, #000 30%, transparent);
  backdrop-filter: blur(3px);
}
</style>
