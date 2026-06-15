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
import CommandPalette from "../components/CommandPalette.vue";
import BrandLogo from "../components/BrandLogo.vue";
import { useThemeStore } from "../stores/theme";
import { Search, Moon, Sun, Settings } from "lucide-vue-next";
import { useComposerStore } from "../stores/composer";

const theme = useThemeStore();
const instances = useInstancesStore();
const chat = useChatStore();
const composer = useComposerStore();
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

// Cmd/Ctrl+K command palette.
const paletteOpen = ref(false);
const composerKey = () => `${chat.instanceId}\0${chat.sessionAlias}`;
function onGlobalKey(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    paletteOpen.value = !paletteOpen.value;
  }
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
  window.addEventListener("keydown", onGlobalKey);
  await instances.loadInstances();
  disconnect = connectEvents((event) => {
    instances.applyEvent(event);
    chat.applyEvent(event);
    tasks.applyEvent(event);
    notices.applyEvent(event);
  }, onStatus);
});

onUnmounted(() => {
  window.removeEventListener("keydown", onGlobalKey);
  disconnect?.();
});
</script>

<template>
  <div class="flex h-screen flex-col bg-bg text-fg">
    <!-- Global top bar: brand + connection status on the left; search, theme, settings on the right. -->
    <header class="flex h-11 shrink-0 items-center gap-3 border-b border-border bg-surface px-3">
      <BrandLogo />
      <ConnectionBadge />
      <div class="ml-auto flex items-center gap-1">
        <button
          data-test="global-search"
          aria-label="Search"
          class="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-fg-muted hover:bg-fg/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          @click="paletteOpen = true"
        >
          <Search :size="16" />
          <span class="hidden font-mono sm:inline">⌘K</span>
        </button>
        <button
          data-test="theme-toggle"
          :aria-label="theme.mode === 'dark' ? 'Switch to light' : 'Switch to dark'"
          class="rounded-md p-1.5 text-fg-muted hover:bg-fg/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          @click="theme.toggle()"
        >
          <Moon v-if="theme.mode === 'dark'" :size="18" />
          <Sun v-else :size="18" />
        </button>
        <router-link
          to="/settings"
          data-test="settings-link"
          aria-label="Settings"
          class="rounded-md p-1.5 text-fg-muted hover:bg-fg/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <Settings :size="18" />
        </router-link>
      </div>
    </header>

    <!-- Mobile top bar: hamburger opens the instance tree, Tasks opens the task panel. -->
    <div class="flex items-center gap-2 border-b border-border bg-surface px-2 py-1.5 lg:hidden">
      <button data-test="open-instances" aria-label="Open instances"
              class="rounded p-1 text-lg leading-none text-fg-muted hover:bg-fg/5" @click="leftOpen = true">☰</button>
      <span class="flex-1 truncate text-center text-sm font-medium">{{ chat.sessionAlias ?? "xacpx relay" }}</span>
      <button data-test="open-tasks" class="rounded px-2 py-1 text-xs text-fg-muted hover:bg-fg/5"
              @click="rightOpen = true">Tasks</button>
    </div>

    <div class="flex flex-1 overflow-hidden">
      <!-- Backdrop closes any open drawer (mobile only). -->
      <div v-if="leftOpen || rightOpen" data-test="drawer-backdrop"
           class="fixed inset-0 z-30 bg-black/30 lg:hidden" @click="closeDrawers" />

      <!-- Left: instances. Off-canvas drawer < lg, static column ≥ lg. -->
      <div data-test="column" data-drawer="left"
           class="fixed inset-y-0 left-0 z-40 flex w-72 max-w-[85%] shrink-0 transform flex-col border-r border-border bg-surface shadow-lg transition-transform lg:static lg:z-auto lg:max-w-none lg:translate-x-0 lg:transform-none lg:shadow-none"
           :class="leftOpen ? 'translate-x-0' : '-translate-x-full'">
        <div class="flex items-center justify-between border-b border-border p-2 text-xs">
          <router-link to="/settings" class="text-fg-muted hover:underline">Settings</router-link>
          <div class="flex items-center gap-3">
            <button class="text-fg-muted hover:underline" @click="onLogout">Logout</button>
            <button data-test="close-instances" aria-label="Close instances"
                    class="text-fg-muted hover:text-fg lg:hidden" @click="leftOpen = false">✕</button>
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
           class="fixed inset-y-0 right-0 z-40 w-72 max-w-[85%] shrink-0 transform overflow-y-auto border-l border-border bg-surface shadow-lg transition-transform lg:static lg:z-auto lg:max-w-none lg:translate-x-0 lg:transform-none lg:shadow-none"
           :class="rightOpen ? 'translate-x-0' : 'translate-x-full'">
        <div class="flex items-center gap-1 border-b border-border p-2">
          <div class="flex overflow-hidden rounded border border-border text-xs">
            <button data-test="right-tab-tasks" class="px-2 py-1" :class="rightTab === 'tasks' ? 'bg-accent text-white' : 'text-fg-muted'" @click="rightTab = 'tasks'">Tasks</button>
            <button data-test="right-tab-files" class="px-2 py-1" :class="rightTab === 'files' ? 'bg-accent text-white' : 'text-fg-muted'" @click="rightTab = 'files'">Files</button>
          </div>
          <button data-test="close-tasks" aria-label="Close tasks"
                  class="ml-auto text-fg-muted hover:text-fg lg:hidden" @click="rightOpen = false">✕</button>
        </div>
        <TaskPanel v-if="rightTab === 'tasks'" />
        <FilesPanel v-else :instance-id="chat.instanceId" />
      </div>
    </div>
    <NoticeToast />
    <CommandPalette v-if="paletteOpen"
                    @close="paletteOpen = false"
                    @select-session="(id, alias) => { onSelect(id, alias); paletteOpen = false; }"
                    @pick-command="(name) => { composer.requestInsert(composerKey(), name); paletteOpen = false; }" />
  </div>
</template>
