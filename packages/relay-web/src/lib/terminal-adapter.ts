// Thin wrapper over @xterm/xterm. Isolating it here means a future renderer
// swap only touches this file. Adds fit() (derive cols/rows from the rendered
// .xterm-screen metrics - most accurate) and lazy webfont loading.

import { ensureTerminalFont, TERMINAL_FONT_FAMILY } from "./terminal-font";

/** Subset of xterm's ITheme we set - foreground/background keep the terminal in sync
 *  with the app's design tokens so the sub-cell fit remainder blends seamlessly.
 *  xterm merges unspecified keys with its own defaults, so a partial theme is safe. */
export interface TerminalTheme {
  foreground?: string;
  background?: string;
}

/** Cursor position on the active screen, via xterm's buffer API. */
export interface TerminalBufferCursor {
  /** Cursor column (0-indexed, in cells). */
  readonly cursorX: number;
  /** Cursor row (0-indexed, relative to the viewport). */
  readonly cursorY: number;
}

export interface TerminalLike {
  open(el: HTMLElement): void;
  write(data: string | Uint8Array): void;
  resize(cols: number, rows: number): void;
  /** Full VT reset (RIS-equivalent): clears grid + scrollback and exits alt-screen. Required
   *  before replaying a rebase keyframe - a keyframe must never be appended to a stale screen. */
  reset(): void;
  dispose(): void;
  onData(cb: (data: string) => void): void;
  focus?(): void;
  paste?(data: string): void;
  getSelection?(): string;
  setTheme?(theme: TerminalTheme): void;
  /** Scroll the viewport by N lines (positive = toward the newest/bottom rows). */
  scrollLines?(amount: number): void;
  /** Active-screen cursor access. Optional so minimal test fakes can omit it. */
  buffer?: { readonly active: TerminalBufferCursor };
  element?: HTMLElement;
  cols: number;
  rows: number;
}

/** Local rendered-grid geometry used for keyboard-open cursor-follow. Distinct from
 *  the remote grid: the soft keyboard shrinks the HOST without shrinking rows, so a
 *  taller rendered screen must be scrolled to keep the cursor row visible locally. */
export interface TerminalLocalGeometry {
  /** Rendered cell height in px. */
  cellHeight: number;
  /** Rendered screen total height in px (= rows × cellHeight). */
  screenHeight: number;
  /** Active-screen cursor row (0-indexed, absolute viewport). */
  cursorY: number;
}

export interface TerminalAdapter {
  /** Resolves once the underlying terminal is open and wired. Rejects if construction fails
   *  or the adapter is disposed before that happens - never hangs forever either way. */
  ready(): Promise<void>;
  /** Accepts raw bytes (preferred - no UTF-8 round trip) or a string (legacy callers). Queued
   *  until ready, and ordered relative to any in-flight resetAndReplay(). */
  write(data: string | Uint8Array): Promise<void> | void;
  /** Queued the same way as write() - never silently dropped before ready. */
  resize(cols: number, rows: number): void;
  /** Rebase entry point: reset (clear grid/scrollback, exit alt-screen) -> resize -> write the
   *  keyframe, as one atomic, ready-awaited, serialized step. Any write() issued concurrently
   *  is queued behind it and flushed strictly afterward - never interleaved with the keyframe. */
  resetAndReplay(data: Uint8Array, cols: number, rows: number): Promise<void>;
  dispose(): void;
  focus(): void;
  /** The current text selection (empty string when nothing is selected). */
  getSelection(): string;
  /** Recolor the live terminal (e.g. on light/dark theme switch). Queued until ready. */
  setTheme(theme: TerminalTheme): void;
  /** Scroll the viewport by N lines (positive = toward the newest/bottom rows). */
  scrollLines(amount: number): void;
  /** Compute cols/rows that fit the host element, using the rendered cell size.
   *  Returns null until the screen has a measurable size. `extraHeightPx` adds
   *  height the host visually lost to local occlusion (soft keyboard) so the
   *  grid stays keyboard-independent - see TerminalViewportController. */
  fit(extraHeightPx?: number): { cols: number; rows: number } | null;
  /** Local cursor/screen metrics (cell height, screen height, cursor row) for
   *  keyboard-open cursor-follow. Null until the screen is measurable. */
  localGeometry(): TerminalLocalGeometry | null;
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
  /** Test seam. Defaults to constructing a real xterm.js Terminal. May return a Promise -
   *  tests use this to exercise genuine ready-before/after-dispose races. */
  factory?: (cols: number, rows: number) => TerminalLike | Promise<TerminalLike>;
}

// The default terminal stylesheet is loaded lazily with the renderer so the main
// bundle never pays for it (the terminal tab is opt-in). We also lazily load the
// JetBrainsMono webfont before constructing the Terminal so its first char-size
// measure uses the real font.
let xtermCss: Promise<unknown> | undefined;

