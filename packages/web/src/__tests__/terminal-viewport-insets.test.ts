// Soft-keyboard viewport inset measurement + tracker.
//
// The keyboard/browser-chrome classification is behavioral: a shrink only
// counts as the keyboard while an editable inside the terminal host holds
// focus AND the shrink is keyboard-sized. The tracker commits opens/grows
// immediately and debounces closes with a fresh re-measure at fire time.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  measureTerminalViewportInsets,
  bindTerminalKeyboardInset,
  KEYBOARD_INSET_CLOSE_DELAY_MS,
  type TerminalViewportLike,
} from "../lib/terminal-viewport-insets";

type VvEvent = "resize" | "scroll";

function installVisualViewport(height: number, offsetTop = 0, scale = 1) {
  const listeners = new Map<VvEvent, Set<() => void>>([["resize", new Set()], ["scroll", new Set()]]);
  const vv: TerminalViewportLike & EventTarget = {
    height, offsetTop, scale,
    addEventListener: (type: string, cb: EventListenerOrEventListenerObject) => {
      listeners.get(type as VvEvent)?.add(cb as () => void);
    },
    removeEventListener: (type: string, cb: EventListenerOrEventListenerObject) => {
      listeners.get(type as VvEvent)?.delete(cb as () => void);
    },
    dispatchEvent: () => true,
  } as unknown as TerminalViewportLike & EventTarget;
  Object.defineProperty(window, "visualViewport", { value: vv, configurable: true });
  return {
    set(height: number, offsetTop = 0) {
      (vv as { height: number }).height = height;
      (vv as { offsetTop: number }).offsetTop = offsetTop;
      for (const cb of listeners.get("resize") ?? []) cb();
    },
    poke: () => { for (const cb of listeners.get("resize") ?? []) cb(); },
  };
}

function focusedHostWithTextarea(): { host: HTMLElement; ta: HTMLTextAreaElement } {
  const host = document.createElement("div");
  const ta = document.createElement("textarea");
  host.appendChild(ta);
  document.body.appendChild(host);
  ta.focus();
  return { host, ta };
}

describe("measureTerminalViewportInsets", () => {
  let host: HTMLElement;
  let ta: HTMLTextAreaElement;
  beforeEach(() => {
    document.body.replaceChildren();
    ({ host, ta } = focusedHostWithTextarea());
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
  });

  it("desktop never reports insets", () => {
    const r = measureTerminalViewportInsets({
      visualViewport: { height: 400, offsetTop: 0, scale: 1 },
      windowHeight: 800, terminalHost: host, activeElement: ta,
      connected: true, mobile: false,
    });
    expect(r).toEqual({ keyboardInset: 0, viewportTopInset: 0, viewportBottomInset: 0 });
  });

  it("keyboard-sized shrink with terminal editable focus lifts as keyboard", () => {
    const r = measureTerminalViewportInsets({
      visualViewport: { height: 500, offsetTop: 0, scale: 1 },
      windowHeight: 800, terminalHost: host, activeElement: ta,
      connected: true, mobile: true,
    });
    expect(r).toEqual({ keyboardInset: 300, viewportTopInset: 0, viewportBottomInset: 0 });
  });

  it("sub-threshold shrink is chrome, not keyboard", () => {
    const r = measureTerminalViewportInsets({
      visualViewport: { height: 750, offsetTop: 10, scale: 1 },
      windowHeight: 800, terminalHost: host, activeElement: ta,
      connected: true, mobile: true,
    });
    expect(r.keyboardInset).toBe(0);
    expect(r.viewportTopInset).toBe(10);
    expect(r.viewportBottomInset).toBe(40);
  });

  it("non-editable focus inside the host is not a keyboard claim", () => {
    const canvas = document.createElement("canvas");
    host.appendChild(canvas);
    canvas.focus?.();
    const r = measureTerminalViewportInsets({
      visualViewport: { height: 500, offsetTop: 0, scale: 1 },
      windowHeight: 800, terminalHost: host, activeElement: canvas,
      connected: true, mobile: true,
    });
    expect(r.keyboardInset).toBe(0);
    expect(r.viewportBottomInset).toBe(300);
  });

  it("focus outside the terminal host is browser chrome, not keyboard", () => {
    const r = measureTerminalViewportInsets({
      visualViewport: { height: 500, offsetTop: 0, scale: 1 },
      windowHeight: 800, terminalHost: host, activeElement: document.body,
      connected: true, mobile: true,
    });
    expect(r.keyboardInset).toBe(0);
  });

  it("disconnected attachments never claim a keyboard", () => {
    const r = measureTerminalViewportInsets({
      visualViewport: { height: 500, offsetTop: 0, scale: 1 },
      windowHeight: 800, terminalHost: host, activeElement: ta,
      connected: false, mobile: true,
    });
    expect(r.keyboardInset).toBe(0);
  });

  it("pinch zoom disables insets entirely", () => {
    const r = measureTerminalViewportInsets({
      visualViewport: { height: 500, offsetTop: 0, scale: 1.5 },
      windowHeight: 800, terminalHost: host, activeElement: ta,
      connected: true, mobile: true,
    });
    expect(r).toEqual({ keyboardInset: 0, viewportTopInset: 0, viewportBottomInset: 0 });
  });

  it("a null visualViewport reports zeros", () => {
    const r = measureTerminalViewportInsets({
      visualViewport: null,
      windowHeight: 800, terminalHost: host, activeElement: ta,
      connected: true, mobile: true,
    });
    expect(r).toEqual({ keyboardInset: 0, viewportTopInset: 0, viewportBottomInset: 0 });
  });
});

