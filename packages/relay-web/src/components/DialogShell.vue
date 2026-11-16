<script setup lang="ts">
import { ref } from "vue";
import { useModalA11y } from "../lib/use-modal-a11y";

// One modal shell: scrim, panel, focus trap, Escape, safe-area padding, layer.
//
// The panel classes are the CALLER's: widths differ on purpose (380px confirms,
// md pickers, lg forms, 3xl/4xl reading overlays), and merging two conflicting
// Tailwind fills would resolve by stylesheet order, not by intent. So the shell
// owns the frame and the accessibility contract, and the caller owns the panel.
//
// `useModalA11y` lives here: it registers the panel in the modal stack that both
// Escape and the mobile back navigation walk, so every dialog closes through the
// same path and nested dialogs only close the top-most one.
//
// The root is a plain element on purpose. A dialog that must escape a
// `transform`ed ancestor wraps this shell in its own `<Teleport to="body">`;
// keeping the Teleport at the call site keeps the shell testable in place.
const props = withDefaults(defineProps<{
  /** Accessible name; pass `labelledby` when the title element has an id. */
  label?: string;
  labelledby?: string;
  /** Panel classes: width, max-height, radius, padding. */
  panelClass?: string;
  /** Rendered as `data-test` on the panel (not the scrim). Named `testId` so a
   *  literal `data-test` attribute does not fall through to the wrapper and
   *  shadow the panel for selectors. */
  testId?: string;
  /** Inset the scrim by the device safe area (full-height dialogs). */
  safeArea?: boolean;
  /** The rung this dialog takes on the overlay ladder (tailwind zIndex). A
   *  dialog opened from another dialog is `nested`; one opened over a drawer
   *  or a sheet stack is `top`. */
  level?: "dialog" | "nested" | "top";
  /** Dimming blur override; the default is the shared scrim token (3px). */
  blurClass?: string;
  /** First control to focus; defaults to the first focusable in the panel.
   *  Accepts the raw ref the caller already holds (its `.value` is usually
   *  still null at setup) or a getter for one. */
  initialFocus?: (() => HTMLElement | null) | { value: HTMLElement | null };
}>(), {
  panelClass: "max-h-[85vh] w-full max-w-md rounded-2xl",
  safeArea: false,
  level: "dialog",
  blurClass: "backdrop-blur-scrim",
});
const emit = defineEmits<{ close: [] }>();

const panel = ref<HTMLElement | null>(null);
/** Focus a tab or button inside the panel without leaving the shell. Managed
 *  instances switches tabs by id; callers that need post-mount focus pass
 *  `initial-focus` instead. */
function focusChild(selector: string): void {
  panel.value?.querySelector<HTMLElement>(selector)?.focus();
}
useModalA11y(panel, () => emit("close"), {
  initialFocus: () => (typeof props.initialFocus === "function" ? props.initialFocus() : props.initialFocus?.value) ?? null,
});
// Token, not a raw z-index: the ladder lives in tailwind.config.js so the next
// stacked overlay picks a rung it can reason about.
const Z: Record<NonNullable<typeof props.level>, string> = {
  dialog: "z-dialog",
  nested: "z-dialog-nested",
  top: "z-dialog-top",
};
defineExpose({ panel, focusChild });
</script>

<template>
  <div
    class="fixed inset-0 flex items-center justify-center bg-scrim p-4"
    :class="[
      Z[level],
      blurClass,
      safeArea
        ? 'h-dvh pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))]'
        : '',
    ]"
    @click.self="emit('close')"
  >
    <div
      ref="panel"
      role="dialog"
      aria-modal="true"
      :aria-label="label"
      :aria-labelledby="labelledby"
      tabindex="-1"
      :data-test="testId"
      class="bg-glass-strong text-fg shadow-glass-float backdrop-blur-glass backdrop-saturate-glass focus:outline-none"
      :class="panelClass"
    >
      <slot />
    </div>
  </div>
</template>
