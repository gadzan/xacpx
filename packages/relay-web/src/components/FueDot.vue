<script setup lang="ts">
// A small onboarding badge that sits on a `position:relative` affordance. Pulses
// while the feature is unseen, then settles to a static dot once the user engages.
withDefaults(defineProps<{ pulsing?: boolean }>(), { pulsing: true });
</script>

<template>
  <span
    data-test="fue-dot"
    class="inline-block h-2 w-2 rounded-full bg-sky-500"
    :class="pulsing ? 'animate-pulse' : ''"
    aria-hidden="true"
  />
</template>
