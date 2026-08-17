// Terminal viewport controller - owns browser-side terminal geometry.
//
// Every viewport signal (host ResizeObserver, window resize, rebase replay,
// keyboard inset changes, initial font/WASM settling) funnels through
// scheduleSync(), which coalesces to a single sync per animation frame - a
// burst of resize events never produces a burst of fits. A sync is two
// deliberately separate steps:
//
//   fitLocal()  - reflow the local emulator to whatever fits the host
//   syncRemote() - forward the geometry to the backend (controller role only)
//
// The remote push is unconditional on every successful fit: the local adapter
// size is NOT backend truth (spectator fits, pane resume, take-control
// handoff), so the terminal store's syncedResize owns the dedupe. Spectators
// never push - their local fit must not change backend geometry.
//
// Layout settlement: the terminal renderer initializes across several frames
// (WASM, webfont, canvas mount, CSS layout), and a font swap changes cell
// metrics without changing host pixels - ResizeObserver stays silent. start()
// therefore re-syncs on a short settling ladder (immediate + 16/64/250/1000ms)
// so the grid always converges to the final metrics.

import type { TerminalAdapter } from "./terminal-adapter";

/** Syncs re-issued after start() to absorb renderer/font/CSS settling. */
const SETTLING_SYNC_DELAYS_MS = [16, 64, 250, 1000];

export interface TerminalViewportControllerOptions {
  host: HTMLElement;
  adapter: TerminalAdapter;
  /** Controller-role gate; spectators fit locally but never push a resize. */
  canResizeRemote(): boolean;
  /** Backend resize forwarder (terminal store owns the syncedResize dedupe). */
  sendRemoteResize(cols: number, rows: number): void;
  /** Test seam: frame scheduler. Defaults to requestAnimationFrame. */
  requestFrame?(cb: () => void): () => void;
}

export interface TerminalViewportController {
  start(): void;
  /** Idempotent; stops the frame, settling timers, and observers. */
  dispose(): void;
  /** Coalesced sync: runs at most one sync per animation frame. */
  scheduleSync(reason?: string): void;
  /** Immediate sync: runs now and replaces any pending frame. */
  forceSync(reason?: string): void;
  /** Re-run local cursor-follow only (no fit / no remote push) — the cursor row
   *  can move on live output without any geometry change, so a write must keep
   *  the prompt visible while the keyboard is open. */
  revealCursor(): void;
  setKeyboardInset(px: number): void;
}

export function createTerminalViewportController(
  opts: TerminalViewportControllerOptions,
): TerminalViewportController {
  const { host, adapter, canResizeRemote, sendRemoteResize } = opts;
  const requestFrame = opts.requestFrame
    ?? ((cb: () => void) => {
      const id = requestAnimationFrame(() => cb());
      return () => cancelAnimationFrame(id);
    });

  let started = false;
  let disposed = false;
  let keyboardInset = 0;
  let cancelFrame: (() => void) | null = null;
  let resizeObserver: ResizeObserver | null = null;
  const settlingTimers: ReturnType<typeof setTimeout>[] = [];
  const onWindowResize = () => scheduleSync("window-resize");

  function scheduleSync(reason?: string): void {
    if (disposed || cancelFrame) return;
    cancelFrame = requestFrame(() => {
      cancelFrame = null;
      runSync(reason);
    });
  }

  function forceSync(reason?: string): void {
    if (disposed) return;
    cancelFrame?.();
    cancelFrame = null;
    runSync(reason);
  }

  function runSync(reason?: string): void {
    if (disposed) return;
    const dim = fitLocal();
    if (dim) {
      applyLocalCursorFollow();
      syncRemote(dim);
    }
  }

  /** Reflow the local emulator to the host; returns the applied geometry.
   *  Null while the renderer is not yet measurable. */
  function fitLocal(): { cols: number; rows: number } | null {
    // The keyboard inset is added back: the remote grid must be sized for the
    // full (pre-keyboard) host height so opening/closing the soft keyboard
    // never churns the backend pane layout - it only occludes locally.
    const dim = adapter.fit(keyboardInset);
    if (!dim) {
      // Renderer not measurable yet (WASM/font/canvas). Retry next frame while
      // the host has layout; once measurable the retries stop on their own.
      if (host.clientWidth > 0) scheduleSync("fit-retry");
      return null;
    }
    if (dim.cols !== adapter.cols() || dim.rows !== adapter.rows()) {
      adapter.resize(dim.cols, dim.rows);
    }
    return dim;
  }

  /** Forward the fit geometry to the backend. The adapter's own cols/rows are
   *  NOT used here: adapter.resize() is queued, so its reported size can still
   *  be stale in this task - the fit result is the truth being pushed. Dedupe
   *  stays the store's job (syncedResize). */
  function syncRemote(dim: { cols: number; rows: number }): void {
    if (!canResizeRemote()) return;
    sendRemoteResize(dim.cols, dim.rows);
  }

  /** Keep the cursor row visible while the soft keyboard occludes the host. The
   *  grid is keyboard-independent — rows stay put, so the canvas is taller than
   *  the shrunken host and flex-center would clip BOTH edges (the prompt at the
   *  bottom out of view). Top-align the canvas and scroll it so the cursor row
   *  sits at the visible bottom. Never shrinks the Ghostty grid. */
  function applyLocalCursorFollow(): void {
    if (keyboardInset <= 0) {
      clearLocalFollow();
      return;
    }
    const vis = host.clientHeight;
    const geo = adapter.localGeometry();
    if (!geo || geo.canvasHeight <= vis) {
      clearLocalFollow();
      return;
    }
    host.style.alignItems = "flex-start";
    const cursorBottom = Math.min(geo.canvasHeight, (geo.cursorY + 1) * geo.cellHeight);
    host.scrollTop = Math.max(0, cursorBottom - vis);
    // The scroll moved the canvas under a stationary IME anchor; re-measure it.
    adapter.syncInputAnchor();
  }

  /** Restore the neutral (flex-centered) layout when the keyboard is closed. */
  function clearLocalFollow(): void {
    const changed = host.style.alignItems !== "" || host.scrollTop !== 0;
    if (host.style.alignItems) host.style.alignItems = "";
    if (host.scrollTop !== 0) host.scrollTop = 0;
    if (changed) adapter.syncInputAnchor();
  }

  return {
    start(): void {
      if (started || disposed) return;
      started = true;
      if (typeof ResizeObserver !== "undefined") {
        resizeObserver = new ResizeObserver(() => scheduleSync("host-resize"));
        resizeObserver.observe(host);
      }
      window.addEventListener("resize", onWindowResize, { passive: true });
      // Immediate sync (not scheduled): the first fit must land in the same
      // task as the attachment becoming ready, before any frame wait.
      forceSync("start");
      for (const delay of SETTLING_SYNC_DELAYS_MS) {
        settlingTimers.push(setTimeout(() => scheduleSync(`settle-${delay}`), delay));
      }
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      cancelFrame?.();
      cancelFrame = null;
      for (const t of settlingTimers.splice(0)) clearTimeout(t);
      resizeObserver?.disconnect();
      resizeObserver = null;
      window.removeEventListener("resize", onWindowResize);
    },
    scheduleSync,
    forceSync,
    revealCursor(): void {
      if (disposed) return;
      applyLocalCursorFollow();
    },
    setKeyboardInset(px: number): void {
      const next = Math.max(0, Math.round(px));
      if (next === keyboardInset) return;
      keyboardInset = next;
      scheduleSync("keyboard-inset");
    },
  };
}
