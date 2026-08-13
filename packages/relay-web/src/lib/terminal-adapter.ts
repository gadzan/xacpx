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
  /** ghostty's Terminal has no public setTheme yet; its renderer does. */
  renderer?: { setTheme?(theme: TerminalTheme): void };
  element?: HTMLElement;
  cols: number;
  rows: number;
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
   *  Returns null until the canvas has a measurable size. */
  fit(): { cols: number; rows: number } | null;
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
 * ghostty-web 0.4 mounts a 1×1 `clip-path: inset(50%)` textarea and focuses it on
 * canvas click, while InputHandler listens for keydown on the host. Several browsers
 * then never deliver keydown. Stretch that textarea over the host so IME and keys work
 * whether focus lands on the host or the helper.
 */
export function revealGhosttyInputSurface(host: HTMLElement): void {
  const ta = host.querySelector("textarea");
  if (!(ta instanceof HTMLTextAreaElement)) return;
  ta.style.position = "absolute";
  ta.style.left = "0";
  ta.style.top = "0";
  ta.style.right = "0";
  ta.style.bottom = "0";
  ta.style.width = "100%";
  ta.style.height = "100%";
  ta.style.opacity = "0";
  ta.style.clipPath = "none";
  ta.style.overflow = "hidden";
  ta.style.zIndex = "1";
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
      revealGhosttyInputSurface(el);
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
    write: (data) => enqueue((t) => t.write(data)),
    resize: (c, r) => { void enqueue((t) => t.resize(c, r)); },
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
    // Queue behind ready(): a focus() issued while WASM is still loading must not
    // no-op. ghostty-web's canvas mousedown focuses a 1×1 clipped textarea; its
    // keydown listener is on the host, so we unclip that textarea and focus the host.
    focus: () => { void enqueue((t) => {
      revealGhosttyInputSurface(el);
      t.focus?.();
      el.focus?.();
    }); },
    getSelection: () => live?.getSelection?.() ?? "",
    setTheme: (theme) => { void enqueue((t) => {
      if (t.setTheme) t.setTheme(theme);
      else t.renderer?.setTheme?.(theme);
    }); },
    scrollLines: (n) => live?.scrollLines?.(n),
    fit: () => {
      if (!live?.element || !live.cols || !live.rows) return null;
      const canvas = live.element.querySelector("canvas");
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      const cellW = rect.width / live.cols;
      const cellH = rect.height / live.rows;
      if (!(cellW > 0) || !(cellH > 0)) return null;
      return {
        cols: Math.max(2, Math.floor(el.clientWidth / cellW)),
        rows: Math.max(1, Math.floor(el.clientHeight / cellH)),
      };
    },
    cols: () => live?.cols ?? opts.cols,
    rows: () => live?.rows ?? opts.rows,
  };
}
