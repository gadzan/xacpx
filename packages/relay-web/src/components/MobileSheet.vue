<script setup lang="ts">
import { ref } from "vue";
import { useModalA11y } from "../lib/use-modal-a11y";
import { X } from "lucide-vue-next";
defineOptions({ inheritAttrs: false });

// Bottom sheet for the mobile (<lg) chrome: a raised panel pinned to the bottom edge,
// with a backdrop, Escape-to-close and focus that moves in on open and returns to the
// trigger on close (useModalA11y). Items are the caller's business; keep them >= 48px
// tall (`min-h-12`) so they are comfortable touch targets.
//
// Mount with `v-if` at the call site: useModalA11y's hooks must pair with the panel's
// lifetime (an always-mounted sheet would swallow Escape while closed). Nested sheets
// stack — only the top-most one owns Escape, so closing a child leaves the parent open.
//
// Two densities: the default header is a title + close row (every row-list sheet). A
// caller that owns its own header — the group run detail, whose header carries a state
// pill, the topic title, the who/when meta row and a Stop action — passes `#header` and
// `:show-close="false"`; the panel keeps the same frame, backdrop, focus contract and
// safe-area padding.
const props = withDefaults(defineProps<{
  /** Accessible dialog name, including when a custom header is provided. */
  title: string;
  testId?: string;
  zClass?: string;
  ddPanel?: boolean;
  /** `tall` gives a document-style sheet more room; content still decides the height. */
  height?: "md" | "tall";
  /** Document padding for reading surfaces (the trace) instead of row padding. */
  padded?: boolean;
  /** The `#header` slot supplies its own close control. */
  showClose?: boolean;
}>(), { height: "md", padded: false, showClose: true });
const emit = defineEmits<{ close: [] }>();
const panel = ref<HTMLElement | null>(null);
const body = ref<HTMLElement | null>(null);
defineExpose({ body });
useModalA11y(panel, () => emit("close"));
</script>

<template>
  <!-- Attributes belong to the dialog, not its backdrop. -->
  <div data-test="sheet-backdrop" class="sheet-backdrop fixed inset-0 bg-black/50 lg:hidden" :class="zClass ?? 'z-40'" @click="emit('close')" />
  <div ref="panel" v-bind="$attrs" role="dialog" aria-modal="true" :aria-label="title" tabindex="-1"
       :data-dd-panel="ddPanel || undefined"
       :data-test="testId"
       class="sheet-panel fixed inset-x-0 bottom-0 flex flex-col overflow-hidden rounded-t-[24px] bg-raised shadow-float lg:hidden"
       :class="[zClass ?? 'z-40', height === 'tall' ? 'max-h-[86dvh]' : 'max-h-[85dvh]']">
    <slot name="header">
      <div class="flex shrink-0 items-center justify-between gap-2 px-4 pb-1 pt-3">
        <h2 class="min-w-0 truncate text-base font-semibold text-fg">{{ title }}</h2>
        <button v-if="showClose" type="button" data-test="sheet-close" :aria-label='$t("common.close")'
                class="grid h-10 w-10 shrink-0 place-items-center rounded-full text-fg-muted transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                @click="emit('close')"><X :size="18" /></button>
      </div>
    </slot>
    <div ref="body" class="thin-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain break-words"
         :class="padded
           ? 'detail-scroll px-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] pt-1'
           : 'px-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))]'">
      <slot />
    </div>
  </div>
</template>

<style scoped>
/* The sheet rises from the bottom edge; the backdrop fades. Only the entry is
   animated (the panel unmounts on close, so there is no exit frame to run). */
.sheet-panel { animation: sheet-rise 240ms cubic-bezier(0.32, 0.72, 0, 1); }
.sheet-backdrop { animation: sheet-fade 200ms ease-out; }
@keyframes sheet-rise {
  from { transform: translateY(100%); }
  to { transform: translateY(0); }
}
@keyframes sheet-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .sheet-panel, .sheet-backdrop { animation: none; }
}
</style>
