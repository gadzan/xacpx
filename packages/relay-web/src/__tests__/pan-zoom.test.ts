import { expect, test } from "vitest";
import { createPanZoom } from "../lib/pan-zoom";

test("starts at identity and formats a transform-origin:0,0 transform", () => {
  const pz = createPanZoom();
  expect(pz.state).toEqual({ scale: 1, x: 0, y: 0 });
  expect(pz.toTransform()).toBe("translate(0px, 0px) scale(1)");
});

test("zoomAt keeps the point under the cursor stationary", () => {
  const pz = createPanZoom();
  pz.zoomAt(2, 100, 0); // zoom 2x centered on viewport x=100
  // content point that was under x=100 must still be under x=100: x = 100 - (100-0)*(2/1) = -100
  expect(pz.state.scale).toBe(2);
  expect(pz.state.x).toBe(-100);
  expect(pz.state.y).toBe(0);
});

test("zoomAt clamps scale to [minScale, maxScale]", () => {
  const pz = createPanZoom({ minScale: 0.5, maxScale: 4 });
  pz.zoomAt(100, 0, 0);
  expect(pz.state.scale).toBe(4);
  pz.zoomAt(0.0001, 0, 0);
  expect(pz.state.scale).toBe(0.5);
});

test("panBy accumulates and reset returns to identity", () => {
  const pz = createPanZoom();
  pz.panBy(10, 20);
  pz.panBy(5, -5);
  expect(pz.state).toEqual({ scale: 1, x: 15, y: 15 });
  pz.zoomAt(2, 50, 50);
  pz.reset();
  expect(pz.state).toEqual({ scale: 1, x: 0, y: 0 });
  expect(pz.toTransform()).toBe("translate(0px, 0px) scale(1)");
});
