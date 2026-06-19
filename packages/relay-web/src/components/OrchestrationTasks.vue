<script setup lang="ts">
import { Ban, List } from "lucide-vue-next";
import { useI18n } from "vue-i18n";
import { useTasksStore } from "../stores/tasks";
import { confirm } from "../lib/use-confirm";

const { t } = useI18n();
const tasks = useTasksStore();

async function cancel(taskId: string) {
  const ok = await confirm({
    title: t("tasks.cancelTitle"),
    message: t("tasks.cancelBody"),
    confirmLabel: t("tasks.cancelConfirm"),
    cancelLabel: t("tasks.keepRunning"),
    tone: "danger",
  });
  if (ok) await tasks.cancelOrchestration(taskId);
}

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
    <h3 class="mb-2 text-xs font-semibold uppercase text-fg-muted">{{ $t("tasks.orchestration") }}</h3>
    <ul class="space-y-1">
      <li v-for="t in tasks.orchestration" :key="t.taskId" class="flex items-center justify-between text-sm text-fg">
        <span class="flex min-w-0 items-center gap-1.5">
          <List :size="14" class="shrink-0 text-fg-muted" />
          <span class="truncate">{{ t.task }} <span class="text-xs" :class="statusClass(t.status)">({{ t.status }})</span></span>
        </span>
        <button data-test="cancel-orchestration" :title="$t('tasks.cancelTask')" :aria-label="$t('tasks.cancelOrchestrationAria')"
                class="ml-2 grid h-6 w-6 shrink-0 place-items-center rounded text-fg-muted transition-colors hover:bg-danger/15 hover:text-danger"
                @click="cancel(t.taskId)"><Ban :size="13" /></button>
      </li>
      <li v-if="tasks.orchestration.length === 0" class="text-xs text-fg-muted">{{ $t("tasks.noOrchestration") }}</li>
    </ul>
  </div>
</template>
