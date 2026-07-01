import { describe, it, expect, vi } from "vitest";
import { createTerminalAdapter } from "../lib/terminal-adapter";

function fakeTerminal() {
  const onData = vi.fn();
  return {
    open: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    dispose: vi.fn(),
    onData: (cb: (d: string) => void) => {
      onData(cb);
    },
    cols: 80,
    rows: 24,
    _onData: onData,
  };
}

describe("terminal-adapter", () => {
  it("opens the ghostty terminal on the element and wires onData", async () => {
    const term = fakeTerminal();
    const onData = vi.fn();
    const el = document.createElement("div");
    createTerminalAdapter(el, { cols: 100, rows: 30, onData, factory: () => term as never });
    // ready is an already-resolved promise; .then runs on the next microtask
    await Promise.resolve();
    expect(term.open).toHaveBeenCalledWith(el);
    expect(term._onData).toHaveBeenCalled();
  });

  it("write/resize/dispose proxy to the underlying terminal", async () => {
    const term = fakeTerminal();
    const a = createTerminalAdapter(document.createElement("div"), {
      cols: 80,
      rows: 24,
      onData: () => {},
      factory: () => term as never,
    });
    // wait for microtask so live is set before calling methods
    await Promise.resolve();
    a.write("hi");
    a.resize(120, 40);
    a.dispose();
    expect(term.write).toHaveBeenCalledWith("hi");
    expect(term.resize).toHaveBeenCalledWith(120, 40);
    expect(term.dispose).toHaveBeenCalled();
  });

  it("fit() computes cols/rows from the rendered canvas metrics", async () => {
    const canvas = document.createElement("canvas");
    // 80 cols * 10px = 800 wide; 24 rows * 20px = 480 tall → cellW=10, cellH=20
    canvas.getBoundingClientRect = () => ({ width: 800, height: 480 }) as DOMRect;
    const element = document.createElement("div");
    element.appendChild(canvas);
    const term = { ...fakeTerminal(), element, cols: 80, rows: 24 };
    const el = document.createElement("div");
    Object.defineProperty(el, "clientWidth", { value: 400, configurable: true });  // 400/10 = 40
    Object.defineProperty(el, "clientHeight", { value: 240, configurable: true }); // 240/20 = 12
    const a = createTerminalAdapter(el, { cols: 80, rows: 24, onData: () => {}, factory: () => term as never });
    await Promise.resolve();
    expect(a.fit()).toEqual({ cols: 40, rows: 12 });
  });

  it("fit() returns null before the canvas has a measurable size", async () => {
    const canvas = document.createElement("canvas");
    canvas.getBoundingClientRect = () => ({ width: 0, height: 0 }) as DOMRect;
    const element = document.createElement("div");
    element.appendChild(canvas);
    const term = { ...fakeTerminal(), element, cols: 80, rows: 24 };
    const a = createTerminalAdapter(document.createElement("div"), {
      cols: 80, rows: 24, onData: () => {}, factory: () => term as never,
    });
    await Promise.resolve();
    expect(a.fit()).toBeNull();
  });

  it("focus() proxies to the underlying terminal", async () => {
    const focus = vi.fn();
    const term = { ...fakeTerminal(), focus };
    const a = createTerminalAdapter(document.createElement("div"), {
      cols: 80, rows: 24, onData: () => {}, factory: () => term as never,
    });
    await Promise.resolve();
    a.focus();
    expect(focus).toHaveBeenCalled();
  });
});
