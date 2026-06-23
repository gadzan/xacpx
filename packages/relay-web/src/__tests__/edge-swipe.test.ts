import { describe, expect, it, vi } from "vitest";
import { createEdgeSwipe, type EdgeSwipeOptions } from "../lib/edge-swipe";

function setup(over: Partial<EdgeSwipeOptions> = {}) {
  const calls = {
    openLeft: vi.fn(),
    openRight: vi.fn(),
    closeLeft: vi.fn(),
    closeRight: vi.fn(),
  };
  const opts: EdgeSwipeOptions = {
    isEnabled: () => true,
    isLeftOpen: () => false,
    isRightOpen: () => false,
    viewportWidth: () => 400,
    ...calls,
    ...over,
  };
  return { swipe: createEdgeSwipe(opts), ...calls };
}

const start = (x: number, y: number) => ({ touches: [{ clientX: x, clientY: y }] });
const end = (x: number, y: number) => ({ changedTouches: [{ clientX: x, clientY: y }] });

describe("createEdgeSwipe", () => {
  it("opens the left drawer on a rightward swipe from the left edge", () => {
    const { swipe, openLeft } = setup();
    swipe.onTouchStart(start(8, 200));
    swipe.onTouchEnd(end(90, 210));
    expect(openLeft).toHaveBeenCalledOnce();
  });

  it("opens the right drawer on a leftward swipe from the right edge", () => {
    const { swipe, openRight } = setup(); // viewportWidth 400 → right edge ≥ 370
    swipe.onTouchStart(start(394, 200));
    swipe.onTouchEnd(end(300, 205));
    expect(openRight).toHaveBeenCalledOnce();
  });

  it("ignores a swipe that does not start near an edge", () => {
    const { swipe, openLeft, openRight } = setup();
    swipe.onTouchStart(start(200, 200));
    swipe.onTouchEnd(end(300, 205));
    expect(openLeft).not.toHaveBeenCalled();
    expect(openRight).not.toHaveBeenCalled();
  });

  it("ignores a swipe shorter than the threshold", () => {
    const { swipe, openLeft } = setup();
    swipe.onTouchStart(start(8, 200));
    swipe.onTouchEnd(end(40, 205)); // dx 32 < 45
    expect(openLeft).not.toHaveBeenCalled();
  });

  it("ignores a vertical-dominant gesture from the edge (a scroll, not a swipe)", () => {
    const { swipe, openLeft } = setup();
    swipe.onTouchStart(start(8, 100));
    swipe.onTouchEnd(end(70, 260)); // dx 62, dy 160 → vertical wins
    expect(openLeft).not.toHaveBeenCalled();
  });

  it("rejects an exact 45° (|dx| === |dy|) swipe as not horizontal-dominant", () => {
    const { swipe, openLeft } = setup();
    swipe.onTouchStart(start(8, 100));
    swipe.onTouchEnd(end(68, 160)); // dx 60, dy 60 → tie, must not open
    expect(openLeft).not.toHaveBeenCalled();
  });

  it("closes the left drawer on a leftward swipe when it is open", () => {
    const { swipe, closeLeft, openRight } = setup({ isLeftOpen: () => true });
    swipe.onTouchStart(start(220, 200)); // start anywhere — backdrop covers content
    swipe.onTouchEnd(end(120, 205));
    expect(closeLeft).toHaveBeenCalledOnce();
    expect(openRight).not.toHaveBeenCalled();
  });

  it("does not close the left drawer on a rightward (wrong-direction) swipe", () => {
    const { swipe, closeLeft } = setup({ isLeftOpen: () => true });
    swipe.onTouchStart(start(120, 200));
    swipe.onTouchEnd(end(220, 205));
    expect(closeLeft).not.toHaveBeenCalled();
  });

  it("closes the right drawer on a rightward swipe when it is open", () => {
    const { swipe, closeRight } = setup({ isRightOpen: () => true });
    swipe.onTouchStart(start(180, 200));
    swipe.onTouchEnd(end(280, 205));
    expect(closeRight).toHaveBeenCalledOnce();
  });

  it("does nothing when disabled (desktop / static columns)", () => {
    const { swipe, openLeft, openRight } = setup({ isEnabled: () => false });
    swipe.onTouchStart(start(8, 200));
    swipe.onTouchEnd(end(120, 205));
    expect(openLeft).not.toHaveBeenCalled();
    expect(openRight).not.toHaveBeenCalled();
  });

  it("does not open from just outside the edge zone", () => {
    const { swipe, openLeft } = setup({ edgeZone: 30 });
    swipe.onTouchStart(start(45, 200)); // 45 > 30
    swipe.onTouchEnd(end(140, 205));
    expect(openLeft).not.toHaveBeenCalled();
  });

  it("does not arm open-right from just inside of the right edge zone", () => {
    const { swipe, openRight } = setup({ edgeZone: 30 }); // width 400 → arm only ≥ 370
    swipe.onTouchStart(start(360, 200));
    swipe.onTouchEnd(end(260, 205));
    expect(openRight).not.toHaveBeenCalled();
  });

  it("ignores a multi-touch start (pinch / two-finger scroll)", () => {
    const { swipe, openLeft } = setup();
    swipe.onTouchStart({ touches: [{ clientX: 6, clientY: 200 }, { clientX: 80, clientY: 240 }] });
    swipe.onTouchEnd(end(110, 205));
    expect(openLeft).not.toHaveBeenCalled();
  });

  it("does not close when the swipe starts inside the drawer panel (only the backdrop closes)", () => {
    const inDrawer = { closest: (sel: string) => (sel === "[data-drawer]" ? {} : null) };
    const { swipe, closeLeft } = setup({ isLeftOpen: () => true });
    swipe.onTouchStart({ touches: [{ clientX: 120, clientY: 200 }], target: inDrawer as unknown as EventTarget });
    swipe.onTouchEnd(end(20, 205));
    expect(closeLeft).not.toHaveBeenCalled();
  });

  it("resets the armed gesture on touchcancel", () => {
    const { swipe, openLeft } = setup();
    swipe.onTouchStart(start(8, 200));
    swipe.onTouchCancel();
    swipe.onTouchEnd(end(110, 205));
    expect(openLeft).not.toHaveBeenCalled();
  });

  it("does nothing on a touchend with no point", () => {
    const { swipe, openLeft } = setup();
    swipe.onTouchStart(start(8, 200));
    expect(() => swipe.onTouchEnd({})).not.toThrow();
    expect(openLeft).not.toHaveBeenCalled();
  });
});
