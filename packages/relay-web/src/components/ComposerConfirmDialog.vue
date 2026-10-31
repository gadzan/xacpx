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
    <div class="fixed inset-0 z-[70] flex items-center justify-center bg-scrim p-4 backdrop-blur-sm" @click.self="emit('cancel')">
      <!-- A confirm dialog has no ✕: cancel is the way out. -->
      <section ref="dialog" data-composer-confirm role="dialog" aria-modal="true" tabindex="-1" :aria-label="title"
               class="w-[calc(100vw-40px)] max-w-[380px] rounded-2xl bg-glass-strong p-4 text-fg shadow-glass-float backdrop-blur-glass backdrop-saturate-glass">
        <div class="mt-3 text-sm text-fg"><slot /></div>
        <div class="mt-4 flex gap-2 lg:justify-end">
          <button ref="focusCancel" type="button" data-test="composer-confirm-cancel"
                  class="h-11 flex-1 rounded-btn border border-hairline bg-raised px-3 text-ui font-medium text-fg lg:h-8 lg:flex-none"
                  @click="emit('cancel')">{{ $t('common.cancel') }}</button>
          <button type="button" data-test="composer-confirm-send" :disabled="pending"
                  class="h-11 flex-1 rounded-btn bg-accent px-3 text-ui font-semibold text-on-accent disabled:opacity-50 lg:h-8 lg:flex-none"
                  @click="emit('confirm')">{{ confirmLabel }}</button>
        </div>
      </section>
    </div>
  </Teleport>
</template>
