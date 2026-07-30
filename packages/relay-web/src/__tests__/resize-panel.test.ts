import { describe, it, expect, vi } from "vitest";
import { clampPanelWidth, createBottomPanelResize, createPanelResize } from "../lib/resize-panel";

describe("clampPanelWidth", () => {
  it("clamps to the hard bounds and rounds", () => {
    expect(clampPanelWidth(100, 240, 560)).toBe(240);
    expect(clampPanelWidth(999, 240, 560)).toBe(560);
    expect(clampPanelWidth(300.6, 240, 560)).toBe(301);
  });

  it("caps to a fraction of the viewport when given", () => {
    // 0.5 * 800 = 400, below max 560 → 400 wins.
    expect(clampPanelWidth(560, 240, 560, 800, 0.5)).toBe(400);
  });

  it("never drops below min even when the viewport cap would", () => {
    // 0.5 * 300 = 150 < min 240 → min wins.
    expect(clampPanelWidth(500, 240, 560, 300, 0.5)).toBe(240);
  });
});

// Minimal event-target stub so the controller is testable without a DOM.
function makeTarget() {
  const listeners: Record<string, ((e: any) => void)[]> = {};
  return {
    addEventListener(type: string, fn: (e: any) => void) {
      (listeners[type] ??= []).push(fn);
    },
    removeEventListener(type: string, fn: (e: any) => void) {
      listeners[type] = (listeners[type] ?? []).filter((f) => f !== fn);
    },
    emit(type: string, e: any) {
      for (const fn of listeners[type] ?? []) fn(e);
    },
    count(type: string) {
      return (listeners[type] ?? []).length;
    },
  };
}

describe("createPanelResize (right panel)", () => {
  it("widens when dragging the left edge leftward", () => {
    let width = 296;
    const target = makeTarget();
    const c = createPanelResize({
      side: "right",
      getWidth: () => width,
      setWidth: (w) => { width = w; },
      min: 240, max: 560,
      isEnabled: () => true,
      target,
    });
    c.onPointerDown({ clientX: 500 });
    target.emit("pointermove", { clientX: 460 }); // moved 40px left → +40 width
    expect(width).toBe(336);
    target.emit("pointermove", { clientX: 520 }); // 20px right of start → -20
    expect(width).toBe(276);
  });

  it("is a no-op and attaches nothing when disabled", () => {
    let width = 296;
    const target = makeTarget();
    const c = createPanelResize({
      side: "right",
      getWidth: () => width,
      setWidth: (w) => { width = w; },
      min: 240, max: 560,
      isEnabled: () => false,
      target,
    });
    c.onPointerDown({ clientX: 500 });
    expect(target.count("pointermove")).toBe(0);
    expect(width).toBe(296);
  });

  it("fires drag callbacks and detaches listeners on release", () => {
    let width = 296;
    const target = makeTarget();
    const onDragStart = vi.fn();
    const onDragEnd = vi.fn();
    const c = createPanelResize({
      side: "right",
      getWidth: () => width,
      setWidth: (w) => { width = w; },
      min: 240, max: 560,
      isEnabled: () => true,
      onDragStart, onDragEnd, target,
    });
    c.onPointerDown({ clientX: 500 });
    expect(onDragStart).toHaveBeenCalledOnce();
    expect(target.count("pointermove")).toBe(1);
    target.emit("pointerup", {});
    expect(onDragEnd).toHaveBeenCalledOnce();
    expect(target.count("pointermove")).toBe(0);
    expect(target.count("pointerup")).toBe(0);
    // A stray move after release must not move the panel.
    target.emit("pointermove", { clientX: 100 });
    expect(width).toBe(296);
  });

  it("cleans up on pointercancel (stolen pointer) just like pointerup", () => {
    let width = 296;
    const target = makeTarget();
    const onDragEnd = vi.fn();
    const c = createPanelResize({
      side: "right",
      getWidth: () => width,
      setWidth: (w) => { width = w; },
      min: 240, max: 560,
      isEnabled: () => true,
      onDragEnd, target,
    });
    c.onPointerDown({ clientX: 500 });
    expect(target.count("pointercancel")).toBe(1);
    target.emit("pointercancel", {});
    expect(onDragEnd).toHaveBeenCalledOnce();
    expect(target.count("pointermove")).toBe(0);
    expect(target.count("pointerup")).toBe(0);
    expect(target.count("pointercancel")).toBe(0);
  });

  it("mirrors direction for a left panel (dragging right widens)", () => {
    let width = 248;
    const target = makeTarget();
    const c = createPanelResize({
      side: "left",
      getWidth: () => width,
      setWidth: (w) => { width = w; },
      min: 200, max: 480,
      isEnabled: () => true,
      target,
    });
    c.onPointerDown({ clientX: 300 });
    target.emit("pointermove", { clientX: 340 }); // 40px right → +40
    expect(width).toBe(288);
  });
});

