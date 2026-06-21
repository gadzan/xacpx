import { describe, it, expect, vi } from "vitest";
import { useSwipeActions } from "../lib/use-swipe-actions";

// jsdom doesn't implement PointerEvent, so feed the handlers plain coordinate
// objects — the composable only reads clientX/clientY.
function pointer(x: number, y = 0) {
  return { clientX: x, clientY: y };
}

describe("useSwipeActions", () => {
  it("fires onSwipeLeft past the threshold", () => {
    const onSwipeLeft = vi.fn(), onSwipeRight = vi.fn();
    const { handlers } = useSwipeActions({ onSwipeLeft, onSwipeRight, threshold: 60 });
    handlers.onPointerdown(pointer(200));
    handlers.onPointermove(pointer(120));
    handlers.onPointerup(pointer(120));
    expect(onSwipeLeft).toHaveBeenCalled();
    expect(onSwipeRight).not.toHaveBeenCalled();
  });
  it("fires onSwipeRight past the threshold", () => {
    const onSwipeLeft = vi.fn(), onSwipeRight = vi.fn();
    const { handlers } = useSwipeActions({ onSwipeLeft, onSwipeRight, threshold: 60 });
    handlers.onPointerdown(pointer(100));
    handlers.onPointermove(pointer(200));
    handlers.onPointerup(pointer(200));
    expect(onSwipeRight).toHaveBeenCalled();
  });
  it("ignores sub-threshold and vertical-dominant moves", () => {
    const onSwipeLeft = vi.fn(), onSwipeRight = vi.fn();
    const { handlers } = useSwipeActions({ onSwipeLeft, onSwipeRight, threshold: 60 });
    handlers.onPointerdown(pointer(200));
    handlers.onPointermove(pointer(180));
    handlers.onPointerup(pointer(180));
    expect(onSwipeLeft).not.toHaveBeenCalled();
    expect(onSwipeRight).not.toHaveBeenCalled();
  });
});
