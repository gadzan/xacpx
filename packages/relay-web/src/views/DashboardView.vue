<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { useRouter } from "vue-router";
import { connectEvents } from "../api/events";
import { useAuthStore } from "../stores/auth";
import { useInstancesStore } from "../stores/instances";
import { useChatStore } from "../stores/chat";
import { useTasksStore } from "../stores/tasks";
import { useNoticesStore } from "../stores/notices";
import { useConnectionStore } from "../stores/connection";
import InstanceTree from "../components/InstanceTree.vue";
import ChatPane from "../components/ChatPane.vue";
import TaskPanel from "../components/TaskPanel.vue";
import FilesPanel from "../components/FilesPanel.vue";
import NoticeToast from "../components/NoticeToast.vue";
import ConnectionBadge from "../components/ConnectionBadge.vue";

const instances = useInstancesStore();
const chat = useChatStore();
const tasks = useTasksStore();
const notices = useNoticesStore();
const conn = useConnectionStore();
const auth = useAuthStore();
const router = useRouter();
let disconnect: (() => void) | null = null;

// Mobile-only drawer state. On desktop (lg:) both panels are static columns and
// these flags are visually irrelevant because the lg: classes override the transform.
const leftOpen = ref(false);
const rightOpen = ref(false);
const rightTab = ref<"tasks" | "files">("tasks");
function closeDrawers() {
  leftOpen.value = false;
  rightOpen.value = false;
}

async function onLogout() {
  await auth.logout();
  router.push({ name: "login" });
}

function onSelect(instanceId: string, alias: string) {
  chat.select(instanceId, alias);
  void chat.loadHistory().catch(() => {});
  leftOpen.value = false; // mobile: jump straight to the conversation
}

let everOnline = false;
async function reloadSnapshot() {
  await instances.loadInstances().catch(() => {});
  if (chat.instanceId && chat.sessionAlias) {
    await instances.loadSessions(chat.instanceId).catch(() => {});
    await chat.loadHistory().catch(() => {});
    await tasks.loadFor(chat.instanceId, chat.sessionAlias).catch(() => {});
  }
}
function onStatus(online: boolean) {
  conn.setOnline(online);
  if (online) {
    if (everOnline) void reloadSnapshot();
    everOnline = true;
  }
}

onMounted(async () => {
  await instances.loadInstances();
  disconnect = connectEvents((event) => {
    instances.applyEvent(event);
    chat.applyEvent(event);
    tasks.applyEvent(event);
    notices.applyEvent(event);
  }, onStatus);
});

onUnmounted(() => disconnect?.());
</script>

<template>
  <div class="flex h-screen flex-col">
    <ConnectionBadge />

    <!-- Mobile top bar: hamburger opens the instance tree, Tasks opens the task panel. -->
    <div class="flex items-center gap-2 border-b bg-white px-2 py-1.5 lg:hidden">
      <button data-test="open-instances" aria-label="Open instances"
              class="rounded p-1 text-lg leading-none hover:bg-slate-100" @click="leftOpen = true">☰</button>
      <span class="flex-1 truncate text-center text-sm font-medium">{{ chat.sessionAlias ?? "xacpx relay" }}</span>
      <button data-test="open-tasks" class="rounded px-2 py-1 text-xs text-slate-600 hover:bg-slate-100"
              @click="rightOpen = true">Tasks</button>
    </div>

    <div class="flex flex-1 overflow-hidden">
      <!-- Backdrop closes any open drawer (mobile only). -->
      <div v-if="leftOpen || rightOpen" data-test="drawer-backdrop"
           class="fixed inset-0 z-30 bg-black/30 lg:hidden" @click="closeDrawers" />

      <!-- Left: instances. Off-canvas drawer < lg, static column ≥ lg. -->
      <div data-test="column" data-drawer="left"
           class="fixed inset-y-0 left-0 z-40 flex w-72 max-w-[85%] shrink-0 transform flex-col bg-white shadow-lg transition-transform lg:static lg:z-auto lg:max-w-none lg:translate-x-0 lg:transform-none lg:shadow-none"
           :class="leftOpen ? 'translate-x-0' : '-translate-x-full'">
        <div class="flex items-center justify-between border-b p-2 text-xs">
          <router-link to="/settings" class="text-slate-500 hover:underline">Settings</router-link>
          <div class="flex items-center gap-3">
            <button class="text-slate-500 hover:underline" @click="onLogout">Logout</button>
            <button data-test="close-instances" aria-label="Close instances"
                    class="text-slate-400 hover:text-slate-600 lg:hidden" @click="leftOpen = false">✕</button>
          </div>
        </div>
        <InstanceTree @select="onSelect" />
      </div>

      <!-- Center: chat, always full width of the remaining space. -->
      <div data-test="column" class="flex flex-1 flex-col">
        <ChatPane @show-files="rightTab = 'files'" />
      </div>

      <!-- Right: tasks. Off-canvas drawer < lg, static column ≥ lg. -->
      <div data-test="column" data-drawer="right"
           class="fixed inset-y-0 right-0 z-40 w-72 max-w-[85%] shrink-0 transform overflow-y-auto border-l bg-white shadow-lg transition-transform lg:static lg:z-auto lg:max-w-none lg:translate-x-0 lg:transform-none lg:shadow-none"
           :class="rightOpen ? 'translate-x-0' : 'translate-x-full'">
        <div class="flex items-center gap-1 border-b p-2">
          <div class="flex overflow-hidden rounded border text-xs">
            <button data-test="right-tab-tasks" class="px-2 py-1" :class="rightTab === 'tasks' ? 'bg-sky-500 text-white' : 'text-slate-500'" @click="rightTab = 'tasks'">Tasks</button>
            <button data-test="right-tab-files" class="px-2 py-1" :class="rightTab === 'files' ? 'bg-sky-500 text-white' : 'text-slate-500'" @click="rightTab = 'files'">Files</button>
          </div>
          <button data-test="close-tasks" aria-label="Close tasks"
                  class="ml-auto text-slate-400 hover:text-slate-600 lg:hidden" @click="rightOpen = false">✕</button>
        </div>
        <TaskPanel v-if="rightTab === 'tasks'" />
        <FilesPanel v-else :instance-id="chat.instanceId" />
      </div>
    </div>
    <NoticeToast />
  </div>
</template>
