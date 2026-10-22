<script setup lang="ts">
import { ref } from "vue";
import { useModalA11y } from "../lib/use-modal-a11y";
defineProps<{ title: string; confirmLabel: string; pending?: boolean }>();
const emit = defineEmits<{ confirm: []; cancel: [] }>();
const dialog = ref<HTMLElement | null>(null);
const focusCancel = ref<HTMLButtonElement | null>(null);
useModalA11y(dialog, () => emit("cancel"), { initialFocus: () => focusCancel.value });
</script>

<template>
  <Teleport to="body">
    <div class="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4" @click.self="emit('cancel')">
      <section ref="dialog" data-composer-confirm role="dialog" aria-modal="true" tabindex="-1" :aria-label="title" class="w-full max-w-sm rounded-2xl bg-surface p-4 text-fg shadow-float">
        <div class="mt-3 text-sm"><slot /></div>
        <div class="mt-4 flex justify-end gap-2">
          <button ref="focusCancel" type="button" data-test="composer-confirm-cancel" class="min-h-11 rounded-lg px-3 text-sm hover:bg-raised" @click="emit('cancel')">{{ $t('common.cancel') }}</button>
          <button type="button" data-test="composer-confirm-send" :disabled="pending" class="min-h-11 rounded-lg bg-accent px-3 text-sm text-on-accent disabled:opacity-50" @click="emit('confirm')">{{ confirmLabel }}</button>
        </div>
      </section>
    </div>
  </Teleport>
</template>
