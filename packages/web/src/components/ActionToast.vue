<script setup lang="ts">
import { useActionToastState, runToastAction, dismissToast } from "../lib/use-action-toast";
const toast = useActionToastState();
</script>
<template>
  <Teleport to="body">
    <!-- One bar, bottom edge. Centred with `inset-x-0 mx-auto w-fit` rather than a
         `-translate-x-1/2`, so the transform stays free for the arrival gesture
         (`.ui-action-toast-*` in style.css) — a translate that both centres and
         animates would fight itself mid-flight. -->
    <Transition name="ui-action-toast">
      <div v-if="toast" data-test="action-toast"
           class="fixed inset-x-0 bottom-[calc(1rem+env(safe-area-inset-bottom))] z-50 mx-auto flex h-9 w-fit items-center gap-3 rounded-lg bg-glass-strong px-3.5 text-ui font-medium text-fg shadow-glass-float backdrop-blur-glass backdrop-saturate-glass">
        <span>{{ toast.message }}</span>
        <button data-test="toast-action" class="font-medium text-accent-text-overlay hover:underline" @click="runToastAction">{{ toast.actionLabel }}</button>
        <button class="text-fg-muted-overlay hover:text-fg" :aria-label="$t('common.dismiss')" @click="dismissToast">×</button>
      </div>
    </Transition>
  </Teleport>
</template>
