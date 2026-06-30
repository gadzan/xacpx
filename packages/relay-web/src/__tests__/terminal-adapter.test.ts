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
});
