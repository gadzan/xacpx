<script setup lang="ts">
import { ref } from "vue";
import DialogShell from "./DialogShell.vue";
import UiButton from "./UiButton.vue";
import { navigateBack } from "../lib/mobile-back";
import { useDirectBotsStore } from "../stores/direct-bots";

const emit = defineEmits<{
  close: [];
}>();

const directBotsStore = useDirectBotsStore();

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
  <DialogShell
    panel-class="w-[calc(100vw-40px)] max-w-[380px] rounded-2xl p-4 lg:w-full"
    labelledby="new-topic-title"
    @close="emit('close')"
  >
      <h3 id="new-topic-title" class="mb-2 text-base font-semibold text-fg">{{ $t("bot.topic.createTitle") }}</h3>
      <p class="mb-3 text-sm text-fg-muted-overlay">{{ $t("bot.topic.createHint") }}</p>
      <form @submit.prevent="handleCreateTopic">
        <input
          v-model="newTopicTitle"
          type="text"
          required
          maxlength="60"
          :placeholder="$t('bot.topic.titlePlaceholder')"
          class="mb-4 h-8 w-full rounded-lg ui-well px-3 text-sm outline-none"
        />
        <div class="flex gap-2 lg:items-center lg:justify-end">
          <UiButton variant="secondary" mobile-block @click="navigateBack">
            {{ $t("common.cancel") }}
          </UiButton>
          <UiButton type="submit" mobile-block :disabled="creatingTopic || !newTopicTitle.trim()">
            {{ $t("common.create") }}
          </UiButton>
        </div>
      </form>
  </DialogShell>
</template>
