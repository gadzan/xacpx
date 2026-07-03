import { describe, it, expect, vi, afterEach } from "vitest";
import { useTabDrag } from "../lib/use-tab-drag";

// jsdom's PointerEvent support is inconsistent across versions; build one that
// definitely carries clientX/clientY regardless of what the runtime provides.
function pointerEvent(type: string, clientX: number, clientY = 0): PointerEvent {
  try {
    return new PointerEvent(type, { clientX, clientY, bubbles: true });
  } catch {
    const e = new MouseEvent(type, { clientX, clientY, bubbles: true });
    return e as unknown as PointerEvent;
  }
}

function fakeStartEvent(clientX: number, clientY = 0): PointerEvent {
  // `start` only reads clientX off the event it's given; a plain object cast is
  // enough and sidesteps constructing a real PointerEvent for the initiating call.
  return { clientX, clientY } as PointerEvent;
}

describe("useTabDrag", () => {
  afterEach(() => {
    // Belt-and-suspenders: any leaked listener from a failing test must not leak
    // into the next test's assertions (which dispatch on document too).
    document.dispatchEvent(pointerEvent("pointercancel", 0, 0));
  });

  it("does not start a drag when movement stays below the 4px threshold", () => {
    const onReorder = vi.fn();
    const { draggingId, overId, start } = useTabDrag({ onReorder });
    start(fakeStartEvent(100), "a");
    document.dispatchEvent(pointerEvent("pointermove", 102)); // dx=2 < 4
    expect(draggingId.value).toBeNull();
    expect(overId.value).toBeNull();
    document.dispatchEvent(pointerEvent("pointerup", 102));
    expect(onReorder).not.toHaveBeenCalled();
  });

  it("starts a drag once movement reaches the threshold and resolves overId via the injected seam", () => {
    const onReorder = vi.fn();
    const resolveId = vi.fn().mockReturnValue("b");
    const { draggingId, overId, start } = useTabDrag({ onReorder, resolveId });
    start(fakeStartEvent(100), "a");
    document.dispatchEvent(pointerEvent("pointermove", 105, 7)); // dx=5 >= 4
    expect(draggingId.value).toBe("a");
    expect(overId.value).toBe("b");
    expect(resolveId).toHaveBeenCalledWith(105, 7);
    document.dispatchEvent(pointerEvent("pointerup", 105, 7));
  });

  it("commits onReorder exactly once on pointerup when over differs from dragged, then resets", () => {
    const onReorder = vi.fn();
    const resolveId = vi.fn().mockReturnValue("b");
    const { draggingId, overId, start } = useTabDrag({ onReorder, resolveId });
    start(fakeStartEvent(100), "a");
    document.dispatchEvent(pointerEvent("pointermove", 110));
    document.dispatchEvent(pointerEvent("pointerup", 110));
    expect(onReorder).toHaveBeenCalledTimes(1);
    expect(onReorder).toHaveBeenCalledWith("a", "b");
    expect(draggingId.value).toBeNull();
    expect(overId.value).toBeNull();
  });

  it("does not call onReorder when the target is the dragged tab itself", () => {
    const onReorder = vi.fn();
    const resolveId = vi.fn().mockReturnValue("a");
    const { start } = useTabDrag({ onReorder, resolveId });
    start(fakeStartEvent(100), "a");
    document.dispatchEvent(pointerEvent("pointermove", 110));
    document.dispatchEvent(pointerEvent("pointerup", 110));
    expect(onReorder).not.toHaveBeenCalled();
  });

  it("does not call onReorder when no drop target resolves", () => {
    const onReorder = vi.fn();
    const resolveId = vi.fn().mockReturnValue(null);
    const { start } = useTabDrag({ onReorder, resolveId });
    start(fakeStartEvent(100), "a");
    document.dispatchEvent(pointerEvent("pointermove", 110));
    document.dispatchEvent(pointerEvent("pointerup", 110));
    expect(onReorder).not.toHaveBeenCalled();
  });

  it("resets without calling onReorder on pointercancel", () => {
    const onReorder = vi.fn();
    const resolveId = vi.fn().mockReturnValue("b");
    const { draggingId, overId, start } = useTabDrag({ onReorder, resolveId });
    start(fakeStartEvent(100), "a");
    document.dispatchEvent(pointerEvent("pointermove", 110));
    expect(draggingId.value).toBe("a");
    document.dispatchEvent(pointerEvent("pointercancel", 110));
    expect(draggingId.value).toBeNull();
    expect(overId.value).toBeNull();
    expect(onReorder).not.toHaveBeenCalled();
  });

  it("removes document listeners after pointerup so a later stray move/up is a no-op", () => {
    const onReorder = vi.fn();
    const resolveId = vi.fn().mockReturnValue("b");
    const { draggingId, start } = useTabDrag({ onReorder, resolveId });
    start(fakeStartEvent(100), "a");
    document.dispatchEvent(pointerEvent("pointermove", 110));
    document.dispatchEvent(pointerEvent("pointerup", 110));
    expect(onReorder).toHaveBeenCalledTimes(1);
    // Stray events after the gesture ended must not resurrect state or refire.
    document.dispatchEvent(pointerEvent("pointermove", 200));
    document.dispatchEvent(pointerEvent("pointerup", 200));
    expect(draggingId.value).toBeNull();
    expect(onReorder).toHaveBeenCalledTimes(1);
  });

  it("removes document listeners after pointercancel so a later stray move/up is a no-op", () => {
    const onReorder = vi.fn();
    const resolveId = vi.fn().mockReturnValue("b");
    const { draggingId, start } = useTabDrag({ onReorder, resolveId });
    start(fakeStartEvent(100), "a");
    document.dispatchEvent(pointerEvent("pointermove", 110));
    document.dispatchEvent(pointerEvent("pointercancel", 110));
    document.dispatchEvent(pointerEvent("pointermove", 200));
    document.dispatchEvent(pointerEvent("pointerup", 200));
    expect(draggingId.value).toBeNull();
    expect(onReorder).not.toHaveBeenCalled();
  });

  it("resets stale drag state from an abandoned gesture when start() re-fires mid-drag", () => {
    const onReorder = vi.fn();
    const resolveId = vi.fn().mockReturnValue("x");
    const { draggingId, overId, start } = useTabDrag({ onReorder, resolveId });

    // Gesture 1: crosses the threshold, so draggingId/overId become non-null.
    start(fakeStartEvent(100), "a");
    document.dispatchEvent(pointerEvent("pointermove", 110));
    expect(draggingId.value).toBe("a");
    expect(overId.value).toBe("x");

    // Gesture 2: a second pointerdown fires before gesture 1's pointerup/cancel
    // (e.g. a second touch point). Re-arming must clear the stale drag refs.
    start(fakeStartEvent(500), "c");
    expect(draggingId.value).toBeNull();
    expect(overId.value).toBeNull();

    // Sub-threshold movement for gesture 2 must not cross into dragging.
    document.dispatchEvent(pointerEvent("pointermove", 502)); // dx=2 < 4
    expect(draggingId.value).toBeNull();
    expect(overId.value).toBeNull();

    document.dispatchEvent(pointerEvent("pointerup", 502));
    expect(onReorder).not.toHaveBeenCalled();
  });

  it("falls back to document.elementFromPoint + closest('[data-tab-id]') when resolveId is omitted", () => {
    // jsdom does not implement elementFromPoint at all (property is undefined),
    // so vi.spyOn has nothing to wrap — stub it directly and remove it after.
    const tab = document.createElement("div");
    tab.setAttribute("data-tab-id", "c");
    document.body.appendChild(tab);
    const stub = vi.fn().mockReturnValue(tab);
    (document as unknown as { elementFromPoint: typeof stub }).elementFromPoint = stub;

    const onReorder = vi.fn();
    const { overId, start } = useTabDrag({ onReorder });
    start(fakeStartEvent(100), "a");
    document.dispatchEvent(pointerEvent("pointermove", 110, 20));
    expect(stub).toHaveBeenCalledWith(110, 20);
    expect(overId.value).toBe("c");
    document.dispatchEvent(pointerEvent("pointerup", 110, 20));

    delete (document as unknown as { elementFromPoint?: typeof stub }).elementFromPoint;
    document.body.removeChild(tab);
  });
});
