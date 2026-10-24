<script setup lang="ts">
import { Square } from "lucide-vue-next";

/**
 * The stop pill below a dispatch row.
 *
 * It addresses the round's leader (项管): the wording names the leader when
 * the core can cancel that one member turn, and says "stop all" when it
 * cannot. The transcript owns the confirmation and the cancellation, so this
 * button only reports the intent.
 */
defineProps<{
  label: string;
}>();

const emit = defineEmits<{ stop: [] }>();
</script>

<template>
  <button
    type="button"
    data-test="group-dispatch-stop-leader"
    class="mt-1 inline-flex items-center gap-1 rounded-full bg-surface px-2 py-0.5 text-xs text-fg-muted transition-colors hover:bg-danger/10 hover:text-danger focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-danger"
    @click.stop="emit('stop')"
  >
    <Square :size="11" class="fill-current" aria-hidden="true" />
    {{ label }}
  </button>
</template>
