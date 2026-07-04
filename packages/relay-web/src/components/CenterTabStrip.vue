<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from "vue";
import { useI18n } from "vue-i18n";
import { MessageSquare, SquareTerminal, X } from "lucide-vue-next";
import { useCenterTabsStore, type CenterTab, TAB_DROP_END } from "../stores/center-tabs";
import { useTabDrag } from "../lib/use-tab-drag";
import { iconForFile } from "../lib/file-icons";

// The center tab strip: pinned Chat button + closable, drag-reorderable file/diff/
// terminal tabs, horizontally scrollable when they overflow. Rendered in two places:
// a standalone row above the content on desktop, and (with `bare`) inside the mobile
// top bar where it replaces the session-name text. `bare` drops the strip's own chrome
// (border/background/shrink-0) so it slots into a host row that already owns those.
//
// `select-none` + `[-webkit-touch-callout:none]` on the root stop a touch press-hold
// (the natural start of a drag) from highlighting a tab's label or popping the iOS
// callout menu. Keep the root <div> the FIRST node in <template>: a leading sibling
// comment would make the component a fragment root, so tests' `w.element` would resolve
// to the comment instead of the div.
const props = defineProps<{ sessionKey: string; bare?: boolean }>();
const store = useCenterTabsStore();
const { t } = useI18n();

// Destructure so Vue's template compiler auto-unwraps the refs (top-level bindings);
// `drag.overId` (member access on a plain object) would NOT be unwrapped.
const { draggingId, overId, start } = useTabDrag({
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

// Guarded close: a clean tab closes immediately; a dirty file tab asks first via the
// native confirm dialog (the store itself can't show UI, so the confirm callback is
// injected — see closeTabGuarded).
function requestClose(id: string) {
  store.closeTabGuarded(props.sessionKey, id, () => window.confirm(t("files.unsavedConfirm")));
}

// Edge-fade + hidden scrollbar. The scrollbar is suppressed (`no-scrollbar`); to signal
// that tabs continue off-screen we fade the strip's content with a mask, but ONLY on the
// side(s) that actually have hidden tabs — a static both-ends mask would dim the first/last
// tab even when nothing is clipped. `canLeft`/`canRight` track the scroll position.
const scroller = ref<HTMLElement | null>(null);
const canLeft = ref(false);
const canRight = ref(false);

function updateFades() {
  const el = scroller.value;
  if (!el) {
    canLeft.value = false;
    canRight.value = false;
    return;
  }
  canLeft.value = el.scrollLeft > 1;
  canRight.value = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
}

const FADE = "1.25rem";
const maskStyle = computed(() => {
  const l = canLeft.value;
  const r = canRight.value;
  if (!l && !r) return {};
  const stops = [l ? "transparent 0" : "#000 0"];
  if (l) stops.push(`#000 ${FADE}`);
  if (r) stops.push(`#000 calc(100% - ${FADE})`);
  stops.push(r ? "transparent 100%" : "#000 100%");
  const g = `linear-gradient(to right, ${stops.join(", ")})`;
  return { maskImage: g, WebkitMaskImage: g };
});

onMounted(() => {
  updateFades();
  scroller.value?.addEventListener("scroll", updateFades, { passive: true });
  window.addEventListener("resize", updateFades);
});
onBeforeUnmount(() => {
  scroller.value?.removeEventListener("scroll", updateFades);
  window.removeEventListener("resize", updateFades);
});
// A tab added/closed changes scrollWidth ⇒ re-evaluate which side overflows.
watch(() => store.tabsFor(props.sessionKey).length, () => nextTick(updateFades));
</script>

<template>
  <div
    ref="scroller"
    :style="maskStyle"
    class="no-scrollbar flex select-none items-center gap-0.5 overflow-x-auto px-1 py-1 [-webkit-touch-callout:none]"
    :class="props.bare ? '' : 'shrink-0 border-b border-border bg-surface'"
  >
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

    <!-- `touch-action: pan-x`: let a horizontal swipe scroll the strip natively; the
         drag-reorder is gated behind a long-press instead (see use-tab-drag). pan-x also
         forbids the browser from vertically panning from a tab — fine because the strip
         only ever lives in the fixed mobile top bar / the desktop row, neither of which is
         inside vertically-scrollable content. Revisit pan-x if the strip is ever placed
         somewhere a vertical scroll must start on a tab. -->
    <div
      v-for="tab in store.tabsFor(props.sessionKey)"
      :key="tab.id"
      data-test="tab"
      :data-tab-id="tab.id"
      style="touch-action: pan-x"
      class="flex shrink-0 items-center gap-1 rounded-md px-2.5 py-1.5 text-[11.5px] transition cursor-pointer"
      :class="[
        tab.id === store.activeFor(props.sessionKey) ? 'bg-accent/10 text-accent font-semibold' : 'text-fg-muted font-medium hover:bg-raised',
        overId === tab.id ? 'ring-1 ring-inset ring-accent' : '',
        tab.id === draggingId ? 'scale-95 opacity-50' : '',
      ]"
      @click="store.setActive(props.sessionKey, tab.id)"
      @pointerdown="start($event, tab.id)"
    >
      <component :is="iconFor(tab)" :size="13" class="shrink-0" />
      <span v-if="tab.kind === 'diff'" class="shrink-0 text-[10px] font-semibold opacity-80">Δ</span>
      <span class="max-w-[10rem] truncate">{{ labelFor(tab) }}</span>
      <span v-if="tab.kind === 'file' && tab.dirty" class="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" aria-hidden="true" />
      <button
        type="button"
        data-test="tab-close"
        :aria-label="$t('center.closeTab')"
        class="ml-0.5 grid h-4 w-4 shrink-0 place-items-center rounded text-fg-muted opacity-60 hover:bg-surface hover:text-fg hover:opacity-100"
        @click.stop="requestClose(tab.id)"
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
