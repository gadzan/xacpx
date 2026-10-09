<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import { AlertCircle, ArrowUp, CircleStop, Loader2, RotateCcw } from "lucide-vue-next";
import { completionKey, replaceRange, slashQuery } from "../lib/composer-completion";
import { useConversationCommandsStore } from "../stores/conversation-commands";
import { useDirectBotsStore } from "../stores/direct-bots";

const props = defineProps<{
  disabled?: boolean;
  /** When set, the parent send returns the durable outcome. Rejection keeps the draft. */
  deliver?: (text: string) => Promise<"accepted" | "rejected" | "uncertain" | "orphaned">;
}>();

const emit = defineEmits<{
  send: [text: string];
  cancel: [];
}>();

const directBotsStore = useDirectBotsStore();
const commandStore = useConversationCommandsStore();

const textareaEl = ref<HTMLTextAreaElement | null>(null);
const promptText = ref("");
const composing = ref(false);
const cmdActiveIdx = ref(0);
const cmdDismissed = ref(false);

const isRunActive = computed(() => directBotsStore.isRunActive);
const isTopicRecovering = computed(() => !directBotsStore.topicReady);
const isPromptInFlight = computed(() => directBotsStore.promptInFlight);
const isCancelling = computed(() => !!directBotsStore.cancellingRunId);
const bot = computed(() => directBotsStore.currentBot);
const isBotDisabled = computed(() => bot.value ? !bot.value.enabled : false);

const slashCommands = computed(() => {
  const instanceId = directBotsStore.instanceId;
  const conversationId = directBotsStore.activeConversationId;
  const topicId = directBotsStore.activeTopicId;
  const botId = directBotsStore.selectedBotId;
  if (!instanceId || !conversationId || !topicId || !botId) return [];
  return commandStore.commandsFor({ instanceId, conversationId, topicId, botId });
});

const slash = computed(() => slashQuery(promptText.value));
const slashMatches = computed(() => {
  const query = slash.value;
  if (!query || cmdDismissed.value) return [];
  return slashCommands.value.filter((command) => command.name.toLowerCase().startsWith(query.query)).slice(0, 8);
});
const slashOpen = computed(() => slashMatches.value.length > 0);

function pickCommand(name: string): void {
  const query = slash.value;
  const replaced = replaceRange(promptText.value, query?.range ?? { start: 0, end: promptText.value.length }, `/${name} `);
  promptText.value = replaced.text;
  cmdDismissed.value = true;
  void nextTick(() => {
    textareaEl.value?.focus();
    textareaEl.value?.setSelectionRange(replaced.cursor, replaced.cursor);
    onInput();
  });
}

function onKeydown(e: KeyboardEvent): void {
  const collapsed = (textareaEl.value?.selectionStart ?? 0) === (textareaEl.value?.selectionEnd ?? 0);
  const action = completionKey({
    key: e.key,
    shiftKey: e.shiftKey,
    isComposing: e.isComposing,
    composing: composing.value,
    menu: slashOpen.value ? "slash" : "closed",
    itemCount: slashMatches.value.length,
    activeIndex: cmdActiveIdx.value,
    holdKeys: false,
    collapsedCaret: collapsed,
    busy: false,
    caretAtStart: false,
    historyArmed: false,
  });
  if (action.type === "ignore" || action.type === "passthrough") return;
  if (action.type === "move") {
    cmdActiveIdx.value = action.index;
    e.preventDefault();
    return;
  }
  if (action.type === "commit") {
    const row = slashMatches.value[action.index];
    if (row) pickCommand(row.name);
    e.preventDefault();
    return;
  }
  if (action.type === "dismiss" || action.type === "blocked") {
    cmdDismissed.value = true;
    e.preventDefault();
    return;
  }
  if (action.type === "send") {
    e.preventDefault();
    void handleSend();
  }
}

async function handleSend(): Promise<void> {
  if (props.disabled || isBotDisabled.value || isPromptInFlight.value || isRunActive.value || isTopicRecovering.value) return;
  const text = promptText.value.trim();
  if (!text) return;
  if (props.deliver) {
    const outcome = await props.deliver(text);
    if (outcome === "accepted" || outcome === "uncertain") clearDraft();
    return;
  }
  emit("send", text);
  clearDraft();
}

function clearDraft(): void {
  promptText.value = "";
  cmdDismissed.value = false;
  if (textareaEl.value) textareaEl.value.style.height = "auto";
}

function handleCancel(): void {
  if (isCancelling.value) return;
  emit("cancel");
}

function handleRetry(): void {
  if (directBotsStore.lastPromptText) {
    emit("send", directBotsStore.lastPromptText);
  }
}

