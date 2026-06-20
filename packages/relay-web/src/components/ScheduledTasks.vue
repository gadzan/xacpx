<script setup lang="ts">
import { computed, ref } from "vue";
import { CalendarClock, ChevronDown, Plus, X } from "lucide-vue-next";
import { useTasksStore } from "../stores/tasks";
import { useChatStore } from "../stores/chat";
import ScheduledTaskRow from "./ScheduledTaskRow.vue";

const tasks = useTasksStore();
const chat = useChatStore();
const executeAt = ref("");
const message = ref("");
// The create form is tucked behind a "+" toggle so the panel stays compact by default.
const composerOpen = ref(false);

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
  composerOpen.value = false;
}
</script>

<template>
  <div class="shrink-0 border-b border-border bg-surface p-3">
    <div class="mb-2 flex items-center gap-1.5">
      <CalendarClock :size="13" class="shrink-0 text-fg-muted" />
      <h3 class="text-xs font-semibold uppercase tracking-wide text-fg-muted">{{ $t("tasks.scheduled") }}</h3>
      <span v-if="tasks.scheduled.length" class="rounded-full bg-bg px-1.5 font-mono text-[10px] tabular-nums text-fg-muted">{{ tasks.scheduled.length }}</span>
      <button type="button" data-test="scheduled-compose-toggle" :title="$t('tasks.newScheduled')" :aria-label="$t('tasks.newScheduled')"
              class="ml-auto grid h-6 w-6 place-items-center rounded-md transition-colors hover:bg-raised hover:text-fg"
              :class="composerOpen ? 'bg-raised text-fg' : 'text-fg-muted'"
              @click="composerOpen = !composerOpen">
        <Plus :size="14" class="transition-transform" :class="composerOpen ? 'rotate-45' : ''" />
      </button>
    </div>

    <ul class="space-y-1">
      <ScheduledTaskRow v-for="t in visible" :key="t.id" :task="t" />
      <li v-if="tasks.scheduled.length === 0" class="rounded-md border border-dashed border-border px-2 py-2 text-center text-[11px] text-fg-muted">{{ $t("tasks.noScheduled") }}</li>
    </ul>

    <button v-if="overflow > 0" type="button" data-test="scheduled-view-all"
            class="mt-1.5 flex w-full items-center justify-center gap-1 rounded-md border border-border bg-bg px-2 py-1 text-[11px] font-medium text-fg-muted transition-colors hover:bg-accent/10 hover:text-accent"
            @click="drawerOpen = true">
      {{ $t("tasks.viewAll", { count: tasks.scheduled.length }) }}
      <ChevronDown :size="12" />
    </button>

    <!-- create form: tucked behind the "+" toggle so the panel stays compact by default -->
    <form v-if="composerOpen" data-test="scheduled-composer" class="mt-2 space-y-2 rounded-lg border border-border bg-bg p-2.5" @submit.prevent="create">
      <label class="flex flex-col gap-1">
        <span class="text-[10px] font-semibold uppercase tracking-wide text-fg-muted">{{ $t("tasks.whenLabel") }}</span>
        <input v-model="executeAt" type="datetime-local" class="w-full rounded-md border border-border bg-surface px-2 py-1 text-xs text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent" />
      </label>
      <label class="flex flex-col gap-1">
        <span class="text-[10px] font-semibold uppercase tracking-wide text-fg-muted">{{ $t("tasks.messageLabel") }}</span>
        <input v-model="message" :placeholder="$t('tasks.messagePlaceholder')" class="w-full rounded-md border border-border bg-surface px-2 py-1 text-xs text-fg placeholder:text-fg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent" />
      </label>
      <div class="flex items-center gap-1.5 pt-0.5">
        <button type="submit" :disabled="!executeAt || !message"
                class="flex-1 rounded-md bg-accent px-2 py-1 text-xs font-medium text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40">{{ $t("tasks.schedule") }}</button>
        <button type="button" class="rounded-md border border-border px-2 py-1 text-xs text-fg-muted transition-colors hover:bg-raised hover:text-fg" @click="composerOpen = false">{{ $t("common.cancel") }}</button>
      </div>
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
          <aside class="flex h-full w-full max-w-md flex-col border-l border-border bg-raised shadow-xl" role="dialog" :aria-label="$t('tasks.allScheduled')">
            <header class="flex items-center justify-between border-b border-border px-4 py-3">
              <h2 class="text-sm font-semibold text-fg">{{ $t("tasks.scheduledCount", { count: tasks.scheduled.length }) }}</h2>
              <button class="rounded p-1 text-fg-muted hover:bg-fg/5 hover:text-fg" :aria-label="$t('tasks.close')" data-test="scheduled-drawer-close" @click="drawerOpen = false"><X :size="16" /></button>
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
