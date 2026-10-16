<script setup lang="ts">
import { ref } from "vue";
import { useModalA11y } from "../lib/use-modal-a11y";
import { X } from "lucide-vue-next";

// Bottom sheet for the mobile (<lg) chrome: a raised panel pinned to the bottom edge,
// with a backdrop, Escape-to-close and focus that moves in on open and returns to the
// trigger on close (useModalA11y). Items are the caller's business; keep them >= 48px
// tall (`min-h-12`) so they are comfortable touch targets.
//
// Mount with `v-if` at the call site: useModalA11y's hooks must pair with the panel's
// lifetime (an always-mounted sheet would swallow Escape while closed). Nested sheets
// stack — only the top-most one owns Escape, so closing a child leaves the parent open.
const props = defineProps<{ title: string; testId?: string; zClass?: string }>();
const emit = defineEmits<{ close: [] }>();
const panel = ref<HTMLElement | null>(null);
useModalA11y(panel, () => emit("close"));
</script>

<template>
  <!-- Fragment root (backdrop + panel): no attribute fallthrough is expected, callers
       pass only the title/testId props declared above. -->
  <div data-test="sheet-backdrop" class="fixed inset-0 bg-black/40 lg:hidden" :class="zClass ?? 'z-40'" @click="emit('close')" />
  <div ref="panel" role="dialog" aria-modal="true" :aria-label="title" tabindex="-1"
       :data-test="testId"
       class="fixed inset-x-0 bottom-0 flex max-h-[85dvh] flex-col rounded-t-2xl bg-raised shadow-float lg:hidden" :class="zClass ?? 'z-40'">
    <div class="flex shrink-0 items-center justify-between gap-2 px-4 pb-1 pt-3">
      <h2 class="min-w-0 truncate text-base font-semibold text-fg">{{ title }}</h2>
      <button type="button" data-test="sheet-close" :aria-label='$t("common.close")'
              class="grid h-10 w-10 shrink-0 place-items-center rounded-lg text-fg-muted transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              @click="emit('close')"><X :size="18" /></button>
    </div>
    <div class="thin-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))]">
      <slot />
    </div>
  </div>
</template>
