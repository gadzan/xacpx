<script setup lang="ts">
import { onMounted, onBeforeUnmount } from "vue";
defineProps<{ x: number; y: number; items: { key: string; label: string }[] }>();
const emit = defineEmits<{ select: [key: string]; close: [] }>();
function onDocClick() { emit("close"); }
function onKey(e: KeyboardEvent) { if (e.key === "Escape") emit("close"); }
onMounted(() => { document.addEventListener("click", onDocClick); document.addEventListener("keydown", onKey); });
onBeforeUnmount(() => { document.removeEventListener("click", onDocClick); document.removeEventListener("keydown", onKey); });
</script>
<template>
  <div data-test="context-menu" class="fixed z-50 min-w-40 rounded-md border border-border bg-surface py-1 text-[12.5px] shadow-lg"
       :style="{ left: x + 'px', top: y + 'px' }" @click.stop>
    <button v-for="it in items" :key="it.key" :data-test="`menu-${it.key}`"
            class="block w-full px-3 py-1.5 text-left text-fg hover:bg-raised"
            @click="emit('select', it.key); emit('close')">{{ it.label }}</button>
  </div>
</template>
