/**
 * Local backport of xterm.js #5836 onto stock `@xterm/xterm@6.0.0`.
 *
 * 6.0.0 `CoreBrowserTerminal._inputEvent` only accepts `insertText` when
 * `e.data && inputType === "insertText" && (!e.composed || !_keyDownSeen)`.
 * iOS Chinese IMEs (Safari / Home Screen Web App) confirm candidates and type
 * space / CJK punctuation as `input` events with `inputType: "insertText"`,
 * `composed: true`, `isComposing: false`, after a keydown that already set
 * `_keyDownSeen` — so `_inputEvent` drops them. See xtermjs/xterm.js#5835.
 *
 * A lone #5614-style `_inputEvent` gate (accept idle insertText even when
 * composed + `_keyDownSeen`) is not enough on 6.0.0. Stock
 * `CompositionHelper.keydown()` for `keyCode === 229` still calls
 * `_handleAnyTextareaChanges()`, which `setTimeout(0)` diffs the textarea and
 * may `triggerDataEvent` again. Real iOS sequence:
 *
 *   1. keydown 229 → helper snapshots textarea + schedules async diff
 *   2. browser updates `textarea.value`
 *   3. `input(insertText)` → a #5614 gate sends immediately
 *   4. setTimeout → helper sees the same change → sends again
 *
 * Worse: iOS double-space → `。` is `deleteContentBackward` then
 * `insertText("。")`. The same-length-but-changed branch of stock
 * `_handleAnyTextareaChanges` can `triggerDataEvent(newValue)` (the whole
 * textarea). Upstream #5836 is the fix: pending keyCode=229 state, converge
 * on keyup/timer, precise DEL+insert (including same-length replacement and
 * repeated keydown), so one 229 input has a single owner. Neither #5614 nor
 * #5836 is in the published 6.0.0.
 *
 * This patch does **not** replace `_inputEvent` with #5614. It wraps
 * CompositionHelper so idle 229 never takes the stock timeout path, flushes a
 * precise textarea diff on keyup/timer, and suppresses `_inputEvent` for the
 * duration of that cycle (input may arrive after keyup cleared `_keyDownSeen`,
 * which stock would then accept). Applied on the Terminal instance without
 * forking `@xterm/xterm` or stretching the helper textarea. Published 6.0.0
 * keeps `_core` / `_keyUp` / `_inputEvent` / `_compositionHelper` /
 * `_isSendingComposition` / `_finalizeComposition` / `coreService` unminified.
 *
 * `CompositionHelper` is created in `open()`, so construct-time apply wraps
 * `term.open` and installs the helper hooks after the original open.
 */

export const C0_DEL = "\x7f";

/** Shape of the published xterm CoreBrowserTerminal fields we touch. */
export interface XtermIosImeCore {
  _keyDownSeen?: boolean;
  _keyPressHandled?: boolean;
  _compositionHelper?: XtermIosImeCompositionHelper;
  textarea?: HTMLTextAreaElement;
  coreService: { triggerDataEvent(data: string, wasUserInput?: boolean): void };
  _keyUp(ev: KeyboardEvent): void;
  _inputEvent(ev: InputEvent): boolean;
  __xacpxIosImePatched?: boolean;
}

export interface XtermIosImeCompositionHelper {
  readonly isComposing?: boolean;
  _isComposing?: boolean;
  _isSendingComposition?: boolean;
  _dataAlreadySent?: string;
  _textarea?: HTMLTextAreaElement;
  _coreService?: { triggerDataEvent(data: string, wasUserInput?: boolean): void };
  _compositionPosition?: { start: number; end: number };
  keydown(ev: KeyboardEvent): boolean;
  compositionstart(): void;
  _finalizeComposition?(waitForSend: boolean): void;
  __xacpxIosImePatched?: boolean;
}

export interface XtermIosImeTerminal {
  _core?: XtermIosImeCore;
  textarea?: HTMLTextAreaElement;
  open(parent: HTMLElement): void;
}

export const XTERM_IOS_IME_PATCH_FAILED =
  "[relay-web] xterm iOS IME insertText patch failed: private _core/_keyUp/_compositionHelper surface missing";

function commonPrefixLength(oldValue: string, newValue: string): number {
  let n = 0;
  while (
    n < oldValue.length
    && n < newValue.length
    && oldValue.charCodeAt(n) === newValue.charCodeAt(n)
  ) {
    n++;
  }
  return n;
}

/**
 * Precise payload for a pending-229 textarea diff (#5836 `_handleAnyTextareaChanges`).
 * Same-length replacement emits DEL+insert, never the whole `newValue`.
 * Returns undefined when nothing changed.
 */
export function pending229Payload(oldValue: string, newValue: string): string | undefined {
  if (newValue === oldValue) return undefined;
  if (newValue.length < oldValue.length) return C0_DEL;
  const prefix = commonPrefixLength(oldValue, newValue);
  const removedCount = oldValue.length - prefix;
  const inserted = newValue.slice(prefix);
  return `${C0_DEL.repeat(removedCount)}${inserted}`;
}

function helperIsComposing(helper: XtermIosImeCompositionHelper | undefined): boolean {
  if (!helper) return false;
  return !!(helper.isComposing || helper._isComposing);
}

function helperIsSending(helper: XtermIosImeCompositionHelper | undefined): boolean {
  return !!helper?._isSendingComposition;
}

