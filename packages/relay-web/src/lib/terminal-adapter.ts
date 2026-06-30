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

async function defaultFactory(cols: number, rows: number): Promise<GhosttyTerminalLike> {
  // Use Function constructor so the import specifier is inside a string: both TS module
  // resolution and Vite's import-analysis are bypassed (they only scan AST-level imports).
  // Replace with: const mod = await import("ghostty-web") once the package is installed.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  const _import = new Function("pkg", "return import(pkg)") as (
    pkg: string
  ) => Promise<{ Terminal: new (o: { cols: number; rows: number }) => GhosttyTerminalLike }>;
  const mod = await _import("ghostty-web");
  return new mod.Terminal({ cols, rows });
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
