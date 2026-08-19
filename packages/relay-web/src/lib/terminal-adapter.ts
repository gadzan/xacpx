// swap only touches this file. Adds fit() (derive cols/rows from the rendered
// .xterm-screen metrics, reserving scrollbar width exactly like the official
// FitAddon), parse-completed writes (xterm's write() is async - the FIFO below
// awaits the write callback, not just the call), raw-byte binary input
// (onBinary), and lazy webfont loading.

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
  /** Queues the data for parsing. May resolve asynchronously - resolving (or
   *  returning a Promise that resolves) must mean the chunk is fully PARSED,
   *  not merely enqueued: xterm's write(data, callback) fires the callback
   *  after the InputHandler has consumed the chunk, and ordering guarantees
   *  (see resetAndReplay) depend on that stronger contract. */
  write(data: string | Uint8Array): Promise<void> | void;
  resize(cols: number, rows: number): void;
  /** Full VT reset (RIS-equivalent): clears grid + scrollback and exits alt-screen. Required
   *  before replaying a rebase keyframe - a keyframe must never be appended to a stale screen. */
  reset(): void;
  dispose(): void;
  onData(cb: (data: string) => void): void;
  /** Legacy binary input (X10 mouse reports et al): charCodes are raw byte
   *  values (charCodeAt(i) & 0xFF), NOT UTF-8. xterm emits these separately
   *  from onData because they cannot round-trip through UTF-8. */
  onBinary?(cb: (data: string) => void): void;
  focus?(): void;
  paste?(data: string): void;
  getSelection?(): string;
  setTheme?(theme: TerminalTheme): void;
  /** Scroll the viewport by N lines (positive = toward the newest/bottom rows). */
  scrollLines?(amount: number): void;
  /** Horizontal chrome reserved inside the host next to the rendered screen
   *  (scrollbar). FitAddon parity: 0 when scrollback is 0, else the scrollbar
   *  width (xterm default 14px). */
  scrollBarWidth?(): number;
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
   *  until ready, and ordered relative to any in-flight resetAndReplay(). Resolves only after
   *  the data is PARSED (or the adapter was disposed mid-write - then it resolves as dropped). */
  write(data: string | Uint8Array): Promise<void> | void;
  /** Queued the same way as write() - never silently dropped before ready. */
  resize(cols: number, rows: number): void;
  /** Rebase entry point: reset (clear grid/scrollback, exit alt-screen) -> resize -> write the
   *  keyframe, as one atomic, ready-awaited, serialized step. Any write() issued concurrently
   *  is queued behind it and flushed strictly afterward - never interleaved with the keyframe.
   *  Atomicity holds against xterm's ASYNC parsing: the keyframe write resolves only after the
   *  chunk is parsed, so a stale live write can never land on the post-reset screen. */
  resetAndReplay(data: Uint8Array, cols: number, rows: number): Promise<void>;
  dispose(): void;
  focus(): void;
  /** The current text selection (empty string when nothing is selected). */
  getSelection(): string;
  /** Recolor the live terminal (e.g. on light/dark theme switch). Queued until ready. */
  setTheme(theme: TerminalTheme): void;
  /** Scroll the viewport by N lines (positive = toward the newest/bottom rows). */
  scrollLines(amount: number): void;
  /** Compute cols/rows that fit the host element, using the rendered cell size and
   *  reserving the scrollbar width (FitAddon parity). Returns null until the screen
   *  has a measurable size. `extraHeightPx` adds height the host visually lost to
   *  local occlusion (soft keyboard) so the grid stays keyboard-independent -
   *  see TerminalViewportController. */
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
  /** Raw binary input from the terminal (legacy mouse reports). Receives the
   *  exact bytes - forward them to the PTY via a raw byte path, never UTF-8. */
  onBinary?: (data: Uint8Array) => void;
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