/** Patch a constructed `@xterm/xterm` Terminal. Idempotent. Returns false if the private surface is missing. */
export function patchXtermIosImeInsertText(term: object): boolean {
  const t = term as XtermIosImeTerminal;
  const core = t._core;
  if (!core || typeof core._keyUp !== "function" || typeof core._inputEvent !== "function") return false;
  if (!core.coreService || typeof core.coreService.triggerDataEvent !== "function") return false;
  if (typeof t.open !== "function") return false;
  if (core.__xacpxIosImePatched) return true;

  const pending: {
    baseline: string | undefined;
    timer: ReturnType<typeof setTimeout> | undefined;
    timerFired: boolean;
    keyupFired: boolean;
    cycleActive: boolean;
  } = {
    baseline: undefined,
    timer: undefined,
    timerFired: false,
    keyupFired: false,
    cycleActive: false,
  };

  const getTextarea = (): HTMLTextAreaElement | undefined => t.textarea ?? core.textarea;

  const clearPending229 = (): void => {
    if (pending.timer !== undefined) {
      clearTimeout(pending.timer);
      pending.timer = undefined;
    }
    pending.baseline = undefined;
    pending.timerFired = false;
    pending.keyupFired = false;
    pending.cycleActive = false;
  };

  const flushPending229 = (source: "timer" | "keyup"): void => {
    const helper = core._compositionHelper;
    if (source === "timer") pending.timerFired = true;
    else pending.keyupFired = true;

    // No cycle in flight (keyup for a non-229 key, or already cleared).
    if (pending.baseline === undefined && !pending.cycleActive) return;

    if (helperIsComposing(helper)) {
      clearPending229();
      return;
    }

    if (pending.baseline !== undefined) {
      const textarea = getTextarea();
      if (textarea) {
        const oldValue = pending.baseline;
        const newValue = textarea.value;
        const payload = pending229Payload(oldValue, newValue);
        if (payload !== undefined) {
          core.coreService.triggerDataEvent(payload, true);
          // Match #5836: cache the post-change textarea (shrink) or the
          // inserted suffix (grow/replace) so compositionend can skip it.
          if (helper) {
            helper._dataAlreadySent = newValue.length < oldValue.length
              ? newValue
              : newValue.slice(commonPrefixLength(oldValue, newValue));
          }
          // Prevent the other of {timer, keyup} from sending the same diff.
          pending.baseline = undefined;
        }
      }
    }

    if (pending.timerFired && pending.keyupFired) {
      clearPending229();
    }
  };

  const ensurePending229Timer = (): void => {
    if (pending.timer !== undefined) return;
    pending.timerFired = false;
    pending.timer = setTimeout(() => {
      pending.timer = undefined;
      flushPending229("timer");
    }, 0);
  };

  const startOrContinuePending229 = (): void => {
    const textarea = getTextarea();
    if (pending.baseline === undefined) {
      pending.baseline = textarea?.value ?? "";
      pending.keyupFired = false;
    }
    pending.cycleActive = true;
    ensurePending229Timer();
  };

  const origKeyUp = core._keyUp.bind(core);
  core._keyUp = function patchedKeyUp(this: XtermIosImeCore, ev: KeyboardEvent): void {
    origKeyUp(ev);
    flushPending229("keyup");
  };

  const origInputEvent = core._inputEvent.bind(core);
  // Not a #5614 accept-gate: skip insertText while 229 owns the cycle so
  // stock `_inputEvent` cannot send after keyup cleared `_keyDownSeen`.
  core._inputEvent = function patchedInputEvent(this: XtermIosImeCore, ev: InputEvent): boolean {
    if (pending.cycleActive) return false;
    return origInputEvent(ev);
  };

  const installHelperHooks = (): boolean => {
    const helper = core._compositionHelper;
    const textarea = getTextarea();
    if (!helper || typeof helper.keydown !== "function" || !textarea) return false;
    if (typeof helper.compositionstart !== "function") return false;
    if (helper.__xacpxIosImePatched) return true;

    const origKeydown = helper.keydown.bind(helper);
    helper.keydown = function patchedHelperKeydown(ev: KeyboardEvent): boolean {
      if (helperIsComposing(this) || helperIsSending(this)) {
        return origKeydown(ev);
      }
      if (ev.keyCode === 229) {
        // Do not call orig: stock `_handleAnyTextareaChanges` would race us.
        startOrContinuePending229();
        return false;
      }
      return origKeydown(ev);
    };

    const origCompositionStart = helper.compositionstart.bind(helper);
    helper.compositionstart = function patchedCompositionStart(): void {
      // Drop a stale 229 snapshot so the compositionend send is the sole owner.
      clearPending229();
      origCompositionStart();
    };

    helper.__xacpxIosImePatched = true;
    return true;
  };

  const origOpen = t.open.bind(t);
  t.open = (parent: HTMLElement): void => {
    origOpen(parent);
    if (!installHelperHooks()) {
      console.error(XTERM_IOS_IME_PATCH_FAILED);
      throw new Error(XTERM_IOS_IME_PATCH_FAILED);
    }
  };

  core.__xacpxIosImePatched = true;
  if (core._compositionHelper) return installHelperHooks();
  return true;
}

/** Production entry: throw (and log) if the private xterm surface is gone so a silent no-op is impossible. */
export function applyXtermIosImeInsertText(term: object): void {
  if (patchXtermIosImeInsertText(term)) return;
  console.error(XTERM_IOS_IME_PATCH_FAILED);
  throw new Error(XTERM_IOS_IME_PATCH_FAILED);
}
