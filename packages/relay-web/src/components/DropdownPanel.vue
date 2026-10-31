<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Check, Search } from "lucide-vue-next";
import MobileSheet from "./MobileSheet.vue";
import { focusSoon, useIsMobile } from "../lib/use-dropdown";
import { navigateBack } from "../lib/mobile-back";
import type { DropdownController, DropdownGroup, DropdownRow } from "../lib/use-dropdown";

// The one dropdown panel (relay-web redesign §F). Desktop: an absolutely
// positioned popover anchored to its trigger. Below lg: the same rows rendered
// inside a MobileSheet. Two modes:
//   · items mode — `groups` of DropdownRow; the panel filters, highlights,
//     navigates and emits `select` with the row value.
//   · slot mode — caller renders its own rows (avatars, per-row actions) and
//     passes `navCount`; Enter/Space emits `navigate` with the row index.
const props = defineProps<{
  dd: DropdownController;
  groups?: DropdownGroup[];
  /** Tailwind width class; default is the list-panel minimum. */
  width?: string;
  placement?: "bottom" | "bottom-end" | "top" | "top-end";
  /** MobileSheet title below lg. */
  title?: string;
  role?: "listbox" | "menu";
  /** Force the search field on (otherwise it appears above 7 rows). */
  searchable?: boolean;
  searchPlaceholder?: string;
  emptyText?: string;
  /** Slot mode: how many rows are keyboard-navigable. */
  navCount?: number;
  /** Raised z-index for panels inside dialogs (MobileSheet only). */
  sheetZ?: string;
  /** data-test for the MobileSheet below lg (defaults to `testId`). */
  sheetTestId?: string;
  testId?: string;
}>();
const emit = defineEmits<{
  select: [value: string];
  close: [];
  navigate: [index: number];
  "update:query": [query: string];
}>();

const { t } = useI18n();
const isMobile = useIsMobile();
const query = ref("");
const searchEl = ref<HTMLInputElement | null>(null);

const filtered = computed<DropdownGroup[]>(() => {
  const needle = query.value.trim().toLowerCase();
  return (props.groups ?? [])
    .map((g) => ({
      label: g.label,
      rows: needle ? g.rows.filter((r) => r.label.toLowerCase().includes(needle)) : g.rows,
    }))
    .filter((g) => g.rows.length > 0);
});
const flatRows = computed<DropdownRow[]>(() => filtered.value.flatMap((g) => g.rows));
const navRows = computed<DropdownRow[]>(() => flatRows.value.filter((r) => !r.disabled));
const totalRows = computed(() => (props.groups ?? []).reduce((n, g) => n + g.rows.length, 0));
const showSearch = computed(() => props.searchable || totalRows.value > 7);

watch(() => query.value, (q) => emit("update:query", q));

function navIndexOf(row: DropdownRow): number {
  return navRows.value.indexOf(row);
}
function isHighlighted(row: DropdownRow): boolean {
  return !row.disabled && navIndexOf(row) === props.dd.highlight;
}

function activate(row: DropdownRow): void {
  if (row.disabled) return;
  emit("select", row.value);
  if (!row.keepOpen) requestClose();
}

/** Below lg the panel is a MobileSheet that owns a history entry, so closing it —
 *  X, backdrop, Escape, picking a row — pops that entry and the popstate closes the
 *  dropdown. On desktop the popover closes in place. */
function requestClose(): void {
  if (isMobile.value) navigateBack();
  else props.dd.closeMenu();
}

// While open, register the navigable rows with the controller and own the
// query lifecycle (cleared on close so the next open starts unfiltered).
watch(
  () => [props.dd.open, navRows.value.length, props.navCount] as const,
  () => {
    if (!props.dd.open) return;
    const itemsMode = props.groups !== undefined;
    props.dd.setNav(itemsMode ? navRows.value.length : props.navCount ?? 0, (index) => {
      if (itemsMode) {
        const row = navRows.value[index];
        if (row) activate(row);
      } else {
        emit("navigate", index);
      }
    });
  },
  { immediate: true },
);

watch(
  () => props.dd.open,
  (open) => {
    if (!open) {
      query.value = "";
      props.dd.firstLetterJump = undefined;
      return;
    }
    if (props.groups !== undefined) {
      const selected = navRows.value.findIndex((r) => r.selected);
      props.dd.highlight = selected >= 0 ? selected : 0;
      props.dd.firstLetterJump = (ch: string) => {
        const n = navRows.value.length;
        for (let k = 1; k <= n; k++) {
          const i = (props.dd.highlight + k + n) % n;
          if (navRows.value[i]?.label.toLowerCase().startsWith(ch.toLowerCase())) {
            props.dd.highlight = i;
            return;
          }
        }
      };
    }
    if (showSearch.value) focusSoon(searchEl.value);
  },
);

function rowClass(row: DropdownRow, mobile: boolean): string {
  if (row.disabled) return "cursor-not-allowed text-fg-muted-overlay";
  if (row.danger) return "text-danger-overlay hover:bg-danger/10";
  const hl = isHighlighted(row);
  return [
    row.selected ? "font-semibold" : "",
    // Selection is background only — never a stripe, never blue text.
    mobile ? "active:bg-fill-hover" : row.selected || hl ? "bg-fill-strong" : "hover:bg-fill-hover",
  ].join(" ");
}

