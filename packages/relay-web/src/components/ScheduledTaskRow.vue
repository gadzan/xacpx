<script setup lang="ts">
import { ref } from "vue";
import { Clock, Loader2, CheckCircle2, XCircle, AlertTriangle, Ban, Eye, Trash2, ChevronRight } from "lucide-vue-next";
import { useI18n } from "vue-i18n";
import type { ScheduledTaskDto, ScheduledTaskStatusDto } from "@ganglion/xacpx-relay-protocol";
import { useTasksStore } from "../stores/tasks";
import { useChatStore } from "../stores/chat";
import { confirm } from "../lib/use-confirm";
import { fmtDateTime } from "../lib/format";

const props = defineProps<{ task: ScheduledTaskDto }>();
const emit = defineEmits<{ view: [] }>();

const { t } = useI18n();
const tasks = useTasksStore();
const chat = useChatStore();

// Each row owns its expand state (collapsed by default — the list got long, especially
// with error text). Click the header to reveal the full message / time / failure reason.
const open = ref(false);

// Per-status presentation. "Upcoming" tasks can still be cancelled; everything else is a
// terminal run record kept in place (Done/Failed/…) so a fired task never silently vanishes.
type Pres = { label: string; cls: string; icon: typeof Clock; spin?: boolean };
function present(status: ScheduledTaskStatusDto): Pres {
  switch (status) {
    case "pending": return { label: t("tasks.statusUpcoming"), cls: "text-fg-muted", icon: Clock };
    case "triggering": return { label: t("tasks.statusRunning"), cls: "text-run", icon: Loader2, spin: true };
    case "executed": return { label: t("tasks.statusDone"), cls: "text-run", icon: CheckCircle2 };
    case "failed": return { label: t("tasks.statusFailed"), cls: "text-danger", icon: XCircle };
    case "missed": return { label: t("tasks.statusMissed"), cls: "text-warn", icon: AlertTriangle };
    case "cancelled": return { label: t("tasks.statusCancelled"), cls: "text-fg-muted", icon: Ban };
  }
}

function view() {
  // Jumping to a run lives in the conversation, so close any overlay (drawer) the row
  // is rendered inside; the parent decides what "view" means for its surface.
  chat.requestScrollToScheduled(props.task.id);
  emit("view");
}

async function cancel(id: string) {
  const ok = await confirm({
    title: t("tasks.cancelScheduledTitle"),
    message: t("tasks.cancelScheduledBody"),
    confirmLabel: t("tasks.cancelTask"),
    cancelLabel: t("tasks.keep"),
    tone: "danger",
  });
  if (ok) await tasks.cancelScheduled(id);
}
</script>

<template>
  <li data-test="scheduled-item" class="rounded-md border border-border bg-bg text-sm">
    <!-- compact header (click to expand) + actions -->
    <div class="flex items-center gap-1 px-2 py-1.5">
      <button type="button" :data-test="`scheduled-toggle-${task.id}`" class="flex min-w-0 flex-1 items-center gap-1.5 text-left cursor-pointer" @click="open = !open">
        <ChevronRight :size="12" class="shrink-0 text-fg-muted transition-transform" :class="open ? 'rotate-90' : ''" />
        <span :data-test="`scheduled-status-${task.id}`" class="inline-flex shrink-0 items-center gap-1 text-[11px] font-medium" :class="present(task.status).cls">
          <component :is="present(task.status).icon" :size="12" :class="present(task.status).spin ? 'animate-spin motion-reduce:animate-none' : ''" />
          {{ present(task.status).label }}
        </span>
        <span class="min-w-0 flex-1 truncate text-[12.5px] text-fg">{{ task.message }}</span>
      </button>
      <span class="flex shrink-0 items-center gap-0.5">
        <button v-if="task.status === 'executed'" data-test="view-scheduled" :title="$t('tasks.viewRunTitle')" :aria-label="$t('tasks.viewRun')"
                class="grid h-6 w-6 place-items-center rounded text-fg-muted transition-colors hover:bg-accent/15 hover:text-accent"
                @click="view"><Eye :size="13" /></button>
        <button v-if="task.status === 'pending'" data-test="cancel-scheduled" :title="$t('tasks.cancelScheduled')" :aria-label="$t('tasks.cancelScheduled')"
                class="grid h-6 w-6 place-items-center rounded text-fg-muted transition-colors hover:bg-danger/15 hover:text-danger"
                @click="cancel(task.id)"><Trash2 :size="13" /></button>
      </span>
    </div>
    <!-- expanded details -->
    <div v-if="open" :data-test="`scheduled-detail-${task.id}`" class="space-y-1 border-t border-border px-2 py-1.5">
      <p class="whitespace-pre-wrap text-[12.5px] text-fg">{{ task.message }}</p>
      <p class="font-mono text-[10.5px] tabular-nums text-fg-muted">{{ fmtDateTime(task.executeAt) }}</p>
      <p v-if="task.status === 'failed' && task.lastError" :data-test="`scheduled-error-${task.id}`" class="rounded bg-danger/10 px-2 py-1 text-[11px] text-danger">{{ task.lastError }}</p>
    </div>
  </li>
</template>
