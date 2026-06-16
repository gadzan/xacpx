<script setup lang="ts">
import { computed, ref } from "vue";
import { ChevronDown, X } from "lucide-vue-next";
import { useTasksStore } from "../stores/tasks";
import { useChatStore } from "../stores/chat";
import ScheduledTaskRow from "./ScheduledTaskRow.vue";

const tasks = useTasksStore();
const chat = useChatStore();
const executeAt = ref("");
const message = ref("");

// The right sidebar is tight, so the inline list shows only the first few tasks; the
// rest live behind a "View all" drawer. Upcoming tasks sort first (see listRecentForChat),
// so the most relevant ones stay visible.
const INLINE_LIMIT = 3;
const visible = computed(() => tasks.scheduled.slice(0, INLINE_LIMIT));
const overflow = computed(() => Math.max(0, tasks.scheduled.length - INLINE_LIMIT));

const drawerOpen = ref(false);

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
      <ScheduledTaskRow v-for="t in visible" :key="t.id" :task="t" />
      <li v-if="tasks.scheduled.length === 0" class="text-xs text-fg-muted">No scheduled tasks.</li>
    </ul>
    <button v-if="overflow > 0" type="button" data-test="scheduled-view-all"
            class="mt-1.5 flex w-full items-center justify-center gap-1 rounded-md border border-border bg-bg px-2 py-1 text-[11px] font-medium text-fg-muted transition-colors hover:bg-accent/10 hover:text-accent"
            @click="drawerOpen = true">
      View all {{ tasks.scheduled.length }}
      <ChevronDown :size="12" />
    </button>
    <form class="mt-2 space-y-1" @submit.prevent="create">
      <input v-model="executeAt" type="datetime-local" class="w-full rounded border border-border bg-bg px-1 py-0.5 text-xs text-fg" />
      <input v-model="message" placeholder="message" class="w-full rounded border border-border bg-bg px-1 py-0.5 text-xs text-fg placeholder:text-fg-muted" />
      <button type="submit" class="w-full rounded bg-accent px-2 py-1 text-xs text-white hover:bg-accent-hover">Schedule</button>
    </form>

    <!-- "View all" drawer: the full, unbounded list of upcoming + recent runs, anchored
         to the right edge so the sidebar stays compact. -->
    <Teleport to="body">
      <Transition
        enter-active-class="transition-opacity duration-200 ease-out motion-reduce:transition-none"
        enter-from-class="opacity-0"
        leave-active-class="transition-opacity duration-150 ease-in motion-reduce:transition-none"
        leave-to-class="opacity-0">
        <div v-if="drawerOpen" data-test="scheduled-drawer" class="fixed inset-0 z-50 flex justify-end bg-black/50" @click.self="drawerOpen = false" @keydown.esc="drawerOpen = false">
          <aside class="flex h-full w-full max-w-md flex-col border-l border-border bg-raised shadow-xl" role="dialog" aria-label="All scheduled tasks">
            <header class="flex items-center justify-between border-b border-border px-4 py-3">
              <h2 class="text-sm font-semibold text-fg">Scheduled · {{ tasks.scheduled.length }}</h2>
              <button class="rounded p-1 text-fg-muted hover:bg-fg/5 hover:text-fg" aria-label="Close" data-test="scheduled-drawer-close" @click="drawerOpen = false"><X :size="16" /></button>
            </header>
            <ul class="flex-1 space-y-1 overflow-y-auto p-3">
              <ScheduledTaskRow v-for="t in tasks.scheduled" :key="t.id" :task="t" @view="drawerOpen = false" />
            </ul>
          </aside>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>