const placementClass = computed(() => {
  switch (props.placement) {
    case "bottom-end": return "absolute right-0 top-full mt-1";
    case "top": return "absolute bottom-full left-0 mb-1";
    case "top-end": return "absolute bottom-full right-0 mb-1";
    default: return "absolute left-0 top-full mt-1";
  }
});
const listRole = computed(() => props.role ?? "listbox");
</script>

<template>
  <!-- <lg: the same rows inside a bottom sheet (title = the dropdown's scene name). -->
  <MobileSheet v-if="isMobile && dd.open" :title="title ?? ''" :z-class="sheetZ" :test-id="sheetTestId ?? testId" dd-panel @close="dd.closeMenu()">
    <div v-if="showSearch" class="sticky top-0 z-10 -mx-2 bg-glass-strong px-3 pb-1 pt-1">
      <div class="flex h-11 items-center gap-2 rounded-lg bg-surface-2 px-3">
        <Search :size="16" class="shrink-0 text-fg-muted-overlay" />
        <input ref="searchEl" v-model="query" type="search" data-test="dd-search"
               :placeholder="searchPlaceholder ?? t('common.filter')"
               class="min-w-0 flex-1 bg-transparent text-base text-fg outline-none placeholder:text-fg-muted-overlay" />
      </div>
    </div>
    <template v-for="(g, gi) in filtered" :key="gi">
      <p v-if="g.label" class="px-3 pb-1 pt-2 text-xs text-fg-muted-overlay">{{ g.label }}</p>
      <button v-for="row in g.rows" :key="row.value" type="button" :role="listRole === 'menu' ? 'menuitem' : 'option'"
              :data-value="row.value"
              :data-test="row.testId"
              :disabled="row.disabled" :aria-selected="row.selected"
              class="flex h-11 w-full items-center gap-3 rounded-item px-3 text-ui"
              :class="rowClass(row, true)"
              @click="activate(row)">
        <component :is="row.icon" v-if="row.icon" :size="16" class="shrink-0 text-fg-muted-overlay" />
        <span class="min-w-0 truncate" :class="row.mono ? 'font-mono text-ui' : ''">{{ row.label }}</span>
        <span v-if="row.hint" class="ml-auto shrink-0 text-xs text-fg-muted-overlay">{{ row.hint }}</span>
        <Check v-else-if="row.selected" :size="16" class="ml-auto shrink-0 text-accent-text" />
      </button>
    </template>
    <p v-if="groups && !flatRows.length" class="px-3 py-3 text-sm text-fg-muted-overlay">{{ emptyText ?? t("common.noMatch") }}</p>
    <slot :mobile="true" />
  </MobileSheet>

  <!-- Desktop popover: one glass surface, rows scroll inside it so the search field
       never needs a sticky backdrop (a second backdrop-filtered layer inside the
       panel would nest glass). -->
  <div v-else-if="dd.open" data-dd-panel
       :data-test="testId" :role="listRole" :aria-label="title"
       class="z-30 flex max-h-80 flex-col overflow-hidden rounded-lg bg-glass-strong p-1 shadow-glass-float backdrop-blur-glass backdrop-saturate-glass"
       :class="[placementClass, width ?? 'min-w-40']">
    <div v-if="showSearch" class="shrink-0 px-1 pb-1 pt-1">
      <div class="flex h-8 items-center gap-2 rounded-sm bg-fill-track px-2">
        <Search :size="14" class="shrink-0 text-fg-muted-overlay" />
        <input ref="searchEl" v-model="query" type="search" data-test="dd-search"
               :placeholder="searchPlaceholder ?? t('common.filter')"
               class="min-w-0 flex-1 bg-transparent text-ui text-fg outline-none placeholder:text-fg-muted-overlay" />
      </div>
    </div>
    <div class="min-h-0 flex-1 overflow-y-auto">
      <template v-for="(g, gi) in filtered" :key="gi">
        <p v-if="g.label" class="px-2 pb-1 pt-2 text-xs text-fg-muted-overlay">{{ g.label }}</p>
        <template v-for="row in g.rows" :key="row.value">
          <div v-if="row.separatorBefore" class="mx-2 my-1 h-px bg-hairline" />
          <button type="button"
                :role="listRole === 'menu' ? 'menuitem' : 'option'"
                :data-value="row.value"
                :data-test="row.testId"
                :disabled="row.disabled" :aria-selected="row.selected"
                class="flex h-[30px] w-full items-center gap-2 rounded-item px-2 text-ui"
                :class="rowClass(row, false)"
                @click="activate(row)" @mouseenter="!row.disabled && (dd.highlight = navIndexOf(row))">
          <component :is="row.icon" v-if="row.icon" :size="14" class="shrink-0 text-fg-muted-overlay" />
          <span class="min-w-0 truncate" :class="row.mono ? 'font-mono' : ''">{{ row.label }}</span>
          <span v-if="row.hint" class="ml-auto shrink-0 text-xs text-fg-muted-overlay">{{ row.hint }}</span>
          <Check v-else-if="row.selected" :size="16" class="ml-auto shrink-0 text-accent-text" />
        </button>
        </template>
      </template>
      <p v-if="groups && !flatRows.length" class="px-2 py-3 text-sm text-fg-muted-overlay">{{ emptyText ?? t("common.noMatch") }}</p>
      <slot :mobile="false" />
    </div>
  </div>
</template>
