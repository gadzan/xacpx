<script setup lang="ts">
import { computed, useId } from "vue";
import { Bot } from "lucide-vue-next";
import { agentIconSvg } from "../lib/agent-icons";
import { scopeSvgIds } from "../lib/svg-ids";

// A square brand glyph for an agent driver. Renders the @lobehub/icons SVG when one exists
// for the driver, else a generic robot fallback. The SVG is a build-time bundled constant
// (see agent-icons.ts), not user input, so v-html is safe here.
// `fill` lets a tile-style brand mark bleed to the edges of its parent box (the avatar
// container sets the size, border and rounding) instead of floating at a fixed px size.
// The generic Bot fallback is line-art, so it stays at a fixed px size even in fill mode.
// Lucide's Bot inks ~93% of its box while the brand marks ink about two thirds of theirs,
// so the fallback draws at 72% of `size`: measured in the 32px group bar, its ink then
// matches the codex and character marks (about 13px of a 19px cell).
const props = withDefaults(defineProps<{ driver?: string | null; size?: number; title?: string; fill?: boolean }>(), {
  size: 16,
  fill: false,
});

// Per-instance ids: see scopeSvgIds. Without this a hidden first copy of the glyph
// (mobile bar on desktop) blanks every gradient-filled copy on the page.
const uid = useId();
const svg = computed(() => scopeSvgIds(agentIconSvg(props.driver), uid));
const px = computed(() => `${props.size}px`);
const FALLBACK_SCALE = 0.72;
const fallbackSize = computed(() => Math.round(props.size * FALLBACK_SCALE));
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
    class="shrink-0 place-items-center"
    :class="fill ? 'grid h-full w-full' : 'inline-grid'"
    :style="fill ? undefined : { width: px, height: px }"
  >
    <span v-if="svg" class="grid h-full w-full place-items-center text-fg [&>svg]:block [&>svg]:h-full [&>svg]:w-full" v-html="svg" />
    <Bot v-else :size="fallbackSize" class="text-fg-muted" />
  </span>
</template>
