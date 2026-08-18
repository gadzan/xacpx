import { describe, it, expect, vi } from "vitest";
import { createTerminalAdapter, type TerminalLike } from "../lib/terminal-adapter";

type Call = { op: "write" | "resize" | "reset" | "setTheme"; args: unknown[] };

/** A fake terminal that records every mutating call (and its arguments) in
 * invocation order, so tests can assert exact ordering - not just individual calls. */
function fakeTerminal() {
  const calls: Call[] = [];
  const onData = vi.fn();
  const term: TerminalLike = {
    open: vi.fn(),
    write: vi.fn((d: string | Uint8Array) => { calls.push({ op: "write", args: [d] }); }),
    resize: vi.fn((c: number, r: number) => { calls.push({ op: "resize", args: [c, r] }); }),
    reset: vi.fn(() => { calls.push({ op: "reset", args: [] }); }),
    dispose: vi.fn(),
    onData: (cb: (d: string) => void) => { onData(cb); },
    setTheme: vi.fn((t) => { calls.push({ op: "setTheme", args: [t] }); }),
    cols: 80,
    rows: 24,
  };
  return { term, calls, onData };
}

/** A factory that resolves only when the test calls `resolve` - for exercising genuine
 * async races (ready-before/after-dispose, late grid mutation, etc). */
function deferredFactory(term: TerminalLike) {
  let resolve!: (t: TerminalLike) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<TerminalLike>((res, rej) => { resolve = res; reject = rej; });
  return { factory: () => promise, resolve: () => resolve(term), reject };
}

async function flush(times = 4) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

/** The rendered grid element the adapter measures: xterm sizes .xterm-screen to exactly
 * cols*cellW x rows*cellH (inline styles), mirroring what the old canvas gave us. */
function screenElement(width: number, height: number): HTMLElement {
  const screen = document.createElement("div");
  screen.className = "xterm-screen";
  screen.getBoundingClientRect = () => ({ width, height }) as DOMRect;
  return screen;
}


