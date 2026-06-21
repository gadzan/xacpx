<script setup lang="ts">
import { useActionToastState, runToastAction, dismissToast } from "../lib/use-action-toast";
const toast = useActionToastState();
</script>
<template>
  <Teleport to="body">
    <div v-if="toast" data-test="action-toast"
         class="fixed bottom-[calc(1rem+env(safe-area-inset-bottom))] left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-fg shadow-lg">
      <span>{{ toast.message }}</span>
      <button data-test="toast-action" class="font-medium text-accent hover:underline" @click="runToastAction">{{ toast.actionLabel }}</button>
      <button class="text-fg-muted hover:text-fg" :aria-label="$t('common.dismiss')" @click="dismissToast">×</button>
    </div>
  </Teleport>
</template>
