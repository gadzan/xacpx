<script setup lang="ts">
import { List } from "lucide-vue-next";
import { useTasksStore } from "../stores/tasks";

const tasks = useTasksStore();

// Map an orchestration task status to a semantic text color.
function statusClass(status: string): string {
  const s = status.toLowerCase();
  if (s.includes("run") || s.includes("active")) return "text-run";
  if (s.includes("fail") || s.includes("error") || s.includes("cancel")) return "text-danger";
  if (s.includes("wait") || s.includes("pending") || s.includes("block")) return "text-warn";
  return "text-fg-muted";
}
</script>

<template>
  <div class="bg-surface p-3">
    <h3 class="mb-2 text-xs font-semibold uppercase text-fg-muted">Orchestration</h3>
    <ul class="space-y-1">
      <li v-for="t in tasks.orchestration" :key="t.taskId" class="flex items-center justify-between text-sm text-fg">
        <span class="flex min-w-0 items-center gap-1.5">
          <List :size="14" class="shrink-0 text-fg-muted" />
          <span class="truncate">{{ t.task }} <span class="text-xs" :class="statusClass(t.status)">({{ t.status }})</span></span>
        </span>
        <button data-test="cancel-orchestration" class="ml-2 text-xs text-danger hover:underline" @click="tasks.cancelOrchestration(t.taskId)">cancel</button>
      </li>
      <li v-if="tasks.orchestration.length === 0" class="text-xs text-fg-muted">No orchestration tasks.</li>
    </ul>
  </div>
</template>
