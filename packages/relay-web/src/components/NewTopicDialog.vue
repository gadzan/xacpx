<script setup lang="ts">
import { ref } from "vue";
import { useModalA11y } from "../lib/use-modal-a11y";
import { navigateBack } from "../lib/mobile-back";
import { useDirectBotsStore } from "../stores/direct-bots";

const emit = defineEmits<{
  close: [];
}>();

const directBotsStore = useDirectBotsStore();

const dialogEl = ref<HTMLElement | null>(null);
// Mount == open, unmount == close: the shared helper registers Escape, traps
// Tab, focuses the first field on open, and restores the trigger on close.
useModalA11y(dialogEl, () => emit("close"));

const newTopicTitle = ref("");
const creatingTopic = ref(false);

async function handleCreateTopic(): Promise<void> {
  const title = newTopicTitle.value.trim();
  if (!title || !directBotsStore.instanceId || !directBotsStore.activeConversationId) return;

  creatingTopic.value = true;
  try {
    await directBotsStore.createTopic(
      directBotsStore.instanceId,
      directBotsStore.activeConversationId,
      title,
    );
    newTopicTitle.value = "";
    emit("close");
  } catch (err: unknown) {
    directBotsStore.generalError = err instanceof Error ? err.message : String(err);
  } finally {
    creatingTopic.value = false;
  }
}
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4 backdrop-blur-sm"
       @click.self="navigateBack">
    <div ref="dialogEl" role="dialog" aria-modal="true" aria-labelledby="new-topic-title" tabindex="-1" class="w-[calc(100vw-40px)] max-w-[380px] rounded-2xl bg-glass-strong p-4 shadow-glass-float backdrop-blur-glass backdrop-saturate-glass lg:w-full">
      <h3 id="new-topic-title" class="mb-2 text-base font-semibold text-fg">{{ $t("bot.topic.createTitle") }}</h3>
      <p class="mb-3 text-sm text-fg-muted-overlay">{{ $t("bot.topic.createHint") }}</p>
      <form @submit.prevent="handleCreateTopic">
        <input
          v-model="newTopicTitle"
          type="text"
          required
          maxlength="60"
          :placeholder="$t('bot.topic.titlePlaceholder')"
          class="mb-4 h-8 w-full rounded-lg bg-surface-2 px-3 text-sm outline-none"
        />
        <div class="flex gap-2 lg:items-center lg:justify-end">
          <button
            type="button"
            class="h-11 flex-1 rounded-btn border border-hairline bg-raised px-3 text-ui font-medium text-fg hover:bg-fill-hover lg:h-8 lg:flex-none"
            @click="navigateBack"
          >
            {{ $t("common.cancel") }}
          </button>
          <button
            type="submit"
            :disabled="creatingTopic || !newTopicTitle.trim()"
            class="h-11 flex-1 rounded-btn bg-accent px-3 text-ui font-semibold text-on-accent hover:opacity-90 disabled:opacity-50 lg:h-8 lg:flex-none"
          >
            {{ $t("common.create") }}
          </button>
        </div>
      </form>
    </div>
  </div>
</template>
