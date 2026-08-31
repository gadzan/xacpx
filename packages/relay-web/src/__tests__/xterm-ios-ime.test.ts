import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  applyXtermIosImeInsertText,
  C0_DEL,
  patchXtermIosImeInsertText,
  pending229Payload,
  XTERM_IOS_IME_PATCH_FAILED,
} from "../lib/xterm-ios-ime";

describe("pending229Payload (#5836 precise textarea diff)", () => {
  it("returns undefined when the value is unchanged", () => {
    expect(pending229Payload("same", "same")).toBeUndefined();
    expect(pending229Payload("", "")).toBeUndefined();
  });

  it("emits only the inserted suffix for append-only changes", () => {
    expect(pending229Payload("", "，")).toBe("，");
    expect(pending229Payload("ab", "abXYZ")).toBe("XYZ");
  });

  it("emits a single DEL on shrink (not the removed substring)", () => {
    expect(pending229Payload("abc", "a")).toBe(C0_DEL);
    expect(pending229Payload(" ", "")).toBe(C0_DEL);
  });

  it("emits precise DEL+insert for same-length replacement, never the whole textarea", () => {
    expect(pending229Payload(" ", "。")).toBe(`${C0_DEL}。`);
    expect(pending229Payload("ab", "ac")).toBe(`${C0_DEL}c`);
    expect(pending229Payload("hello ", "hello。")).toBe(`${C0_DEL}。`);
    expect(pending229Payload("hello ", "hello。")).not.toBe("hello。");
  });

  it("emits prefix-based DEL+insert for a mid-string replacement", () => {
    expect(pending229Payload("abcde", "abXYde")).toBe(`${C0_DEL.repeat(3)}XYde`);
  });
});

describe("applyXtermIosImeInsertText surface", () => {
  it("throws and logs when the private surface is missing", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => applyXtermIosImeInsertText({})).toThrow(XTERM_IOS_IME_PATCH_FAILED);
      expect(err).toHaveBeenCalledWith(XTERM_IOS_IME_PATCH_FAILED);
      expect(() => applyXtermIosImeInsertText({ _core: {} })).toThrow(XTERM_IOS_IME_PATCH_FAILED);
      expect(patchXtermIosImeInsertText({})).toBe(false);
      expect(patchXtermIosImeInsertText({ _core: {} })).toBe(false);
    } finally {
      err.mockRestore();
    }
  });
});

