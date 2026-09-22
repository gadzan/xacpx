<script setup lang="ts">
import { ref } from "vue";
import { useModalA11y } from "../lib/use-modal-a11y";
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
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
       @click.self="emit('close')">
    <div ref="dialogEl" role="dialog" aria-modal="true" aria-labelledby="new-topic-title" tabindex="-1" class="w-full max-w-sm rounded-xl border border-border bg-surface p-4 shadow-xl">
      <h3 id="new-topic-title" class="text-sm font-semibold mb-2">{{ $t("bot.topic.createTitle") }}</h3>
      <p class="text-xs text-fg-muted mb-3">{{ $t("bot.topic.createHint") }}</p>
      <form @submit.prevent="handleCreateTopic">
        <input
          v-model="newTopicTitle"
          type="text"
          required
          maxlength="60"
          :placeholder="$t('bot.topic.titlePlaceholder')"
          class="w-full rounded-lg border border-border bg-bg px-3 py-1.5 text-sm outline-none focus:border-accent mb-4"
        />
        <div class="flex items-center justify-end gap-2">
          <button
            type="button"
            class="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-fg-muted hover:bg-raised"
            @click="emit('close')"
          >
            {{ $t("common.cancel") }}
          </button>
          <button
            type="submit"
            :disabled="creatingTopic || !newTopicTitle.trim()"
            class="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg hover:opacity-90 disabled:opacity-50"
          >
            {{ $t("common.create") }}
          </button>
        </div>
      </form>
    </div>
  </div>
</template>
