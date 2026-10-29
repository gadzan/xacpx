<script setup lang="ts">
import { ref } from "vue";
import { Paperclip } from "lucide-vue-next";
import { useComposerStore } from "../stores/composer";

/** The paperclip entry of a composer: hidden file input plus the button that
 *  opens it, scoped to one conversation draft. Lives in the composer's
 *  #actions slot so it folds away with the affordance row. */
const props = defineProps<{ scopeKey: string; disabled?: boolean }>();
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
  <input ref="picker" type="file" multiple class="hidden" data-test="attach-input" @change="picked" />
  <button type="button" data-test="attach-btn" :aria-label="$t('chat.attach.add')" :title="$t('chat.attach.add')"
    :disabled="disabled" class="flex items-center gap-1.5 px-1.5 py-1 rounded-sm text-fg-muted hover:bg-raised transition-colors disabled:opacity-40"
    @click="picker?.click()"><Paperclip :size="15" /></button>
</template>
