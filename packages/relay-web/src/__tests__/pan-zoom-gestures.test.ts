import { afterEach, expect, test } from "vitest";
import { createPanZoom } from "../lib/pan-zoom";
import { attachPanZoomGestures } from "../lib/pan-zoom-gestures";

let detach: (() => void) | null = null;
afterEach(() => { detach?.(); detach = null; document.body.innerHTML = ""; });

// jsdom lacks real WheelEvent/PointerEvent/TouchEvent ergonomics; dispatch a bare Event with the
// properties the handlers read assigned onto it.
function fire(el: EventTarget, type: string, props: Record<string, unknown>): void {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(e, props);
  el.dispatchEvent(e);
}
function el(): HTMLElement {
  const d = document.createElement("div");
  document.body.appendChild(d);
  return d;
}

test("wheelRequiresModifier: plain wheel is a no-op, Ctrl+wheel zooms", () => {
  const target = el();
  const pz = createPanZoom();
  detach = attachPanZoomGestures(target, pz, () => {}, { wheelRequiresModifier: true });
  fire(target, "wheel", { deltaY: -100, clientX: 0, clientY: 0 });
  expect(pz.state.scale).toBe(1); // plain wheel ignored → page scrolls
  fire(target, "wheel", { deltaY: -100, ctrlKey: true, clientX: 0, clientY: 0 });
  expect(pz.state.scale).toBeCloseTo(1.1);
});

test("without wheelRequiresModifier a plain wheel zooms", () => {
  const target = el();
  const pz = createPanZoom();
  detach = attachPanZoomGestures(target, pz, () => {});
  fire(target, "wheel", { deltaY: 100, clientX: 0, clientY: 0 });
  expect(pz.state.scale).toBeCloseTo(1 / 1.1);
});

test("mouse pointer drag pans", () => {
  const target = el();
  const pz = createPanZoom();
  detach = attachPanZoomGestures(target, pz, () => {});
  fire(target, "pointerdown", { pointerType: "mouse", pointerId: 1, clientX: 0, clientY: 0 });
  fire(target, "pointermove", { pointerType: "mouse", pointerId: 1, clientX: 25, clientY: 40 });
  fire(target, "pointerup", { pointerType: "mouse", pointerId: 1 });
  expect(pz.state.x).toBe(25);
  expect(pz.state.y).toBe(40);
});

test("two-finger touch pinch zooms", () => {
  const target = el();
  const pz = createPanZoom();
  detach = attachPanZoomGestures(target, pz, () => {});
  fire(target, "touchstart", { touches: [{ clientX: 0, clientY: 0 }, { clientX: 10, clientY: 0 }] });
  fire(target, "touchmove", { touches: [{ clientX: 0, clientY: 0 }, { clientX: 20, clientY: 0 }] });
  expect(pz.state.scale).toBeCloseTo(2); // distance 10 → 20
});

test("without oneFingerTouchPan a single-finger drag is ignored (page keeps scrolling)", () => {
  const target = el();
  const pz = createPanZoom();
  detach = attachPanZoomGestures(target, pz, () => {}); // default: oneFingerTouchPan false
  fire(target, "touchstart", { touches: [{ clientX: 0, clientY: 0 }] });
  fire(target, "touchmove", { touches: [{ clientX: 30, clientY: 40 }] });
  expect(pz.state).toEqual({ scale: 1, x: 0, y: 0 }); // not panned — the anti-hijack default
});

test("with oneFingerTouchPan a single-finger drag pans", () => {
  const target = el();
  const pz = createPanZoom();
  detach = attachPanZoomGestures(target, pz, () => {}, { oneFingerTouchPan: true });
  fire(target, "touchstart", { touches: [{ clientX: 0, clientY: 0 }] });
  fire(target, "touchmove", { touches: [{ clientX: 30, clientY: 40 }] });
  expect(pz.state.x).toBe(30);
  expect(pz.state.y).toBe(40);
});

test("detach stops all gestures", () => {
  const target = el();
  const pz = createPanZoom();
  const d = attachPanZoomGestures(target, pz, () => {});
  d();
  fire(target, "wheel", { deltaY: -100, clientX: 0, clientY: 0 });
  expect(pz.state.scale).toBe(1);
});
