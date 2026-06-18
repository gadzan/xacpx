<script lang="ts">
// A themed, NON-editable select (pick from a list, no typing) matching the dark theme —
// a styled replacement for a native <select> whose option popup can't be themed. Supports
// labelled option groups and disabled options, with keyboard nav and click-outside close.
// Types live in this plain <script> block so consumers can import them (a <script setup>
// block cannot `export`).
export interface SelectOption { value: string; label: string; disabled?: boolean }
export interface SelectGroup { label?: string; options: SelectOption[] }
</script>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { ChevronDown, Check } from "lucide-vue-next";

const props = defineProps<{
  modelValue: string;
  groups: SelectGroup[];
  placeholder?: string;
  dataTest?: string;
  ariaLabel?: string;
}>();
const emit = defineEmits<{ "update:modelValue": [value: string] }>();

const open = ref(false);
const boxEl = ref<HTMLElement | null>(null);
const highlight = ref(-1);

// Flattened options for keyboard nav + selected-label lookup; the flat index lines up with
// `flatIndex(gi, oi)` used in the template for highlight comparison.
const flatOptions = computed(() => props.groups.flatMap((g) => g.options));
const selectedLabel = computed(() => flatOptions.value.find((o) => o.value === props.modelValue)?.label ?? "");

function openMenu(): void {
  open.value = true;
  const cur = flatOptions.value.findIndex((o) => o.value === props.modelValue && !o.disabled);
  highlight.value = cur >= 0 ? cur : flatOptions.value.findIndex((o) => !o.disabled);
}
function closeMenu(): void { open.value = false; }
function toggle(): void { open.value ? closeMenu() : openMenu(); }
function pick(o: SelectOption): void {
  if (o.disabled) return;
  emit("update:modelValue", o.value);
  closeMenu();
}
function move(dir: 1 | -1): void {
  const opts = flatOptions.value;
  if (!opts.length) return;
  let i = highlight.value;
  for (let step = 0; step < opts.length; step++) {
    i = (i + dir + opts.length) % opts.length;
    if (!opts[i].disabled) { highlight.value = i; return; }
  }
}
function onKeydown(e: KeyboardEvent): void {
  if (!open.value) {
    if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") { e.preventDefault(); openMenu(); }
    return;
  }
  if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
  else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
  else if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    const o = flatOptions.value[highlight.value];
    if (o) pick(o);
  } else if (e.key === "Escape") { e.stopPropagation(); closeMenu(); }
}

function onDocPointerDown(e: MouseEvent): void {
  if (open.value && boxEl.value && !boxEl.value.contains(e.target as Node)) closeMenu();
}
onMounted(() => document.addEventListener("mousedown", onDocPointerDown));
onBeforeUnmount(() => document.removeEventListener("mousedown", onDocPointerDown));

function flatIndex(groupIdx: number, optIdx: number): number {
  let n = 0;
  for (let g = 0; g < groupIdx; g++) n += props.groups[g].options.length;
  return n + optIdx;
}
</script>

<template>
  <div ref="boxEl" class="relative">
    <button type="button" :data-test="dataTest" :aria-label="ariaLabel" :aria-expanded="open"
            class="flex w-full items-center justify-between rounded-lg border border-border bg-bg py-2 pl-3 pr-2 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            @click="toggle" @keydown="onKeydown">
      <span class="truncate" :class="selectedLabel ? 'text-fg' : 'text-fg-muted'">{{ selectedLabel || placeholder || "Select…" }}</span>
      <ChevronDown :size="16" class="ml-2 shrink-0 text-fg-muted transition-transform" :class="open ? 'rotate-180' : ''" />
    </button>
    <ul v-if="open" class="absolute z-10 mt-1 max-h-60 w-full overflow-auto rounded-lg border border-border bg-raised py-1 shadow-xl">
      <template v-for="(g, gi) in groups" :key="gi">
        <li v-if="g.label" class="px-3 pb-0.5 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-fg-muted">{{ g.label }}</li>
        <li v-for="(o, oi) in g.options" :key="o.value"
            :data-value="o.value"
            class="flex items-center justify-between px-3 py-1.5 text-sm"
            :class="[
              o.disabled ? 'cursor-not-allowed text-fg-muted/50'
                : flatIndex(gi, oi) === highlight ? 'cursor-pointer bg-accent/15 text-fg'
                : 'cursor-pointer text-fg-muted hover:bg-fg/5',
            ]"
            @mousedown.prevent="pick(o)" @mouseenter="!o.disabled && (highlight = flatIndex(gi, oi))">
          <span class="truncate">{{ o.label }}</span>
          <Check v-if="o.value === modelValue" :size="14" class="ml-2 shrink-0 text-accent" />
        </li>
      </template>
    </ul>
  </div>
</template>
