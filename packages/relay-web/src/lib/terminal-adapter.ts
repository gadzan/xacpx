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
  write(data: string): void;
  resize(cols: number, rows: number): void;
  dispose(): void;
  onData(cb: (data: string) => void): void;
  focus?(): void;
  paste?(data: string): void;
  getSelection?(): string;
  setTheme?(theme: TerminalTheme): void;
  /** ghostty's Terminal has no public setTheme yet; its renderer does. */
  renderer?: { setTheme?(theme: TerminalTheme): void };
  element?: HTMLElement;
  cols: number;
  rows: number;
}

export interface TerminalAdapter {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  dispose(): void;
  focus(): void;
  /** The current text selection (empty string when nothing is selected). */
  getSelection(): string;
  /** Recolor the live terminal (e.g. on light/dark theme switch). No-op before open. */
  setTheme(theme: TerminalTheme): void;
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
  /** Test seam. Defaults to constructing a real ghostty-web Terminal. */
  factory?: (cols: number, rows: number) => GhosttyTerminalLike;
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

export function createTerminalAdapter(el: HTMLElement, opts: TerminalAdapterOptions): TerminalAdapter {
  let live: GhosttyTerminalLike | undefined;
  const fontFamily = opts.fontFamily ?? `"${TERMINAL_FONT_FAMILY}", monospace`;
  const fontSize = opts.fontSize ?? 13;

  const ready: Promise<GhosttyTerminalLike> = opts.factory
    ? Promise.resolve(opts.factory(opts.cols, opts.rows))
    : defaultFactory(opts.cols, opts.rows, fontFamily, fontSize, opts.theme);

  // open()/onData() are called ONLY inside ready.then — never synchronously. With an
  // injected factory (tests), ready is already-resolved, so .then runs next microtask;
  // await Promise.resolve() in tests before asserting.
  void ready.then((t) => {
    live = t;
    t.open(el);
    t.onData(opts.onData);
  });

  return {
    write: (d) => live?.write(d),
    resize: (c, r) => live?.resize(c, r),
    dispose: () => live?.dispose(),
    focus: () => live?.focus?.(),
    getSelection: () => live?.getSelection?.() ?? "",
    setTheme: (theme) => {
      if (live?.setTheme) live.setTheme(theme);
      else live?.renderer?.setTheme?.(theme);
    },
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
