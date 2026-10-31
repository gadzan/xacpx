<script setup lang="ts">
import { useNoticesStore } from "../stores/notices";

const notices = useNoticesStore();

// Map a notice kind to a semantic accent tone. Kinds are freeform strings
// (e.g. "task-completion", "task-progress"); errors/failures read danger,
// completions read run (success), everything else reads info.
function toneClass(kind: string): string {
  const k = kind.toLowerCase();
  if (k === "queue-overflow") return "text-fg-muted-overlay";
  if (k.includes("fail") || k.includes("error")) return "text-danger-overlay";
  if (k.includes("comple") || k.includes("done") || k.includes("success")) return "text-run-overlay";
  return "text-accent-text-overlay";
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
      :data-test="n.kind === 'queue-overflow' ? 'queue-overflow-toast' : 'notice'"
      class="pointer-events-auto flex h-9 items-center rounded-lg bg-glass-strong px-3.5 text-ui shadow-glass-float backdrop-blur-glass backdrop-saturate-glass"
    >
      <div class="flex min-w-0 flex-1 items-center justify-between gap-2">
        <span v-if="n.kind === 'queue-overflow'" class="min-w-0 truncate text-fg-muted-overlay">{{ n.text }}</span>
        <span v-else class="flex min-w-0 items-center gap-2">
          <span class="shrink-0 text-xs uppercase" :class="toneClass(n.kind)">{{ n.kind }}</span>
          <span class="min-w-0 truncate">{{ n.text }}</span>
        </span>
        <button class="shrink-0 text-fg-muted-overlay hover:text-fg" :aria-label="$t('common.dismissNotice')" @click="notices.dismiss(n.id)">×</button>
      </div>
    </div>
  </div>
</template>
