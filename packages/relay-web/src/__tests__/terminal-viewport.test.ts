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
  const fit = vi.fn((_extraHeightPx = 0): { cols: number; rows: number } | null => ({ cols: 150, rows: 45 }));
  const localGeometry = vi.fn((): { cellHeight: number; canvasHeight: number; cursorY: number } | null => null);
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
    localGeometry,
    syncInputAnchor: vi.fn(),
    cols: () => cols,
    rows: () => rows,
  };
  return { adapter, fit, localGeometry };
}

function host(width = 800, height = 600) {
  const el = document.createElement("div");
  Object.defineProperty(el, "clientWidth", { value: width, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: height, configurable: true });
  return el;
}

function setup(opts?: Partial<Parameters<typeof createTerminalViewportController>[0]>) {
  const frames = manualFrames();
  const { adapter, fit, localGeometry } = fakeAdapter();
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
  return { controller, adapter, fit, localGeometry, el, frames, canResizeRemote, sendRemoteResize };
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

  describe("keyboard-open local cursor-follow", () => {
    it("scrolls the host so the cursor row stays visible without resizing the grid", async () => {
      // 40 rows × 20px = 800px canvas; keyboard shrinks the host to 500px.
      const frames = manualFrames();
      const { adapter, fit, localGeometry } = fakeAdapter();
      const el = host(800, 500);
      const controller = createTerminalViewportController({
        host: el,
        adapter,
        canResizeRemote: () => true,
        sendRemoteResize: vi.fn(),
        requestFrame: frames.requestFrame,
      });
      fit.mockReturnValue({ cols: 150, rows: 40 });
      localGeometry.mockReturnValue({ cellHeight: 20, canvasHeight: 800, cursorY: 39 });
      controller.start();
      frames.flushAll();

      controller.setKeyboardInset(300);
      frames.flushAll();

      // Cursor row 39 bottom = 40*20 = 800px; visible is 500px -> scroll 300px.
      expect(el.style.alignItems).toBe("flex-start");
      expect(el.scrollTop).toBe(300);
      // The scroll moved the canvas under a stationary IME anchor: re-anchor.
      expect(adapter.syncInputAnchor).toHaveBeenCalled();
      // Remote grid stayed at the fit rows — never shrunk for the keyboard.
      expect(adapter.resize).toHaveBeenLastCalledWith(150, 40);
    });

    it("clears the local follow when the keyboard closes", async () => {
      const frames = manualFrames();
      const { adapter, fit, localGeometry } = fakeAdapter();
      const el = host(800, 500);
      const controller = createTerminalViewportController({
        host: el,
        adapter,
        canResizeRemote: () => true,
        sendRemoteResize: vi.fn(),
        requestFrame: frames.requestFrame,
      });
      fit.mockReturnValue({ cols: 150, rows: 40 });
      localGeometry.mockReturnValue({ cellHeight: 20, canvasHeight: 800, cursorY: 39 });
      controller.start();
      frames.flushAll();
      controller.setKeyboardInset(300);
      frames.flushAll();
      expect(el.scrollTop).toBe(300);

      controller.setKeyboardInset(0);
      frames.flushAll();
      expect(el.style.alignItems).toBe("");
      expect(el.scrollTop).toBe(0);
    });

    it("revealCursor re-scrolls on live output without a fit or remote push", async () => {
      const frames = manualFrames();
      const { adapter, fit, localGeometry } = fakeAdapter();
      const sendRemoteResize = vi.fn();
      const el = host(800, 500);
      const controller = createTerminalViewportController({
        host: el,
        adapter,
        canResizeRemote: () => true,
        sendRemoteResize,
        requestFrame: frames.requestFrame,
      });
      fit.mockReturnValue({ cols: 150, rows: 40 });
      controller.start();
      frames.flushAll();
      controller.setKeyboardInset(300);
      localGeometry.mockReturnValue({ cellHeight: 20, canvasHeight: 800, cursorY: 30 });
      frames.flushAll();
      expect(el.scrollTop).toBe(120); // (30+1)*20 - 500

      // Cursor moves down on output; revealCursor must follow without re-fitting.
      const fitCalls = fit.mock.calls.length;
      const resizeCalls = sendRemoteResize.mock.calls.length;
      localGeometry.mockReturnValue({ cellHeight: 20, canvasHeight: 800, cursorY: 39 });
      controller.revealCursor();
      expect(el.scrollTop).toBe(300);
      expect(fit.mock.calls.length).toBe(fitCalls);
      expect(sendRemoteResize.mock.calls.length).toBe(resizeCalls);
    });
  });

  it("honors a keyboard inset set before start() on the very first fit (re-attach while keyboard open)", () => {
    // Re-attach with the keyboard already up: the keyboardInset is remembered,
    // so setKeyboardInset() runs BEFORE start(). The first forceSync must then
    // fit the full (pre-keyboard) grid, never the shrunken host — otherwise the
    // remote grid would temporarily collapse 40→25 rows and reflow back to 40.
    const frames = manualFrames();
    const { adapter, fit, localGeometry } = fakeAdapter();
    const sendRemoteResize = vi.fn();
    const el = host(800, 500); // keyboard-shrunk visible host
    const controller = createTerminalViewportController({
      host: el,
      adapter,
      canResizeRemote: () => true,
      sendRemoteResize,
      requestFrame: frames.requestFrame,
    });
    fit.mockImplementation((extraHeightPx = 0) => ({
      cols: 150,
      rows: Math.floor((500 + extraHeightPx) / 20),
    }));
    localGeometry.mockReturnValue({ cellHeight: 20, canvasHeight: 800, cursorY: 39 });

    controller.setKeyboardInset(300);
    controller.start();
    frames.flushAll();

    // The first fit already carried the inset; no fit(0) ever happened.
    expect(fit.mock.calls[0][0]).toBe(300);
    const rowsSeen = fit.mock.calls.map((c) => Math.floor((500 + (c[0] ?? 0)) / 20));
    expect(rowsSeen).not.toContain(25);
    expect(sendRemoteResize).toHaveBeenCalledWith(150, 40);
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
