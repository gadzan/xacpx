// Thin wrapper over ghostty-web (xterm.js-compatible API). Isolating it here means a
// future swap back to @xterm/xterm only touches this file. Adds fit() (derive cols/rows
// from ghostty's own rendered canvas metrics — most accurate) and lazy webfont loading.

import { ensureTerminalFont, TERMINAL_FONT_FAMILY } from "./terminal-font";

/** Subset of ghostty's ITheme we set — foreground/background keep the terminal in sync
 *  with the app's design tokens so the sub-cell fit remainder blends seamlessly. */
export interface TerminalTheme {
  foreground?: string;
  background?: string;
  cursor?: string;
}

/** Cursor position on the active screen, via ghostty's xterm-compatible buffer API. */
export interface GhosttyBufferCursor {
  /** Cursor column (0-indexed, in cells). */
  readonly cursorX: number;
  /** Cursor row (0-indexed, relative to the viewport). */
  readonly cursorY: number;
}

export interface GhosttyTerminalLike {
  open(el: HTMLElement): void;
  write(data: string | Uint8Array): void;
  resize(cols: number, rows: number): void;
  /** Full VT reset (RIS-equivalent): clears grid + scrollback and exits alt-screen. Required
   *  before replaying a rebase keyframe — a keyframe must never be appended to a stale screen. */
  reset(): void;
  dispose(): void;
  onData(cb: (data: string) => void): void;
  focus?(): void;
  paste?(data: string): void;
  getSelection?(): string;
  setTheme?(theme: TerminalTheme): void;
  /** Scroll the viewport by N lines (positive = toward the newest/bottom rows). */
  scrollLines?(amount: number): void;
  /** Active-screen cursor access. Optional so minimal test fakes can omit it - the IME
   *  anchor then falls back to the canvas origin. */
  buffer?: { readonly active: GhosttyBufferCursor };
  /** ghostty's Terminal has no public setTheme yet; its renderer does. */
  renderer?: { setTheme?(theme: TerminalTheme): void };
  element?: HTMLElement;
  cols: number;
  rows: number;
}

/** Local rendered-canvas geometry used for keyboard-open cursor-follow. Distinct from
 *  the remote grid: the soft keyboard shrinks the HOST without shrinking rows, so a
 *  taller canvas must be scrolled to keep the cursor row visible locally. */
export interface TerminalLocalGeometry {
  /** Rendered canvas cell height in px. */
  cellHeight: number;
  /** Rendered canvas total height in px (= rows × cellHeight). */
  canvasHeight: number;
  /** Active-screen cursor row (0-indexed, absolute viewport). */
  cursorY: number;
}

export interface TerminalAdapter {
  /** Resolves once the underlying terminal is open and wired. Rejects if construction fails
   *  or the adapter is disposed before that happens — never hangs forever either way. */
  ready(): Promise<void>;
  /** Accepts raw bytes (preferred — no UTF-8 round trip) or a string (legacy callers). Queued
   *  until ready, and ordered relative to any in-flight resetAndReplay(). */
  write(data: string | Uint8Array): Promise<void> | void;
  /** Queued the same way as write() — never silently dropped before ready. */
  resize(cols: number, rows: number): void;
  /** Rebase entry point: reset (clear grid/scrollback, exit alt-screen) → resize → write the
   *  keyframe, as one atomic, ready-awaited, serialized step. Any write() issued concurrently
   *  is queued behind it and flushed strictly afterward — never interleaved with the keyframe. */
  resetAndReplay(data: Uint8Array, cols: number, rows: number): Promise<void>;
  dispose(): void;
  focus(): void;
  /** The current text selection (empty string when nothing is selected). */
  getSelection(): string;
  /** Recolor the live terminal (e.g. on light/dark theme switch). Queued until ready. */
  setTheme(theme: TerminalTheme): void;
  /** Scroll the viewport by N lines (positive = toward the newest/bottom rows). */
  scrollLines(amount: number): void;
  /** Compute cols/rows that fit the host element, using the rendered canvas cell size.
   *  Returns null until the canvas has a measurable size. `extraHeightPx` adds
   *  height the host visually lost to local occlusion (soft keyboard) so the
   *  grid stays keyboard-independent - see TerminalViewportController. */
  fit(extraHeightPx?: number): { cols: number; rows: number } | null;
  /** Local cursor/canvas metrics (cell height, canvas height, cursor row) for
   *  keyboard-open cursor-follow. Null until the canvas is measurable. */
  localGeometry(): TerminalLocalGeometry | null;
  /** Re-anchor the IME helper textarea at the cursor using the CURRENT canvas
   *  rect. The host can be scrolled (keyboard cursor-follow) without the canvas
   *  resizing, so the anchor must re-measure after any such scroll. */
  syncInputAnchor(): void;
  cols(): number;
  rows(): number;
}

