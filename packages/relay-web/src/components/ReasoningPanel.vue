<script setup lang="ts">
import { computed, ref } from "vue";
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
  <div class="mt-1 rounded border border-slate-200 text-xs">
    <button type="button" class="flex w-full items-center gap-1 px-2 py-1 text-left text-slate-600" @click="localOpen = !localOpen">
      <span>{{ open ? "▾" : "▸" }}</span>
      <span>🧠 {{ streaming ? "Reasoning…" : "Reasoning" }}</span>
      <span v-if="streaming" data-test="reasoning-shimmer" class="ml-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-slate-400" aria-hidden="true" />
    </button>
    <p v-if="open" data-test="reasoning-body" class="whitespace-pre-wrap px-2 pb-2 text-slate-600">{{ reasoning }}</p>
  </div>
</template>