/** xterm's default scrollbar reservation (ViewportConstants.DEFAULT_SCROLL_BAR_WIDTH). */
const DEFAULT_SCROLLBAR_WIDTH = 14;

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
    // The callback fires after the chunk is parsed - this Promise resolving is
    // exactly the "parsed, not enqueued" contract TerminalLike.write demands.
    write: (data) => new Promise<void>((resolve) => { term.write(data, resolve); }),
    resize: (c, r) => term.resize(c, r),
    reset: () => term.reset(),
    dispose: () => term.dispose(),
    onData: (cb) => { term.onData(cb); },
    onBinary: (cb) => { term.onBinary(cb); },
    focus: () => term.focus(),
    paste: (data) => term.paste(data),
    getSelection: () => term.getSelection(),
    // xterm has no setTheme method; assigning options.theme triggers a live recolor
    // (xterm fills unspecified colors from its own defaults, so partial themes are safe).
    setTheme: (t) => { term.options.theme = t; },
    scrollLines: (amount) => term.scrollLines(amount),
    // FitAddon parity: scrollback 0 means no scrollbar; the overview ruler
    // width overrides. `||` (not `??`) matches FitAddon exactly - an explicit
    // width of 0 also falls back to the default scrollbar reservation.
    scrollBarWidth: () => term.options.scrollback === 0
      ? 0
      : (term.options.overviewRuler?.width || DEFAULT_SCROLLBAR_WIDTH),
    get buffer() { return term.buffer; },
    get element() { return term.element; },
    get cols() { return term.cols; },
    get rows() { return term.rows; },
  };
}

/** xterm's onBinary contract: each charCode is one raw byte (low 8 bits). */
function binaryStringToBytes(data: string): Uint8Array {
  const bytes = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i) & 0xff;
  return bytes;
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

  // Resolved on dispose so an in-flight awaited write (whose xterm callback may
  // never fire on a disposed terminal) settles as "dropped" instead of hanging.
  let openDisposeGate!: () => void;
  const disposeGate = new Promise<void>((resolve) => { openDisposeGate = resolve; });

  const factoryResult = opts.factory ? opts.factory(opts.cols, opts.rows) : defaultFactory(opts.cols, opts.rows, fontFamily, fontSize, opts.theme);
  const factoryPromise: Promise<TerminalLike> = Promise.resolve(factoryResult);

  void factoryPromise.then(
    (t) => {
      if (disposed) { t.dispose(); return; } // dispose() won the race - never open()/mutate the grid.
      live = t;
      t.open(el);
      t.onData(opts.onData);
      if (opts.onBinary) {
        t.onBinary?.((data) => {
          if (!disposed) opts.onBinary!(binaryStringToBytes(data));
        });
      }
      settleReady();
    },
    (err) => {
      if (!disposed) failReady(err);
    },
  );

  // Every write/resize/theme/replay funnels through this single FIFO chain: (a) calls made
  // before `ready` queue instead of silently no-oping, (b) a resetAndReplay() together with
  // any write()s issued while it's in flight run in strict call order, and (c) an op's
  // returned Promise is AWAITED before the next op starts - for writes that Promise means
  // "parsed", so a resetAndReplay() keyframe can never interleave with (or be preceded by)
  // a stale live write still sitting in xterm's async write buffer.
  let queue: Promise<void> = readyPromise.catch(() => { /* dispose-before-ready: drain queued ops as no-ops below */ });

  function enqueue(op: (t: TerminalLike) => Promise<void> | void): Promise<void> {
    const run = queue.then(async () => {
      if (disposed || !live) return;
      // Dispose mid-write settles the op early (data dropped) - the xterm write
      // callback may never fire on a disposed terminal.
      await Promise.race([op(live), disposeGate]);
    });
    queue = run.catch(() => { /* one failing op must not wedge every op queued after it */ });
    return run;
  }

  return {
    ready: () => (disposed ? Promise.reject(new Error("terminal adapter disposed")) : readyPromise),
    write: (data) => enqueue((t) => t.write(data)),
    resize: (c, r) => { void enqueue((t) => { t.resize(c, r); }); },
    resetAndReplay: (data, cols, rows) => enqueue(async (t) => {
      // Safe point: every earlier write() in the FIFO has fully PARSED by now.
      t.reset();
      t.resize(cols, rows);
      await t.write(data);
    }),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      openDisposeGate(); // unstick any awaited write/replay with data dropped
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
      // FitAddon parity: the scrollbar sits next to the screen inside the host,
      // so its width is not available for columns.
      const scrollbarW = live.scrollBarWidth?.() ?? DEFAULT_SCROLLBAR_WIDTH;
      return {
        cols: Math.max(2, Math.floor((el.clientWidth - scrollbarW) / cellW)),
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
