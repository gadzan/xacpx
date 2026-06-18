<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ChevronDown, ChevronUp } from "lucide-vue-next";

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
         :class="!expanded && overflows ? 'overflow-hidden' : ''"
         :style="!expanded && overflows ? { maxHeight: maxPx + 'px' } : undefined">
      <slot />
    </div>
    <button v-if="overflows" type="button" data-test="expand-toggle"
            class="mt-1 inline-flex items-center gap-1 text-[10.5px] font-medium text-accent hover:underline"
            @click="expanded = !expanded">
      <component :is="expanded ? ChevronUp : ChevronDown" :size="12" />
      {{ expanded ? "Show less" : "Show more" }}
    </button>
  </div>
</template>
