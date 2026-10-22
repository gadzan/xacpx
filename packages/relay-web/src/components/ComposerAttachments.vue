<script setup lang="ts">
import { ref } from "vue";
import { FileText, Loader2, Paperclip, RotateCcw, X } from "lucide-vue-next";
import { useComposerStore } from "../stores/composer";

const props = defineProps<{ scopeKey: string; instanceId: string; disabled?: boolean }>();
const composer = useComposerStore();
const picker = ref<HTMLInputElement | null>(null);
async function picked(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = "";
  if (!props.disabled) await composer.addFiles(files, props.scopeKey);
}
</script>

<template>
  <div class="flex flex-wrap items-center gap-2 px-3 pt-2 pb-1" data-test="composer-attachments">
    <input ref="picker" type="file" multiple class="hidden" data-test="attach-input" @change="picked" />
    <button type="button" data-test="attach-btn" :aria-label="$t('chat.attach.add')" :title="$t('chat.attach.add')"
      :disabled="disabled" class="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-fg-muted hover:bg-surface-2 disabled:opacity-40 lg:h-7 lg:w-7"
      @click="picker?.click()"><Paperclip :size="16" /></button>
    <div v-for="entry in composer.pending" :key="entry.id" data-test="attachment-chip"
      class="flex min-w-0 items-center gap-1.5 rounded-lg border border-border bg-surface-2 px-2 py-1 text-xs">
      <img v-if="entry.previewUrl" :src="entry.previewUrl" :alt="entry.filename" class="h-8 w-8 rounded object-cover" />
      <FileText v-else :size="16" class="shrink-0 text-fg-muted" />
      <span class="max-w-[140px] truncate">{{ entry.filename }}</span>
      <Loader2 v-if="entry.status === 'uploading'" :size="14" class="animate-spin text-fg-muted" :aria-label="$t('common.loading')" />
      <button v-if="entry.status === 'error'" type="button" data-test="attachment-retry" :aria-label="$t('common.retry')" :title="$t('common.retry')"
        class="grid h-7 w-7 place-items-center rounded text-danger hover:bg-danger/10" @click="composer.retryAttachment(entry.id, scopeKey)"><RotateCcw :size="14" /></button>
      <button type="button" data-test="attachment-remove" :aria-label="$t('chat.attach.remove')" :title="$t('chat.attach.remove')"
        class="grid h-7 w-7 place-items-center rounded text-fg-muted hover:bg-raised" @click="composer.removeAttachment(entry.id, scopeKey)"><X :size="14" /></button>
    </div>
    <span v-if="composer.rejection" data-test="attach-rejected" role="alert" class="w-full text-xs text-danger">
      {{ composer.rejection.reason === 'too-many' ? $t('chat.attach.tooMany') : $t('chat.attach.tooLarge', { name: composer.rejection.filename }) }}
    </span>
  </div>
</template>
