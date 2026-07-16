import { expect, test } from "vitest";
import { computeFit, createPanZoom } from "../lib/pan-zoom";

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

test("panBy accumulates and reset returns to identity (default home)", () => {
  const pz = createPanZoom();
  pz.panBy(10, 20);
  pz.panBy(5, -5);
  expect(pz.state).toEqual({ scale: 1, x: 15, y: 15 });
  pz.zoomAt(2, 50, 50);
  pz.reset();
  expect(pz.state).toEqual({ scale: 1, x: 0, y: 0 });
  expect(pz.toTransform()).toBe("translate(0px, 0px) scale(1)");
});

test("setHome makes reset return to the fitted view, not 1×", () => {
  const pz = createPanZoom();
  pz.setHome(0.5, 40, 0); // seed a fit-to-container home
  expect(pz.state).toEqual({ scale: 0.5, x: 40, y: 0 }); // snaps to home immediately
  expect(pz.atHome()).toBe(true);
  pz.zoomAt(2, 100, 100);
  expect(pz.atHome()).toBe(false); // user zoomed away from home
  pz.reset();
  expect(pz.state).toEqual({ scale: 0.5, x: 40, y: 0 }); // back to the fit, not identity
  expect(pz.atHome()).toBe(true);
});

test("setHome below the default min-scale floor makes that fit the zoom-out limit", () => {
  const pz = createPanZoom(); // default minScale 0.2
  pz.setHome(0.1, 0, 0); // a big diagram fitted below the floor
  pz.zoomAt(0.5, 0, 0); // try to zoom further out
  expect(pz.state.scale).toBe(0.1); // clamped at the fit, not the old 0.2 floor
  pz.zoomAt(2, 0, 0); // zoom in still works
  expect(pz.state.scale).toBeCloseTo(0.2);
});

test("computeFit scales down to fit, never up, and centers", () => {
  // Width-bound, align top → y pinned to 0, x centered.
  expect(computeFit(100, 1000, 200, 100, { align: "top" })).toEqual({ scale: 0.5, x: 0, y: 0 });
  // Height-bound, centered on both axes.
  expect(computeFit(1000, 100, 200, 400)).toEqual({ scale: 0.25, x: 475, y: 0 });
  // Smaller than the container → never upscales past 1×.
  expect(computeFit(1000, 1000, 100, 100)).toEqual({ scale: 1, x: 450, y: 450 });
  // Any non-positive dimension → null (unmeasured element).
  expect(computeFit(0, 100, 100, 100)).toBeNull();
  expect(computeFit(100, 100, 100, 0)).toBeNull();
});
