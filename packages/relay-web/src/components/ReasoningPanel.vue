<script setup lang="ts">
import { computed, ref } from "vue";
import { Brain, ChevronDown, ChevronRight } from "lucide-vue-next";

const props = withDefaults(defineProps<{ reasoning: string; defaultOpen?: boolean; streaming?: boolean }>(), {
  defaultOpen: false,
  streaming: false,
});

// Reasoning is collapsed by default — de-cardified single line (zcode-style) with a
// live shimmer while streaming. The user expands it on demand into an indented block.
const localOpen = ref(props.defaultOpen ?? false);
const open = computed(() => localOpen.value);
</script>

<template>
  <div class="text-xs">
    <button type="button"
            class="group flex items-center gap-1.5 py-1 px-1.5 -mx-1.5 rounded-md text-left text-fg-muted hover:text-fg hover:bg-fg/5 transition-colors"
            @click="localOpen = !localOpen">
      <Brain :size="13" class="shrink-0 transition-colors"
             :class="streaming ? 'text-accent' : 'text-fg-muted/80 group-hover:text-fg'" />
      <span class="text-[12px] font-medium transition-colors"
            :class="streaming ? 'shimmer-text text-accent' : ''">{{ streaming ? $t("reasoning.reasoningStreaming") : $t("reasoning.reasoning") }}</span>
      <span v-if="streaming" data-test="reasoning-shimmer" class="ml-0.5 inline-block h-1.5 w-1.5 animate-pulse motion-reduce:animate-none rounded-full bg-accent" aria-hidden="true" />
      <ChevronDown v-if="open" :size="12" class="shrink-0 opacity-60 group-hover:opacity-100 transition-opacity" />
      <ChevronRight v-else :size="12" class="shrink-0 opacity-40 group-hover:opacity-80 transition-opacity" />
    </button>
    <p v-if="open" data-test="reasoning-body"
       class="ml-2.5 my-1 border-l-2 border-border/60 pl-3 py-0.5 text-[12px] leading-relaxed text-fg-muted/85 whitespace-pre-wrap">
      {{ reasoning }}
    </p>
  </div>
</template>
