// Thin wrapper over ghostty-web (xterm.js-compatible API). Isolating it here means a
// future swap back to @xterm/xterm only touches this file. ghostty-web docs confirm
// open()/write()/onData(); resize()/cols/rows are assumed xterm-compatible — if an
// addon/API gap bites, replace `defaultFactory` here, not the call sites.

export interface GhosttyTerminalLike {
  open(el: HTMLElement): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  dispose(): void;
  onData(cb: (data: string) => void): void;
  cols: number;
  rows: number;
}

export interface TerminalAdapter {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  dispose(): void;
  cols(): number;
  rows(): number;
}

export interface TerminalAdapterOptions {
  cols: number;
  rows: number;
  onData: (data: string) => void;
  /** Test seam. Defaults to constructing a real ghostty-web Terminal. */
  factory?: (cols: number, rows: number) => GhosttyTerminalLike;
}

// ghostty-web loads its ~400KB WASM once via the argless `init()`, which fetches
// `ghostty-vt.wasm` relative to the page root (`/ghostty-vt.wasm`). We ship that file
// via `packages/relay-web/public/ghostty-vt.wasm` (Vite copies public/ to the dist root,
// the hub serves the SPA at root), so the fetch resolves. `init()` takes no URL argument,
// so the asset MUST live at the served root — do not rename it.
let ghosttyInit: Promise<void> | undefined;

async function defaultFactory(cols: number, rows: number): Promise<GhosttyTerminalLike> {
  const mod = await import("ghostty-web");
  ghosttyInit ??= mod.init();
  await ghosttyInit;
  return new mod.Terminal({ cols, rows }) as unknown as GhosttyTerminalLike;
}

export function createTerminalAdapter(el: HTMLElement, opts: TerminalAdapterOptions): TerminalAdapter {
  let live: GhosttyTerminalLike | undefined;

  const ready: Promise<GhosttyTerminalLike> = opts.factory
    ? Promise.resolve(opts.factory(opts.cols, opts.rows))
    : defaultFactory(opts.cols, opts.rows);

  // open() and onData() are called ONLY inside ready.then — never synchronously.
  // When a factory is injected (tests), ready is already-resolved, so .then runs on
  // the next microtask. Call `await Promise.resolve()` in tests before asserting.
  void ready.then((t) => {
    live = t;
    t.open(el);
    t.onData(opts.onData);
  });

  return {
    write: (d) => live?.write(d),
    resize: (c, r) => live?.resize(c, r),
    dispose: () => live?.dispose(),
    cols: () => live?.cols ?? opts.cols,
    rows: () => live?.rows ?? opts.rows,
  };
}