export interface TerminalAdapterOptions {
  cols: number;
  rows: number;
  onData: (data: string) => void;
  fontFamily?: string;
  fontSize?: number;
  /** Initial foreground/background; keeps the terminal matching the app theme. */
  theme?: TerminalTheme;
  /** Test seam. Defaults to constructing a real ghostty-web Terminal. May return a Promise —
   *  tests use this to exercise genuine ready-before/after-dispose races. */
  factory?: (cols: number, rows: number) => GhosttyTerminalLike | Promise<GhosttyTerminalLike>;
}

// ghostty-web loads its ~400KB WASM once via the argless `init()`, which fetches
// `ghostty-vt.wasm` from the served root. We also lazily load the JetBrainsMono webfont
// before constructing the Terminal so its first font-measure is correct.
let ghosttyInit: Promise<void> | undefined;

async function defaultFactory(
  cols: number, rows: number, fontFamily: string, fontSize: number, theme?: TerminalTheme,
): Promise<GhosttyTerminalLike> {
  const mod = await import("ghostty-web");
  ghosttyInit ??= mod.init();
  await ghosttyInit;
  await ensureTerminalFont();
  return new mod.Terminal({ cols, rows, fontFamily, fontSize, ...(theme ? { theme } : {}) }) as unknown as GhosttyTerminalLike;
}

/**
 * Position ghostty-web's 1×1 helper textarea as an invisible one-cell IME anchor at the
 * rendered terminal cursor. Windows IMEs place the composition/candidate UI at the focused
 * editable element's caret geometry - stretching the textarea over the host (the old
 * workaround) makes candidates pop up in a corner far from the shell cursor. The textarea
 * stays invisible and click-through (the canvas owns pointer interaction); keydown and
 * composition events still bubble from it to ghostty's host-level InputHandler.
 */
export function syncGhosttyInputAnchor(host: HTMLElement, terminal: GhosttyTerminalLike): void {
  const ta = host.querySelector("textarea");
  if (!(ta instanceof HTMLTextAreaElement)) return;
  const canvas = (terminal.element ?? host).querySelector("canvas") ?? host.querySelector("canvas");
  if (!canvas) return;
  const canvasRect = canvas.getBoundingClientRect();
  const hostRect = host.getBoundingClientRect();
  const cols = Math.max(1, terminal.cols);
  const rows = Math.max(1, terminal.rows);
  const cellW = canvasRect.width / cols;
  const cellH = canvasRect.height / rows;
  if (!(cellW > 0) || !(cellH > 0)) return;
  const cursor = terminal.buffer?.active;
  const cx = clampCell(cursor?.cursorX, cols - 1);
  const cy = clampCell(cursor?.cursorY, rows - 1);
  // Keep the textarea focusable but invisible - never fullscreen (IME anchor) and never a
  // pointer target (canvas interaction). "absolute" also undoes the "fixed" ghostty's
  // contextmenu-copy flow can leave behind; left/top are host-relative.
  ta.style.position = "absolute";
  ta.style.left = `${canvasRect.left - hostRect.left + cx * cellW}px`;
  ta.style.top = `${canvasRect.top - hostRect.top + cy * cellH}px`;
  ta.style.right = "";
  ta.style.bottom = "";
  ta.style.width = `${cellW}px`;
  ta.style.height = `${cellH}px`;
  ta.style.opacity = "0";
  ta.style.clipPath = "none";
  ta.style.overflow = "hidden";
  ta.style.pointerEvents = "none";
  ta.style.zIndex = "";
}

function clampCell(v: number | undefined, max: number): number {
  return Number.isFinite(v) ? Math.min(max, Math.max(0, v as number)) : 0;
}

