import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useLongPress } from "../lib/use-long-press";

function ev(type: string, clientX: number, clientY = 0): PointerEvent {
  try {
    return new PointerEvent(type, { clientX, clientY, bubbles: true });
  } catch {
    return new MouseEvent(type, { clientX, clientY, bubbles: true }) as unknown as PointerEvent;
  }
}
function touchStart(clientX: number, clientY = 0): PointerEvent {
  return { clientX, clientY, pointerType: "touch" } as PointerEvent;
}
function mouseStart(clientX: number, clientY = 0): PointerEvent {
  return { clientX, clientY, pointerType: "mouse" } as PointerEvent;
}

describe("useLongPress", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    document.dispatchEvent(ev("pointercancel", 0, 0));
    vi.useRealTimers();
  });

  it("fires after the hold on touch, with the press coordinates", () => {
    const cb = vi.fn();
    const { start } = useLongPress(cb);
    start(touchStart(30, 40));
    expect(cb).not.toHaveBeenCalled(); // still within the hold
    vi.advanceTimersByTime(450);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(30, 40);
  });

  it("ignores mouse/pen — those use the native right-click contextmenu", () => {
    const cb = vi.fn();
    const { start } = useLongPress(cb);
    start(mouseStart(30, 40));
    vi.advanceTimersByTime(1000);
    expect(cb).not.toHaveBeenCalled();
  });

  it("cancels when the finger moves past the slop before the hold (it's a scroll)", () => {
    const cb = vi.fn();
    const { start } = useLongPress(cb);
    start(touchStart(30, 40));
    document.dispatchEvent(ev("pointermove", 50, 40)); // dx=20 > 10px slop
    vi.advanceTimersByTime(450);
    expect(cb).not.toHaveBeenCalled();
  });

  it("cancels when the finger lifts before the hold", () => {
    const cb = vi.fn();
    const { start } = useLongPress(cb);
    start(touchStart(30, 40));
    document.dispatchEvent(ev("pointerup", 30, 40));
    vi.advanceTimersByTime(450);
    expect(cb).not.toHaveBeenCalled();
  });

  it("swallows exactly the one trailing click (armed at lift, so hold duration doesn't matter)", () => {
    const cb = vi.fn();
    const { start } = useLongPress(cb);
    start(touchStart(30, 40));
    vi.advanceTimersByTime(450); // fired
    // No swallow is armed until the finger lifts — so even an arbitrarily long hold works.
    const early = new MouseEvent("click", { cancelable: true, bubbles: true });
    document.dispatchEvent(early);
    expect(early.defaultPrevented).toBe(false); // nothing armed yet

    document.dispatchEvent(ev("pointerup", 30, 40)); // lift arms the one-shot swallow
    const lift = new MouseEvent("click", { cancelable: true, bubbles: true });
    document.dispatchEvent(lift);
    expect(lift.defaultPrevented).toBe(true);

    // Only that one is swallowed; a later unrelated click passes through.
    const later = new MouseEvent("click", { cancelable: true, bubbles: true });
    document.dispatchEvent(later);
    expect(later.defaultPrevented).toBe(false);
  });
});
