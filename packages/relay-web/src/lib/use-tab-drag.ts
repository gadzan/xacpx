import { ref, type Ref } from "vue";

/** Px of pointer movement before a pointerdown on a tab commits to a drag
 *  rather than staying a click. Mirrors the `intent` threshold in
 *  `use-swipe-actions.ts`. */
const THRESHOLD = 4;

export interface TabDragOptions {
  onReorder: (draggedId: string, targetId: string) => void;
  /** Hit-test seam: given viewport coords, return the `data-tab-id` of the tab
   *  underneath, or null. Defaults to a real DOM lookup via
   *  `document.elementFromPoint`, which jsdom can't lay out — tests inject
   *  this to control `overId` deterministically. */
  resolveId?: (x: number, y: number) => string | null;
}

export interface TabDragHandlers {
  draggingId: Ref<string | null>;
  overId: Ref<string | null>;
  /** Call from a tab's `pointerdown` handler. */
  start: (e: PointerEvent, id: string) => void;
}

function defaultResolveId(x: number, y: number): string | null {
  const el = document.elementFromPoint(x, y);
  return el?.closest("[data-tab-id]")?.getAttribute("data-tab-id") ?? null;
}

/** Vanilla Pointer Events tab drag-reorder (mouse + touch), mirroring the
 *  attach/detach-on-document style of `use-swipe-actions.ts` / `edge-swipe.ts`.
 *  `start` arms the gesture but does not mark it dragging until the pointer
 *  has moved past `THRESHOLD`, so a plain tap/click never flags a drag. */
export function useTabDrag(opts: TabDragOptions): TabDragHandlers {
  const draggingId = ref<string | null>(null);
  const overId = ref<string | null>(null);
  const resolveId = opts.resolveId ?? defaultResolveId;

  let armedId: string | null = null;
  let startX = 0;

  function reset() {
    armedId = null;
    draggingId.value = null;
    overId.value = null;
    document.removeEventListener("pointermove", pointermove);
    document.removeEventListener("pointerup", pointerup);
    document.removeEventListener("pointercancel", pointercancel);
  }

  function pointermove(e: PointerEvent) {
    if (armedId === null) return;
    if (draggingId.value === null) {
      if (Math.abs(e.clientX - startX) < THRESHOLD) return;
      draggingId.value = armedId;
    }
    overId.value = resolveId(e.clientX, e.clientY);
  }

  function pointerup() {
    const dragged = draggingId.value;
    const over = overId.value;
    if (dragged && over && over !== dragged) {
      opts.onReorder(dragged, over);
    }
    reset();
  }

  function pointercancel() {
    reset();
  }

  function start(e: PointerEvent, id: string) {
    // Defensive: drop any listeners from a prior gesture that never reached
    // pointerup/pointercancel (e.g. a second pointerdown mid-drag) before
    // re-adding, so listeners never accumulate across gestures.
    document.removeEventListener("pointermove", pointermove);
    document.removeEventListener("pointerup", pointerup);
    document.removeEventListener("pointercancel", pointercancel);
    armedId = id;
    startX = e.clientX;
    document.addEventListener("pointermove", pointermove);
    document.addEventListener("pointerup", pointerup);
    document.addEventListener("pointercancel", pointercancel);
  }

  return { draggingId, overId, start };
}
