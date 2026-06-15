<script setup lang="ts">
import { computed, ref } from "vue";
import { Brain, ChevronDown, ChevronRight } from "lucide-vue-next";
const props = withDefaults(defineProps<{ reasoning: string; defaultOpen?: boolean; streaming?: boolean }>(), {
  defaultOpen: true,
  streaming: false,
});
// While the reasoning is still streaming we force the panel open (and ignore the
// user's toggle) so the live thought is visible; once it settles, the user's own
// open/closed preference takes over. Historical panels are never streaming.
const localOpen = ref(props.defaultOpen ?? true);
const open = computed(() => props.streaming || localOpen.value);
</script>

<template>
  <div class="mt-1 rounded-lg border border-border bg-surface text-xs">
    <button type="button" class="flex w-full items-center gap-1 px-2 py-1 text-left text-fg-muted" @click="localOpen = !localOpen">
      <ChevronDown v-if="open" :size="14" />
      <ChevronRight v-else :size="14" />
      <span class="inline-flex items-center gap-1"><Brain :size="14" /> {{ streaming ? "Reasoning…" : "Reasoning" }}</span>
      <span v-if="streaming" data-test="reasoning-shimmer" class="ml-1 inline-block h-1.5 w-1.5 animate-pulse motion-reduce:animate-none rounded-full bg-fg-muted" aria-hidden="true" />
    </button>
    <p v-if="open" data-test="reasoning-body" class="whitespace-pre-wrap px-2 pb-2 text-fg-muted">{{ reasoning }}</p>
  </div>
</template>
