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
  // swipe regression tests for the wiring.
  it("exposes bare pointer-event handler keys", () => {
    const { handlers } = useSwipeActions({});
    expect(Object.keys(handlers).sort()).toEqual(["pointercancel", "pointerdown", "pointermove", "pointerup"]);
  });
  it("reports a live delta during a horizontal drag, then ends with the final delta", () => {
    const onMove = vi.fn(), onEnd = vi.fn();
    const { handlers } = useSwipeActions({ onMove, onEnd });
    handlers.pointerdown(pointer(200));
    handlers.pointermove(pointer(160)); // dx -40 → horizontal
    handlers.pointermove(pointer(120)); // dx -80
    expect(onMove).toHaveBeenNthCalledWith(1, -40);
    expect(onMove).toHaveBeenNthCalledWith(2, -80);
    handlers.pointerup(pointer(120));
    expect(onEnd).toHaveBeenCalledWith(-80);
  });
  it("yields to vertical scroll: no move, ends with 0", () => {
    const onMove = vi.fn(), onEnd = vi.fn();
    const { handlers } = useSwipeActions({ onMove, onEnd });
    handlers.pointerdown(pointer(200, 200));
    handlers.pointermove(pointer(196, 260)); // vertical-dominant
    expect(onMove).not.toHaveBeenCalled();
    expect(onEnd).toHaveBeenCalledWith(0);
    handlers.pointerup(pointer(196, 260)); // stray up after yield must not re-fire
    expect(onEnd).toHaveBeenCalledTimes(1);
  });
  it("a sub-intent tap never starts a drag (no move, ends with 0)", () => {
    const onMove = vi.fn(), onEnd = vi.fn();
    const { handlers } = useSwipeActions({ onMove, onEnd });
    handlers.pointerdown(pointer(200));
    handlers.pointermove(pointer(198)); // 2px < intent
    handlers.pointerup(pointer(198));
    expect(onMove).not.toHaveBeenCalled();
    expect(onEnd).toHaveBeenCalledWith(0);
  });
  it("ends with 0 on pointercancel and a stray up does not re-fire", () => {
    const onMove = vi.fn(), onEnd = vi.fn();
    const { handlers } = useSwipeActions({ onMove, onEnd });
    handlers.pointerdown(pointer(200));
    handlers.pointermove(pointer(120)); // horizontal drag…
    handlers.pointercancel();           // …but the browser reclassified it as scroll
    handlers.pointerup(pointer(120));   // stray up after cancel must not re-fire
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledWith(0);
  });
});
