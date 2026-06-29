<script setup lang="ts">
import { computed, ref } from "vue";
import { Brain, ChevronDown, ChevronRight } from "lucide-vue-next";
const props = withDefaults(defineProps<{ reasoning: string; defaultOpen?: boolean; streaming?: boolean }>(), {
  defaultOpen: false,
  streaming: false,
});
// Reasoning is collapsed by default — the header (with a live shimmer while streaming)
// signals it's there without burying the answer/tools below a wall of thought. The user
// expands it on demand; their toggle is respected even mid-stream.
const localOpen = ref(props.defaultOpen ?? false);
const open = computed(() => localOpen.value);
</script>

<template>
  <div class="overflow-hidden rounded-lg border border-border bg-surface text-xs shadow-e1">
    <button type="button" class="flex w-full items-center gap-1.5 px-3 py-2 text-left text-fg-muted" @click="localOpen = !localOpen">
      <ChevronDown v-if="open" :size="13" class="shrink-0" />
      <ChevronRight v-else :size="13" class="shrink-0" />
      <Brain :size="13" :class="streaming ? 'text-accent' : ''" />
      <span class="text-[12px] font-medium" :class="streaming ? 'shimmer-text' : ''">{{ streaming ? $t("reasoning.reasoningStreaming") : $t("reasoning.reasoning") }}</span>
      <span v-if="streaming" data-test="reasoning-shimmer" class="ml-1 inline-block h-1.5 w-1.5 animate-pulse motion-reduce:animate-none rounded-full bg-fg-muted" aria-hidden="true" />
    </button>
    <p v-if="open" data-test="reasoning-body" class="whitespace-pre-wrap border-t border-border px-3 pb-2.5 pt-2 text-[12px] leading-relaxed text-fg-muted">{{ reasoning }}</p>
  </div>
</template>
