// Soft-keyboard viewport insets - mobile browser lifecycle, modeled on
// rmux-web-share's viewport-insets design (measurement semantics only).
//
// Both the on-screen keyboard and collapsible browser chrome shrink
// visualViewport; the distinction is behavioral, not browser-specific:
//   keyboard  = an editable INSIDE the terminal host holds focus AND the
//               viewport lost a large chunk of height (keyboard-sized)
//   chrome    = anything else (address bar, safe area, viewport scroll)
//
// The keyboard inset is LOCAL occlusion only. The terminal grid must never
// shrink because a keyboard opened: TerminalViewportController adds the inset
// back to the host height when fitting (keyboard-independent remote geometry),
// and the app layout lifts the visible surface by the same amount.

/** Below this shrink the viewport change is not keyboard-sized (chrome/bars). */
export const MIN_KEYBOARD_INSET_PX = 120;
/** Pinch zoom disables inset compensation entirely. */
const MAX_VIEWPORT_SCALE_FOR_INSETS = 1.01;

export interface TerminalViewportLike {
  height: number;
  offsetTop: number;
  scale: number;
}

export interface TerminalViewportInsetInput {
  visualViewport: TerminalViewportLike | null;
  windowHeight: number;
  terminalHost: HTMLElement;
  activeElement: Element | null;
  /** Attachment open - a disconnected tab never claims a keyboard. */
  connected: boolean;
  /** Touch viewport gate; desktop never reports insets. */
  mobile: boolean;
}

export interface TerminalViewportInsets {
  keyboardInset: number;
  viewportTopInset: number;
  viewportBottomInset: number;
}

function zeroInsets(): TerminalViewportInsets {
  return { keyboardInset: 0, viewportTopInset: 0, viewportBottomInset: 0 };
}

function positiveRound(value: number): number {
  return Math.max(0, Math.round(value));
}

function hostHasEditableFocus(host: HTMLElement, active: Element | null): boolean {
  if (!(active instanceof HTMLElement) || !host.contains(active)) return false;
  return active instanceof HTMLTextAreaElement
    || active instanceof HTMLInputElement
    || active.isContentEditable;
}

/** Pure measurement: classify the current viewport shrink as keyboard vs
 *  browser chrome. No listeners, no timers - fully deterministic. */
export function measureTerminalViewportInsets(input: TerminalViewportInsetInput): TerminalViewportInsets {
  const vv = input.visualViewport;
  if (!input.mobile || !vv || vv.scale > MAX_VIEWPORT_SCALE_FOR_INSETS) {
    return zeroInsets();
  }

  const top = positiveRound(vv.offsetTop);
  const bottom = positiveRound(input.windowHeight - vv.offsetTop - vv.height);
  const keyboard = positiveRound(input.windowHeight - vv.height);
  const keyboardCanLift =
    input.connected
    && hostHasEditableFocus(input.terminalHost, input.activeElement)
    && keyboard > MIN_KEYBOARD_INSET_PX
    && bottom > MIN_KEYBOARD_INSET_PX;

  if (keyboardCanLift) {
    // While typing, the whole shrink is the keyboard; browser chrome is
    // absorbed into the lift so the input line stays visible.
    return { keyboardInset: keyboard, viewportTopInset: 0, viewportBottomInset: 0 };
  }
  return { keyboardInset: 0, viewportTopInset: top, viewportBottomInset: bottom };
}

/** A real keyboard close is sustained; a per-keystroke viewport transient
 *  recovers within a frame or two. Defer shrinking the inset by this long so
 *  the transient cannot collapse the local lift mid-typing. */
export const KEYBOARD_INSET_CLOSE_DELAY_MS = 300;

export interface TerminalKeyboardInsetOptions {
  host: HTMLElement;
  isMobile(): boolean;
  isConnected(): boolean;
  /** Keyboard-inset commit (local lift + fit compensation). */
  onKeyboardInset(px: number): void;
  closeDelayMs?: number;
}

/**
 * Tracks visualViewport and commits keyboard insets with close-debounce.
 *
 * Opening/growing commits immediately (the lift must track the keyboard with
 * no lag); shrinking/closing defers a single re-measure - the timer re-measures
 * at fire time (never commits a stale value), and a grow event cancels it.
 * Returns a dispose function; safe to call once.
 */
export function bindTerminalKeyboardInset(
  opts: TerminalKeyboardInsetOptions,
): () => void {
  const vv = typeof window !== "undefined" ? window.visualViewport : null;
  if (!vv) return () => {};
  const closeDelay = opts.closeDelayMs ?? KEYBOARD_INSET_CLOSE_DELAY_MS;

  let current = 0;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  function measure(): TerminalViewportInsets {
    return measureTerminalViewportInsets({
      visualViewport: vv,
      windowHeight: window.innerHeight,
      terminalHost: opts.host,
      activeElement: document.activeElement,
      connected: opts.isConnected(),
      mobile: opts.isMobile(),
    });
  }

  function commit(px: number): void {
    if (px === current) return;
    current = px;
    opts.onKeyboardInset(px);
  }

  function clearCloseTimer(): void {
    if (closeTimer !== null) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }
  }

  function apply(): void {
    if (disposed) return;
    const measured = measure();
    if (measured.keyboardInset >= current || current === 0) {
      // Opening/growing, or a hard close from zero (desktop, disconnected):
      // apply immediately so the lift tracks the keyboard with no lag.
      clearCloseTimer();
      commit(measured.keyboardInset);
      return;
    }
    // Shrinking or closing while the keyboard is up: defer one re-measure. A
    // genuine close is sustained and still lands; a transient recovers (a grow
    // commits immediately and cancels this, or the re-measure holds the inset).
    if (closeTimer === null) {
      closeTimer = setTimeout(() => {
        closeTimer = null;
        if (disposed) return;
        commit(measure().keyboardInset);
      }, closeDelay);
    }
  }

  vv.addEventListener("resize", apply);
  vv.addEventListener("scroll", apply);
  apply();
  return () => {
    disposed = true;
    clearCloseTimer();
    vv.removeEventListener("resize", apply);
    vv.removeEventListener("scroll", apply);
  };
}
