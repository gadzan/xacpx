<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { MessageSquare, SquareTerminal, X } from "lucide-vue-next";
import { useCenterTabsStore, type CenterTab, TAB_DROP_END } from "../stores/center-tabs";
import { useTabDrag } from "../lib/use-tab-drag";
import { iconForFile } from "../lib/file-icons";

const props = defineProps<{ sessionKey: string }>();
const store = useCenterTabsStore();
const { t } = useI18n();

// Destructure so Vue's template compiler auto-unwraps `overId` (a top-level ref
// binding); `drag.overId` (member access on a plain object) would NOT be unwrapped.
const { overId, start } = useTabDrag({
  onReorder: (draggedId, targetId) => store.reorder(props.sessionKey, draggedId, targetId),
});

/** Last "/"-segment of a path, or the whole string when there's no separator. */
function basename(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? path : path.slice(idx + 1);
}

function iconFor(tab: CenterTab) {
  return tab.kind === "terminal" ? SquareTerminal : iconForFile(tab.path);
}

function labelFor(tab: CenterTab): string {
  return tab.kind === "terminal" ? t("center.terminal") : basename(tab.path);
}
</script>

<template>
  <div class="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-border bg-surface px-1 py-1">
    <!-- Pinned chat tab: never closable, never draggable, always first. -->
    <button
      type="button"
      data-test="tab-chat"
      class="flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11.5px] transition-colors cursor-pointer"
      :class="store.activeFor(props.sessionKey) === 'chat' ? 'bg-accent/10 text-accent font-semibold' : 'text-fg-muted font-medium hover:bg-raised'"
      @click="store.setActive(props.sessionKey, 'chat')"
    >
      <MessageSquare :size="13" />{{ $t("center.chat") }}
    </button>

    <div
      v-for="tab in store.tabsFor(props.sessionKey)"
      :key="tab.id"
      data-test="tab"
      :data-tab-id="tab.id"
      style="touch-action: none"
      class="flex shrink-0 items-center gap-1 rounded-md px-2.5 py-1.5 text-[11.5px] transition-colors cursor-pointer"
      :class="[
        tab.id === store.activeFor(props.sessionKey) ? 'bg-accent/10 text-accent font-semibold' : 'text-fg-muted font-medium hover:bg-raised',
        overId === tab.id ? 'ring-1 ring-inset ring-accent' : '',
      ]"
      @click="store.setActive(props.sessionKey, tab.id)"
      @pointerdown="start($event, tab.id)"
    >
      <component :is="iconFor(tab)" :size="13" class="shrink-0" />
      <span v-if="tab.kind === 'diff'" class="shrink-0 text-[10px] font-semibold opacity-80">Δ</span>
      <span class="max-w-[10rem] truncate">{{ labelFor(tab) }}</span>
      <button
        type="button"
        data-test="tab-close"
        :aria-label="$t('center.closeTab')"
        class="ml-0.5 grid h-4 w-4 shrink-0 place-items-center rounded text-fg-muted opacity-60 hover:bg-surface hover:text-fg hover:opacity-100"
        @click.stop="store.closeTab(props.sessionKey, tab.id)"
      >
        <X :size="11" />
      </button>
    </div>

    <!-- Trailing drop zone: not a tab (no label/close), just extends the drop target past
         the last tab so a drag released in the empty strip area moves it to the end.
         `flex-1` fills remaining strip width; `min-w-3` keeps it hit-testable even when
         tabs already fill/overflow the strip. -->
    <div
      data-test="tab-drop-end"
      :data-tab-id="TAB_DROP_END"
      class="min-w-3 flex-1 self-stretch rounded-md"
      :class="overId === TAB_DROP_END ? 'ring-1 ring-inset ring-accent' : ''"
    />
  </div>
</template>