async function defaultFactory(
  cols: number, rows: number, fontFamily: string, fontSize: number, theme?: TerminalTheme,
): Promise<TerminalLike> {
  const [{ Terminal }] = await Promise.all([
    import("@xterm/xterm"),
    (xtermCss ??= import("@xterm/xterm/css/xterm.css")),
  ]);
  await ensureTerminalFont();
  const term = new Terminal({ cols, rows, fontFamily, fontSize, ...(theme ? { theme } : {}) });
  return {
    open: (el) => term.open(el),
    write: (data) => term.write(data),
    resize: (c, r) => term.resize(c, r),
    reset: () => term.reset(),
    dispose: () => term.dispose(),
    onData: (cb) => { term.onData(cb); },
    focus: () => term.focus(),
    paste: (data) => term.paste(data),
    getSelection: () => term.getSelection(),
    // xterm has no setTheme method; assigning options.theme triggers a live recolor
    // (xterm fills unspecified colors from its own defaults, so partial themes are safe).
    setTheme: (t) => { term.options.theme = t; },
    scrollLines: (amount) => term.scrollLines(amount),
    get buffer() { return term.buffer; },
    get element() { return term.element; },
    get cols() { return term.cols; },
    get rows() { return term.rows; },
  };
}

export function createTerminalAdapter(el: HTMLElement, opts: TerminalAdapterOptions): TerminalAdapter {
  let live: TerminalLike | undefined;
  let disposed = false;
  const fontFamily = opts.fontFamily ?? `"${TERMINAL_FONT_FAMILY}", monospace`;
  const fontSize = opts.fontSize ?? 13;

  let settleReady!: () => void;
  let failReady!: (err: unknown) => void;
  const readyPromise = new Promise<void>((resolve, reject) => { settleReady = resolve; failReady = reject; });
  // Nobody is required to call ready() - a rejection (e.g. dispose racing construction) must
  // never surface as an unhandled rejection on this internal reference. The promise returned
  // BY ready() below is a fresh one whenever it matters, so callers still observe the outcome.
  readyPromise.catch(() => {});

  const factoryResult = opts.factory ? opts.factory(opts.cols, opts.rows) : defaultFactory(opts.cols, opts.rows, fontFamily, fontSize, opts.theme);
  const factoryPromise: Promise<TerminalLike> = Promise.resolve(factoryResult);

  void factoryPromise.then(
    (t) => {
      if (disposed) { t.dispose(); return; } // dispose() won the race - never open()/mutate the grid.
      live = t;
      t.open(el);
      t.onData(opts.onData);
      settleReady();
    },
    (err) => {
      if (!disposed) failReady(err);
    },
  );

  // Every write/resize/theme/replay funnels through this single FIFO chain: (a) calls made
  // before `ready` queue instead of silently no-oping, and (b) a resetAndReplay() together with
  // any write()s issued while it's in flight run in strict call order - a keyframe can never be
  // interleaved with (or preceded by) a stale live write landing on the old screen.
  let queue: Promise<void> = readyPromise.catch(() => { /* dispose-before-ready: drain queued ops as no-ops below */ });

  function enqueue(op: (t: TerminalLike) => void): Promise<void> {
    const run = queue.then(() => {
      if (disposed || !live) return;
      op(live);
    });
    queue = run.catch(() => { /* one failing op must not wedge every op queued after it */ });
    return run;
  }

  return {
    ready: () => (disposed ? Promise.reject(new Error("terminal adapter disposed")) : readyPromise),
    write: (data) => enqueue((t) => { t.write(data); }),
    resize: (c, r) => { void enqueue((t) => { t.resize(c, r); }); },
    resetAndReplay: (data, cols, rows) => enqueue((t) => {
      t.reset();
      t.resize(cols, rows);
      t.write(data);
    }),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      failReady(new Error("terminal adapter disposed")); // unstick anyone awaiting ready()
      live?.dispose();
      live = undefined;
    },
    // Queue behind ready(): a focus() issued while the module is still loading must not no-op.
    // xterm's focus() targets its own helper textarea, which xterm keeps anchored at the
    // cursor cell for IME - no adapter-side anchor management needed.
    focus: () => { void enqueue((t) => { t.focus?.(); }); },
    getSelection: () => live?.getSelection?.() ?? "",
    setTheme: (theme) => { void enqueue((t) => { t.setTheme?.(theme); }); },
    scrollLines: (n) => live?.scrollLines?.(n),
    fit: (extraHeightPx = 0) => {
      if (!live?.element || !live.cols || !live.rows) return null;
      const screen = live.element.querySelector(".xterm-screen");
      if (!screen) return null;
      const rect = screen.getBoundingClientRect();
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
      const screen = live.element.querySelector(".xterm-screen");
      if (!screen) return null;
      const rect = screen.getBoundingClientRect();
      if (!(rect.height > 0)) return null;
      return {
        cellHeight: rect.height / live.rows,
        screenHeight: rect.height,
        cursorY: live.buffer?.active?.cursorY ?? 0,
      };
    },
    cols: () => live?.cols ?? opts.cols,
    rows: () => live?.rows ?? opts.rows,
  };
}
