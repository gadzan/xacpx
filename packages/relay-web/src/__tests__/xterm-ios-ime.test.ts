import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  patchXtermIosImeInsertText,
  shouldAcceptXtermInsertText,
  stockXtermDropsComposedInsertText,
  type XtermIosImeCore,
} from "../lib/xterm-ios-ime";

function iosInsertText(data: string, extra?: Partial<InputEvent>): InputEvent {
  return {
    data,
    inputType: "insertText",
    composed: true,
    isComposing: false,
    ...extra,
  } as InputEvent;
}

/** Replica of stock @xterm/xterm@6.0.0 `_inputEvent` (the published gate). */
function attachStockInputEvent(core: XtermIosImeCore & { sent: string[] }): XtermIosImeCore & { sent: string[] } {
  core._inputEvent = function stockInputEvent(this: XtermIosImeCore, ev: InputEvent): boolean {
    if (ev.data && ev.inputType === "insertText" && (!ev.composed || !this._keyDownSeen) && !this.optionsService.rawOptions.screenReaderMode) {
      if (this._keyPressHandled) return false;
      this.coreService.triggerDataEvent(ev.data, true);
      this.cancel(ev);
      return true;
    }
    return false;
  };
  return core;
}

function makeCore(overrides?: Partial<XtermIosImeCore> & { isComposing?: boolean; sending?: boolean }): XtermIosImeCore & { sent: string[] } {
  const sent: string[] = [];
  const { isComposing, sending, ...rest } = overrides ?? {};
  const core = {
    sent,
    _keyDownSeen: true,
    _keyPressHandled: false,
    _compositionHelper: {
      isComposing: isComposing ?? false,
      _isSendingComposition: sending ?? false,
    },
    optionsService: { rawOptions: { screenReaderMode: false } },
    coreService: { triggerDataEvent: (d: string) => { sent.push(d); } },
    cancel: vi.fn(),
    _inputEvent: (_ev: InputEvent) => false,
    ...rest,
  } as XtermIosImeCore & { sent: string[] };
  return attachStockInputEvent(core);
}

describe("xterm iOS IME insertText gate (#5614 backport)", () => {
  it("documents the stock 6.0.0 drop: composed insertText after keydown is rejected", () => {
    expect(stockXtermDropsComposedInsertText(
      { data: "，", inputType: "insertText", composed: true },
      true,
    )).toBe(true);
    const core = makeCore();
    expect(core._inputEvent(iosInsertText("，"))).toBe(false);
    expect(core.sent).toEqual([]);
  });

  it("accepts non-composition insertText when CompositionHelper is idle, even after keydown", () => {
    const idle = makeCore();
    expect(shouldAcceptXtermInsertText(iosInsertText("，"), idle, false)).toBe(true);
    expect(shouldAcceptXtermInsertText(iosInsertText(" "), idle, false)).toBe(true);
    expect(shouldAcceptXtermInsertText(iosInsertText("你好"), idle, false)).toBe(true);

    expect(shouldAcceptXtermInsertText(iosInsertText("，"), makeCore({ isComposing: true }), false)).toBe(false);
    expect(shouldAcceptXtermInsertText(iosInsertText("😀"), makeCore({ sending: true }), false)).toBe(false);
    expect(shouldAcceptXtermInsertText(iosInsertText("，", { isComposing: true }), idle, false)).toBe(false);
    expect(shouldAcceptXtermInsertText(iosInsertText("a"), makeCore({ _keyPressHandled: true }), false)).toBe(false);
    expect(shouldAcceptXtermInsertText(
      { data: "，", inputType: "insertFromPaste", isComposing: false } as InputEvent,
      idle,
      false,
    )).toBe(false);
    expect(shouldAcceptXtermInsertText(iosInsertText("，"), idle, true)).toBe(false);
  });

  it("patched core accepts iOS-style composed insertText after keydown", () => {
    const core = makeCore();
    expect(patchXtermIosImeInsertText({ _core: core })).toBe(true);
    expect(core._inputEvent(iosInsertText("，"))).toBe(true);
    expect(core.sent).toEqual(["，"]);
    expect(core._keyDownSeen).toBe(true);
  });

  it("patched core still drops insertText during composition (no pinyin leak)", () => {
    const core = makeCore({ isComposing: true });
    patchXtermIosImeInsertText({ _core: core });
    expect(core._inputEvent(iosInsertText("ni"))).toBe(false);
    expect(core.sent).toEqual([]);
  });

  it("patched core drops insertText while compositionend send is pending, even if keyup already cleared _keyDownSeen", () => {
    // Stock 6.0.0 would ACCEPT this (composed + !_keyDownSeen) and CompositionHelper
    // would also send on its timeout — emoji duplication. #5614 rejects it.
    const core = makeCore({ sending: true, _keyDownSeen: false });
    expect(core._inputEvent(iosInsertText("😀"))).toBe(true);
    expect(core.sent).toEqual(["😀"]);
    core.sent.length = 0;
    patchXtermIosImeInsertText({ _core: core });
    expect(core._inputEvent(iosInsertText("😀"))).toBe(false);
    expect(core.sent).toEqual([]);
  });

  it("patched core does not double-send when keypress already handled the character", () => {
    const core = makeCore({ _keyPressHandled: true });
    patchXtermIosImeInsertText({ _core: core });
    expect(core._inputEvent(iosInsertText("a"))).toBe(false);
    expect(core.sent).toEqual([]);
  });

  it("is idempotent and no-ops when _core/_inputEvent is missing", () => {
    const core = makeCore();
    const term = { _core: core };
    expect(patchXtermIosImeInsertText(term)).toBe(true);
    expect(patchXtermIosImeInsertText(term)).toBe(true);
    expect(patchXtermIosImeInsertText({})).toBe(false);
    expect(patchXtermIosImeInsertText({ _core: {} })).toBe(false);
  });
});