function onInput(): void {
  cmdDismissed.value = false;
  cmdActiveIdx.value = 0;
  if (!textareaEl.value) return;
  textareaEl.value.style.height = "auto";
  const nextHeight = Math.min(textareaEl.value.scrollHeight, 200);
  textareaEl.value.style.height = `${nextHeight}px`;
}
</script>

<template>
  <div class="border-t border-border bg-surface px-3 py-2.5 sm:px-4">
    <!-- Disabled bot warning -->
    <div v-if="isBotDisabled" class="mb-2 flex items-center gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-1.5 text-xs text-warning">
      <AlertCircle :size="14" class="shrink-0" />
      <span>{{ $t("bot.prompt.botDisabledWarning") }}</span>
    </div>

    <!-- Cancellation uncertainty (separate from prompt errors; no retry target) -->
    <div v-else-if="directBotsStore.cancelError" class="mb-2 flex items-center gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-1.5 text-xs text-warning">
      <AlertCircle :size="14" class="shrink-0" />
      <span class="truncate">{{ $t(`bot.errors.${directBotsStore.cancelError}`) }}</span>
    </div>

    <!-- Error Banner & Retry -->
    <div v-else-if="directBotsStore.promptError" class="mb-2 flex items-center justify-between gap-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-1.5 text-xs text-danger">
      <div class="flex items-center gap-2 min-w-0">
        <AlertCircle :size="14" class="shrink-0" />
        <span class="truncate">{{ directBotsStore.promptErrorDetail ?? $t(`bot.errors.${directBotsStore.promptError}`) }}</span>
      </div>
      <button
        type="button"
        class="flex items-center gap-1 rounded bg-danger/20 px-2 py-0.5 font-medium hover:bg-danger/30 transition-colors"
        @click="handleRetry"
      >
        <RotateCcw :size="12" />
        <span>{{ $t("bot.prompt.retry") }}</span>
      </button>
    </div>

    <!-- Main Input Box -->
    <div class="relative flex items-end gap-2 rounded-xl border border-border bg-bg p-1.5 focus-within:border-accent transition-colors">
      <div
        v-if="slashOpen"
        data-test="direct-cmd-menu"
        class="absolute bottom-full left-0 z-20 mb-1.5 w-full overflow-hidden rounded-xl border border-border bg-surface shadow-xl"
      >
        <button
          v-for="(command, index) in slashMatches"
          :key="command.name"
          type="button"
          data-test="direct-cmd-item"
          class="flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-xs hover:bg-raised"
          :class="index === cmdActiveIdx ? 'bg-accent/10' : ''"
          @mousedown.prevent="pickCommand(command.name)"
        >
          <span class="font-medium text-fg">/{{ command.name }}</span>
          <span v-if="command.description" class="truncate text-fg-muted">{{ command.description }}</span>
        </button>
      </div>
      <textarea
        ref="textareaEl"
        v-model="promptText"
        :disabled="disabled || isBotDisabled || isPromptInFlight || isRunActive || isTopicRecovering"
        :placeholder="isBotDisabled ? $t('bot.prompt.botDisabledPlaceholder') : isTopicRecovering ? $t('bot.prompt.recoveringPlaceholder') : isRunActive ? $t('bot.prompt.runActivePlaceholder') : $t('bot.prompt.placeholder')"
        class="min-h-[38px] max-h-[200px] w-full resize-none bg-transparent px-2.5 py-2 text-sm text-fg outline-none placeholder:text-fg-muted disabled:cursor-not-allowed disabled:opacity-50"
        @keydown="onKeydown"
        @input="onInput"
        @compositionstart="composing = true"
        @compositionend="composing = false"
      />

      <div class="flex shrink-0 items-center gap-1 pb-1 pr-1">
        <!-- Stop Run Button (When run is active) -->
        <button
          v-if="isRunActive"
          type="button"
          data-test="stop-run-button"
          :title="$t('bot.prompt.stopRun')"
          :aria-label="$t('bot.prompt.stopRun')"
          :disabled="isCancelling"
          class="grid h-8 w-8 place-items-center rounded-lg bg-danger text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          @click="handleCancel"
        >
          <Loader2 v-if="isCancelling" :size="15" class="animate-spin" />
          <CircleStop v-else :size="16" />
        </button>

        <!-- Send Button -->
        <button
          v-else
          type="button"
          data-test="send-prompt-button"
          :title="$t('bot.prompt.send')"
          :aria-label="$t('bot.prompt.send')"
          :disabled="disabled || isBotDisabled || isPromptInFlight || !promptText.trim()"
          class="grid h-8 w-8 place-items-center rounded-lg bg-accent text-accent-fg transition-opacity hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
          @click="handleSend"
        >
          <Loader2 v-if="isPromptInFlight" :size="15" class="animate-spin" />
          <ArrowUp v-else :size="16" :stroke-width="2.5" />
        </button>
      </div>
    </div>
  </div>
</template>
