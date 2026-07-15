<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { X, ZoomIn, ZoomOut, RotateCcw } from "lucide-vue-next";
import { createPanZoom } from "../lib/pan-zoom";
import { attachPanZoomGestures } from "../lib/pan-zoom-gestures";
import { useModalA11y } from "../lib/use-modal-a11y";

// Rendered only while open (parent v-if) → mount/unmount == open/close.
defineProps<{ svg: string }>();
const emit = defineEmits<{ close: [] }>();

const dialogEl = ref<HTMLElement | null>(null);
const stageEl = ref<HTMLElement | null>(null);
const transform = ref("translate(0px, 0px) scale(1)");
const pz = createPanZoom();
function apply(): void {
  transform.value = pz.toTransform();
}

useModalA11y(dialogEl, () => emit("close"));

let detach: (() => void) | null = null;
let prevOverflow = "";
onMounted(() => {
  if (stageEl.value) {
    detach = attachPanZoomGestures(stageEl.value, pz, apply, { oneFingerTouchPan: true });
  }
  prevOverflow = document.body.style.overflow;
  document.body.style.overflow = "hidden";
});
onBeforeUnmount(() => {
  detach?.();
  document.body.style.overflow = prevOverflow;
});

function zoomButton(factor: number): void {
  const r = stageEl.value?.getBoundingClientRect();
  pz.zoomAt(factor, r ? r.width / 2 : 0, r ? r.height / 2 : 0);
  apply();
}
function reset(): void {
  pz.reset();
  apply();
}
// Background (not the diagram) click closes — but a drag-to-pan that starts and ends on the empty
// stage also synthesizes a click, so ignore it if the pointer moved beyond a small threshold.
let downX = 0;
let downY = 0;
function onStagePointerDown(e: PointerEvent): void {
  downX = e.clientX;
  downY = e.clientY;
}
function onStageClick(e: MouseEvent): void {
  if (e.target !== stageEl.value) return; // clicked the diagram, not the backdrop
  if (Math.abs(e.clientX - downX) > 4 || Math.abs(e.clientY - downY) > 4) return; // was a drag
  emit("close");
}
</script>

<template>
  <Teleport to="body">
    <div
      ref="dialogEl"
      class="mermaid-viewer"
      tabindex="-1"
      role="dialog"
      aria-modal="true"
      aria-label="Diagram viewer"
    >
      <div ref="stageEl" class="mv-stage" @pointerdown="onStagePointerDown" @click="onStageClick">
        <!-- eslint-disable-next-line vue/no-v-html -- SVG already DOMPurify-sanitized by render-mermaid -->
        <div class="mv-content" :style="{ transform }" v-html="svg" />
      </div>
      <div class="mv-controls">
        <button type="button" aria-label="Zoom out" @click="zoomButton(0.8)"><ZoomOut :size="18" /></button>
        <button type="button" aria-label="Reset" @click="reset()"><RotateCcw :size="18" /></button>
        <button type="button" aria-label="Zoom in" @click="zoomButton(1.25)"><ZoomIn :size="18" /></button>
        <button type="button" aria-label="Close" @click="emit('close')"><X :size="18" /></button>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.mermaid-viewer {
  position: fixed;
  inset: 0;
  z-index: 60;
  background: rgb(var(--c-bg) / 0.92);
  backdrop-filter: blur(2px);
}
.mv-stage {
  position: absolute;
  inset: 0;
  overflow: hidden;
  cursor: grab;
  touch-action: none;
}
.mv-stage:active {
  cursor: grabbing;
}
.mv-content {
  transform-origin: 0 0;
  width: max-content;
}
.mv-content :deep(svg) {
  display: block;
}
.mv-controls {
  position: absolute;
  top: calc(0.75rem + env(safe-area-inset-top));
  right: 0.75rem;
  display: flex;
  gap: 0.35rem;
}
.mv-controls button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2rem;
  height: 2rem;
  border-radius: 8px;
  border: 1px solid rgb(var(--c-border));
  background: rgb(var(--c-surface));
  color: rgb(var(--c-fg));
  box-shadow: var(--shadow-e1);
}
.mv-controls button:hover {
  background: rgb(var(--c-bg-raised, var(--c-surface)));
}
</style>