describe("real @xterm/xterm@6.0.0", () => {
  let term: { dispose(): void } | undefined;

  beforeEach(() => {
    // jsdom has no matchMedia; xterm CoreBrowserService reads DPR via it on open.
    if (typeof window.matchMedia !== "function") {
      window.matchMedia = ((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener() {},
        removeListener() {},
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent() { return false; },
      })) as typeof window.matchMedia;
    }
    // Color.ts probes a 1×1 canvas at import time; jsdom throws without canvas.
    HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
  });

  afterEach(() => {
    term?.dispose();
    term = undefined;
  });

  async function openXterm(opts?: { patchBeforeOpen?: boolean; patchAfterOpen?: boolean }): Promise<{
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
    if (opts?.patchBeforeOpen) applyXtermIosImeInsertText(t);
    t.open(host);
    if (opts?.patchAfterOpen) applyXtermIosImeInsertText(t);
    const textarea = host.querySelector("textarea");
    if (!textarea) throw new Error("xterm helper textarea missing");
    return { term: t, textarea, received };
  }

  function dispatchKey(textarea: HTMLTextAreaElement, type: "keydown" | "keyup" | "keypress", keyCode: number, extra?: KeyboardEventInit): void {
    const ev = new KeyboardEvent(type, {
      key: extra?.key ?? (keyCode === 229 ? "Unidentified" : extra?.key),
      code: extra?.code ?? "Unidentified",
      bubbles: true,
      cancelable: true,
      composed: true,
      ...extra,
    });
    Object.defineProperty(ev, "keyCode", { get: () => keyCode });
    Object.defineProperty(ev, "which", { get: () => keyCode });
    if (extra?.charCode !== undefined) {
      Object.defineProperty(ev, "charCode", { get: () => extra.charCode });
    }
    textarea.dispatchEvent(ev);
  }

  function dispatchInput(textarea: HTMLTextAreaElement, inputType: string, data?: string): void {
    textarea.dispatchEvent(new InputEvent("input", {
      data,
      inputType,
      isComposing: false,
      bubbles: true,
      cancelable: true,
      composed: true,
    }));
  }

  /** Real dual-path timing: keydown 229 → mutate value → insertText → keyup/timer. */
  function fireIos229Insert(textarea: HTMLTextAreaElement, data: string): void {
    textarea.value = "";
    dispatchKey(textarea, "keydown", 229);
    textarea.value = data;
    dispatchInput(textarea, "insertText", data);
    dispatchKey(textarea, "keyup", 229);
  }

  async function nextMacrotask(): Promise<void> {
    await new Promise((r) => setTimeout(r, 0));
  }

  it("stock terminal drops composed insertText when the textarea value is unchanged (pure _inputEvent path)", async () => {
    const { textarea, received } = await openXterm();
    dispatchKey(textarea, "keydown", 229);
    dispatchInput(textarea, "insertText", "，");
    await nextMacrotask();
    expect(received).toEqual([]);
  });

  it("patched terminal sends a 229 insertText character exactly once through the dual-path race", async () => {
    const { textarea, received } = await openXterm({ patchAfterOpen: true });
    fireIos229Insert(textarea, "，");
    await nextMacrotask();
    expect(received).toEqual(["，"]);
    fireIos229Insert(textarea, " ");
    await nextMacrotask();
    expect(received).toEqual(["，", " "]);
    fireIos229Insert(textarea, "你好");
    await nextMacrotask();
    expect(received).toEqual(["，", " ", "你好"]);
  });

  it("patched terminal still sends exactly once when insertText arrives after keyup", async () => {
    const { textarea, received } = await openXterm({ patchAfterOpen: true });
    textarea.value = "";
    dispatchKey(textarea, "keydown", 229);
    textarea.value = "，";
    dispatchKey(textarea, "keyup", 229);
    dispatchInput(textarea, "insertText", "，");
    await nextMacrotask();
    expect(received).toEqual(["，"]);
  });

  it("patched terminal still sends exactly once when the 229 timer fires before keyup", async () => {
    const { textarea, received } = await openXterm({ patchAfterOpen: true });
    textarea.value = "";
    dispatchKey(textarea, "keydown", 229);
    textarea.value = "，";
    dispatchInput(textarea, "insertText", "，");
    await nextMacrotask();
    expect(received).toEqual(["，"]);
    dispatchKey(textarea, "keyup", 229);
    await nextMacrotask();
    expect(received).toEqual(["，"]);
  });

  it("iOS double-space conversion emits 。 once, not the whole textarea", async () => {
    const { textarea, received } = await openXterm({ patchAfterOpen: true });
    textarea.value = "hello ";
    dispatchKey(textarea, "keydown", 229);
    textarea.value = "hello";
    dispatchInput(textarea, "deleteContentBackward");
    textarea.value = "hello。";
    dispatchInput(textarea, "insertText", "。");
    dispatchKey(textarea, "keyup", 229);
    await nextMacrotask();
    expect(received.join("")).toBe(`${C0_DEL}。`);
    expect(received.join("")).not.toBe("hello。");
    expect(received).not.toContain("hello。");
  });

  it("patched terminal still commits CJK composition once with no pinyin leak", async () => {
    const { textarea, received } = await openXterm({ patchAfterOpen: true });
    textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    textarea.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "ni" }));
    dispatchKey(textarea, "keydown", 229);
    dispatchInput(textarea, "insertText", "ni");
    expect(received).toEqual([]);
    textarea.value = "你好";
    textarea.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    await nextMacrotask();
    expect(received).toEqual(["你好"]);
  });

  it("English keydown is not doubled by a following composed insertText", async () => {
    const { textarea, received } = await openXterm({ patchAfterOpen: true });
    dispatchKey(textarea, "keydown", 65, { key: "a", code: "KeyA" });
    expect(received.length).toBeGreaterThanOrEqual(1);
    const afterKeydown = [...received];
    // Stock drops this while `_keyDownSeen` is set. After keyup, stock would
    // accept it — the 229 owner must not keep a #5614 insertText gate.
    dispatchInput(textarea, "insertText", "a");
    dispatchKey(textarea, "keyup", 65, { key: "a", code: "KeyA" });
    await nextMacrotask();
    expect(received).toEqual(afterKeydown);
  });

  it("adapter order (construct → patch → open) owns the 229 dual-path and still commits composition once", async () => {
    const { textarea, received } = await openXterm({ patchBeforeOpen: true });

    fireIos229Insert(textarea, "，");
    await nextMacrotask();
    expect(received).toEqual(["，"]);

    // Helper textarea does not keep the previous commit as a growing buffer.
    textarea.value = "";
    textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    textarea.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "ni" }));
    dispatchKey(textarea, "keydown", 229);
    dispatchInput(textarea, "insertText", "ni");
    expect(received).toEqual(["，"]);
    textarea.value = "你好";
    textarea.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    await nextMacrotask();
    expect(received).toEqual(["，", "你好"]);
  });

  it("apply is idempotent on a real Terminal", async () => {
    const { term: t } = await openXterm({ patchBeforeOpen: true });
    expect(() => applyXtermIosImeInsertText(t)).not.toThrow();
    expect(patchXtermIosImeInsertText(t)).toBe(true);
  });

  it("repeated 229 keydowns in one cycle share one baseline (one send)", async () => {
    const { textarea, received } = await openXterm({ patchAfterOpen: true });
    textarea.value = "";
    dispatchKey(textarea, "keydown", 229);
    textarea.value = "x";
    dispatchKey(textarea, "keydown", 229);
    textarea.value = "xy";
    dispatchKey(textarea, "keydown", 229);
    textarea.value = "xy，";
    dispatchKey(textarea, "keyup", 229);
    await nextMacrotask();
    expect(received.join("")).toBe("xy，");
    expect(received).toHaveLength(1);
  });
});
