<script setup lang="ts">
import { ref } from "vue";

// One button for the whole board: four variants, two visual sizes, and a hit
// area that grows to 44px on coarse pointers (the visual height stays 28/32).
//
// The sizes are the VISUAL surface. `mobile-block` is the dialog-footer shape
// (full-width and 44 tall below lg, compact from lg) that the small forms use;
// it is a layout choice, not a size.
const props = withDefaults(defineProps<{
  variant?: "primary" | "secondary" | "ghost" | "danger" | "danger-ghost";
  size?: "sm" | "md";
  disabled?: boolean;
  type?: "button" | "submit" | "reset";
  /** Stretch to the row and grow to touch height below lg. */
  mobileBlock?: boolean;
}>(), {
  variant: "primary",
  size: "md",
  disabled: false,
  type: "button",
  mobileBlock: false,
});

const VARIANTS: Record<NonNullable<typeof props.variant>, string> = {
  primary: "bg-accent text-on-accent hover:bg-accent-hover disabled:opacity-40",
  secondary: "border border-hairline bg-raised text-fg hover:bg-fill-hover disabled:opacity-40",
  ghost: "text-fg-muted hover:bg-fill-hover hover:text-fg disabled:opacity-40",
  danger: "bg-danger text-on-danger hover:bg-danger/90 disabled:opacity-40",
  "danger-ghost": "text-danger-text hover:bg-danger/10 disabled:opacity-40",
};
const SIZES: Record<NonNullable<typeof props.size>, string> = {
  sm: "h-7 px-2.5 text-xs",
  md: "h-8 px-3 text-ui",
};

// The element, for callers that manage focus themselves (a confirm's safe
// default, a hit-area measurement). A template ref on a component yields the
// instance, not the node.
const el = ref<HTMLButtonElement | null>(null);
defineExpose({ el });
</script>

<template>
  <button
    ref="el"
    :type="type"
    :disabled="disabled"
    class="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-btn font-medium transition-colors ease-ui motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed [@media(pointer:coarse)]:min-h-11"
    :class="[
      VARIANTS[variant],
      SIZES[size],
      mobileBlock ? 'h-11 flex-1 lg:h-8 lg:flex-none' : '',
    ]"
  >
    <slot />
  </button>
</template>
