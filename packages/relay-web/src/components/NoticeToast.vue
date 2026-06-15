<script setup lang="ts">
import { useNoticesStore } from "../stores/notices";

const notices = useNoticesStore();

// Map a notice kind to a semantic accent tone. Kinds are freeform strings
// (e.g. "task-completion", "task-progress"); errors/failures read danger,
// completions read run (success), everything else reads info.
function toneClass(kind: string): string {
  const k = kind.toLowerCase();
  if (k.includes("fail") || k.includes("error")) return "text-danger";
  if (k.includes("complet") || k.includes("done") || k.includes("success")) return "text-run";
  return "text-info";
}
</script>

<template>
  <div
    class="pointer-events-none fixed bottom-4 right-4 z-50 flex w-72 flex-col gap-2"
    aria-live="polite"
  >
    <div
      v-for="n in notices.items.slice(0, 4)"
      :key="n.id"
      data-test="notice"
      class="pointer-events-auto rounded border border-border bg-raised px-3 py-2 text-sm text-fg shadow-lg"
    >
      <div class="flex items-start justify-between gap-2">
        <span><span class="text-xs uppercase" :class="toneClass(n.kind)">{{ n.kind }}</span><br />{{ n.text }}</span>
        <button class="text-xs text-fg-muted hover:text-fg" aria-label="Dismiss" @click="notices.dismiss(n.id)">×</button>
      </div>
    </div>
  </div>
</template>
