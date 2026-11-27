<script setup lang="ts">
import { ref } from "vue";

// One button for the whole board: four variants, two visual sizes, and a hit
// area that grows to 44px on coarse pointers (the visual height stays 28/32).
//
// Pressing it moves it: a 2% inward scale over the shared 150ms curve, so the
// control answers the pointer before the action lands. Under reduced motion the
// scale is dropped and only the fill changes.
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
  // A filled primary is the only control with a hue-tinted shadow: it sits on
  // the page rather than floating above it, so it gets the button shadow, never
  // the overlay one. The sheen is a background-image over the fill, so the
  // control catches light at the top the way a piece of glass does — a flat
  // fill with one soft shadow is what made the old buttons read as plastic.
  primary: "bg-accent bg-[linear-gradient(180deg,rgba(255,255,255,0.16),rgba(255,255,255,0))] text-on-accent shadow-btn hover:bg-accent-hover disabled:opacity-40 disabled:shadow-none",
  // Secondary is a frosted wafer: translucent, hairline-edged, with a
  // specular top edge. On the raised workbench a solid white pill vanishes.
  secondary: "border border-hairline bg-raised/75 text-fg shadow-btn-raised backdrop-blur-sm hover:bg-raised disabled:opacity-40 dark:bg-white/[0.06] dark:hover:bg-white/[0.11]",
  ghost: "text-fg-muted hover:bg-fill-hover hover:text-fg active:bg-fill-strong disabled:opacity-40",
  danger: "bg-danger bg-[linear-gradient(180deg,rgba(255,255,255,0.16),rgba(255,255,255,0))] text-on-danger shadow-btn-raised hover:bg-danger/90 disabled:opacity-40 disabled:shadow-none",
  "danger-ghost": "border border-transparent text-danger-text hover:border-danger/20 hover:bg-danger/10 disabled:opacity-40",
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
    class="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-btn font-medium transition-[transform,background-color,border-color,box-shadow,color] duration-150 ease-ui active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed [@media(pointer:coarse)]:min-h-11"
    :class="[
      VARIANTS[variant],
      SIZES[size],
      mobileBlock ? 'h-11 flex-1 lg:h-8 lg:flex-none' : '',
    ]"
  >
    <slot />
  </button>
</template>
