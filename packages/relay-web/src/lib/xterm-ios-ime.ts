/**
 * Local backport of xterm.js #5614 onto stock `@xterm/xterm@6.0.0`.
 *
 * 6.0.0 `CoreBrowserTerminal._inputEvent` only accepts `insertText` when
 * `e.data && inputType === "insertText" && (!e.composed || !_keyDownSeen)`.
 * iOS Chinese IMEs (Safari / Home Screen Web App) confirm candidates and type
 * space / CJK punctuation as `input` events with `inputType: "insertText"`,
 * `composed: true`, `isComposing: false`, after a keydown that already set
 * `_keyDownSeen` — so the characters are dropped. English still works because
 * it is delivered via keydown → onData. See xtermjs/xterm.js#5835.
 *
 * Upstream #5614 changes the gate to "not actively composing / not pending a
 * compositionend send". That both *accepts* the iOS path and *rejects* the
 * emoji double-send (compositionend schedules a send, then insertText fires
 * after keyup cleared `_keyDownSeen`). Neither #5614 nor the keyup fallback
 * (#5836) is in the published 6.0.0. This replaces the instance method
 * (published bundle keeps `_core` / `_inputEvent` / `_compositionHelper` /
 * `_isSendingComposition` / `coreService` unminified) without forking xterm
 * or stretching the helper textarea.
 */

/** Shape of the published xterm CoreBrowserTerminal fields we touch. */
export interface XtermIosImeCore {
  _keyDownSeen: boolean;
  _keyPressHandled: boolean;
  _unprocessedDeadKey?: boolean;
  _compositionHelper?: {
    readonly isComposing: boolean;
    _isSendingComposition?: boolean;
    readonly isSendingComposition?: boolean;
  };
  optionsService: { rawOptions: { screenReaderMode?: boolean } };
  coreService: { triggerDataEvent(data: string, wasUserInput?: boolean): void };
  cancel(ev: Event, force?: boolean): boolean | void;
  _inputEvent(ev: InputEvent): boolean;
  __xacpxIosImePatched?: boolean;
}

export interface XtermIosImeTerminal {
  _core?: XtermIosImeCore;
}

/** Stock 6.0.0 `_inputEvent` gate: composed + prior keydown ⇒ drop. */
export function stockXtermDropsComposedInsertText(
  ev: Pick<InputEvent, "data" | "inputType" | "composed">,
  keyDownSeen: boolean,
): boolean {
  return !!(ev.data && ev.inputType === "insertText" && ev.composed && keyDownSeen);
}

function isSendingComposition(helper: NonNullable<XtermIosImeCore["_compositionHelper"]>): boolean {
  return !!(helper.isSendingComposition ?? helper._isSendingComposition);
}

function isCompositionBusy(core: Pick<XtermIosImeCore, "_compositionHelper">, evIsComposing: boolean | undefined): boolean {
  if (evIsComposing) return true;
  const helper = core._compositionHelper;
  if (!helper) return false;
  return helper.isComposing || isSendingComposition(helper);
}

/**
 * #5614 gate: accept non-composition insertText when CompositionHelper is idle.
 * Unlike stock 6.0.0, `_keyDownSeen` / `composed` do not participate.
 */
export function shouldAcceptXtermInsertText(
  ev: Pick<InputEvent, "data" | "inputType" | "isComposing">,
  core: Pick<XtermIosImeCore, "_keyPressHandled" | "_compositionHelper">,
  screenReaderMode: boolean,
): boolean {
  if (!ev.data || ev.inputType !== "insertText") return false;
  if (screenReaderMode) return false;
  if (core._keyPressHandled) return false;
  if (isCompositionBusy(core, ev.isComposing)) return false;
  return true;
}

/** Patch a constructed `@xterm/xterm` Terminal. Idempotent. Returns false if the private surface is missing. */
export function patchXtermIosImeInsertText(term: object): boolean {
  const core = (term as XtermIosImeTerminal)._core;
  if (!core || typeof core._inputEvent !== "function") return false;
  if (core.__xacpxIosImePatched) return true;
  if (!core.coreService || typeof core.coreService.triggerDataEvent !== "function") return false;

  core._inputEvent = function patchedInputEvent(this: XtermIosImeCore, ev: InputEvent): boolean {
    if (!shouldAcceptXtermInsertText(ev, this, !!this.optionsService?.rawOptions?.screenReaderMode)) {
      return false;
    }
    this._unprocessedDeadKey = false;
    this.coreService.triggerDataEvent(ev.data!, true);
    this.cancel(ev);
    return true;
  };
  core.__xacpxIosImePatched = true;
  return true;
}
