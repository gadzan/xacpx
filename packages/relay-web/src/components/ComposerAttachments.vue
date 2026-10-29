<script setup lang="ts">
import { computed } from "vue";
import { FileText, Loader2, RotateCcw, X } from "lucide-vue-next";
import { useComposerStore } from "../stores/composer";

const props = defineProps<{ scopeKey: string; disabled?: boolean }>();
const composer = useComposerStore();
/** Nothing staged and nothing rejected: render nothing, so the folded
 *  attachments slot never adds height to an expanded-but-empty composer. */
const visible = computed(() => composer.pending.length > 0 || composer.rejection !== null);
</script>

<template>
  <div v-if="visible" class="flex flex-wrap items-center gap-2 px-3 pt-2 pb-1" data-test="composer-attachments">
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
