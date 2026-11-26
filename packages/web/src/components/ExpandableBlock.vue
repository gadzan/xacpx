<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ChevronDown } from "lucide-vue-next";

// Clamps long content (a file read, command output, big diff) to a bounded height so it
// stays inline without burying the rest of the turn. A "Show more" toggle reveals the
// full content on demand. Re-measures as content streams in (ResizeObserver).
const props = withDefaults(defineProps<{ maxPx?: number }>(), { maxPx: 200 });

const expanded = ref(false);
const overflows = ref(false);
const inner = ref<HTMLElement | null>(null);
let ro: ResizeObserver | null = null;

function measure(): void {
  const el = inner.value;
  if (!el) return;
  overflows.value = el.scrollHeight > props.maxPx + 8;
}

onMounted(() => {
  void nextTick(measure);
  if (typeof ResizeObserver !== "undefined" && inner.value) {
    ro = new ResizeObserver(() => measure());
    ro.observe(inner.value);
  }
});
onBeforeUnmount(() => ro?.disconnect());
// A collapse re-checks overflow (content/threshold may have changed meanwhile).
watch(expanded, () => { if (!expanded.value) void nextTick(measure); });
</script>

<template>
  <div>
    <div ref="inner" data-test="clamp-inner"
         :class="!expanded && overflows ? 'overflow-hidden clamp-fade' : ''"
         :style="!expanded && overflows ? { maxHeight: maxPx + 'px' } : undefined">
      <slot />
    </div>
    <button v-if="overflows" type="button" data-test="expand-toggle" :aria-expanded="expanded"
            class="mt-1 inline-flex items-center gap-1 text-xs font-medium text-accent-text hover:underline"
            @click="expanded = !expanded">
      <!-- One chevron that turns over, not two icons swapping: the eye follows the
           direction of the change instead of re-finding the control. -->
      <ChevronDown :size="12" class="transition-transform duration-150 ease-ui motion-reduce:transition-none"
                   :class="expanded ? 'rotate-180' : ''" />
      {{ expanded ? $t("common.showLess") : $t("common.showMore") }}
    </button>
  </div>
</template>

<style scoped>
/* The clamp cuts the content mid-line; fade the last quarter instead of leaving a
   hard edge, so "there is more below" is visible before the toggle is read. A
   mask — not an overlay gradient — because it never has to match the material
   behind it (raised card, chrome, canvas), and it cannot swallow a click. */
.clamp-fade {
  -webkit-mask-image: linear-gradient(to bottom, #000 72%, transparent 100%);
  mask-image: linear-gradient(to bottom, #000 72%, transparent 100%);
}
</style>
