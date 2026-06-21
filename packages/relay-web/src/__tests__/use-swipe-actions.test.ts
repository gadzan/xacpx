import { describe, it, expect, vi } from "vitest";
import { useSwipeActions } from "../lib/use-swipe-actions";

// jsdom doesn't implement PointerEvent, so feed the handlers plain coordinate
// objects — the composable only reads clientX/clientY.
function pointer(x: number, y = 0) {
  return { clientX: x, clientY: y };
}

describe("useSwipeActions", () => {
  // Handler keys must be bare DOM event names so `v-on="handlers"` binds real
  // pointer events (Vue re-applies the `on` prefix); an `onPointerdown` key would
  // bind a dead event and the swipe would silently never fire. See InstanceTree's
  // "binds swipe handlers to real pointer events" regression test for the wiring.
  it("exposes bare pointer-event handler keys", () => {
    const { handlers } = useSwipeActions({ onSwipeLeft: vi.fn(), onSwipeRight: vi.fn() });
    expect(Object.keys(handlers).sort()).toEqual(["pointerdown", "pointermove", "pointerup"]);
  });
  it("fires onSwipeLeft past the threshold", () => {
    const onSwipeLeft = vi.fn(), onSwipeRight = vi.fn();
    const { handlers } = useSwipeActions({ onSwipeLeft, onSwipeRight, threshold: 60 });
    handlers.pointerdown(pointer(200));
    handlers.pointermove(pointer(120));
    handlers.pointerup(pointer(120));
    expect(onSwipeLeft).toHaveBeenCalled();
    expect(onSwipeRight).not.toHaveBeenCalled();
  });
  it("fires onSwipeRight past the threshold", () => {
    const onSwipeLeft = vi.fn(), onSwipeRight = vi.fn();
    const { handlers } = useSwipeActions({ onSwipeLeft, onSwipeRight, threshold: 60 });
    handlers.pointerdown(pointer(100));
    handlers.pointermove(pointer(200));
    handlers.pointerup(pointer(200));
    expect(onSwipeRight).toHaveBeenCalled();
  });
  it("ignores sub-threshold and vertical-dominant moves", () => {
    const onSwipeLeft = vi.fn(), onSwipeRight = vi.fn();
    const { handlers } = useSwipeActions({ onSwipeLeft, onSwipeRight, threshold: 60 });
    handlers.pointerdown(pointer(200));
    handlers.pointermove(pointer(180));
    handlers.pointerup(pointer(180));
    expect(onSwipeLeft).not.toHaveBeenCalled();
    expect(onSwipeRight).not.toHaveBeenCalled();
  });
});
