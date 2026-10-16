<script lang="ts">
// A themed, NON-editable select (pick from a list, no typing) matching the
// redesign's unified dropdown (§F): field-shaped trigger + one panel style.
// Supports labelled option groups and disabled options, with keyboard nav,
// search (auto above 7 rows) and a MobileSheet below lg.
// Types live in this plain <script> block so consumers can import them (a
// <script setup> block cannot `export`).
export interface SelectOption { value: string; label: string; disabled?: boolean; hint?: string; testId?: string }
export interface SelectGroup { label?: string; options: SelectOption[] }
</script>

<script setup lang="ts">
import { computed } from "vue";
import { ChevronDown } from "lucide-vue-next";
import DropdownPanel from "./DropdownPanel.vue";
import { useDropdown } from "../lib/use-dropdown";
import type { DropdownGroup } from "../lib/use-dropdown";

const props = defineProps<{
  modelValue: string;
  groups: SelectGroup[];
  placeholder?: string;
  dataTest?: string;
  ariaLabel?: string;
  /** Element id for the trigger button (label `for` support). */
  id?: string;
  /** MobileSheet title (defaults to the aria label). */
  title?: string;
  disabled?: boolean;
  /** Compact field (git branch picker): h-6, mono label, small chevron. */
  compact?: boolean;
  /** Panel anchor relative to the trigger. */
  placement?: "bottom" | "bottom-end" | "top" | "top-end";
  /** Raised z-index for sheets opened inside dialogs. */
  sheetZ?: string;
}>();
const emit = defineEmits<{ "update:modelValue": [value: string] }>();

const dd = useDropdown();

const dropdownGroups = computed<DropdownGroup[]>(() => {
  const groups = props.groups.map((g) => ({
    label: g.label,
    rows: g.options.map((o) => ({
      value: o.value,
      label: o.label,
      disabled: o.disabled,
      hint: o.hint,
      testId: o.testId,
      selected: o.value === props.modelValue,
    })),
  }));
  // Nothing selected yet: show the placeholder as a disabled first row (the native
  // <select> had one). Skipped when "" is a real option (e.g. effort "Default").
  const hasEmptyOption = groups.some((g) => g.rows.some((r) => r.value === ""));
  if (props.modelValue || hasEmptyOption || !props.placeholder) return groups;
  return [{ rows: [{ value: "", label: props.placeholder, disabled: true }] }, ...groups];
});
const selectedLabel = computed(
  () => props.groups.flatMap((g) => g.options).find((o) => o.value === props.modelValue)?.label ?? "",
);

function onSelect(value: string): void {
  emit("update:modelValue", value);
}
</script>

<template>
  <div class="relative">
    <button type="button"
            :id="id"
            :ref="(el) => (dd.trigger = el as HTMLElement | null)"
            :data-test="dataTest"
            :data-value="modelValue"
            :aria-label="ariaLabel"
            :aria-haspopup="true"
            :aria-expanded="dd.open"
            :disabled="disabled"
            class="items-center justify-between text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50"
            :class="compact
              ? 'flex h-6 min-w-0 max-w-full gap-1 rounded-sm bg-surface-2 px-1.5 font-mono text-xs font-medium text-fg'
              : 'flex h-9 w-full rounded-lg bg-surface-2 pl-3 pr-2 text-sm text-fg'"
            @click="dd.toggle()">
      <span class="min-w-0 truncate" :class="compact ? '' : (selectedLabel ? 'text-fg' : 'text-fg-muted')">
        {{ selectedLabel || placeholder || "Select…" }}
      </span>
      <ChevronDown :size="compact ? 12 : 16" class="shrink-0 text-fg-muted transition-transform"
                   :class="[compact ? '' : 'ml-2', dd.open ? 'rotate-180' : '']" />
    </button>
    <DropdownPanel :dd="dd" :groups="dropdownGroups" :title="title ?? ariaLabel ?? placeholder"
                   :width="compact ? 'min-w-40' : 'w-full'" :placement="placement ?? 'bottom'"
                   :sheet-z="sheetZ" role="listbox" @select="onSelect" />
  </div>
</template>
