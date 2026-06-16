<script setup lang="ts">
import { ref } from "vue";
import { Clock, Loader2, CheckCircle2, XCircle, AlertTriangle, Ban, Eye, Trash2, ChevronRight } from "lucide-vue-next";
import type { ScheduledTaskStatusDto } from "@ganglion/xacpx-relay-protocol";
import { useTasksStore } from "../stores/tasks";
import { useChatStore } from "../stores/chat";
import { confirm } from "../lib/use-confirm";

const tasks = useTasksStore();
const chat = useChatStore();
const executeAt = ref("");
const message = ref("");

// Rows collapse to a compact line by default (the list got long, especially with error
// text). Click a row to expand its full message / time / failure reason. Expanded ids
// are tracked in a reactive Set.
const expanded = ref<Set<string>>(new Set());
function toggle(id: string) {
  const next = new Set(expanded.value);
  next.has(id) ? next.delete(id) : next.add(id);
  expanded.value = next;
}

// Per-status presentation. "Upcoming" tasks can still be cancelled; everything else is a
// terminal run record kept in place (Done/Failed/…) so a fired task never silently vanishes.
type Pres = { label: string; cls: string; icon: typeof Clock; spin?: boolean };
function present(status: ScheduledTaskStatusDto): Pres {
  switch (status) {
    case "pending": return { label: "Upcoming", cls: "text-fg-muted", icon: Clock };
    case "triggering": return { label: "Running", cls: "text-run", icon: Loader2, spin: true };
    case "executed": return { label: "Done", cls: "text-run", icon: CheckCircle2 };
    case "failed": return { label: "Failed", cls: "text-danger", icon: XCircle };
    case "missed": return { label: "Missed", cls: "text-warn", icon: AlertTriangle };
    case "cancelled": return { label: "Cancelled", cls: "text-fg-muted", icon: Ban };
  }
}

async function create() {
  if (!chat.instanceId || !chat.sessionAlias || !executeAt.value || !message.value) return;
  const iso = new Date(executeAt.value).toISOString();
  await tasks.createScheduled(chat.instanceId, chat.sessionAlias, iso, message.value);
  executeAt.value = "";
  message.value = "";
}

async function cancel(id: string) {
  const ok = await confirm({
    title: "Cancel scheduled task?",
    message: "It will be removed from the schedule and won't run.",
    confirmLabel: "Cancel task",
    cancelLabel: "Keep",
    tone: "danger",
  });
  if (ok) await tasks.cancelScheduled(id);
}
</script>

<template>
  <div class="border-b border-border bg-surface p-3">
    <h3 class="mb-2 text-xs font-semibold uppercase text-fg-muted">Scheduled</h3>
    <ul class="space-y-1">
      <li v-for="t in tasks.scheduled" :key="t.id" data-test="scheduled-item" class="rounded-md border border-border bg-bg text-sm">
        <!-- compact header (click to expand) + actions -->
        <div class="flex items-center gap-1 px-2 py-1.5">
          <button type="button" :data-test="`scheduled-toggle-${t.id}`" class="flex min-w-0 flex-1 items-center gap-1.5 text-left cursor-pointer" @click="toggle(t.id)">
            <ChevronRight :size="12" class="shrink-0 text-fg-muted transition-transform" :class="expanded.has(t.id) ? 'rotate-90' : ''" />
            <span :data-test="`scheduled-status-${t.id}`" class="inline-flex shrink-0 items-center gap-1 text-[11px] font-medium" :class="present(t.status).cls">
              <component :is="present(t.status).icon" :size="12" :class="present(t.status).spin ? 'animate-spin motion-reduce:animate-none' : ''" />
              {{ present(t.status).label }}
            </span>
            <span class="min-w-0 flex-1 truncate text-[12.5px] text-fg">{{ t.message }}</span>
          </button>
          <span class="flex shrink-0 items-center gap-0.5">
            <button v-if="t.status === 'executed'" data-test="view-scheduled" title="View this run in the conversation" aria-label="View run"
                    class="grid h-6 w-6 place-items-center rounded text-fg-muted transition-colors hover:bg-accent/15 hover:text-accent"
                    @click="chat.requestScrollToScheduled(t.id)"><Eye :size="13" /></button>
            <button v-if="t.status === 'pending'" data-test="cancel-scheduled" title="Cancel scheduled task" aria-label="Cancel scheduled task"
                    class="grid h-6 w-6 place-items-center rounded text-fg-muted transition-colors hover:bg-danger/15 hover:text-danger"
                    @click="cancel(t.id)"><Trash2 :size="13" /></button>
          </span>
        </div>
        <!-- expanded details -->
        <div v-if="expanded.has(t.id)" :data-test="`scheduled-detail-${t.id}`" class="space-y-1 border-t border-border px-2 py-1.5">
          <p class="whitespace-pre-wrap text-[12.5px] text-fg">{{ t.message }}</p>
          <p class="font-mono text-[10.5px] tabular-nums text-fg-muted">{{ new Date(t.executeAt).toLocaleString() }}</p>
          <p v-if="t.status === 'failed' && t.lastError" :data-test="`scheduled-error-${t.id}`" class="rounded bg-danger/10 px-2 py-1 text-[11px] text-danger">{{ t.lastError }}</p>
        </div>
      </li>
      <li v-if="tasks.scheduled.length === 0" class="text-xs text-fg-muted">No scheduled tasks.</li>
    </ul>
    <form class="mt-2 space-y-1" @submit.prevent="create">
      <input v-model="executeAt" type="datetime-local" class="w-full rounded border border-border bg-bg px-1 py-0.5 text-xs text-fg" />
      <input v-model="message" placeholder="message" class="w-full rounded border border-border bg-bg px-1 py-0.5 text-xs text-fg placeholder:text-fg-muted" />
      <button type="submit" class="w-full rounded bg-accent px-2 py-1 text-xs text-white hover:bg-accent-hover">Schedule</button>
    </form>
  </div>
</template>