describe("real @xterm/xterm@6.0.0", () => {
  let term: { dispose(): void } | undefined;

  beforeEach(() => {
    // jsdom has no matchMedia; xterm CoreBrowserService reads DPR via it on open.
    if (typeof window.matchMedia !== "function") {
      window.matchMedia = (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener() {},
        removeListener() {},
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent() { return false; },
      });
    }
    // Color.ts probes a 1×1 canvas at import time; jsdom throws without canvas.
    HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
  });

  afterEach(() => {
    term?.dispose();
    term = undefined;
  });

  async function openXterm(): Promise<{
    term: import("@xterm/xterm").Terminal;
    textarea: HTMLTextAreaElement;
    received: string[];
  }> {
    const { Terminal } = await import("@xterm/xterm");
    const host = document.createElement("div");
    host.style.width = "800px";
    host.style.height = "400px";
    document.body.appendChild(host);
    const t = new Terminal({ cols: 80, rows: 24 });
    term = t;
    const received: string[] = [];
    t.onData((d) => { received.push(d); });
    t.open(host);
    const textarea = host.querySelector("textarea");
    if (!textarea) throw new Error("xterm helper textarea missing");
    return { term: t, textarea, received };
  }

  function fireIosComposedInsertText(textarea: HTMLTextAreaElement, data: string): void {
    // keyCode 229 is the iOS IME keydown; keep value unchanged so
    // CompositionHelper._handleAnyTextareaChanges is a no-op and this is a
    // pure `_inputEvent` measurement.
    const keydown = new KeyboardEvent("keydown", {
      key: "Unidentified",
      code: "Unidentified",
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    Object.defineProperty(keydown, "keyCode", { get: () => 229 });
    Object.defineProperty(keydown, "which", { get: () => 229 });
    textarea.dispatchEvent(keydown);
    textarea.dispatchEvent(new InputEvent("input", {
      data,
      inputType: "insertText",
      isComposing: false,
      bubbles: true,
      cancelable: true,
      composed: true,
    }));
  }

  it("stock terminal drops iOS-style composed insertText after keydown", async () => {
    const { textarea, received } = await openXterm();
    fireIosComposedInsertText(textarea, "，");
    expect(received).toEqual([]);
  });

  it("patched terminal delivers iOS-style composed insertText to onData", async () => {
    const { term: t, textarea, received } = await openXterm();
    expect(patchXtermIosImeInsertText(t)).toBe(true);
    fireIosComposedInsertText(textarea, "，");
    expect(received).toEqual(["，"]);
    fireIosComposedInsertText(textarea, " ");
    expect(received).toEqual(["，", " "]);
    fireIosComposedInsertText(textarea, "你好");
    expect(received).toEqual(["，", " ", "你好"]);
  });

  it("patched terminal still commits CJK composition once with no pinyin leak", async () => {
    const { term: t, textarea, received } = await openXterm();
    expect(patchXtermIosImeInsertText(t)).toBe(true);
    textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    textarea.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "ni" }));
    fireIosComposedInsertText(textarea, "ni");
    expect(received).toEqual([]);
    textarea.value = "你好";
    textarea.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    expect(received).toEqual(["你好"]);
  });
});
