<script setup lang="ts">
import { ref } from "vue";
import DialogShell from "./DialogShell.vue";
import UiButton from "./UiButton.vue";
defineProps<{ title: string; confirmLabel: string; pending?: boolean }>();
const emit = defineEmits<{ confirm: []; cancel: [] }>();
const cancelButton = ref<InstanceType<typeof UiButton> | null>(null);
// Cancel is the safe default for a destructive confirm.
const initialFocus = (): HTMLElement | null => cancelButton.value?.el ?? null;
</script>

<template>
  <Teleport to="body">
  <!-- level="top": this confirms over the composer and possibly an open drawer.
       Pre-shell it was z-70; the dialog default (z-50) sits level with the
       run-detail drawer. -->
  <DialogShell
    level="top"
    panel-class="w-[calc(100vw-40px)] max-w-[380px] rounded-2xl p-4"
    :label="title"
    :initial-focus="initialFocus"
    @close="emit('cancel')"
  >
      <!-- A confirm dialog has no ✕: cancel is the way out. -->
      <section data-composer-confirm>
        <div class="mt-3 text-sm text-fg"><slot /></div>
        <div class="mt-4 flex gap-2 lg:justify-end">
          <UiButton ref="cancelButton" variant="secondary" data-test="composer-confirm-cancel"
                    mobile-block @click="emit('cancel')">{{ $t('common.cancel') }}</UiButton>
          <UiButton data-test="composer-confirm-send" :disabled="pending"
                    mobile-block @click="emit('confirm')">{{ confirmLabel }}</UiButton>
        </div>
      </section>
  </DialogShell>
  </Teleport>
</template>
