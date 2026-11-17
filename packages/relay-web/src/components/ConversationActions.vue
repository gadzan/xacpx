<script setup lang="ts">
import { Monitor, SquareTerminal } from "lucide-vue-next";
import { useI18n } from "vue-i18n";

// Conversation-context actions (terminal, instance desktop). Rendered twice, never at the
// same time: in the global bar while the mobile chrome is up (< lg), and in the content
// bar (the pane's own header) on desktop. DashboardView gates each copy on `isDesktop`, so
// exactly one node carries each test id.
defineProps<{
  terminalDisabled: boolean;
  terminalTitle: string;
  terminalActive: boolean;
  desktopVisible: boolean;
  desktopDisabled: boolean;
  desktopActive: boolean;
}>();
const emit = defineEmits<{ terminal: []; desktop: [] }>();
const { t } = useI18n();
</script>

<template>
  <div class="flex shrink-0 items-center gap-1.5">
    <button
      data-test="toggle-terminal"
      :aria-label='$t("terminal.title")'
      :title="terminalTitle"
      :disabled="terminalDisabled"
      class="grid h-10 w-10 lg:h-7 lg:w-7 place-items-center rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-40"
      :class="terminalActive ? 'bg-accent-soft text-accent' : 'text-fg-muted hover:bg-raised'"
      @click="emit('terminal')"
    >
      <SquareTerminal :size="15" />
    </button>
    <button
      v-if="desktopVisible"
      data-test="toggle-desktop"
      :aria-label='$t("desktop.title")'
      :title='t("desktop.title")'
      :disabled="desktopDisabled"
      class="grid h-10 w-10 lg:h-7 lg:w-7 place-items-center rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-40"
      :class="desktopActive ? 'bg-accent-soft text-accent' : 'text-fg-muted hover:bg-raised'"
      @click="emit('desktop')"
    >
      <Monitor :size="15" />
    </button>
  </div>
</template>
