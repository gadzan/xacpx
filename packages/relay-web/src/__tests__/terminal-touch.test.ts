// Terminal touch scroll state machine: pending (browser owns the gesture,
// long-press stays native) -> scrolling (threshold crossed, preventDefault,
// whole-line terminal scroll).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { bindTerminalTouchScroll } from "../lib/terminal-touch";

function touchPoint(x: number, y: number) {
  return { clientX: x, clientY: y };
}

/** jsdom has no TouchEvent; an Event with expando touches is enough here. */
function touchEvent(type: "touchstart" | "touchmove" | "touchend", point: { clientX: number; clientY: number }) {
  const e = new Event(type, { cancelable: true });
  Object.assign(e, { touches: [touchPoint(point.clientX, point.clientY)] });
  return e;
}

function setupHost(cellHeight = 25, hostHeight = 600) {
  const host = document.createElement("div");
  Object.defineProperty(host, "clientHeight", { value: hostHeight, configurable: true });
  document.body.appendChild(host);
  const scrollLines = vi.fn();
  const dispose = bindTerminalTouchScroll({ host, lineHeight: () => cellHeight, scrollLines });
  return { host, scrollLines, dispose };
}

describe("bindTerminalTouchScroll", () => {
  let cleanup: Array<() => void> = [];
  beforeEach(() => { document.body.replaceChildren(); cleanup = []; });
  afterEach(() => { cleanup.forEach((d) => d()); });

  it("sub-threshold moves stay native: no scroll, no preventDefault", () => {
    const { host, scrollLines } = setupHost();
    host.dispatchEvent(touchEvent("touchstart", { clientX: 100, clientY: 300 }));
    const small = touchEvent("touchmove", { clientX: 102, clientY: 304 });
    host.dispatchEvent(small);
    expect(scrollLines).not.toHaveBeenCalled();
    expect(small.defaultPrevented).toBe(false);
  });

  it("dragging past the threshold scrolls by whole lines and cancels the gesture", () => {
    const { host, scrollLines } = setupHost();
    host.dispatchEvent(touchEvent("touchstart", { clientX: 100, clientY: 300 }));
    const move = touchEvent("touchmove", { clientX: 100, clientY: 325 }); // 25px, cell = 25
    host.dispatchEvent(move);
    expect(move.defaultPrevented).toBe(true);
    expect(scrollLines).toHaveBeenCalledWith(-1);
  });

  it("accumulates the pixel remainder across moves", () => {
    const { host, scrollLines } = setupHost();
    host.dispatchEvent(touchEvent("touchstart", { clientX: 0, clientY: 0 }));
    host.dispatchEvent(touchEvent("touchmove", { clientX: 0, clientY: 8 }));  // crosses threshold
    host.dispatchEvent(touchEvent("touchmove", { clientX: 0, clientY: 20 })); // +12 residual
    expect(scrollLines).not.toHaveBeenCalled();
    host.dispatchEvent(touchEvent("touchmove", { clientX: 0, clientY: 40 })); // +20 -> 40px residual
    expect(scrollLines).toHaveBeenCalledWith(-1); // 1 full line of 25px
  });

  it("touchend after a scroll is cancelled; a new gesture starts pending", () => {
    const { host, scrollLines } = setupHost();
    host.dispatchEvent(touchEvent("touchstart", { clientX: 0, clientY: 0 }));
    host.dispatchEvent(touchEvent("touchmove", { clientX: 0, clientY: 30 }));
    expect(scrollLines).toHaveBeenCalledTimes(1);
    const end = touchEvent("touchend", { clientX: 0, clientY: 30 });
    host.dispatchEvent(end);
    expect(end.defaultPrevented).toBe(true);

    host.dispatchEvent(touchEvent("touchstart", { clientX: 0, clientY: 0 }));
    host.dispatchEvent(touchEvent("touchmove", { clientX: 0, clientY: 5 }));
    expect(scrollLines).toHaveBeenCalledTimes(1); // still pending, no scroll
  });

  it("scrolls by the renderer cell height, independent of the host height (keyboard-open)", () => {
    // A 40-row terminal at 20px cells is an 800px canvas. The open keyboard
    // shrinks the HOST to 500px without shrinking rows; host-derived math
    // (500/40 = 12.5px) would over-count lines. The lineHeight callback reads
    // the real rendered cell height, so a 40px drag is exactly 2 lines.
    const { host, scrollLines } = setupHost(20, 500);
    host.dispatchEvent(touchEvent("touchstart", { clientX: 0, clientY: 0 }));
    host.dispatchEvent(touchEvent("touchmove", { clientX: 0, clientY: 40 }));
    expect(scrollLines).toHaveBeenCalledWith(-2);
  });

  it("multi-touch resets to idle", () => {
    const { host, scrollLines } = setupHost();
    const twoFinger = new Event("touchstart", { cancelable: true });
    Object.assign(twoFinger, { touches: [touchPoint(0, 0), touchPoint(10, 10)] });
    host.dispatchEvent(twoFinger);
    host.dispatchEvent(touchEvent("touchmove", { clientX: 0, clientY: 30 }));
    expect(scrollLines).not.toHaveBeenCalled();
  });

  it("dispose removes the listeners", () => {
    const { host, scrollLines, dispose } = setupHost();
    dispose();
    host.dispatchEvent(touchEvent("touchstart", { clientX: 0, clientY: 0 }));
    host.dispatchEvent(touchEvent("touchmove", { clientX: 0, clientY: 60 }));
    expect(scrollLines).not.toHaveBeenCalled();
  });
});
