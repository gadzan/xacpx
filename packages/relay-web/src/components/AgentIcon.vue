<script setup lang="ts">
import { computed } from "vue";
import { Bot } from "lucide-vue-next";
import { agentIconSvg } from "../lib/agent-icons";

// A square brand glyph for an agent driver. Renders the @lobehub/icons SVG when one exists
// for the driver, else a generic robot fallback. The SVG is a build-time bundled constant
// (see agent-icons.ts), not user input, so v-html is safe here.
const props = withDefaults(defineProps<{ driver?: string | null; size?: number; title?: string }>(), {
  size: 16,
});

const svg = computed(() => agentIconSvg(props.driver));
const px = computed(() => `${props.size}px`);
</script>

<template>
  <!-- The wrapper fixes the box; the inner SVG (which ships with its own width/height) is
       forced to fill it so every brand mark lands at the same size. -->
  <span
    data-test="agent-icon"
    :data-driver="driver || ''"
    :title="title"
    class="inline-grid shrink-0 place-items-center [&>svg]:h-full [&>svg]:w-full"
    :style="{ width: px, height: px }"
  >
    <span v-if="svg" class="grid h-full w-full place-items-center" v-html="svg" />
    <Bot v-else :size="size" class="text-fg-muted" />
  </span>
</template>