export function createTerminalAdapter(el: HTMLElement, opts: TerminalAdapterOptions): TerminalAdapter {
  let live: GhosttyTerminalLike | undefined;
  let disposed = false;
  const fontFamily = opts.fontFamily ?? `"${TERMINAL_FONT_FAMILY}", monospace`;
  const fontSize = opts.fontSize ?? 13;

  let settleReady!: () => void;
  let failReady!: (err: unknown) => void;
  const readyPromise = new Promise<void>((resolve, reject) => { settleReady = resolve; failReady = reject; });
  // Nobody is required to call ready() — a rejection (e.g. dispose racing construction) must
  // never surface as an unhandled rejection on this internal reference. The promise returned
  // BY ready() below is a fresh one whenever it matters, so callers still observe the outcome.
  readyPromise.catch(() => {});

  const factoryResult = opts.factory ? opts.factory(opts.cols, opts.rows) : defaultFactory(opts.cols, opts.rows, fontFamily, fontSize, opts.theme);
  const factoryPromise: Promise<GhosttyTerminalLike> = Promise.resolve(factoryResult);

  void factoryPromise.then(
    (t) => {
      if (disposed) { t.dispose(); return; } // dispose() won the race — never open()/mutate the canvas.
      live = t;
      t.open(el);
      t.onData(opts.onData);
      syncGhosttyInputAnchor(el, t);
      settleReady();
    },
    (err) => {
      if (!disposed) failReady(err);
    },
  );

  // Every write/resize/theme/replay funnels through this single FIFO chain: (a) calls made
  // before `ready` queue instead of silently no-oping, and (b) a resetAndReplay() together with
  // any write()s issued while it's in flight run in strict call order — a keyframe can never be
  // interleaved with (or preceded by) a stale live write landing on the old screen.
  let queue: Promise<void> = readyPromise.catch(() => { /* dispose-before-ready: drain queued ops as no-ops below */ });

  function enqueue(op: (t: GhosttyTerminalLike) => void): Promise<void> {
    const run = queue.then(() => {
      if (disposed || !live) return;
      op(live);
    });
    queue = run.catch(() => { /* one failing op must not wedge every op queued after it */ });
    return run;
  }

  return {
    ready: () => (disposed ? Promise.reject(new Error("terminal adapter disposed")) : readyPromise),
    // write/resize/resetAndReplay each re-sync the IME anchor afterwards: ordinary shell
    // output moves the cursor without changing the host size, so a ResizeObserver alone
    // would leave the composition UI anchored to a stale cell.
    write: (data) => enqueue((t) => { t.write(data); syncGhosttyInputAnchor(el, t); }),
    resize: (c, r) => { void enqueue((t) => { t.resize(c, r); syncGhosttyInputAnchor(el, t); }); },
    resetAndReplay: (data, cols, rows) => enqueue((t) => {
      t.reset();
      t.resize(cols, rows);
      t.write(data);
      syncGhosttyInputAnchor(el, t);
    }),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      failReady(new Error("terminal adapter disposed")); // unstick anyone awaiting ready()
      live?.dispose();
      live = undefined;
    },
    // Queue behind ready(): a focus() issued while WASM is still loading must not no-op.
    // ghostty-web 0.4's Terminal.focus() focuses the host (the canvas's parent), NOT its
    // helper textarea - but the textarea is the IME anchor, so focus it directly. It is a
    // host child, so keydown/composition events still bubble to ghostty's InputHandler.
    focus: () => { void enqueue((t) => {
      syncGhosttyInputAnchor(el, t);
      const ta = el.querySelector("textarea");
      if (ta instanceof HTMLTextAreaElement) {
        ta.focus({ preventScroll: true });
      } else {
        t.focus?.();
        el.focus?.();
      }
    }); },
    getSelection: () => live?.getSelection?.() ?? "",
    setTheme: (theme) => { void enqueue((t) => {
      if (t.setTheme) t.setTheme(theme);
      else t.renderer?.setTheme?.(theme);
    }); },
    scrollLines: (n) => live?.scrollLines?.(n),
    fit: (extraHeightPx = 0) => {
      if (!live?.element || !live.cols || !live.rows) return null;
      const canvas = live.element.querySelector("canvas");
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      const cellW = rect.width / live.cols;
      const cellH = rect.height / live.rows;
      if (!(cellW > 0) || !(cellH > 0)) return null;
      return {
        cols: Math.max(2, Math.floor(el.clientWidth / cellW)),
        rows: Math.max(1, Math.floor((el.clientHeight + extraHeightPx) / cellH)),
      };
    },
    localGeometry: () => {
      if (!live?.element || !live.rows) return null;
      const canvas = live.element.querySelector("canvas");
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      if (!(rect.height > 0)) return null;
      return {
        cellHeight: rect.height / live.rows,
        canvasHeight: rect.height,
        cursorY: live.buffer?.active?.cursorY ?? 0,
      };
    },
    syncInputAnchor: () => {
      if (live) syncGhosttyInputAnchor(el, live);
    },
    cols: () => live?.cols ?? opts.cols,
    rows: () => live?.rows ?? opts.rows,
  };
}
