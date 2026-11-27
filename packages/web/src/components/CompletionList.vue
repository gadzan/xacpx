<script lang="ts">
// One row of a completion list (slash commands, @-mentions). Deliberately
// narrow: the fields below cover every list the two composers render, so the
// row markup and its keyboard/touch contract exist once.
//
// Types live in this plain <script> block so consumers can import them (a
// <script setup> block cannot `export`).
export interface CompletionTrailing {
  text: string;
  /** accent = the lead marker, mono = a bot id; default is muted. */
  tone?: "accent" | "mono";
}
export interface CompletionRow {
  key: string;
  label: string;
  /** Muted trailing text: a command description, a mention's agent · workspace. */
  detail?: string;
  /** Accent marker in front of the label (the skill chip). */
  badge?: string;
  /** Muted/accent/mono chips after the label (lead, role, reason, bot id). */
  trailing?: CompletionTrailing[];
  disabled?: boolean;
  /** Tooltip, e.g. why a mention cannot be selected. */
  title?: string;
  testId?: string;
  /** Extra data-* attributes (data-bot-id and friends). */
  data?: Record<string, string>;
}
</script>

<script setup lang="ts">
// The list body of a composer completion menu. It is NOT a full menu: the
// caller owns the popover/sheet shell (CompletionMenu) and the keyboard.
//
// `listId` is what turns the rows into an ARIA listbox. The Direct composer's
// textarea IS a combobox and owns `aria-activedescendant`, so it passes an id
// and the rows become options. The Group composer's textarea is a plain
// textarea that offers two suggestion lists, so it passes no id and the rows
// stay plain buttons — a listbox with no combobox is worse than none.
//
// Rows are 32px on desktop and 46px on touch, so the mobile sheet is reachable
// with a thumb while the desktop popover stays dense. Every activation
// suppresses pointerdown: the textarea must keep focus and its caret.
const props = defineProps<{
  /** Set only when a combobox owns this list; enables the listbox roles. */
  listId?: string;
  ariaLabel?: string;
  testId: string;
  itemTestId: string;
  /** Row ids are `${itemIdPrefix}${index}` for aria-activedescendant. */
  itemIdPrefix?: string;
  rows: CompletionRow[];
  activeIndex: number;
  mobile: boolean;
  /** Shown when there are no rows (loading / error / empty text). */
  statusText?: string;
}>();
const emit = defineEmits<{ pick: [index: number] }>();

</script>

<template>
  <div
    :id="listId"
    :role="listId ? 'listbox' : undefined"
    :aria-label="listId ? ariaLabel : undefined"
    :data-test="testId"
    :class="mobile ? 'w-full' : ''"
  >
    <button
      v-for="(row, index) in rows"
      :id="itemIdPrefix ? `${itemIdPrefix}${index}` : undefined"
      :key="row.key"
      type="button"
      :role="listId ? 'option' : undefined"
      :aria-selected="listId ? index === activeIndex : undefined"
      :aria-disabled="row.disabled || undefined"
      :title="row.title"
      :data-test="row.testId ?? itemTestId"
      v-bind="row.data"
      class="flex w-full items-center gap-2 rounded-item text-left text-sm"
      :class="[
        mobile ? 'min-h-[46px] px-3' : 'h-8 px-2',
        index === activeIndex ? 'bg-fill-strong' : 'hover:bg-fill-hover',
        row.disabled ? 'text-fg-muted' : '',
      ]"
      @pointerdown.prevent
      @click="emit('pick', index)"
    >
      <span v-if="row.badge" class="shrink-0 text-accent-text">{{ row.badge }}</span>
      <span class="min-w-0 truncate font-medium text-fg" :class="row.trailing?.length ? 'flex-1' : ''">{{ row.label }}</span>
      <span v-if="row.detail" class="truncate text-fg-muted">{{ row.detail }}</span>
      <span
        v-for="chip in row.trailing ?? []"
        :key="chip.text"
        class="shrink-0 truncate text-xs"
        :class="chip.tone === 'accent' ? 'text-accent-text' : chip.tone === 'mono' ? 'font-mono text-fg-muted' : 'text-fg-muted'"
      >{{ chip.text }}</span>
    </button>
    <div v-if="!rows.length && statusText" role="status" class="px-3 py-2 text-xs text-fg-muted">
      {{ statusText }}
    </div>
    <!-- More / retry / hint actions. They sit inside the listbox so a long list
         keeps one scroll container; they are plain buttons, not options. -->
    <slot />
  </div>
</template>
