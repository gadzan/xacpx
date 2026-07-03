<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch } from "vue";
const props = defineProps<{ x: number; y: number; items: { key: string; label: string }[] }>();
const emit = defineEmits<{ select: [key: string]; close: [] }>();

// Open at the click point, then clamp into the viewport so a menu near the right/bottom
// edge doesn't spill off-screen (measured after mount from the menu's own size).
const el = ref<HTMLElement | null>(null);
const pos = ref({ x: props.x, y: props.y });
function clamp() {
  const node = el.value;
  if (!node) return;
  const { width, height } = node.getBoundingClientRect();
  const m = 8;
  const vw = window.innerWidth, vh = window.innerHeight;
  let x = props.x, y = props.y;
  if (width && x + width > vw - m) x = Math.max(m, vw - width - m);
  if (height && y + height > vh - m) y = Math.max(m, vh - height - m);
  pos.value = { x, y };
}
// Re-open at a new point without a remount (same row right-clicked again): re-clamp.
watch(() => [props.x, props.y], () => { pos.value = { x: props.x, y: props.y }; clamp(); });

function onDocClick() { emit("close"); }
function onKey(e: KeyboardEvent) { if (e.key === "Escape") emit("close"); }
onMounted(() => { clamp(); document.addEventListener("click", onDocClick); document.addEventListener("keydown", onKey); });
onBeforeUnmount(() => { document.removeEventListener("click", onDocClick); document.removeEventListener("keydown", onKey); });
</script>
<template>
  <div ref="el" data-test="context-menu" class="fixed z-50 min-w-40 rounded-md border border-border bg-surface py-1 text-[12.5px] shadow-lg"
       :style="{ left: pos.x + 'px', top: pos.y + 'px' }" @click.stop>
    <button v-for="it in items" :key="it.key" :data-test="`menu-${it.key}`"
            class="block w-full px-3 py-1.5 text-left text-fg hover:bg-raised"
            @click="emit('select', it.key); emit('close')">{{ it.label }}</button>
  </div>
</template>
