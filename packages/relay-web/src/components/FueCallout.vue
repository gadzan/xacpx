<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { computeCalloutPlacement, type Rect } from "../lib/fue-placement";

const props = defineProps<{ title: string; body: string; anchor?: Rect | null }>();
const emit = defineEmits<{ dismiss: [] }>();

const card = ref<HTMLElement | null>(null);
const style = ref<Record<string, string>>({ visibility: "hidden" });

function reposition(): void {
  const el = card.value;
  if (!el) return;
  const size = { width: el.offsetWidth || 256, height: el.offsetHeight || 96 };
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  if (props.anchor) {
    const p = computeCalloutPlacement(props.anchor, size, viewport);
    style.value = { top: `${p.top}px`, left: `${p.left}px`, visibility: "visible" };
  } else {
    // No anchor — center in the viewport as a fallback.
    style.value = {
      top: `${Math.max(8, viewport.height / 2 - size.height / 2)}px`,
      left: `${Math.max(8, viewport.width / 2 - size.width / 2)}px`,
      visibility: "visible",
    };
  }
}

function onKey(e: KeyboardEvent): void {
  if (e.key === "Escape") emit("dismiss");
}

onMounted(() => {
  reposition();
  window.addEventListener("keydown", onKey);
  window.addEventListener("resize", reposition);
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKey);
  window.removeEventListener("resize", reposition);
});
</script>

<template>
  <Teleport to="body">
    <div
      ref="card"
      data-test="fue-callout"
      class="fixed z-50 w-64 rounded-lg border border-slate-200 bg-white p-3 text-sm shadow-lg"
      :style="style"
      role="dialog"
    >
      <p class="font-medium text-slate-800">{{ title }}</p>
      <p class="mt-1 text-xs text-slate-500">{{ body }}</p>
      <div class="mt-2 flex justify-end">
        <button
          data-test="fue-dismiss"
          type="button"
          class="rounded bg-sky-500 px-2 py-1 text-xs font-medium text-white hover:bg-sky-600"
          @click="emit('dismiss')"
        >
          Got it
        </button>
      </div>
    </div>
  </Teleport>
</template>
