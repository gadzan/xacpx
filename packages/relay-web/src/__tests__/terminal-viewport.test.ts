// TerminalViewportController regression suite.
//
// The controller owns browser-side terminal geometry: every viewport signal
// (ResizeObserver, window resize, rebase replay, keyboard inset, layout/font
// settling) funnels through scheduleSync(), which coalesces to one sync per
// animation frame. Local fit and remote resize are deliberately separate
// steps - spectators fit locally but never push, and the remote push stays
// unconditional because the terminal store owns the "last synced" dedupe.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTerminalViewportController } from "../lib/terminal-viewport";
import type { TerminalAdapter } from "../lib/terminal-adapter";

/** Manual frame queue: frames flush only when the test pumps them. */
function manualFrames() {
  const pending: Array<() => void> = [];
  const requestFrame = (cb: () => void) => {
    pending.push(cb);
    return () => {
      const i = pending.indexOf(cb);
      if (i >= 0) pending.splice(i, 1);
    };
  };
  const flushOne = () => {
    const cb = pending.shift();
    cb?.();
  };
  const flushAll = () => {
    while (pending.length) flushOne();
  };
  return { requestFrame, flushOne, flushAll, get pending() { return pending.length; } };
}

function fakeAdapter() {
  let cols = 80;
  let rows = 24;
  const fit = vi.fn((): { cols: number; rows: number } | null => ({ cols: 150, rows: 45 }));
  const adapter: TerminalAdapter = {
    write: vi.fn(),
    resize: vi.fn((c: number, r: number) => { cols = c; rows = r; }),
    resetAndReplay: vi.fn(async () => {}),
    dispose: vi.fn(),
    focus: vi.fn(),
    getSelection: vi.fn(() => ""),
    setTheme: vi.fn(),
    scrollLines: vi.fn(),
    ready: vi.fn(async () => {}),
    fit,
    cols: () => cols,
    rows: () => rows,
  };
  return { adapter, fit };
}

function host(width = 800, height = 600) {
  const el = document.createElement("div");
  Object.defineProperty(el, "clientWidth", { value: width, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: height, configurable: true });
  return el;
}

function setup(opts?: Partial<Parameters<typeof createTerminalViewportController>[0]>) {
  const frames = manualFrames();
  const { adapter, fit } = fakeAdapter();
  const canResizeRemote = opts?.canResizeRemote ?? vi.fn(() => true);
  const sendRemoteResize = opts?.sendRemoteResize ?? vi.fn();
  const el = host();
  const controller = createTerminalViewportController({
    host: el,
    adapter,
    canResizeRemote: canResizeRemote,
    sendRemoteResize,
    requestFrame: frames.requestFrame,
  });
  return { controller, adapter, fit, el, frames, canResizeRemote, sendRemoteResize };
}

