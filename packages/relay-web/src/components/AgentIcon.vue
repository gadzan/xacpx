<script setup lang="ts">
import { computed } from "vue";
import { Bot } from "lucide-vue-next";
import { agentIconSvg } from "../lib/agent-icons";

// A square brand glyph for an agent driver. Renders the @lobehub/icons SVG when one exists
// for the driver, else a generic robot fallback. The SVG is a build-time bundled constant
// (see agent-icons.ts), not user input, so v-html is safe here.
// `fill` lets a tile-style brand mark bleed to the edges of its parent box (the avatar
// container sets the size, border and rounding) instead of floating at a fixed px size.
// The generic Bot fallback is line-art, so it stays at `size` even in fill mode.
const props = withDefaults(defineProps<{ driver?: string | null; size?: number; title?: string; fill?: boolean }>(), {
  size: 16,
  fill: false,
});

const svg = computed(() => agentIconSvg(props.driver));
const px = computed(() => `${props.size}px`);
</script>

<template>
  <!-- The wrapper fixes the box; the brand SVG (which ships at its own 1em size) is forced
       to fill the box so every mark lands at the same size, centered. The fill rule must
       sit on the element the <svg> is a DIRECT child of — for a v-html brand icon that's
       the inner span, not this wrapper. -->
  <span
    data-test="agent-icon"
    :data-driver="driver || ''"
    :title="title"
    role="img"
    :aria-label="title || driver || undefined"
    class="shrink-0 place-items-center [&>svg]:h-full [&>svg]:w-full"
    :class="fill ? 'grid h-full w-full' : 'inline-grid'"
    :style="fill ? undefined : { width: px, height: px }"
  >
    <span v-if="svg" class="grid h-full w-full place-items-center [&>svg]:block [&>svg]:h-full [&>svg]:w-full" v-html="svg" />
    <Bot v-else :size="size" class="text-fg-muted" />
  </span>
</template>
