import { nextTick, onBeforeUnmount, onMounted, watch } from "vue";

/** Restore once per detail/attempt, including when the trace arrives after opening. */
export function useDetailScrollMemory(
  element: () => HTMLElement | null | undefined,
  key: () => string,
  memory: () => Map<string, number> | undefined,
  ready: () => boolean,
): { remember: () => void } {
  let target: number | undefined;
  let observer: ResizeObserver | undefined;
  let frame: number | undefined;
  let generation = 0;
  let active = false;
  let scroller: HTMLElement | null = null;

  function finish(): void {
    target = undefined;
    observer?.disconnect();
    observer = undefined;
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
  }

  function apply(): void {
    if (target === undefined || !scroller) return;
    scroller.scrollTop = target;
    // A short loading shell clamps scrollTop. Keep the original offset until
    // the real content can hold it, rather than remembering the clamped value.
    if (ready() && Math.abs(scroller.scrollTop - target) <= 1) finish();
  }

  function schedule(): void {
    if (target === undefined || frame !== undefined) return;
    frame = requestAnimationFrame(() => {
      frame = undefined;
      apply();
    });
  }

  function onIntent(event: Event): void {
    if (event instanceof KeyboardEvent
      && !["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) return;
    finish();
  }

  function detach(): void {
    scroller?.removeEventListener("wheel", onIntent);
    scroller?.removeEventListener("touchstart", onIntent);
    scroller?.removeEventListener("pointerdown", onIntent);
    scroller?.removeEventListener("keydown", onIntent);
    scroller = null;
  }

  async function begin(): Promise<void> {
    const current = ++generation;
    finish();
    detach();
    target = memory()?.get(key());
    await nextTick();
    if (!active || current !== generation) return;
    scroller = element() ?? null;
    if (!scroller) return;
    scroller.addEventListener("wheel", onIntent, { passive: true });
    scroller.addEventListener("touchstart", onIntent, { passive: true });
    scroller.addEventListener("pointerdown", onIntent, { passive: true });
    scroller.addEventListener("keydown", onIntent);
    scroller.scrollTop = target ?? 0;
    if (target === undefined) return;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(schedule);
      observer.observe(scroller);
      if (scroller.firstElementChild) observer.observe(scroller.firstElementChild);
    }
    apply();
    schedule();
  }

  onMounted(() => { active = true; void begin(); });
  watch(key, () => { if (active) void begin(); }, { flush: "post" });
  watch(ready, () => { void nextTick(schedule); }, { flush: "post" });
  onBeforeUnmount(() => {
    active = false;
    generation++;
    finish();
    detach();
  });

  return {
    remember(): void {
      if (scroller && target === undefined) memory()?.set(key(), scroller.scrollTop);
    },
  };
}