describe("createBottomPanelResize (composer)", () => {
  it("grows when dragging the top edge upward, shrinks downward", () => {
    let height = 120;
    const target = makeTarget();
    const c = createBottomPanelResize({
      getHeight: () => height,
      setHeight: (h) => { height = h; },
      min: 60, max: 480,
      isEnabled: () => true,
      target,
    });
    c.onPointerDown({ clientY: 500 });
    target.emit("pointermove", { clientY: 460 }); // moved 40px up → +40 height
    expect(height).toBe(160);
    target.emit("pointermove", { clientY: 520 }); // 20px below start → -20
    expect(height).toBe(100);
  });

  it("clamps to bounds and to the viewport fraction", () => {
    let height = 120;
    const target = makeTarget();
    const c = createBottomPanelResize({
      getHeight: () => height,
      setHeight: (h) => { height = h; },
      min: 60, max: 480,
      maxViewportFraction: 0.5,
      viewportHeight: () => 600, // cap = 300 < max 480
      isEnabled: () => true,
      target,
    });
    c.onPointerDown({ clientY: 500 });
    target.emit("pointermove", { clientY: 0 }); // +500 raw → capped at 300
    expect(height).toBe(300);
    target.emit("pointermove", { clientY: 900 }); // -400 raw → floor at 60
    expect(height).toBe(60);
  });

  it("is a no-op and attaches nothing when disabled", () => {
    let height = 120;
    const target = makeTarget();
    const c = createBottomPanelResize({
      getHeight: () => height,
      setHeight: (h) => { height = h; },
      min: 60, max: 480,
      isEnabled: () => false,
      target,
    });
    c.onPointerDown({ clientY: 500 });
    expect(target.count("pointermove")).toBe(0);
    expect(height).toBe(120);
  });

  it("detaches listeners on release and on pointercancel", () => {
    let height = 120;
    const target = makeTarget();
    const onDragStart = vi.fn();
    const onDragEnd = vi.fn();
    const c = createBottomPanelResize({
      getHeight: () => height,
      setHeight: (h) => { height = h; },
      min: 60, max: 480,
      isEnabled: () => true,
      onDragStart, onDragEnd, target,
    });
    c.onPointerDown({ clientY: 500 });
    expect(onDragStart).toHaveBeenCalledOnce();
    target.emit("pointerup", {});
    expect(onDragEnd).toHaveBeenCalledOnce();
    expect(target.count("pointermove")).toBe(0);
    expect(target.count("pointercancel")).toBe(0);
    target.emit("pointermove", { clientY: 100 });
    expect(height).toBe(120);
    // Stolen pointer: pointercancel must clean up just like pointerup.
    c.onPointerDown({ clientY: 500 });
    target.emit("pointercancel", {});
    expect(onDragEnd).toHaveBeenCalledTimes(2);
    expect(target.count("pointermove")).toBe(0);
    expect(target.count("pointerup")).toBe(0);
  });
});
