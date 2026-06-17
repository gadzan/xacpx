<script setup lang="ts">
import { computed } from "vue";
import { Circle, Loader2, CheckCircle2 } from "lucide-vue-next";
import type { PlanEntryDto } from "@ganglion/xacpx-relay-protocol";

const props = defineProps<{ entries: PlanEntryDto[] }>();
const done = computed(() => props.entries.filter((e) => e.status === "completed").length);
const iconOf = (s: PlanEntryDto["status"]) =>
  s === "completed" ? CheckCircle2 : s === "in_progress" ? Loader2 : Circle;
const clsOf = (s: PlanEntryDto["status"]) =>
  s === "completed" ? "text-run" : s === "in_progress" ? "text-accent" : "text-fg-muted";
</script>

<template>
  <div v-if="entries.length" data-test="plan-panel" class="rounded-md border border-border bg-surface p-2 text-sm">
    <div class="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase text-fg-muted">
      Plan <span class="font-mono tabular-nums">{{ done }}/{{ entries.length }}</span>
    </div>
    <ul class="space-y-0.5">
      <li v-for="(e, i) in entries" :key="i" class="flex items-start gap-1.5">
        <component :is="iconOf(e.status)" :size="13" :class="[clsOf(e.status), 'mt-0.5 shrink-0', e.status === 'in_progress' ? 'animate-spin motion-reduce:animate-none' : '']" />
        <span :class="['min-w-0', e.status === 'completed' ? 'text-fg-muted line-through' : 'text-fg']">{{ e.content }}</span>
      </li>
    </ul>
  </div>
</template>
