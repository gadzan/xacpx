<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import { useI18n } from "vue-i18n";
import { AlertCircle, ArrowUp, CircleStop, Loader2, RotateCcw } from "lucide-vue-next";
import { useDirectBotsStore } from "../stores/direct-bots";

const props = defineProps<{
  disabled?: boolean;
}>();

const emit = defineEmits<{
  send: [text: string];
  cancel: [];
}>();

const { t } = useI18n();
const directBotsStore = useDirectBotsStore();

const textareaEl = ref<HTMLTextAreaElement | null>(null);
const promptText = ref("");

const isRunActive = computed(() => directBotsStore.isRunActive);
const isTopicRecovering = computed(() => !directBotsStore.topicReady);
const isPromptInFlight = computed(() => directBotsStore.promptInFlight);
const isCancelling = computed(() => !!directBotsStore.cancellingRunId);
const bot = computed(() => directBotsStore.currentBot);
const isBotDisabled = computed(() => bot.value ? !bot.value.enabled : false);

function onKeydown(e: KeyboardEvent): void {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    handleSend();
  }
}

function handleSend(): void {
  if (props.disabled || isBotDisabled.value || isPromptInFlight.value || isRunActive.value || isTopicRecovering.value) return;
  const text = promptText.value.trim();
  if (!text) return;
  emit("send", text);
  promptText.value = "";
  if (textareaEl.value) {
    textareaEl.value.style.height = "auto";
  }
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
      <textarea
        ref="textareaEl"
        v-model="promptText"
        :disabled="disabled || isBotDisabled || isPromptInFlight || isRunActive || isTopicRecovering"
        :placeholder="isBotDisabled ? $t('bot.prompt.botDisabledPlaceholder') : isTopicRecovering ? $t('bot.prompt.recoveringPlaceholder') : isRunActive ? $t('bot.prompt.runActivePlaceholder') : $t('bot.prompt.placeholder')"
        class="min-h-[38px] max-h-[200px] w-full resize-none bg-transparent px-2.5 py-2 text-sm text-fg outline-none placeholder:text-fg-muted disabled:cursor-not-allowed disabled:opacity-50"
        @keydown="onKeydown"
        @input="onInput"
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
