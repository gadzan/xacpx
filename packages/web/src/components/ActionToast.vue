<script setup lang="ts">
import { useActionToastState, runToastAction, dismissToast } from "../lib/use-action-toast";
const toast = useActionToastState();
</script>
<template>
  <Teleport to="body">
    <div v-if="toast" data-test="action-toast"
         class="fixed bottom-[calc(1rem+env(safe-area-inset-bottom))] left-1/2 z-50 flex h-9 -translate-x-1/2 items-center gap-3 rounded-lg bg-glass-strong px-3.5 text-ui font-medium text-fg shadow-glass-float backdrop-blur-glass backdrop-saturate-glass">
      <span>{{ toast.message }}</span>
      <button data-test="toast-action" class="font-medium text-accent-text-overlay hover:underline" @click="runToastAction">{{ toast.actionLabel }}</button>
      <button class="text-fg-muted-overlay hover:text-fg" :aria-label="$t('common.dismiss')" @click="dismissToast">×</button>
    </div>
  </Teleport>
</template>
