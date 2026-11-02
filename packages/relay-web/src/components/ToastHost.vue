<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { AlertCircle, CheckCircle2, Info } from "lucide-vue-next";
import { useToasts, dismissToast } from "../lib/use-toasts";
import { useIsMobile } from "../lib/use-dropdown";

// Global stack of short-lived toasts (file-op results, etc).
//
// The stack sits in the empty space of the conversation header, not over the
// transcript: a toast pinned to the top of the viewport covered the first line
// of the conversation. The header is MEASURED rather than nested — the desktop
// conversation header is itself a glass surface, and a backdrop-filtered
// element must never live inside another one.
const toasts = useToasts();
const isMobile = useIsMobile();

/** Where the toast stack is anchored, in viewport coordinates. */
const style = ref<Record<string, string>>({ top: "60px", left: "50%", transform: "translateX(-50%)" });

/** The visible conversation header (one pane is on screen at a time). */
function headerAnchor(): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>("[data-conversation-header]")) {
    if (el.getBoundingClientRect().width > 0) return el;
  }
  return null;
}

function reposition(): void {
  if (isMobile.value) {
    // Below lg the conversation header is the mobile top bar; the toast clears it.
    style.value = { top: "60px", left: "50%", transform: "translateX(-50%)" };
    return;
  }
  const anchor = headerAnchor();
  if (!anchor) return;
  const rect = anchor.getBoundingClientRect();
  if (!rect.width) return;
  style.value = {
    top: `${rect.top + 8}px`,
    left: `${rect.left + rect.width / 2}px`,
    transform: "translateX(-50%)",
  };
}

const ICONS = { success: CheckCircle2, error: AlertCircle, info: Info } as const;

function toneIcon(tone: string): typeof ICONS[keyof typeof ICONS] {
  return ICONS[tone as keyof typeof ICONS] ?? Info;
}

function toneClass(tone: string): string {
  if (tone === "error") return "text-danger-overlay";
  if (tone === "success") return "text-run-overlay";
  return "text-accent-text-overlay";
}

// The header band moves when the pane changes and the viewport resizes; the
// toast follows it.
watch(() => toasts.value.length, () => void nextTick(reposition));
onMounted(() => {
  reposition();
  window.addEventListener("resize", reposition);
});
onBeforeUnmount(() => window.removeEventListener("resize", reposition));
</script>

<template>
  <Teleport to="body">
    <div
      class="pointer-events-none fixed z-[60] flex w-72 max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-col gap-2"
      :style="style"
      aria-live="polite"
    >
      <div
        v-for="t in toasts"
        :key="t.id"
        data-test="toast"
        class="pointer-events-auto flex h-9 items-center gap-2 rounded-lg bg-glass-strong px-3.5 text-ui font-medium text-fg shadow-glass-float backdrop-blur-glass backdrop-saturate-glass"
      >
        <component :is="toneIcon(t.tone)" :size="16" class="shrink-0" :class="toneClass(t.tone)" aria-hidden="true" />
        <span class="min-w-0 flex-1 truncate">{{ $t(t.key, t.params ?? {}) }}</span>
        <button data-test="toast-dismiss" class="shrink-0 text-fg-muted hover:text-fg" :aria-label="$t('common.dismiss')" @click="dismissToast(t.id)">×</button>
      </div>
    </div>
  </Teleport>
</template>
