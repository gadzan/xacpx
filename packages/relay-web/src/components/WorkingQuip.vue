<script setup lang="ts">
import RunStatusChip from "./RunStatusChip.vue";

// The transcript's floating bubble. It carries only the running state today (a session
// `LiveTurn` has no waiting/queued phase), so it renders the shared chip in `running` and
// keeps the shimmering quip copy.
defineProps<{ status: string; elapsed: string }>();
</script>

<template>
  <RunStatusChip state="running" :label="status" :elapsed="elapsed" shimmer />
</template>
