<script setup lang="ts">
import MobileSheet from "./MobileSheet.vue";

// The shell around a composer completion list. Desktop: the glass popover
// anchored above the composer. Below lg: the same content inside a bottom
// sheet. Both stay next to the composer instead of taking over the screen —
// the caret must not move while the list is open.
//
// The sheet renders through a Teleport because the composer sits in a stacked
// layer, and it must not move focus on mount: the textarea keeps DOM focus and
// owns aria-activedescendant, so `data-sheet-initial-focus` marks a target that
// is not focusable.
defineProps<{
  open: boolean;
  mobile: boolean;
  title: string;
  sheetTestId: string;
  panelClass?: string;
}>();
const emit = defineEmits<{ close: [] }>();
</script>

<template>
  <Teleport v-if="open && mobile" to="body">
    <MobileSheet :title="title" :test-id="sheetTestId" data-completion-surface @close="emit('close')">
      <span data-sheet-initial-focus aria-hidden="true" />
      <slot :mobile="true" />
    </MobileSheet>
  </Teleport>
  <div
    v-else-if="open"
    data-completion-surface
    class="absolute bottom-full left-0 z-20 mb-2 w-full overflow-y-auto rounded-lg bg-glass-strong p-1 shadow-glass-float backdrop-blur-glass backdrop-saturate-glass"
    :class="panelClass ?? 'max-h-80'"
  >
    <slot :mobile="false" />
  </div>
</template>
