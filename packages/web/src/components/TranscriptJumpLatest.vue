<script setup lang="ts">
import { ArrowDown } from "lucide-vue-next";

defineProps<{
  visible: boolean;
}>();

const emit = defineEmits<{ jump: [] }>();
</script>

<template>
  <Transition name="ui-fade">
    <div v-show="visible" aria-hidden="true" class="jump-scrim" />
  </Transition>
  <!-- Centred with `inset-x-0 mx-auto` rather than a `-translate-x-1/2`, so the
       transform stays free for the arrival gesture: the button rises 6px into
       place and sinks back out of it (`.ui-float-*` in style.css). -->
  <Transition name="ui-float">
    <button
      v-show="visible"
      data-test="jump-latest"
      type="button"
      :aria-label="$t('chat.jumpLatest')"
      :title="$t('chat.jumpLatest')"
      class="absolute inset-x-0 bottom-3 z-10 mx-auto grid h-7 w-7 place-items-center rounded-sm bg-surface/85 text-fg shadow-[0_1px_2px_rgba(0,0,0,0.05)] backdrop-blur-md transition-[transform,background-color,color,box-shadow] duration-150 ease-ui hover:bg-surface active:scale-95 motion-reduce:active:scale-100"
      @click="emit('jump')"
    >
      <ArrowDown :size="13" :stroke-width="2.5" />
    </button>
  </Transition>
</template>

<style scoped>
/* The mask fades the backdrop blur itself, so content blurs out toward the bottom
   edge instead of ending at a hard band. */
.jump-scrim {
  position: absolute;
  /* The composer wrapper (pt-1.5 + a top-transparent gradient) sits between the
     transcript bottom and the input card; without reaching over it the fade
     stops 6px short and content ghosts through right above the card. The
     wrapper paints later but its top is transparent, so the extension shows. */
  inset: auto 0 -0.375rem 0;
  height: 4.5rem;
  pointer-events: none;
  background: linear-gradient(to top, rgb(var(--c-bg) / 1), rgb(var(--c-bg) / 0));
  -webkit-mask-image: linear-gradient(to top, #000 30%, transparent);
  mask-image: linear-gradient(to top, #000 30%, transparent);
  backdrop-filter: blur(3px);
}
</style>