describe("bindTerminalKeyboardInset", () => {
  let host: HTMLElement;
  let ta: HTMLTextAreaElement;
  let vv: ReturnType<typeof installVisualViewport>;
  let onInset: ReturnType<typeof vi.fn>;
  let dispose: (() => void) | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.replaceChildren();
    ({ host, ta } = focusedHostWithTextarea());
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
    vv = installVisualViewport(800);
    onInset = vi.fn();
  });
  afterEach(() => {
    dispose?.();
    dispose = null;
    vi.useRealTimers();
    delete (window as { visualViewport?: unknown }).visualViewport;
  });

  function bind() {
    dispose = bindTerminalKeyboardInset({
      host,
      isMobile: () => true,
      isConnected: () => true,
      onKeyboardInset: onInset,
    });
  }

  it("keyboard open commits immediately", () => {
    bind();
    vv.set(500);
    expect(onInset).toHaveBeenCalledWith(300);
  });

  it("per-keystroke shrink transient never drops the inset", async () => {
    bind();
    vv.set(500); // keyboard open: 300
    vv.set(560); // transient shrink: measured 240 < current 300 -> deferred
    vv.set(500); // recovered: cancels the close, still 300
    await vi.advanceTimersByTimeAsync(KEYBOARD_INSET_CLOSE_DELAY_MS * 2);
    expect(onInset).toHaveBeenCalledTimes(1);
    expect(onInset).toHaveBeenLastCalledWith(300);
  });

  it("real close commits zero after the debounce, re-measuring fresh", async () => {
    bind();
    vv.set(500);
    expect(onInset).toHaveBeenLastCalledWith(300);

    vv.set(800); // keyboard closed: measured 0 -> deferred close
    // Reopened before the timer fires: the fire-time re-measure must see the
    // keyboard still open at the same inset (never commits a stale zero).
    vv.set(500);
    await vi.advanceTimersByTimeAsync(KEYBOARD_INSET_CLOSE_DELAY_MS * 2);
    expect(onInset).toHaveBeenCalledTimes(1);

    vv.set(800); // and now a sustained close
    await vi.advanceTimersByTimeAsync(KEYBOARD_INSET_CLOSE_DELAY_MS + 10);
    expect(onInset).toHaveBeenLastCalledWith(0);
    expect(onInset).toHaveBeenCalledTimes(2);
  });

  it("dispose stops the close timer and removes listeners", async () => {
    bind();
    vv.set(500);
    dispose?.();
    vv.set(800);
    await vi.advanceTimersByTimeAsync(KEYBOARD_INSET_CLOSE_DELAY_MS * 2);
    expect(onInset).toHaveBeenCalledTimes(1); // only the open commit
  });
});