describe("terminal-adapter", () => {
  it("opens the xterm terminal on the element and wires onData", async () => {
    const { term, onData } = fakeTerminal();
    const onDataCb = vi.fn();
    const el = document.createElement("div");
    createTerminalAdapter(el, { cols: 100, rows: 30, onData: onDataCb, factory: () => term });
    await flush();
    expect(term.open).toHaveBeenCalledWith(el);
    expect(onData).toHaveBeenCalled();
  });

  it("write/resize/dispose proxy to the underlying terminal", async () => {
    const { term, calls } = fakeTerminal();
    const a = createTerminalAdapter(document.createElement("div"), {
      cols: 80, rows: 24, onData: () => {}, factory: () => term,
    });
    await a.ready();
    await a.write("hi");
    a.resize(120, 40);
    await flush();
    a.dispose();
    expect(calls).toEqual([{ op: "write", args: ["hi"] }, { op: "resize", args: [120, 40] }]);
    expect(term.dispose).toHaveBeenCalledTimes(1);
  });

  it("fit() computes cols/rows from the rendered screen metrics", async () => {
    // 80 cols * 10px = 800 wide; 24 rows * 20px = 480 tall -> cellW=10, cellH=20
    const element = document.createElement("div");
    element.appendChild(screenElement(800, 480));
    const { term } = fakeTerminal();
    term.element = element;
    const el = document.createElement("div");
    Object.defineProperty(el, "clientWidth", { value: 400, configurable: true });  // 400/10 = 40
    Object.defineProperty(el, "clientHeight", { value: 240, configurable: true }); // 240/20 = 12
    const a = createTerminalAdapter(el, { cols: 80, rows: 24, onData: () => {}, factory: () => term });
    await a.ready();
    expect(a.fit()).toEqual({ cols: 40, rows: 12 });
  });

  it("fit() returns null before the screen has a measurable size", async () => {
    const element = document.createElement("div");
    element.appendChild(screenElement(0, 0));
    const { term } = fakeTerminal();
    term.element = element;
    const a = createTerminalAdapter(document.createElement("div"), {
      cols: 80, rows: 24, onData: () => {}, factory: () => term,
    });
    await a.ready();
    expect(a.fit()).toBeNull();
  });

  it("localGeometry() reports cell height, screen height and the cursor row", async () => {
    const element = document.createElement("div");
    element.appendChild(screenElement(800, 480));
    const { term } = fakeTerminal();
    term.element = element;
    term.buffer = { active: { cursorX: 0, cursorY: 7 } };
    const a = createTerminalAdapter(document.createElement("div"), {
      cols: 80, rows: 24, onData: () => {}, factory: () => term,
    });
    await a.ready();
    expect(a.localGeometry()).toEqual({ cellHeight: 480 / 24, screenHeight: 480, cursorY: 7 });
  });


  it("focus() proxies to the underlying terminal focus", async () => {
    const { term } = fakeTerminal();
    const focus = vi.fn();
    term.focus = focus;
    const a = createTerminalAdapter(document.createElement("div"), {
      cols: 80, rows: 24, onData: () => {}, factory: () => term,
    });
    await a.ready();
    a.focus();
    await flush();
    expect(focus).toHaveBeenCalledTimes(1);
  });


  it("focus() issued before ready still lands after the terminal opens", async () => {
    const { term } = fakeTerminal();
    const focus = vi.fn();
    (term as unknown as { focus: () => void }).focus = focus;
    const { factory, resolve } = deferredFactory(term);
    const a = createTerminalAdapter(document.createElement("div"), {
      cols: 80, rows: 24, onData: () => {}, factory,
    });
    a.focus();
    await flush();
    expect(focus).not.toHaveBeenCalled();
    resolve();
    await a.ready();
    await flush();
    expect(focus).toHaveBeenCalled();
  });

  describe("readiness", () => {
    it("ready() resolves once an async factory settles", async () => {
      const { term } = fakeTerminal();
      const { factory, resolve } = deferredFactory(term);
      const a = createTerminalAdapter(document.createElement("div"), { cols: 80, rows: 24, onData: () => {}, factory });
      let settled = false;
      void a.ready().then(() => { settled = true; });
      await flush();
      expect(settled).toBe(false);
      expect(term.open).not.toHaveBeenCalled();
      resolve();
      await a.ready();
      expect(settled).toBe(true);
      expect(term.open).toHaveBeenCalled();
    });

    it("queues write/resize/setTheme issued before ready and flushes them in call order once ready resolves", async () => {
      const { term, calls } = fakeTerminal();
      const { factory, resolve } = deferredFactory(term);
      const a = createTerminalAdapter(document.createElement("div"), { cols: 80, rows: 24, onData: () => {}, factory });

      const pendingWrite = a.write("queued-before-ready");
      a.resize(90, 30);
      a.setTheme({ foreground: "#fff" });
      await flush();
      expect(calls).toEqual([]); // not silently dropped — nothing has run yet, all still queued

      resolve();
      await a.ready();
      await pendingWrite;
      await flush();

      expect(calls).toEqual([
        { op: "write", args: ["queued-before-ready"] },
        { op: "resize", args: [90, 30] },
        { op: "setTheme", args: [{ foreground: "#fff" }] },
      ]);
    });

    it("rejects ready() and awaiters when the factory itself rejects", async () => {
      const err = new Error("boom");
      const a = createTerminalAdapter(document.createElement("div"), {
        cols: 80, rows: 24, onData: () => {}, factory: () => Promise.reject(err),
      });
      await expect(a.ready()).rejects.toThrow("boom");
    });
  });

  describe("dispose safety", () => {
    it("dispose before the factory settles rejects ready(), never opens/mutates the canvas, and disposes the late terminal instead", async () => {
      const { term } = fakeTerminal();
      const { factory, resolve } = deferredFactory(term);
      const el = document.createElement("div");
      const a = createTerminalAdapter(el, { cols: 80, rows: 24, onData: () => {}, factory });

      const readyRejected = expect(a.ready()).rejects.toThrow();
      a.dispose();
      a.dispose(); // double dispose must be a safe no-op

      resolve(); // the async factory settles AFTER dispose — must not open() or mutate the canvas
      await readyRejected;
      await flush();

      expect(term.open).not.toHaveBeenCalled();
      expect(term.dispose).toHaveBeenCalledTimes(1);
    });

    it("ready() called after dispose rejects immediately instead of hanging", async () => {
      const { term } = fakeTerminal();
      const a = createTerminalAdapter(document.createElement("div"), {
        cols: 80, rows: 24, onData: () => {}, factory: () => term,
      });
      await a.ready();
      a.dispose();
      await expect(a.ready()).rejects.toThrow();
    });

    it("write/resize/resetAndReplay queued before dispose are safely dropped, not run against a disposed terminal", async () => {
      const { term, calls } = fakeTerminal();
      const { factory, resolve } = deferredFactory(term);
      const a = createTerminalAdapter(document.createElement("div"), { cols: 80, rows: 24, onData: () => {}, factory });

      void a.write("never");
      const replay = a.resetAndReplay(new Uint8Array([1, 2, 3]), 80, 24).catch(() => {});
      a.dispose();
      resolve();
      await replay;
      await flush();

      expect(calls).toEqual([]);
      expect(term.write).not.toHaveBeenCalled();
      expect(term.reset).not.toHaveBeenCalled();
    });

    it("double dispose never double-disposes the underlying terminal", async () => {
      const { term } = fakeTerminal();
      const a = createTerminalAdapter(document.createElement("div"), {
        cols: 80, rows: 24, onData: () => {}, factory: () => term,
      });
      await a.ready();
      a.dispose();
      a.dispose();
      a.dispose();
      expect(term.dispose).toHaveBeenCalledTimes(1);
    });
  });

  describe("resetAndReplay (rebase)", () => {
    it("resets, then resizes, then writes the keyframe — never appends on the old screen", async () => {
      const { term, calls } = fakeTerminal();
      const a = createTerminalAdapter(document.createElement("div"), {
        cols: 80, rows: 24, onData: () => {}, factory: () => term,
      });
      await a.ready();
      const keyframe = new Uint8Array([0x1b, 0x5b, 0x32, 0x4a]);
      await a.resetAndReplay(keyframe, 100, 40);
      expect(calls).toEqual([
        { op: "reset", args: [] },
        { op: "resize", args: [100, 40] },
        { op: "write", args: [keyframe] },
      ]);
    });

    it("buffers a live write() issued alongside resetAndReplay and flushes it strictly after the keyframe, never interleaved", async () => {
      const { term, calls } = fakeTerminal();
      const a = createTerminalAdapter(document.createElement("div"), {
        cols: 80, rows: 24, onData: () => {}, factory: () => term,
      });
      await a.ready();
      const before = new TextEncoder().encode("before");
      const keyframe = new TextEncoder().encode("KEYFRAME");
      const after = new TextEncoder().encode("after");

      void a.write(before);
      void a.resetAndReplay(keyframe, 80, 24);
      void a.write(after);
      await flush();

      expect(calls.map((c) => c.op)).toEqual(["write", "reset", "resize", "write", "write"]);
      expect(calls[0].args[0]).toBe(before);   // live write before the rebase
      expect(calls[3].args[0]).toBe(keyframe); // the keyframe itself
      expect(calls[4].args[0]).toBe(after);    // live write buffered during the rebase, flushed after
    });

    it("a rebase into the alternate screen replaces the whole screen instead of appending to stale content", async () => {
      const decoder = new TextDecoder();
      let screen = "";
      const term: TerminalLike = {
        open: vi.fn(),
        onData: vi.fn(),
        dispose: vi.fn(),
        reset: vi.fn(() => { screen = ""; }),
        resize: vi.fn(),
        write: vi.fn((d: string | Uint8Array) => { screen += typeof d === "string" ? d : decoder.decode(d); }),
        cols: 80,
        rows: 24,
      };
      const a = createTerminalAdapter(document.createElement("div"), {
        cols: 80, rows: 24, onData: () => {}, factory: () => term,
      });
      await a.ready();
      await a.write("stale primary screen content");
      expect(screen).toBe("stale primary screen content");

      await a.resetAndReplay(new TextEncoder().encode("\u001b[?1049hALT SCREEN KEYFRAME"), 80, 24);
      expect(screen).toBe("\u001b[?1049hALT SCREEN KEYFRAME"); // old content gone, not appended
    });

    it("serializes back-to-back resetAndReplay calls instead of interleaving their resets/resizes/writes", async () => {
      const { term, calls } = fakeTerminal();
      const a = createTerminalAdapter(document.createElement("div"), {
        cols: 80, rows: 24, onData: () => {}, factory: () => term,
      });
      await a.ready();
      const first = new Uint8Array([1]);
      const second = new Uint8Array([2]);
      const p1 = a.resetAndReplay(first, 80, 24);
      const p2 = a.resetAndReplay(second, 100, 30);
      await Promise.all([p1, p2]);
      expect(calls).toEqual([
        { op: "reset", args: [] }, { op: "resize", args: [80, 24] }, { op: "write", args: [first] },
        { op: "reset", args: [] }, { op: "resize", args: [100, 30] }, { op: "write", args: [second] },
      ]);
    });
  });

  describe("binary bytes", () => {
    it("passes raw non-UTF8 bytes through to the terminal unchanged instead of round-tripping through UTF-8", async () => {
      const { term } = fakeTerminal();
      const a = createTerminalAdapter(document.createElement("div"), {
        cols: 80, rows: 24, onData: () => {}, factory: () => term,
      });
      await a.ready();
      const raw = new Uint8Array([0xff, 0xfe, 0x00, 0x80, 0xc3, 0x28, 0xed, 0xa0, 0x80]);
      await a.write(raw);
      expect(term.write).toHaveBeenCalledTimes(1);
      const [received] = vi.mocked(term.write).mock.calls[0];
      expect(received).toBe(raw); // same reference — no copy/decode/re-encode round trip
      expect(Array.from(received as Uint8Array)).toEqual(Array.from(raw));
    });

    it("passes raw non-UTF8 keyframe bytes through resetAndReplay unchanged", async () => {
      const { term } = fakeTerminal();
      const a = createTerminalAdapter(document.createElement("div"), {
        cols: 80, rows: 24, onData: () => {}, factory: () => term,
      });
      await a.ready();
      const raw = new Uint8Array([0xff, 0xfe, 0xc0, 0x80]);
      await a.resetAndReplay(raw, 80, 24);
      const writeCall = vi.mocked(term.write).mock.calls.at(-1)!;
      expect(writeCall[0]).toBe(raw);
    });
  });
});
