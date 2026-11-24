<script setup lang="ts">
import { watch } from "vue";
import { useChatStore } from "../stores/chat";
import { useTasksStore } from "../stores/tasks";
import ScheduledTasks from "./ScheduledTasks.vue";
import OrchestrationTasks from "./OrchestrationTasks.vue";

const chat = useChatStore();
const tasks = useTasksStore();

watch(
  () => [chat.instanceId, chat.sessionAlias] as const,
  ([id, alias]) => { if (id && alias) void tasks.loadFor(id, alias); },
  { immediate: true },
);
</script>

<template>
  <div v-if="chat.instanceId && chat.sessionAlias" class="flex h-full flex-col">
    <ScheduledTasks />
    <OrchestrationTasks class="min-h-0 flex-1" />
  </div>
  <div v-else class="p-4 text-sm text-fg-muted">{{ $t("taskPanel.noSession") }}</div>
</template>
