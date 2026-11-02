<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch } from "vue";
import MobileSheet from "./MobileSheet.vue";
import { claimKeyboard, releaseKeyboard, useIsMobile } from "../lib/use-dropdown";
export interface ContextMenuItem {
  key: string;
  label: string;
  /** Destructive entry: red text, red hover wash. */
  danger?: boolean;
  /** Rendered but inert (no click, dimmed). */
  disabled?: boolean;
}
const props = defineProps<{
  x: number;
  y: number;
  items: ContextMenuItem[];
  /** MobileSheet title (below lg the menu renders as a sheet, ignoring x/y). */
  title?: string;
}>();
const emit = defineEmits<{ select: [key: string]; close: [] }>();

// The unified action menu (relay-web redesign §F): one panel style, ↑↓/Home/End
// navigation, Enter/Space select, Esc closes. Desktop anchors at the click
// point; below lg the same items render inside a MobileSheet.
const isMobile = useIsMobile();
const highlight = ref(-1);
const enabled = () => props.items.filter((it) => !it.disabled);

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

function step(dir: 1 | -1): void {
  const items = enabled();
  if (!items.length) return;
  let i = items.findIndex((it) => it.key === highlightedKey());
  for (let guard = 0; guard < items.length; guard++) {
    i = (i + dir + items.length) % items.length;
    if (i >= 0) { highlight.value = props.items.indexOf(items[i]!); return; }
  }
}
function highlightedKey(): string | null {
  const item = props.items[highlight.value];
  return item && !item.disabled ? item.key : null;
}
function activate(index: number): void {
  const item = props.items[index];
  if (!item || item.disabled) return;
  emit("select", item.key);
}
function onKey(e: KeyboardEvent): void {
  if (e.key === "ArrowDown") { e.preventDefault(); step(1); }
  else if (e.key === "ArrowUp") { e.preventDefault(); step(-1); }
  else if (e.key === "Home") { e.preventDefault(); highlight.value = props.items.findIndex((it) => !it.disabled); }
  else if (e.key === "End") { e.preventDefault(); for (let i = props.items.length - 1; i >= 0; i--) if (!props.items[i]!.disabled) { highlight.value = i; break; } }
  else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); if (highlight.value >= 0) activate(highlight.value); }
  else if (e.key === "Escape") { e.preventDefault(); emit("close"); }
}
function rowClass(it: ContextMenuItem, index: number): string {
  if (it.disabled) return "cursor-not-allowed text-fg-muted-overlay";
  const hl = index === highlight.value;
  if (it.danger) return ["text-danger-overlay", hl ? "bg-fill-strong" : "hover:bg-danger/10"].join(" ");
  return ["text-fg", hl ? "bg-fill-strong" : "hover:bg-fill-hover"].join(" ");
}
function onDocClick() { emit("close"); }
// The menu owns document keys while open (the dropdown that spawned it stands down).
const keyboardToken = {};
onMounted(() => {
  clamp();
  highlight.value = props.items.findIndex((it) => !it.disabled);
  claimKeyboard(keyboardToken);
  document.addEventListener("click", onDocClick);
  document.addEventListener("keydown", onKey);
});
onBeforeUnmount(() => {
  document.removeEventListener("click", onDocClick);
  document.removeEventListener("keydown", onKey);
  releaseKeyboard(keyboardToken);
});
</script>

<template>
  <!-- <lg: the same items in a bottom sheet (right-click has no touch equivalent,
       so FileTreeNode long-press opens this). -->
  <MobileSheet v-if="isMobile" :title="title ?? ''" dd-panel @close="emit('close')">
    <button v-for="(it, i) in items" :key="it.key" :data-test="`menu-${it.key}`" :disabled="it.disabled"
            class="flex h-11 w-full items-center rounded-lg px-3 text-left text-sm disabled:cursor-not-allowed"
            :class="rowClass(it, i)"
            @click="emit('select', it.key); emit('close')">
      {{ it.label }}
    </button>
  </MobileSheet>

  <!-- Desktop: anchored at the pointer. `data-dd-panel` marks it as a layer owned by
       the open dropdown, so the dropdown's outside-pointerdown check ignores it. -->
  <div v-else ref="el" data-test="context-menu" data-dd-panel
       class="fixed z-50 min-w-40 rounded-lg bg-glass-strong p-1 shadow-glass-float backdrop-blur-glass backdrop-saturate-glass"
       :style="{ left: pos.x + 'px', top: pos.y + 'px' }" @click.stop>
    <button v-for="(it, i) in items" :key="it.key" :data-test="`menu-${it.key}`" :disabled="it.disabled"
            class="flex h-[30px] w-full items-center rounded-item px-2 text-left text-ui disabled:cursor-not-allowed"
            :class="rowClass(it, i)"
            @click="emit('select', it.key); emit('close')">
      {{ it.label }}
    </button>
  </div>
</template>
