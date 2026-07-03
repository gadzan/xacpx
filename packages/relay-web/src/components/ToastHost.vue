<script setup lang="ts">
import { useToasts, dismissToast } from "../lib/use-toasts";

// Global stack of short-lived toasts (file-op results, etc). Top-center so it doesn't
// collide with NoticeToast (bottom-right) or ActionToast (bottom-center).
const toasts = useToasts();

function toneClass(tone: string): string {
  if (tone === "error") return "text-danger";
  if (tone === "success") return "text-run";
  return "text-info";
}
</script>

<template>
  <Teleport to="body">
    <div
      class="pointer-events-none fixed left-1/2 top-[calc(0.75rem+env(safe-area-inset-top))] z-[60] flex w-72 max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-col gap-2"
      aria-live="polite"
    >
      <div
        v-for="t in toasts"
        :key="t.id"
        data-test="toast"
        class="pointer-events-auto flex items-start justify-between gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-sm shadow-lg"
      >
        <span :class="toneClass(t.tone)">{{ $t(t.key, t.params ?? {}) }}</span>
        <button data-test="toast-dismiss" class="shrink-0 text-fg-muted hover:text-fg" :aria-label="$t('common.dismiss')" @click="dismissToast(t.id)">×</button>
      </div>
    </div>
  </Teleport>
</template>