describe("terminal viewport controller", () => {
  beforeEach(() => { document.body.replaceChildren(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("coalesces multiple scheduleSync calls within one frame into a single sync", () => {
    const { controller, adapter, fit, frames } = setup();
    controller.start();
    frames.flushAll(); // start()'s immediate scheduleSync
    expect(fit).toHaveBeenCalledTimes(1);
    fit.mockClear();

    controller.scheduleSync("a");
    controller.scheduleSync("b");
    controller.scheduleSync("c");
    expect(fit).not.toHaveBeenCalled(); // nothing runs mid-frame

    frames.flushOne();
    expect(fit).toHaveBeenCalledTimes(1);
    frames.flushAll();
    expect(fit).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it("forceSync runs immediately and swallows the pending frame", () => {
    const { controller, adapter, fit, frames } = setup();
    controller.scheduleSync("pending");
    controller.forceSync("rebase");
    expect(fit).toHaveBeenCalledTimes(1); // ran synchronously

    frames.flushAll(); // the cancelled frame must not run a second sync
    expect(fit).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it("fitLocal skips redundant local reflow but the remote push stays unconditional", () => {
    // The store's syncedResize owns dedupe: the local adapter size is NOT
    // backend truth (spectator fits, pane resume, take-control handoff), so
    // the controller must forward every successful fit.
    const { controller, adapter, fit, frames, sendRemoteResize } = setup();
    fit.mockReturnValue({ cols: 80, rows: 24 }); // == adapter's current size
    controller.start();
    frames.flushAll();
    expect(adapter.resize).not.toHaveBeenCalled();
    expect(sendRemoteResize).toHaveBeenCalledWith(80, 24);
    controller.dispose();
  });

  it("spectators fit locally and never push a backend resize", () => {
    const { controller, adapter, frames, sendRemoteResize } = setup({ canResizeRemote: () => false });
    controller.start();
    frames.flushAll();
    expect(adapter.resize).toHaveBeenCalledWith(150, 45);
    expect(sendRemoteResize).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("retries on the next frame while fit() is not yet measurable, then stops", () => {
    const { controller, adapter, fit, frames } = setup();
    fit
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(null)
      .mockReturnValue({ cols: 100, rows: 30 });
    controller.start(); // immediate sync: fit null (#1) -> retry scheduled
    frames.flushOne(); // retry: still null -> schedules another
    expect(adapter.resize).not.toHaveBeenCalled();

    frames.flushOne(); // retry: measurable -> fits
    expect(adapter.resize).toHaveBeenCalledWith(100, 30);
    expect(frames.pending).toBe(0); // no endless frame loop after success
    controller.dispose();
  });

  it("gives up the frame retry while the host has no layout, and refits when it settles", () => {
    const { controller, adapter, fit, el, frames } = setup();
    fit.mockReturnValueOnce(null).mockReturnValue({ cols: 120, rows: 40 });
    Object.defineProperty(el, "clientWidth", { value: 0, configurable: true });
    controller.start();
    frames.flushAll(); // host unmeasurable -> no retry scheduled
    expect(frames.pending).toBe(0);
    expect(adapter.resize).not.toHaveBeenCalled();

    Object.defineProperty(el, "clientWidth", { value: 800, configurable: true });
    controller.scheduleSync("layout-settled");
    frames.flushAll();
    expect(adapter.resize).toHaveBeenCalledWith(120, 40);
    controller.dispose();
  });

  describe("settling", () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it("re-fits as font/WASM metrics settle after start (16/64/250/1000ms)", async () => {
      const { adapter, fit } = fakeAdapter();
      const el = host();
      const sendRemoteResize = vi.fn();
      const controller = createTerminalViewportController({
        host: el,
        adapter,
        canResizeRemote: () => true,
        sendRemoteResize,
        requestFrame: (cb) => {
          const t = setTimeout(() => cb(), 0);
          return () => clearTimeout(t);
        },
      });
      // First measurable size is the default font; the webfont loads later and
      // the same host pixels now fit a different grid. (The fake adapter
      // already starts at 80x24, so the first fit is a no-op local reflow -
      // observe the remote push instead.)
      fit.mockReturnValueOnce({ cols: 80, rows: 24 }).mockReturnValue({ cols: 150, rows: 45 });
      controller.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(adapter.resize).not.toHaveBeenCalled();
      expect(sendRemoteResize).toHaveBeenCalledWith(80, 24);

      await vi.advanceTimersByTimeAsync(1100); // all settling timers fire
      expect(adapter.resize).toHaveBeenLastCalledWith(150, 45);
      expect(sendRemoteResize).toHaveBeenLastCalledWith(150, 45);
      controller.dispose();
    });

    it("dispose stops the settling timers; double dispose is safe", async () => {
      const { adapter, fit } = fakeAdapter();
      const sendRemoteResize = vi.fn();
      const controller = createTerminalViewportController({
        host: host(),
        adapter,
        canResizeRemote: () => true,
        sendRemoteResize,
        requestFrame: (cb) => {
          const t = setTimeout(() => cb(), 0);
          return () => clearTimeout(t);
        },
      });
      controller.start();
      await vi.advanceTimersByTimeAsync(0);
      controller.dispose();
      controller.dispose();

      fit.mockClear();
      await vi.advanceTimersByTimeAsync(2000);
      expect(fit).not.toHaveBeenCalled();
    });
  });

  it("keyboard inset feeds the keyboard-independent height into fit()", () => {
    // Soft keyboard occlusion is local: rows must be derived from the full
    // (pre-keyboard) height so the remote grid never churns as it opens.
    const frames = manualFrames();
    const { adapter, fit } = fakeAdapter();
    const sendRemoteResize = vi.fn();
    const controller = createTerminalViewportController({
      host: host(),
      adapter,
      canResizeRemote: () => true,
      sendRemoteResize,
      requestFrame: frames.requestFrame,
    });
    // Simulate the adapter's inset-aware fit: 600px host, 20px cells, inset added back.
    fit.mockImplementation((extraHeightPx = 0) => ({
      cols: 150,
      rows: Math.floor((600 + extraHeightPx) / 20),
    }));
    controller.start();
    frames.flushAll();
    expect(fit).toHaveBeenLastCalledWith(0);
    expect(adapter.resize).toHaveBeenCalledWith(150, 30);

    controller.setKeyboardInset(300);
    frames.flushAll();
    expect(fit).toHaveBeenLastCalledWith(300);
    expect(adapter.resize).toHaveBeenLastCalledWith(150, 45);
    controller.dispose();
  });

  it("start() syncs immediately and re-syncs on window resize", () => {
    const { controller, adapter, fit, frames } = setup();
    controller.start();
    expect(fit).toHaveBeenCalledTimes(1); // immediate, no frame wait
    fit.mockClear();

    window.dispatchEvent(new Event("resize"));
    expect(frames.pending).toBeGreaterThan(0);
    frames.flushAll();
    expect(fit).toHaveBeenCalledTimes(1);
    controller.dispose();

    window.dispatchEvent(new Event("resize"));
    frames.flushAll();
    expect(fit).toHaveBeenCalledTimes(1); // disposed: listener removed
  });

  it("start() observes the host with ResizeObserver and re-syncs on its callback", () => {
    const instances: Array<{ cb: () => void }> = [];
    const RealRO = globalThis.ResizeObserver;
    class CapturingRO {
      constructor(cb: () => void) { instances.push({ cb }); }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    globalThis.ResizeObserver = CapturingRO as unknown as typeof ResizeObserver;
    try {
      const frames = manualFrames();
      const { adapter, fit } = fakeAdapter();
      const controller = createTerminalViewportController({
        host: host(),
        adapter,
        canResizeRemote: () => true,
        sendRemoteResize: vi.fn(),
        requestFrame: frames.requestFrame,
      });
      controller.start();
      frames.flushAll();
      expect(instances.length).toBe(1);
      fit.mockClear();

      instances[0].cb();
      frames.flushAll();
      expect(fit).toHaveBeenCalledTimes(1);
      controller.dispose();
    } finally {
      globalThis.ResizeObserver = RealRO;
    }
  });
});
