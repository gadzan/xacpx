<script setup lang="ts">
import { ref } from "vue";
import { Clock } from "lucide-vue-next";
import { useTasksStore } from "../stores/tasks";
import { useChatStore } from "../stores/chat";

const tasks = useTasksStore();
const chat = useChatStore();
const executeAt = ref("");
const message = ref("");

async function create() {
  if (!chat.instanceId || !chat.sessionAlias || !executeAt.value || !message.value) return;
  const iso = new Date(executeAt.value).toISOString();
  await tasks.createScheduled(chat.instanceId, chat.sessionAlias, iso, message.value);
  executeAt.value = "";
  message.value = "";
}
</script>

<template>
  <div class="border-b border-border bg-surface p-3">
    <h3 class="mb-2 text-xs font-semibold uppercase text-fg-muted">Scheduled</h3>
    <ul class="space-y-1">
      <li v-for="t in tasks.scheduled" :key="t.id" class="flex items-center justify-between text-sm text-fg">
        <span class="flex min-w-0 items-center gap-1.5">
          <Clock :size="14" class="shrink-0 text-fg-muted" />
          <span class="truncate"><span class="font-mono text-fg-muted">{{ new Date(t.executeAt).toLocaleString() }}</span> {{ t.message }}</span>
        </span>
        <button data-test="cancel-scheduled" class="ml-2 text-xs text-danger hover:underline" @click="tasks.cancelScheduled(t.id)">cancel</button>
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
