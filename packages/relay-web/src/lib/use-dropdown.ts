import { onBeforeUnmount, onMounted, reactive, ref, watch, nextTick } from "vue";
import type { Component, Ref } from "vue";

// ── shared dropdown behaviour (relay-web redesign §F) ──────────────────────
// One composable drives every dropdown: an outside pointerdown closes, Esc
// closes and returns focus to the trigger, ↑↓/Home/End/Enter/Space navigate and
// select, selecting closes, and only one dropdown is open at a time (module
// registry below). Panels share one visual style — see DropdownPanel.vue.

/** One row of a dropdown. `selected` shows the trailing accent check. */
export interface DropdownRow {
  value: string;
  label: string;
  icon?: Component;
  disabled?: boolean;
  danger?: boolean;
  /** Trailing muted note (e.g. "not installed"). */
  hint?: string;
  /** Render the label in the mono face (model ids, branches). */
  mono?: boolean;
  /** Selected row: trailing accent ✓ + font-medium (never a tinted row). */
  selected?: boolean;
  /** Multi-select rows keep the panel open after activation. */
  keepOpen?: boolean;
  /** Render a hairline divider above this row (desktop panel only). */
  separatorBefore?: boolean;
  /** data-test hook for the row button. */
  testId?: string;
}
export interface DropdownGroup {
  label?: string;
  rows: DropdownRow[];
}

export interface DropdownController {
  open: boolean;
  /** Index into the panel's visible rows; -1 = none. */
  highlight: number;
  /** The trigger element, so Esc can return focus to it. */
  trigger: HTMLElement | null;
  toggle(): void;
  openMenu(): void;
  /** `focusTrigger` is set only for keyboard-driven closes (Esc). */
  closeMenu(options?: { focusTrigger?: boolean }): void;
  /** Registered by DropdownPanel while open: how many rows are navigable and
   *  what activating row `i` does. Disabled rows are excluded from `count`. */
  setNav(count: number, onSelect: (index: number) => void): void;
  /** Optional: jump the highlight to the next row whose label starts with a key
   *  (only fires when no search field owns the keyboard). */
  firstLetterJump?: (ch: string) => void;
}

// Module-level "only one open at a time": opening a dropdown closes whatever
// was open before it. The stored closer never returns focus — the newly opened
// trigger owns focus by then.
let activeClose: (() => void) | null = null;
// Keyboard ownership: the most recently opened floating layer handles keys, so
// a dropdown's row menu (ContextMenu) doesn't double-move highlights.
let keyboardOwner: object | null = null;

/** Claim document-level key handling for a floating layer (dropdown, row menu). */
export function claimKeyboard(owner: object | null): void {
  keyboardOwner = owner;
}

/** Release the claim, but only while `owner` still holds it. */
export function releaseKeyboard(owner: object): void {
  if (keyboardOwner === owner) keyboardOwner = null;
}

export function useDropdown(): DropdownController {
  const nav = { count: 0, onSelect: (_i: number) => {} };
  const closer = (): void => dd.closeMenu();
  const dd = reactive<DropdownController>({
    open: false,
    highlight: -1,
    trigger: null,
    toggle() {
      if (dd.open) dd.closeMenu();
      else dd.openMenu();
    },
    openMenu() {
      if (dd.open) return;
      if (activeClose !== closer) activeClose?.();
      activeClose = closer;
      claimKeyboard(dd);
      dd.open = true;
    },
    closeMenu(options) {
      if (!dd.open) return;
      dd.open = false;
      dd.highlight = -1;
      if (activeClose === closer) activeClose = null;
      releaseKeyboard(dd);
      if (options?.focusTrigger) dd.trigger?.focus();
    },
    setNav(count, onSelect) {
      nav.count = count;
      nav.onSelect = onSelect;
    },
  });

  function step(from: number, dir: 1 | -1): number {
    const n = nav.count;
    if (!n) return -1;
    let i = from < 0 ? (dir === 1 ? -1 : 0) : from;
    for (let guard = 0; guard < n; guard++) {
      i = (i + dir + n) % n;
      if (i >= 0) return i;
    }
    return from;
  }

  function onKeydown(e: KeyboardEvent): void {
    if (!dd.open) return;
    // Another floating layer (e.g. a row's ContextMenu) owns the keyboard.
    if (keyboardOwner && keyboardOwner !== dd) return;
    const inTextField = e.target instanceof HTMLElement &&
      (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA");
    switch (e.key) {
      case "ArrowDown": e.preventDefault(); dd.highlight = step(dd.highlight, 1); break;
      case "ArrowUp": e.preventDefault(); dd.highlight = step(dd.highlight, -1); break;
      case "Home": e.preventDefault(); dd.highlight = nav.count ? 0 : -1; break;
      case "End": e.preventDefault(); dd.highlight = nav.count - 1; break;
      case "Enter":
        // Enter inside a text field with nothing navigable belongs to the field
        // (e.g. the row rename form); otherwise it selects the highlight.
        if (!inTextField || nav.count > 0) {
          e.preventDefault();
          if (dd.highlight >= 0) nav.onSelect(dd.highlight);
        }
        break;
      case " ":
        if (inTextField) break; // typing a space in the search field
        e.preventDefault();
        if (dd.highlight >= 0) nav.onSelect(dd.highlight);
        break;
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        dd.closeMenu({ focusTrigger: true });
        break;
      default:
        // First-letter jump when no search field owns the keyboard.
        if (inTextField || e.metaKey || e.ctrlKey || e.altKey || e.key.length !== 1) break;
        if (dd.firstLetterJump) dd.firstLetterJump(e.key);
        break;
    }
  }

  function onPointerDown(e: PointerEvent): void {
    if (!dd.open) return;
    const target = e.target as Element | null;
    // The trigger and the panel keep it open; so does any floating layer the
    // panel owns (a row's ContextMenu), found via the shared marker attribute.
    if (target && (dd.trigger?.contains(target) || target.closest?.("[data-dd-panel]"))) return;
    // Outside click closes WITHOUT stealing focus back to the trigger.
    dd.closeMenu();
  }

  onMounted(() => {
    // Capture phase: run before bubbling document listeners (useModalA11y), so its
    // Escape sees defaultPrevented regardless of which component mounted first.
    document.addEventListener("keydown", onKeydown, true);
    document.addEventListener("pointerdown", onPointerDown, true);
  });
  onBeforeUnmount(() => {
    document.removeEventListener("keydown", onKeydown, true);
    document.removeEventListener("pointerdown", onPointerDown, true);
    // Only release what this instance holds; another open dropdown keeps its claim.
    if (activeClose === closer) activeClose = null;
    releaseKeyboard(dd);
  });

  return dd;
}

/** The `lg` breakpoint as JS, shared so every dropdown switches to MobileSheet
 *  together (keep in sync with the Tailwind `lg` breakpoint). Reads innerWidth
 *  rather than matchMedia: jsdom and older WebViews report no media support. */
export function useIsMobile(): Ref<boolean> {
  const isMobile = ref(typeof window !== "undefined" && window.innerWidth < 1024);
  function sync(): void { isMobile.value = window.innerWidth < 1024; }
  onMounted(() => window.addEventListener("resize", sync));
  onBeforeUnmount(() => window.removeEventListener("resize", sync));
  return isMobile;
}

/** Focus a node after the DOM settles (panel open → search field). */
export function focusSoon(el: HTMLElement | null | undefined): void {
  if (!el) return;
  void nextTick(() => el.focus());
}
